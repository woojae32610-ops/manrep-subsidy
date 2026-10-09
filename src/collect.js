// ─────────────────────────────────────────────────────────────
// 1단계: 수집
//   세 소스를 모아 소상공인 관련 공고만 걸러서 data/items.json 에 병합
//     정부24 공공서비스 API  — "제도" 목록 (기한 없는 게 많음)           키: GOV24_API_KEY
//     기업마당 API           — 중앙·지자체 "모집공고" (접수기간 있음)     키: BIZINFO_API_KEY
//     K-Startup API          — 창업 "모집공고"                            키: GOV24_API_KEY (같은 공공데이터포털 키)
//   - 새 공고는 추가, 바뀐 공고는 hash 갱신(→ AI 요약 다시), 사라진 공고는 removed 표시 (그 소스가 정상 수집된 날만)
//   - 한 소스가 실패해도 나머지는 진행. 정부24가 실패하면 종료코드 1 (알림용)
//   - 신청기한 파싱 → 마감 자동 판정
//   - data/field-report.md 에 소스별 결과·필드 리포트
// 사용: node src/collect.js            (실제 API, .env 의 키 필요)
//       node src/collect.js --sample   (data/sample/*.json 으로 키 없이 테스트, 정부24만)
//       node src/collect.js --raw      (data/raw/ 스냅샷 재사용 — API 안 부르고 필터·파싱만 다시)
//       node src/collect.js --probe    (각 API 첫 페이지만 불러 data/probe-report.md 에 실제 필드를 기록. items.json 안 건드림)
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import * as gov24 from './lib/gov24.js';
import * as bizinfo from './lib/bizinfo.js';
import * as kstartup from './lib/kstartup.js';
import { parseDeadline, statusOf } from './lib/dates.js';
import {
  DATA_DIR, loadEnv, readJson, writeJson, loadItems, saveItems,
  hash, todayKST, daysBetween, clean, hasAny, argFlag, log,
} from './lib/util.js';

loadEnv();
const today = todayKST();
const S = config.sources;
// 자동 실행(GitHub Actions 등 CI)에서 키가 없으면 샘플 모드로 빠져 실제 데이터를 덮어쓰면 안 되므로 바로 멈춘다
if (process.env.CI && !process.env.GOV24_API_KEY && !argFlag('--sample')) {
  console.error('✖ GOV24_API_KEY 가 없습니다. GitHub 저장소 Settings → Secrets and variables → Actions 에 등록하세요.');
  process.exit(1);
}
const useSample = argFlag('--sample') || !process.env.GOV24_API_KEY;
const useRaw = argFlag('--raw');
const RAW = (name) => path.join(DATA_DIR, 'raw', `${name}.json`);

const HASH_FIELDS = [
  '서비스명', '서비스목적요약', '서비스목적', '지원대상', '선정기준', '지원내용',
  '지원유형', '신청기한', '신청방법', '구비서류', '접수기관명', '문의처', '온라인신청사이트URL',
];

// ── 소스별 로더: 각각 "공통 필드(정부24식 한국어 키)로 된 행 배열"을 돌려준다 ──
async function loadGov24() {
  let list, detail;
  if (useRaw) {
    list = readJson(RAW('serviceList'), []);
    detail = readJson(RAW('serviceDetail'), []);
    if (!list.length) throw new Error('data/raw/serviceList.json 이 비어 있어요. 먼저 API로 한 번 수집하세요.');
    log(`  raw 스냅샷: 목록 ${list.length}건, 상세 ${detail.length}건 (API 호출 없음)`);
  } else if (useSample) {
    if (!process.env.GOV24_API_KEY && !argFlag('--sample')) log('  GOV24_API_KEY 가 .env 에 없어서 샘플 모드로 실행합니다.');
    list = readJson(path.join(DATA_DIR, 'sample', 'serviceList.json'), []);
    detail = readJson(path.join(DATA_DIR, 'sample', 'serviceDetail.json'), []);
    log(`  샘플: 목록 ${list.length}건, 상세 ${detail.length}건`);
  } else {
    list = await gov24.fetchAll('serviceList');
    detail = await gov24.fetchAll('serviceDetail');
    writeJson(RAW('serviceList'), list);
    writeJson(RAW('serviceDetail'), detail);
    log(`  수집 완료: 목록 ${list.length}건, 상세 ${detail.length}건 (data/raw/ 에 저장)`);
  }
  const detailById = new Map();
  for (const d of detail) if (d?.서비스ID) detailById.set(d.서비스ID, d);
  const rows = [];
  for (const row of list) {
    if (!row?.서비스ID) continue;
    const src = { ...row };
    for (const [k, v] of Object.entries(detailById.get(row.서비스ID) ?? {})) if (clean(v)) src[k] = v; // 상세가 있으면 상세 우선
    rows.push(src);
  }
  return { rows, list, detail };
}

