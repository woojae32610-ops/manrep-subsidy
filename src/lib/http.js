// 공통 HTTP GET → JSON (재시도·타임아웃). 소스 어댑터(gov24, bizinfo, kstartup)가 같이 쓴다.
import { log } from './util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 manrep-subsidy/1.0';

/**
 * @param {URL|string} url
 * @param {{timeoutMs?:number, retries?:number, label?:string, isAuthError?:(status:number, json:any, text:string)=>boolean}} opt
 * @returns {Promise<{json:any, text:string, status:number}>}
 */
export async function getJson(url, opt = {}) {
  const { timeoutMs = 30000, retries = 3, label = 'http', isAuthError } = opt;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json, */*', 'user-agent': UA } });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 아래에서 처리 */ }
      if (isAuthError && isAuthError(res.status, json, text)) {
        throw Object.assign(new Error(`인증 실패 (HTTP ${res.status}) ${text.slice(0, 300)}`), { fatal: true });
      }
      if (res.status === 429) throw Object.assign(new Error('일일 트래픽 초과 (HTTP 429)'), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      if (json === null) throw new Error(`JSON 아님: ${text.slice(0, 300)}`);
      return { json, text, status: res.status };
    } catch (e) {
      if (e.fatal || attempt === retries) throw e;
      log(`  재시도 ${attempt}/${retries} (${label}): ${String(e.message).split('\n')[0].slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    } finally { clearTimeout(t); }
  }
}

/** 응답 어딘가(깊이 3까지)에 있는 첫 배열을 찾는다 — 소스마다 감싸는 모양이 달라서 */
export function findArray(obj, depth = 0) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const k of ['data', 'item', 'items', 'jsonArray', 'list', 'body', 'response']) {
    if (k in obj) { const r = findArray(obj[k], depth + 1); if (r) return r; }
  }
  for (const v of Object.values(obj)) { const r = findArray(v, depth + 1); if (r) return r; }
  return null;
}

/** HTML 태그·엔티티 제거 (기업마당 요약 필드에 HTML이 섞여 옴) */
export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** "20260131" / "2026-01-31 10:00:00" / "2026.01.31" → "2026-01-31" (못 읽으면 '') */
export function toIsoDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return '';
}

/** 여러 후보 키 중 처음 값이 있는 것 (API 필드명이 문서마다 달라서 방어적으로) */
export function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}
