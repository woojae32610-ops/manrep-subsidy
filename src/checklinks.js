// ─────────────────────────────────────────────────────────────
// 링크 점검: 공고의 "신청 페이지"(온라인신청사이트URL)와 "정부24 원문"(상세조회URL)이 실제로 열리는지 확인
//   판정 3단계 (멀쩡한 링크를 숨기지 않기 위해):
//     dead   — HTTP 404/410, 또는 200인데 에러 페이지("이용에 불편을 드려서 죄송합니다" 등) → 바로 숨김
//     ok     — 열림. 인증서 오류(공공기관 사이트에 흔함, 브라우저에선 열림)도 ok 로 봄
//     unsure — 타임아웃/연결거부/fetch failed/403 등 네트워크성 실패 → 다음 날 다시 확인, 2번 연속이면 dead
//   - ok 는 7일마다, unsure 는 매일 다시 점검
//   - build.js 가 dead 링크 버튼은 숨기고 안내 문구를 띄움
// 사용: node src/checklinks.js          node src/checklinks.js --all (전부 다시)
// ─────────────────────────────────────────────────────────────
import { loadItems, saveItems, todayKST, daysBetween, argFlag, log } from './lib/util.js';

const CONCURRENCY = 6;
const TIMEOUT = 15000;
const RECHECK_DAYS = 7;
const ERROR_MARKERS = ['이용에 불편을 드려서', '페이지를 찾을 수 없', '존재하지 않는 페이지', '서비스 준비중'];
const CERT_ERRORS = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|ERR_TLS_CERT_ALTNAME_INVALID|UNABLE_TO_GET_ISSUER_CERT/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** @returns {{state:'ok'|'dead'|'unsure', why?:string}|null} */
async function probe(url) {
  if (!url) return null;
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(u, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'text/html,*/*', 'accept-language': 'ko-KR,ko;q=0.9' } });
    if (res.status === 404 || res.status === 410) return { state: 'dead', why: `HTTP ${res.status}` };
    if (res.status >= 400) return { state: 'unsure', why: `HTTP ${res.status}` }; // 403(봇 차단)·5xx(일시 장애)는 의심만
    const text = (await res.text()).slice(0, 200000);
    const hit = ERROR_MARKERS.find((m) => text.includes(m));
    if (hit && text.length < 60000) return { state: 'dead', why: `에러 페이지 ("${hit}")` };
    return { state: 'ok' };
  } catch (e) {
    const msg = `${e.cause?.code || ''} ${e.message || ''}`;
    if (CERT_ERRORS.test(msg)) return { state: 'ok', why: '인증서 경고(브라우저에선 열림)' };
    if (/ENOTFOUND/.test(msg)) return { state: 'dead', why: '도메인 없음 (사이트가 사라짐)' };
    return { state: 'unsure', why: e.name === 'AbortError' ? '타임아웃' : (e.cause?.code || e.message).slice(0, 60) };
  } finally { clearTimeout(t); }
}

// 이전 결과와 합쳐 최종 상태 결정: unsure 가 "다른 날" 2번 연속이면 dead (같은 날 여러 번 돌려도 한 번으로 침)
function settle(prev, now, sameDay) {
  if (!now) return { state: null, fails: 0 };
  if (now.state === 'ok') return { state: 'ok', fails: 0 };
  if (now.state === 'dead') return { state: 'dead', fails: 9, why: now.why };
  const fails = sameDay ? Math.max(prev?.fails ?? 0, 1) : (prev?.fails ?? 0) + 1;
  return { state: fails >= 2 ? 'dead' : 'unsure', fails, why: now.why };
}

const items = loadItems();
const today = todayKST();
const all = argFlag('--all');
const queue = Object.values(items).filter((it) => !it.removed && it.status !== '마감').filter((it) => {
  const L = it.links;
  if (all || !L?.at) return true;
  if (L.apply === 'unsure' || L.detail === 'unsure') return daysBetween(L.at, today) >= 1; // 의심은 매일
  return daysBetween(L.at, today) >= RECHECK_DAYS;
});
log(`링크 점검 대상: ${queue.length}건`);

let done = 0; const tally = { dead: 0, unsure: 0 };
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) {
    const it = queue.shift();
    const prev = all ? {} : (it.links || {}); // --all 은 카운터도 처음부터
    const sameDay = prev.at === today;
    const [a, d] = await Promise.all([probe(it.src.온라인신청사이트URL), probe(it.src.상세조회URL)]);
    const A = settle({ fails: prev.applyFails }, a, sameDay), D = settle({ fails: prev.detailFails }, d, sameDay);
    it.links = {
      at: today, apply: A.state, detail: D.state, applyFails: A.fails, detailFails: D.fails,
      why: [A.why ? `신청: ${A.why}` : '', D.why ? `원문: ${D.why}` : ''].filter(Boolean).join(' / ') || undefined,
    };
    done++;
    for (const s of [A.state, D.state]) if (s === 'dead' || s === 'unsure') tally[s]++;
    const bad = [A.state, D.state].some((x) => x === 'dead' || x === 'unsure');
    if (bad) log(`${A.state === 'dead' || D.state === 'dead' ? '✖' : '?'} ${it.src.서비스명}  ${it.links.why}`);
    if (done % 50 === 0) { saveItems(items); log(`  ${done}건 점검`); }
  }
}));
saveItems(items);
log(`완료: ${done}건 점검 — 죽음 ${tally.dead} (사이트에서 숨김), 의심 ${tally.unsure} (내일 다시 확인, 2번 연속 실패면 숨김)`);