async function loadBizinfo() {
  if (useSample) return { rows: [], skipped: '샘플 모드' };
  let raw;
  if (useRaw) {
    raw = readJson(RAW('bizinfo'), null);
    if (!raw) return { rows: [], skipped: 'data/raw/bizinfo.json 없음' };
  } else {
    if (!bizinfo.hasKey()) return { rows: [], skipped: 'BIZINFO_API_KEY 없음 (기업마당 사이트에서 발급 → .env / GitHub Secrets)' };
    raw = await bizinfo.fetchAll(today);
    writeJson(RAW('bizinfo'), raw);
  }
  const rows = raw.map(bizinfo.mapRow).filter(Boolean);
  log(`  기업마당: 원본 ${raw.length}건 → 분야·이름 제외 후 ${rows.length}건`);
  return { rows, rawCount: raw.length };
}

async function loadKstartup() {
  if (useSample) return { rows: [], skipped: '샘플 모드' };
  let raw;
  if (useRaw) {
    raw = readJson(RAW('kstartup'), null);
    if (!raw) return { rows: [], skipped: 'data/raw/kstartup.json 없음' };
  } else {
    if (!kstartup.hasKey()) return { rows: [], skipped: 'GOV24_API_KEY 없음' };
    raw = await kstartup.fetchAll(today);
    writeJson(RAW('kstartup'), raw);
  }
  const rows = raw.map((r) => kstartup.mapRow(r, today)).filter(Boolean);
  log(`  K-Startup: 원본 ${raw.length}건 → 종료·제외 후 ${rows.length}건`);
  return { rows, rawCount: raw.length };
}

const LOADERS = { gov24: loadGov24, bizinfo: loadBizinfo, kstartup: loadKstartup };

async function main() {
  // ── 소스별 수집 (하나가 실패해도 나머지는 진행) ──
  const results = {};
  for (const [name, loader] of Object.entries(LOADERS)) {
    if (!S[name]?.enabled) { results[name] = { skipped: '설정(config.sources)에서 꺼짐' }; continue; }
    log(`▶ ${S[name].label} 수집`);
    try {
      const r = await loader();
      results[name] = { ok: !r.skipped, ...r };
      if (r.skipped) log(`  건너뜀: ${r.skipped}`);
    } catch (e) {
      results[name] = { ok: false, error: e.message, rows: [] };
      log(`✖ ${S[name].label} 실패: ${String(e.message).split('\n')[0]}`);
    }
  }
  if (!Object.values(results).some((r) => r.ok)) throw new Error('수집된 소스가 하나도 없습니다.');

  // ── 1차 필터(규칙) + items.json 병합 ──
  const items = loadItems();
  for (const it of Object.values(items)) it.source ??= 'gov24'; // 예전 데이터 호환
  const seen = new Set();
  const ran = new Set(Object.entries(results).filter(([, r]) => r.ok).map(([n]) => n));
  const stat = {};
  const candidates = [];
  let added = 0, changed = 0, unchanged = 0;

  for (const [name, res] of Object.entries(results)) {
    if (!res.ok) continue;
    const tierCount = { A: 0, B: 0, C: 0 };
    let kept = 0;
    for (const row of res.rows) {
      const src = { ...row };
      for (const k of Object.keys(src)) if (typeof src[k] === 'string') src[k] = clean(src[k]);
      const tier = candidateTier(src);
      if (!tier) continue;
      tierCount[tier]++; kept++;
      candidates.push(src);

      const id = src.서비스ID;
      const h = hash(HASH_FIELDS.map((f) => src[f] ?? '').join('|'));
      const dl = parseDeadline(src.신청기한);
      const status = statusOf(dl, today);
      seen.add(id);

      const prev = items[id];
      if (!prev) {
        items[id] = { id, source: name, src, hash: h, ...dl, status, firstSeen: today, lastSeen: today, removed: false, ai: null };
        added++;
      } else {
        if (prev.hash !== h) changed++; else unchanged++;
        items[id] = { ...prev, source: name, src, hash: h, ...dl, status, lastSeen: today, removed: false };
      }
      items[id].tier = tier;
      if (useSample) items[id].sample = true; else delete items[id].sample;
    }
    stat[name] = { rows: res.rows.length, kept, tierCount };
    log(`  ${S[name].label} 규칙 필터: ${res.rows.length} → ${kept}건  (소상공인 태그 ${tierCount.A} / 직격 키워드 ${tierCount.C} / 사업체 대상 ${tierCount.B})`);
  }

  // ── 사라진 공고 표시 (이번에 정상 수집된 소스만) + 오래된 것 정리 ──
  let removed = 0, purged = 0;
  for (const it of Object.values(items)) {
    if (ran.has(it.source) && !seen.has(it.id) && !it.removed) { it.removed = true; it.removedAt = today; removed++; }
    if (it.removed && it.removedAt && daysBetween(it.removedAt, today) > config.filter.keepExpiredDays * 2) { delete items[it.id]; purged++; }
  }
  saveItems(items);

  const counts = {};
  for (const it of Object.values(items)) if (!it.removed) counts[it.status] = (counts[it.status] ?? 0) + 1;
  log(`items.json: 신규 ${added} / 변경 ${changed} / 유지 ${unchanged} / 사라짐 ${removed}${purged ? ` / 정리 ${purged}` : ''}`);
  log(`상태 분포: ${JSON.stringify(counts)}`);
  const needAi = Object.values(items).filter((it) => !it.removed && it.status !== '마감' && (!it.ai || it.ai.hash !== it.hash)).length;
  log(`AI 요약 필요: ${needAi}건  → node src/summarize.js`);

  writeFieldReport(results, stat, candidates, items);

  // 정부24(주 소스)가 실패했으면 알림용으로 실패 종료. 보조 소스 실패는 리포트에만 남긴다.
  if (results.gov24 && results.gov24.ok === false && results.gov24.error) throw new Error(`정부24 수집 실패: ${results.gov24.error}`);
}

