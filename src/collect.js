// ─────────────────────────────────────────────────────────────
// 1단계: 수집
//   정부24 공공서비스 API → 소상공인 관련 공고만 걸러서 data/items.json 에 병합
//   - 새 공고는 추가, 바뀐 공고는 hash 갱신(→ AI 요약 다시), 사라진 공고는 removed 표시
//   - 신청기한 파싱 → 마감 자동 판정
//   - data/field-report.md 에 실제로 어떤 필드/값이 오는지 리포트
// 사용: node src/collect.js            (실제 API, .env 의 GOV24_API_KEY 필요)
//       node src/collect.js --sample   (data/sample/*.json 으로 키 없이 테스트)
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { fetchAll } from './lib/gov24.js';
import { parseDeadline, statusOf } from './lib/dates.js';
import {
  DATA_DIR, loadEnv, readJson, writeJson, loadItems, saveItems,
  hash, todayKST, daysBetween, clean, hasAny, argFlag, log,
} from './lib/util.js';

loadEnv();
const today = todayKST();
// 자동 실행(GitHub Actions 등 CI)에서 키가 없으면 샘플 모드로 빠져 실제 데이터를 덮어쓰면 안 되므로 바로 멈춘다
if (process.env.CI && !process.env.GOV24_API_KEY && !argFlag('--sample')) {
  console.error('✖ GOV24_API_KEY 가 없습니다. GitHub 저장소 Settings → Secrets and variables → Actions 에 등록하세요.');
  process.exit(1);
}
const useSample = argFlag('--sample') || !process.env.GOV24_API_KEY;
const useRaw = argFlag('--raw'); // data/raw/ 스냅샷 재사용 (API 안 부르고 필터·파싱만 다시)

const HASH_FIELDS = [
  '서비스명', '서비스목적요약', '서비스목적', '지원대상', '선정기준', '지원내용',
  '지원유형', '신청기한', '신청방법', '구비서류', '접수기관명', '문의처', '온라인신청사이트URL',
];

async function main() {
  let list, detail;
  if (useRaw) {
    list = readJson(path.join(DATA_DIR, 'raw', 'serviceList.json'), []);
    detail = readJson(path.join(DATA_DIR, 'raw', 'serviceDetail.json'), []);
    if (!list.length) { console.error('✖ data/raw/ 가 비어 있어요. 먼저 API로 한 번 수집하세요.'); process.exitCode = 1; return; }
    log(`raw 스냅샷 로드: 목록 ${list.length}건, 상세 ${detail.length}건 (API 호출 없음)`);
  } else if (useSample) {
    if (!process.env.GOV24_API_KEY && !argFlag('--sample')) log('GOV24_API_KEY 가 .env 에 없어서 샘플 모드로 실행합니다.');
    list = readJson(path.join(DATA_DIR, 'sample', 'serviceList.json'), []);
    detail = readJson(path.join(DATA_DIR, 'sample', 'serviceDetail.json'), []);
    log(`샘플 로드: 목록 ${list.length}건, 상세 ${detail.length}건`);
  } else {
    log('정부24 API 수집 시작');
    list = await fetchAll('serviceList');
    detail = await fetchAll('serviceDetail');
    writeJson(path.join(DATA_DIR, 'raw', 'serviceList.json'), list);
    writeJson(path.join(DATA_DIR, 'raw', 'serviceDetail.json'), detail);
    log(`수집 완료: 목록 ${list.length}건, 상세 ${detail.length}건 (data/raw/ 에 저장)`);
  }

  // ── 상세를 서비스ID로 인덱싱 ──
  const detailById = new Map();
  for (const d of detail) if (d?.서비스ID) detailById.set(d.서비스ID, d);

  // ── 1차 필터: 규칙 (tier A: 사용자구분 소상공인 / C: 직격 키워드 / B: 사업체 대상 + 사업 키워드) ──
  const candidates = [];
  const tierCount = { A: 0, B: 0, C: 0 };
  for (const row of list) {
    if (!row?.서비스ID) continue;
    const t = candidateTier(row);
    if (!t) continue;
    tierCount[t]++;
    row._tier = t;
    candidates.push(row);
  }
  log(`규칙 필터: ${list.length} → ${candidates.length}건  (소상공인 태그 ${tierCount.A} / 직격 키워드 ${tierCount.C} / 사업체 대상 ${tierCount.B})`);

  // ── 병합 + items.json 갱신 ──
  const items = loadItems();
  const seen = new Set();
  let added = 0, changed = 0, unchanged = 0;

  for (const row of candidates) {
    const d = detailById.get(row.서비스ID) ?? {};
    const tier = row._tier; delete row._tier;
    const src = { ...row };
    for (const [k, v] of Object.entries(d)) if (clean(v)) src[k] = v; // 상세가 있으면 상세 우선
    for (const k of Object.keys(src)) if (typeof src[k] === 'string') src[k] = clean(src[k]);

    const id = src.서비스ID;
    const h = hash(HASH_FIELDS.map((f) => src[f] ?? '').join('|'));
    const dl = parseDeadline(src.신청기한);
    const status = statusOf(dl, today);
    seen.add(id);

    const prev = items[id];
    if (!prev) {
      items[id] = { id, src, hash: h, ...dl, status, firstSeen: today, lastSeen: today, removed: false, ai: null };
      added++;
    } else {
      if (prev.hash !== h) changed++; else unchanged++;
      items[id] = { ...prev, src, hash: h, ...dl, status, lastSeen: today, removed: false };
    }
    items[id].tier = tier;
    if (useSample) items[id].sample = true; else delete items[id].sample;
  }

  let removed = 0, purged = 0;
  for (const it of Object.values(items)) {
    if (!seen.has(it.id) && !it.removed) { it.removed = true; it.removedAt = today; removed++; }
    // 사라진 지 오래된 건 파일에서 완전히 정리 (keepExpiredDays 의 2배)
    if (it.removed && it.removedAt && daysBetween(it.removedAt, today) > config.filter.keepExpiredDays * 2) { delete items[it.id]; purged++; }
  }
  saveItems(items);

  const counts = {};
  for (const it of Object.values(items)) if (!it.removed) counts[it.status] = (counts[it.status] ?? 0) + 1;
  log(`items.json: 신규 ${added} / 변경 ${changed} / 유지 ${unchanged} / 사라짐 ${removed}${purged ? ` / 정리 ${purged}` : ''}`);
  log(`상태 분포: ${JSON.stringify(counts)}`);
  const needAi = Object.values(items).filter((it) => !it.removed && it.status !== '마감' && (!it.ai || it.ai.hash !== it.hash)).length;
  log(`AI 요약 필요: ${needAi}건  → node src/summarize.js`);

  writeFieldReport(list, detail, candidates, items);
}

