// 기업마당(bizinfo.go.kr) 지원사업 공고 API
//   GET https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do?crtfcKey=...&dataType=json&pageUnit=500&pageIndex=1
//   응답: { jsonArray: [ {pblancId, pblancNm, jrsdInsttNm, excInsttNm, bsnsSumryCn, pldirSportRealmLclasCodeNm,
//           trgetNm, hashTags, reqstBeginEndDe("20260101 ~ 20260131"), creatPnttm, refrncNm, pblancUrl, rceptEngnHmpgUrl ...} ] }
//   (문서가 빈약해서 필드명은 방어적으로 읽고, --probe 로 실제 응답을 확인한 뒤 보정)
// 정부24는 "제도" 단위라 기한이 없는 게 많고, 기업마당은 "모집공고" 단위라 접수기간이 있다.
import config from '../../config.js';
import { getJson, findArray, stripHtml, decodeEntities, toIsoDate, pick } from './http.js';
import { clean, hasAny, log } from './util.js';

const C = config.sources.bizinfo;
export const SOURCE = 'bizinfo';
const HOST = 'https://www.bizinfo.go.kr';

export const hasKey = () => !!String(process.env.BIZINFO_API_KEY ?? '').trim();

function apiUrl(params) {
  const u = new URL(C.base);
  u.searchParams.set('crtfcKey', String(process.env.BIZINFO_API_KEY ?? '').trim());
  u.searchParams.set('dataType', 'json');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u;
}

export const idOf = (r) => clean(pick(r, ['pblancId', 'pblancID', 'pblanc_id', 'id']));

/** 한 페이지. 응답 모양이 문서마다 달라서 배열을 찾아 돌려준다 */
export async function fetchPage({ pageUnit = C.pageUnit, pageIndex = 1 } = {}) {
  const { json, text } = await getJson(apiUrl({ pageUnit, pageIndex, searchCnt: pageUnit }), {
    timeoutMs: C.timeoutMs, label: `bizinfo p${pageIndex}`,
    isAuthError: (st) => st === 401 || st === 403,
  });
  const rows = findArray(json);
  if (!rows) throw new Error(`예상 밖 응답 (배열 없음): ${text.slice(0, 300)}`);
  return { rows, json };
}

const abs = (u) => { const s = clean(decodeEntities(u)); return !s ? '' : s.startsWith('/') ? HOST + s : s; };
const registeredAt = (r) => toIsoDate(pick(r, ['creatPnttm', 'creatDt', 'registDt', 'frstRegistPnttm']));

/** "20260101 ~ 20260131" → "2026-01-01 ~ 2026-01-31" (dates.js 가 읽을 수 있는 꼴로) */
export function formatPeriod(s) {
  return clean(s).replace(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g, '$1-$2-$3');
}
function endDateOf(r) {
  const dates = formatPeriod(pick(r, ['reqstBeginEndDe', 'reqstDe'])).match(/\d{4}-\d{2}-\d{2}/g);
  return dates?.length ? dates[dates.length - 1] : '';
}

/** 해시태그("2026,금융,서울,중소벤처기업부")에서 우리 지역 이름 뽑기 */
export function regionsFromTags(tags) {
  const found = [];
  for (const tag of String(tags ?? '').split(/[,#\s]+/).filter(Boolean)) {
    if (tag === '전국') { found.push('전국'); continue; }
    for (const [region, words] of Object.entries(config.taxonomy.regionKeywords)) if (words.includes(tag) && !found.includes(region)) found.push(region);
  }
  return found.join(', ');
}

/** 모든 페이지. 등록일이 maxAgeDays 보다 오래된 공고만 있는 페이지가 나오면 멈춘다 (최신순 가정 + 안전장치) */
export async function fetchAll(today) {
  const out = [];
  const seen = new Set();
  const cutoff = new Date(Date.parse(today) - C.maxAgeDays * 86400000).toISOString().slice(0, 10);
  let prevFirst = null;
  for (let page = 1; page <= C.maxPages; page++) {
    const { rows } = await fetchPage({ pageIndex: page });
    if (!rows.length) break;
    const first = idOf(rows[0]);
    if (first && first === prevFirst) { log('  bizinfo: 페이지가 넘어가지 않음 → 여기까지'); break; }
    prevFirst = first;
    let fresh = 0;
    for (const r of rows) {
      const id = idOf(r);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const reg = registeredAt(r), end = endDateOf(r);
      if (reg && reg >= cutoff) fresh++;
      if (end && end < today) continue;                 // 이미 끝난 공고는 아예 안 들임
      if (!end && reg && reg < cutoff) continue;        // 기한도 없고 너무 오래된 것
      out.push(r);
    }
    log(`  bizinfo p${page}: +${rows.length} (유효 누적 ${out.length})`);
    if (fresh === 0 || rows.length < C.pageUnit) break;
  }
  return out;
}

/** 기업마당 원본 → 우리 공통 필드(정부24와 같은 한국어 키). 소스별 제외 규칙에 걸리면 null */
export function mapRow(r) {
  const id = idOf(r);
  if (!id) return null;
  const name = clean(pick(r, ['pblancNm', 'pblancNM', 'title']));
  const field = clean(pick(r, ['pldirSportRealmLclasCodeNm', 'lclasNm']));
  const sub = clean(pick(r, ['pldirSportRealmMlsfcCodeNm', 'mlsfcNm']));
  const target = stripHtml(pick(r, ['trgetNm']));
  const tags = clean(pick(r, ['hashTags', 'hashtags']));
  if (C.excludeFields.includes(field)) return null;
  if (hasAny(name, C.excludeNames)) return null;
  const body = stripHtml(pick(r, ['bsnsSumryCn', 'bsnsSumryCN']));   // 공고 본문(HTML) — 첫 문단은 요약으로, 전체는 지원내용으로
  const firstPara = body.split(/\n+/).find((l) => l.trim().length > 10) ?? body;
  const all = `${name} ${target} ${tags}`;
  const smallBiz = hasAny(all, config.filter.strong);
  return {
    서비스ID: id,
    서비스명: decodeEntities(name),
    서비스목적요약: firstPara.slice(0, 300),
    지원대상: target,
    지원내용: body,
    지원유형: [field, sub].filter(Boolean).join(' > '),
    신청기한: formatPeriod(pick(r, ['reqstBeginEndDe', 'reqstDe'])),
    신청방법: stripHtml(pick(r, ['reqstMthPapersCn'])),
    접수기관명: clean(pick(r, ['excInsttNm'])),
    소관기관명: clean(pick(r, ['jrsdInsttNm'])),
    문의처: stripHtml(pick(r, ['refrncNm'])),
    상세조회URL: abs(pick(r, ['pblancUrl'])) || `${HOST}/sii/siia/selectSIIA200Detail.do?target=PR&pblancId=${encodeURIComponent(id)}`,
    온라인신청사이트URL: abs(pick(r, ['rceptEngnHmpgUrl'])),
    사용자구분: smallBiz ? '소상공인' : '법인/시설/단체',      // 공통 규칙 필터(candidateTier)가 쓰는 값
    서비스분야: field === '창업' ? '고용·창업' : `기업지원·${field || '기타'}`,
    지역: regionsFromTags(tags),
    해시태그: tags,
    출처: '기업마당',
    수정일시: toIsoDate(pick(r, ['updtPnttm'])) || registeredAt(r),
  };
}