const EVENT_RE = /(^|[^A-Za-z])IR([^A-Za-z]|$)/; // "IR 데모데이", "(IR)" — FAIR 같은 단어 속 IR 은 제외 안 함

/** 후보 등급: 'A' 사용자구분에 소상공인 / 'C' 직격 키워드 / 'B' 사업체 대상 + 사업 키워드 / null 제외 (모든 소스 공통) */
export function candidateTier(row) {
  const F = config.filter;
  const user = row.사용자구분 ?? '', field = row.서비스분야 ?? '';
  const nameTarget = `${row.서비스명 ?? ''} ${row.지원대상 ?? ''}`;
  const all = `${nameTarget} ${row.서비스목적요약 ?? ''}`;
  if (hasAny(row.서비스명 ?? '', F.excludeNames)) return null;
  if (hasAny(row.서비스명 ?? '', F.excludeEvents) || EVENT_RE.test(row.서비스명 ?? '')) return null;
  if (user.includes('소상공인')) return 'A';
  if (F.excludeFields.includes(field)) return null;
  if (hasAny(nameTarget, F.strong)) return 'C';
  const business = user.includes('법인/시설/단체') || field === '고용·창업';
  const individualOnly = user === '개인' && !hasAny(all, ['창업', '소상공인', '자영업', '사업']);
  if (business && hasAny(all, F.business) && !individualOnly) return 'B';
  return null;
}

// ── 소스별 결과 + 어떤 필드/값이 실제로 오는지 리포트 ──
function writeFieldReport(results, stat, candidates, items) {
  const list = results.gov24?.list ?? [], detail = results.gov24?.detail ?? [];
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
  const live = Object.values(items).filter((it) => !it.removed);
  const bySource = (name) => live.filter((it) => it.source === name);
  const parseRate = (rows) => {
    const c = { 마감일파싱: 0, 상시: 0, 둘다없음: 0 };
    for (const it of rows) { if (it.deadline) c.마감일파싱++; else if (it.always) c.상시++; else c.둘다없음++; }
    return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' / ');
  };
  const srcLines = Object.entries(results).map(([name, r]) => {
    const L = S[name]?.label ?? name;
    if (r.skipped) return `- ${L}: 건너뜀 — ${r.skipped}`;
    if (!r.ok) return `- ${L}: ✖ 실패 — ${String(r.error).split('\n')[0].slice(0, 200)}`;
    const s = stat[name] ?? {};
    return `- ${L}: 원본 ${r.rawCount ?? r.list?.length ?? r.rows.length}건 → 규칙 필터 후 ${s.kept ?? 0}건 (items 현재 ${bySource(name).length}건, ${parseRate(bySource(name))})`;
  }).join('\n');

  const md = `# 수집 리포트 (${today})

## 소스별 결과
${srcLines}

## 정부24 serviceList 필드 (채워진 건수)
| 필드 | 건수 | 채움률 |
|---|---|---|
${fill(list)}

## 정부24 serviceDetail 필드 (채워진 건수)
| 필드 | 건수 | 채움률 |
|---|---|---|
${fill(detail)}

## 사용자구분 상위값 (정부24 목록 전체)
${top(list, '사용자구분')}

## 지원유형 상위값 (정부24 목록 전체)
${top(list, '지원유형')}

## 서비스분야 상위값 (정부24 목록 전체)
${top(list, '서비스분야')}

## 소관기관명 상위값 (후보, 전체 소스)
${top(candidates, '소관기관명', 25)}

## 신청기한 표기 예시 (후보, 전체 소스)
${sample(candidates, '신청기한', 30)}

## 신청기한 파싱 결과 (items.json 전체)
${parseRate(live)}
`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'field-report.md'), md, 'utf8');
  log('수집 리포트: data/field-report.md');
}