/** 후보 등급: 'A' 사용자구분에 소상공인 / 'C' 직격 키워드 / 'B' 사업체 대상 + 사업 키워드 / null 제외 */
export function candidateTier(row) {
  const F = config.filter;
  const user = row.사용자구분 ?? '', field = row.서비스분야 ?? '';
  const nameTarget = `${row.서비스명 ?? ''} ${row.지원대상 ?? ''}`;
  const all = `${nameTarget} ${row.서비스목적요약 ?? ''}`;
  if (hasAny(row.서비스명 ?? '', F.excludeNames)) return null;
  if (user.includes('소상공인')) return 'A';
  if (F.excludeFields.includes(field)) return null;
  if (hasAny(nameTarget, F.strong)) return 'C';
  const business = user.includes('법인/시설/단체') || field === '고용·창업';
  const individualOnly = user === '개인' && !hasAny(all, ['창업', '소상공인', '자영업', '사업']);
  if (business && hasAny(all, F.business) && !individualOnly) return 'B';
  return null;
}

// ── 어떤 필드/값이 실제로 오는지 리포트 (처음 한 번 같이 보고 필터·프롬프트 조정용) ──
function writeFieldReport(list, detail, candidates, items) {
  const fill = (rows) => {
    const c = {};
    for (const r of rows) for (const [k, v] of Object.entries(r ?? {})) { c[k] ??= 0; if (clean(v)) c[k]++; }
    return Object.entries(c).sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `| ${k} | ${n} | ${rows.length ? Math.round((n / rows.length) * 100) : 0}% |`).join('\n');
  };
  const top = (rows, field, n = 15) => {
    const c = {};
    for (const r of rows) { const v = clean(r?.[field]) || '(빈값)'; c[v] = (c[v] ?? 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, k]) => `- ${v}: ${k}`).join('\n');
  };
  const sample = (rows, field, n = 20) => {
    const vals = [...new Set(rows.map((r) => clean(r?.[field])).filter(Boolean))];
    return vals.slice(0, n).map((v) => `- ${v.slice(0, 80)}`).join('\n');
  };
  const parseRate = () => {
    const c = { 마감일파싱: 0, 상시: 0, 둘다없음: 0 };
    for (const it of Object.values(items)) { if (it.removed) continue; if (it.deadline) c.마감일파싱++; else if (it.always) c.상시++; else c.둘다없음++; }
    return Object.entries(c).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  };

  const md = `# 정부24 API 필드 리포트 (${today})

- 목록(serviceList): ${list.length}건 / 상세(serviceDetail): ${detail.length}건 / 키워드 필터 후보: ${candidates.length}건

## serviceList 필드 (채워진 건수)
| 필드 | 건수 | 채움률 |
|---|---|---|
${fill(list)}

## serviceDetail 필드 (채워진 건수)
| 필드 | 건수 | 채움률 |
|---|---|---|
${fill(detail)}

## 사용자구분 상위값 (목록 전체)
${top(list, '사용자구분')}

## 지원유형 상위값 (목록 전체)
${top(list, '지원유형')}

## 서비스분야 상위값 (목록 전체)
${top(list, '서비스분야')}

## 소관기관명 상위값 (후보)
${top(candidates, '소관기관명', 25)}

## 신청기한 표기 예시 (후보)
${sample(candidates, '신청기한', 30)}

## 신청기한 파싱 결과 (items.json 기준)
${parseRate()}
`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'field-report.md'), md, 'utf8');
  log('필드 리포트: data/field-report.md');
}

main().catch((e) => { console.error('\n✖ 수집 실패:', e.message); process.exitCode = 1; });
