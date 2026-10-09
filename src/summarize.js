// ─────────────────────────────────────────────────────────────
// 2단계: AI 게이트 + 요약·분류
//   (1) 게이트: 싼 모델(Haiku)로 "사장님한테 해당되는 공고인가?"만 전부 판정 → it.gate
//   (2) 요약:   게이트 통과한 것만 상위 모델로 구조화 요약 → it.ai
//   - 구조화 출력(JSON 스키마)이라 필드 누락·형식 이탈 없음
//   - 요약 속 숫자를 원문과 코드로 대조 → 불일치는 flags 에 기록, data/review.md 로 모아줌
//   - 요약이 없거나 원문이 바뀐 것만 처리 (hash 비교) → 매일 돌려도 비용은 신규·변경분만
// 사용: node src/summarize.js               (.env 의 ANTHROPIC_API_KEY 필요)
//       node src/summarize.js --dry-run     (프롬프트만 출력, 호출 안 함)
//       node src/summarize.js --limit 5     (각 단계 앞 5건만 — 모델 비교·테스트용)
//       node src/summarize.js --gate-only   (게이트만)
//       node src/summarize.js --force       (전부 다시)
//       node src/summarize.js --id B55307700011   (이 공고 하나만 다시 — 회원 지적 받았을 때)
//       node src/summarize.js --model claude-sonnet-5-5
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { SYSTEM_PROMPT, buildUserPrompt, OUTPUT_SCHEMA, GATE_SYSTEM, buildGatePrompt, GATE_SCHEMA } from './lib/prompt.js';
import { verifyNumbers } from './lib/verify.js';
import { DATA_DIR, loadEnv, loadItems, saveItems, todayKST, argFlag, argValue, log } from './lib/util.js';

loadEnv();
const dry = argFlag('--dry-run');
const force = argFlag('--force');
const gateOnly = argFlag('--gate-only');
const limit = Number(argValue('--limit', 0)) || 0;
const model = argValue('--model', config.llm.model);
const gateModel = argValue('--gate-model', config.llm.gateModel);
const T = config.taxonomy;

const items = loadItems();
const onlyId = argValue('--id', '');

// --recheck: API 호출 없이, 저장된 요약의 숫자 검증만 다시 (verify.js 고쳤을 때)
if (argFlag('--recheck')) {
  let n = 0;
  for (const it of Object.values(items)) {
    if (!it.ai) continue;
    const flags = verifyNumbers(it.ai, it.src);
    if (it.ai.confidence === 'low') flags.push('AI 확신도 낮음 (원문 모호)');
    it.ai.flags = flags; n++;
  }
  saveItems(items);
  log(`숫자 검증 다시: ${n}건`);
  writeReview(items);
  process.exit(0);
}
if (onlyId && !items[onlyId]) { console.error(`✖ items.json 에 ${onlyId} 가 없어요.`); process.exit(1); }
const live = Object.values(items).filter((it) => !it.removed && (it.status !== '마감' || it.id === onlyId) && (!onlyId || it.id === onlyId));

let gateQueue = live.filter((it) => force || onlyId || !it.gate || it.gate.hash !== it.hash);
if (limit) gateQueue = gateQueue.slice(0, limit);
log(`게이트 대상: ${gateQueue.length}건 (model: ${gateModel})`);

if (dry) {
  const it = gateQueue[0] ?? live[0];
  console.log('\n=== GATE SYSTEM ===\n' + GATE_SYSTEM);
  console.log('\n=== GATE USER ===\n' + buildGatePrompt(it.src));
  console.log('\n=== SUMMARY SYSTEM ===\n' + SYSTEM_PROMPT);
  console.log('\n=== SUMMARY USER ===\n' + buildUserPrompt(it.src));
  console.log('\n=== OUTPUT SCHEMA ===\n' + JSON.stringify(OUTPUT_SCHEMA, null, 2));
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('✖ .env 에 ANTHROPIC_API_KEY 가 없습니다. (platform.claude.com 에서 발급)');
  process.exit(1);
}

const { default: Anthropic } = await import('@anthropic-ai/sdk');
const { jsonSchemaOutputFormat } = await import('@anthropic-ai/sdk/helpers/json-schema');
const client = new Anthropic({ apiKey: String(process.env.ANTHROPIC_API_KEY).trim(), maxRetries: 4 });
const priceOf = (m) => config.llm.price[m] ?? { in: 0, out: 0 };
const usage = { gate: { in: 0, out: 0 }, full: { in: 0, out: 0 } };

async function callStructured(m, system, user, schema, maxTokens) {
  let res;
  try {
    res = await client.messages.parse({
      model: m, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: jsonSchemaOutputFormat(schema) },
    });
  } catch (e) {
    // SDK가 잘린 JSON을 파싱하다 실패하면 이 메시지로 옴 → 대부분 max_tokens 부족
    if (/Failed to parse structured output/i.test(e.message)) throw new Error(`출력이 잘려 JSON 불완전 (max_tokens ${maxTokens}) — 한도 올리기`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('모델이 거부함 (refusal)');
  if (res.stop_reason === 'max_tokens') throw new Error(`출력이 잘림 (max_tokens ${maxTokens}) — 한도 올리기`);
  let out = res.parsed_output;
  if (!out) out = JSON.parse(res.content?.find((b) => b.type === 'text')?.text ?? '{}');
  return { out, usage: { in: res.usage?.input_tokens ?? 0, out: res.usage?.output_tokens ?? 0 } };
}

// 간단한 동시 실행 풀
async function runPool(queue, n, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) { await worker(queue.shift()); if (++i % 20 === 0) saveItems(items); }
  }));
  saveItems(items);
}