// ── --probe: 각 API 첫 페이지만 불러서 실제 필드명·값을 기록 (새 소스 붙일 때 매핑 확인용) ──
async function runProbe() {
  const cut = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 300 ? s.slice(0, 300) + '…' : s; };
  const dump = (obj) => Object.entries(obj ?? {}).map(([k, v]) => `| ${k} | ${cut(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n');
  const out = [`# 소스 응답 점검 (${today}, ${process.env.CI ? 'GitHub Actions' : '로컬'})`, ''];
  const section = async (title, fn) => {
    out.push(`## ${title}`);
    try { out.push(...await fn()); } catch (e) { out.push(`✖ 실패: ${String(e.message).slice(0, 600)}`); }
    out.push('');
  };

  await section(`정부24 (${process.env.GOV24_API_KEY ? '키 있음' : '키 없음'})`, async () => {
    if (!process.env.GOV24_API_KEY) return ['키 없어서 건너뜀'];
    const r = await gov24.fetchPage('serviceList', 1, 2);
    return [`totalCount: ${r.total}, 받은 행: ${r.rows.length}`, '', '| 필드 | 값 |', '|---|---|', dump(r.rows[0])];
  });

  await section(`기업마당 (${bizinfo.hasKey() ? '키 있음' : '키 없음'})`, async () => {
    if (!bizinfo.hasKey()) return ['BIZINFO_API_KEY 없어서 건너뜀'];
    const p1 = await bizinfo.fetchPage({ pageUnit: 3, pageIndex: 1 });
    const p2 = await bizinfo.fetchPage({ pageUnit: 3, pageIndex: 2 });
    const ids = (p) => p.rows.map(bizinfo.idOf).join(', ');
    const lines = [
      `응답 최상위 키: ${Object.keys(p1.json ?? {}).join(', ')}`,
      `p1 행 ${p1.rows.length}건 [${ids(p1)}]  /  p2 행 ${p2.rows.length}건 [${ids(p2)}]  → 페이지 넘김 ${ids(p1) && ids(p1) === ids(p2) ? '안 됨' : '됨'}`,
      '', '### 원본 첫 행', '| 필드 | 값 |', '|---|---|', dump(p1.rows[0]),
      '', '### 우리 필드로 매핑한 결과', '| 필드 | 값 |', '|---|---|', dump(bizinfo.mapRow(p1.rows[0] ?? {}) ?? { '(제외됨)': '분야·이름 제외 규칙에 걸림' }),
    ];
    return lines;
  });

  await section(`K-Startup (${kstartup.hasKey() ? '공공데이터포털 키 있음' : '키 없음'})`, async () => {
    if (!kstartup.hasKey()) return ['GOV24_API_KEY 없어서 건너뜀'];
    const r = await kstartup.fetchPage({ page: 1, perPage: 3 });
    return [
      `응답 최상위 키: ${Object.keys(r.json ?? {}).join(', ')}  / total: ${r.total}, 받은 행: ${r.rows.length}`,
      '', '### 원본 첫 행', '| 필드 | 값 |', '|---|---|', dump(r.rows[0]),
      '', '### 우리 필드로 매핑한 결과', '| 필드 | 값 |', '|---|---|', dump(kstartup.mapRow(r.rows[0] ?? {}, today) ?? { '(제외됨)': '모집 종료/마감/제외 규칙' }),
    ];
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'probe-report.md'), out.join('\n'), 'utf8');
  log('점검 리포트: data/probe-report.md');
}

if (argFlag('--probe')) {
  runProbe().catch((e) => { console.error('\n✖ 점검 실패:', e.message); process.exitCode = 1; });
} else {
  main().catch((e) => { console.error('\n✖ 수집 실패:', e.message); process.exitCode = 1; });
}
