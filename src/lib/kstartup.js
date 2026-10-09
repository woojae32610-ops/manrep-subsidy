// K-Startup(창업진흥원) 창업지원사업 공고 API — 공공데이터포털 15125364
//   GET https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01
//       ?serviceKey=...&page=1&perPage=500&returnType=json&rcrt_prgs_yn=Y
//   키는 정부24와 같은 공공데이터포털 계정 키(GOV24_API_KEY). 활용신청이 승인돼 있어야 한다.
//   응답 필드(문서 기준, --probe 로 확인 후 보정): pbanc_sn, biz_pbanc_nm, pbanc_ctnt, supt_biz_clsfc, aply_trgt, aply_trgt_ctnt,
//     aply_excl_trgt_ctnt, biz_enyy, biz_trgt_age, supt_regin, pbanc_rcpt_bgng_dt, pbanc_rcpt_end_dt, pbanc_ntrp_nm, sprv_inst,
//     biz_prch_dprt_nm, prch_cnpl_no, detl_pg_url, biz_aply_url, biz_gdnc_url, prfn_matr, rcrt_prgs_yn
import config from '../../config.js';
import { getJson, findArray, stripHtml, toIsoDate, pick, formatPhone } from './http.js';
import { clean, hasAny, log } from './util.js';

const C = config.sources.kstartup;
export const SOURCE = 'kstartup';

export const hasKey = () => !!String(process.env.GOV24_API_KEY ?? '').trim();

function apiUrl(op, params) {
  const u = new URL(`${C.base}/${op}`);
  u.searchParams.set('serviceKey', String(process.env.GOV24_API_KEY ?? '').trim());
  u.searchParams.set('returnType', 'json');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u;
}

export const idOf = (r) => clean(pick(r, ['pbanc_sn', 'pbancSn', 'id']));

export async function fetchPage({ page = 1, perPage = C.perPage } = {}) {
  const { json, text } = await getJson(apiUrl('getAnnouncementInformation01', { page, perPage, rcrt_prgs_yn: 'Y' }), {
    timeoutMs: C.timeoutMs, label: `kstartup p${page}`,
    isAuthError: (st, j, t) => st === 401 || st === 403 || (j && typeof j.code === 'number' && j.code < 0) || /SERVICE.?KEY|NOT.?REGISTERED|UNREGISTERED/i.test(t.slice(0, 600)),
  });
  const rows = findArray(json);
  if (!rows) throw new Error(`예상 밖 응답 (배열 없음): ${text.slice(0, 300)}`);
  const total = json?.matchCount ?? json?.totalCount ?? null;
  return { rows, total, json };
}

const isOpen = (r, today) => String(pick(r, ['rcrt_prgs_yn'])).toUpperCase() !== 'N' && (!toIsoDate(pick(r, ['pbanc_rcpt_end_dt'])) || toIsoDate(pick(r, ['pbanc_rcpt_end_dt'])) >= today);

/** 최신순으로 오고 rcrt_prgs_yn 필터는 서버가 무시하므로(3만 건 전체), 열린 공고가 하나도 없는 페이지가 나오면 멈춘다 */
export async function fetchAll(today) {
  const out = [];
  const seen = new Set();
  let total = null;
  for (let page = 1; page <= C.maxPages; page++) {
    const r = await fetchPage({ page });
    total = r.total ?? total;
    if (!r.rows.length) break;
    let added = 0, open = 0;
    for (const row of r.rows) {
      const id = idOf(row);
      if (!id || seen.has(id)) continue;
      seen.add(id); added++;
      if (!isOpen(row, today)) continue;
      open++; out.push(row);
    }
    log(`  kstartup p${page}: +${r.rows.length} (열린 공고 ${open}, 누적 ${out.length}${total != null ? ` / 전체 ${total}` : ''})`);
    if (!added || !open || r.rows.length < C.perPage || (total != null && seen.size >= total)) break;
  }
  return out;
}

