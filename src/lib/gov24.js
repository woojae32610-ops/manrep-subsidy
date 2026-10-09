// 정부24(공공서비스) 오픈API 클라이언트
// 엔드포인트: serviceList(목록) / serviceDetail(상세) / supportConditions(지원조건)
// 공통 파라미터: serviceKey(디코딩 키), page, perPage, returnType=JSON
import config from '../../config.js';
import { log } from './util.js';

const { base, perPage, maxPages, timeoutMs } = config.gov24;

async function get(op, params) {
  const url = new URL(`${base}/${op}`);
  url.searchParams.set('serviceKey', process.env.GOV24_API_KEY);
  url.searchParams.set('returnType', 'JSON');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 아래에서 처리 */ }
      if (json && Array.isArray(json.data)) return json; // 정상 응답이면 끝
      // 여기부터는 실패 응답. 공공데이터포털 오류는 {code: -4, msg: ...} 꼴 또는 HTTP 401/403
      const code = json && typeof json.code === 'number' ? json.code : null;
      if (res.status === 401 || res.status === 403 || (code !== null && code < 0)) {
        throw Object.assign(new Error(`인증 실패 (HTTP ${res.status}${code !== null ? `, code ${code}` : ''}). 키가 아직 활성화 안 됐거나(신청 후 ~1시간), 키를 잘못 넣었을 수 있어요.\n${text.slice(0, 300)}`), { fatal: true });
      }
      if (res.status === 429) throw Object.assign(new Error('일일 트래픽 초과 (HTTP 429)'), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw new Error(`예상 밖 응답: ${text.slice(0, 300)}`);
    } catch (e) {
      if (e.fatal || attempt === 3) throw e;
      log(`  재시도 ${attempt}/3 (${op} p${params.page}): ${e.message.split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    } finally { clearTimeout(t); }
  }
}

/** 한 엔드포인트의 모든 페이지를 모아 배열로 반환 */
export async function fetchAll(op) {
  const out = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    const j = await get(op, { page, perPage });
    total = j.matchCount ?? j.totalCount ?? total;
    out.push(...j.data);
    log(`  ${op} p${page}: +${j.data.length} (누적 ${out.length}${total != null ? ` / ${total}` : ''})`);
    if (!j.data.length || (total != null && out.length >= total)) break;
  }
  return out;
}