// ── (1) 게이트 ──
let gDone = 0, gFail = 0, gNo = 0;
await runPool(gateQueue, Math.max(config.llm.concurrency, 6), async (it) => {
  try {
    const { out, usage: u } = await callStructured(gateModel, GATE_SYSTEM, buildGatePrompt(it.src), GATE_SCHEMA, 1000);
    usage.gate.in += u.in; usage.gate.out += u.out;
    it.gate = { hash: it.hash, model: gateModel, at: todayKST(), relevant: !!out.relevant, reason: out.reason ?? '' };
    gDone++; if (!it.gate.relevant) gNo++;
    if (gDone % 25 === 0) log(`  게이트 ${gDone}건 (제외 ${gNo})`);
  } catch (e) { gFail++; log(`✖ 게이트 ${it.src.서비스명}: ${e.message.split('\n')[0]}`); }
});
const gc = usage.gate.in * priceOf(gateModel).in + usage.gate.out * priceOf(gateModel).out;
log(`게이트 완료 ${gDone}건 (제외 ${gNo}, 실패 ${gFail})  ≈ $${(gc / 1e6).toFixed(3)}`);

// ── (2) 요약 ──
let fullQueue = gateOnly ? [] : live.filter((it) => it.gate?.relevant && (force || onlyId || !it.ai || it.ai.hash !== it.hash));
if (limit) fullQueue = fullQueue.slice(0, limit);
log(`요약 대상: ${fullQueue.length}건 (model: ${model})`);

let done = 0, failed = 0;
await runPool(fullQueue, config.llm.concurrency, async (it) => {
  try {
    const { out, usage: u } = await callStructured(model, SYSTEM_PROMPT, buildUserPrompt(it.src), OUTPUT_SCHEMA, config.llm.maxTokens);
    usage.full.in += u.in; usage.full.out += u.out;
    // enum 안전장치 + 분류 비어있으면 fallback
    out.targets = (out.targets ?? []).filter((t) => T.targets.includes(t));
    out.support_types = (out.support_types ?? []).filter((t) => T.supportTypes.includes(t));
    if (!out.support_types.length) out.support_types = ['기타'];
    if (!T.regions.includes(out.region)) out.region = '전국';
    const flags = verifyNumbers(out, it.src);
    if (out.confidence === 'low') flags.push('AI 확신도 낮음 (원문 모호)');
    it.ai = { hash: it.hash, model, at: todayKST(), usage: u, ...out, flags };
    done++;
    const f = flags.length ? `  ⚑ ${flags.join(' / ')}` : '';
    log(`✓ ${done}/${done + fullQueue.length}  ${it.src.서비스명}${out.relevant ? '' : '  (관련없음→숨김)'}${f}`);
  } catch (e) { failed++; log(`✖ ${it.src.서비스명}: ${e.message.split('\n')[0]}`); }
});
const fc = usage.full.in * priceOf(model).in + usage.full.out * priceOf(model).out;
log(`요약 완료 ${done}건 / 실패 ${failed}건  토큰 in ${usage.full.in.toLocaleString()} out ${usage.full.out.toLocaleString()}  ≈ $${(fc / 1e6).toFixed(3)}`);
log(`총 비용 ≈ $${((gc + fc) / 1e6).toFixed(3)}`);

writeReview(items);

// ── 검수 리스트: 숫자 불일치·확신도 낮음·관련없음 판정 ──
function writeReview(items) {
const review = Object.values(items)
  .filter((it) => !it.removed && it.ai && (it.ai.flags?.length || !it.ai.relevant))
  .sort((a, b) => (b.ai.flags?.length ?? 0) - (a.ai.flags?.length ?? 0));
const gated = Object.values(items).filter((it) => !it.removed && it.gate && !it.gate.relevant);
const md = `# 검수 리스트 (${todayKST()})

## 요약 검수 ${review.length}건 — 숫자 불일치 / 확신도 낮음 / 관련없음
원문 링크 열어서 확인 후, 틀렸으면 items.json 의 ai 필드를 고치거나 해당 항목만 \`--force\` 로 다시 돌리세요.

${review.map((it) => `### ${it.src.서비스명}  (${it.id})
- 원문: ${it.src.상세조회URL ?? '-'}
- relevant: ${it.ai.relevant}  / confidence: ${it.ai.confidence}
${(it.ai.flags ?? []).map((f) => `- ⚑ ${f}`).join('\n')}
- 요약: ${it.ai.summary}
- 지원: ${it.ai.what}
- 최대: ${it.ai.max_amount ?? '-'}
`).join('\n')}

## 게이트에서 제외된 ${gated.length}건 — "사장님 대상 아님" 판정 (훑어보고 억울한 게 있으면 config 필터나 프롬프트 조정)
${gated.map((it) => `- ${it.src.서비스명} — ${it.gate.reason}`).join('\n')}
`;
fs.writeFileSync(path.join(DATA_DIR, 'review.md'), md, 'utf8');
log(`검수 리스트 → data/review.md (요약 검수 ${review.length}건, 게이트 제외 ${gated.length}건)`);
}