/** K-Startup 원본 → 공통 필드. 모집 종료(rcrt_prgs_yn=N)·마감 지난 것·제외 규칙은 null */
export function mapRow(r, today) {
  const id = idOf(r);
  if (!id) return null;
  if (String(pick(r, ['rcrt_prgs_yn'])).toUpperCase() === 'N') return null;
  const name = clean(pick(r, ['biz_pbanc_nm', 'pbanc_nm', 'title']));
  if (hasAny(name, C.excludeNames)) return null;
  const start = toIsoDate(pick(r, ['pbanc_rcpt_bgng_dt']));
  const end = toIsoDate(pick(r, ['pbanc_rcpt_end_dt']));
  if (end && today && end < today) return null;
  const content = stripHtml(pick(r, ['pbanc_ctnt', 'pbancCtnt']));
  const target = stripHtml(pick(r, ['aply_trgt_ctnt']));
  const targetCode = clean(pick(r, ['aply_trgt']));
  const excl = stripHtml(pick(r, ['aply_excl_trgt_ctnt']));
  const years = clean(pick(r, ['biz_enyy']));
  const age = clean(pick(r, ['biz_trgt_age']));
  const prefer = stripHtml(pick(r, ['prfn_matr']));
  const region = clean(pick(r, ['supt_regin']));
  const org = clean(pick(r, ['pbanc_ntrp_nm']));
  const all = `${name} ${target} ${targetCode}`;
  // 접수 방법: aply_mthd_* 중 값이 있는 것만 (온라인은 URL, 나머지는 안내 문구)
  const methods = [['온라인', 'aply_mthd_onli_rcpt_istc'], ['이메일', 'aply_mthd_eml_rcpt_istc'], ['방문', 'aply_mthd_vst_rcpt_istc'], ['우편', 'aply_mthd_pssr_rcpt_istc'], ['팩스', 'aply_mthd_fax_rcpt_istc'], ['기타', 'aply_mthd_etc_istc']]
    .map(([k, f]) => { const v = clean(pick(r, [f])); return v ? `${k}: ${v}` : ''; }).filter(Boolean);
  const onlineUrl = clean(pick(r, ['biz_aply_url', 'aply_mthd_onli_rcpt_istc']));
  return {
    서비스ID: `KS_${id}`,
    서비스명: name,
    서비스목적요약: '',
    지원대상: [target, targetCode && targetCode !== target ? `(${targetCode})` : '', years ? `업력: ${years}` : '', age && !age.includes(',') ? `연령: ${age}` : ''].filter(Boolean).join('\n'),
    선정기준: [excl ? `제외 대상: ${excl}` : '', prefer ? `우대: ${prefer}` : ''].filter(Boolean).join('\n'),
    지원내용: content,
    지원유형: clean(pick(r, ['supt_biz_clsfc'])),
    신청기한: start || end ? `${start || ''} ~ ${end || ''}`.trim() : '',
    신청방법: methods.join('\n'),
    접수기관명: org,
    소관기관명: org,                                    // sprv_inst 는 '민간/공공' 구분값이라 기관명으로 못 씀
    주관구분: clean(pick(r, ['sprv_inst'])),
    부서명: clean(pick(r, ['biz_prch_dprt_nm'])),
    문의처: formatPhone(pick(r, ['prch_cnpl_no'])),
    상세조회URL: clean(pick(r, ['detl_pg_url'])) || `https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=${encodeURIComponent(id)}`,
    온라인신청사이트URL: onlineUrl,
    사용자구분: hasAny(all, config.filter.strong) ? '소상공인' : '법인/시설/단체',
    서비스분야: '고용·창업',
    지역: region,
    출처: 'K-Startup',
    수정일시: toIsoDate(pick(r, ['pbanc_bgng_dt', 'reg_dt', 'frst_reg_dt'])) || start,
  };
}
