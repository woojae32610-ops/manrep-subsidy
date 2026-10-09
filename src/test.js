// 가벼운 단위 테스트: node src/test.js
import assert from 'node:assert/strict';
import { parseDeadline, statusOf } from './lib/dates.js';
import { verifyNumbers } from './lib/verify.js';
import * as bizinfo from './lib/bizinfo.js';
import * as kstartup from './lib/kstartup.js';

const T = '2026-10-09';
const cases = [
  ['2026.03.01 ~ 2026.10.31', { start: '2026-03-01', deadline: '2026-10-31' }],
  ['2026. 3. 1. ~ 10. 31.', { start: '2026-03-01', deadline: '2026-10-31' }],
  ['2026년 9월 1일부터 2026년 9월 30일까지', { start: '2026-09-01', deadline: '2026-09-30' }],
  ['2026-10-14까지', { deadline: '2026-10-14' }],
  ['2026.2.2.~2026.11.30. (예산 소진 시 발급 마감)', { start: '2026-02-02', deadline: '2026-11-30' }],
  ["(1차) '25.2.24.~3.7. (2차) '25.7.10.~7.18.", { start: '2025-02-24', deadline: '2025-07-18' }],
  ['(3분기) 2026.6.30.(화)~7.15.(수) / (4분기) 2026.8.31.(월)~9.15.(화) ※ 예산 소진 시 조기 종료', { start: '2026-06-30', deadline: '2026-09-15' }],
  ['2026.11.01.부터', { start: '2026-11-01', deadline: null }],
  ['상시', { deadline: null, always: true }],
  ['연중신청가능', { deadline: null, always: true }],
  ['예산 소진 시까지', { deadline: null, always: true }],
  ['사업공고에 따름', { deadline: null, always: false }],
  ['5~6월', { deadline: null, start: null }],
  ['', { deadline: null, always: false }],
];
for (const [input, want] of cases) {
  const got = parseDeadline(input);
  for (const k of Object.keys(want)) assert.equal(got[k], want[k], `parseDeadline("${input}").${k} = ${got[k]}, want ${want[k]}`);
}
assert.equal(statusOf(parseDeadline('2026.01.01 ~ 2026.09.30'), T), '마감');
assert.equal(statusOf(parseDeadline('2026.01.01 ~ 2026.10.14'), T), '마감임박');
assert.equal(statusOf(parseDeadline('2026.01.01 ~ 2026.12.31'), T), '접수중');
assert.equal(statusOf(parseDeadline('2026.11.01 ~ 2026.12.31'), T), '예정');
assert.equal(statusOf(parseDeadline('상시'), T), '상시');
assert.equal(statusOf(parseDeadline('사업공고에 따름'), T), '공고별');
assert.equal(statusOf(parseDeadline("'25.7.10.~7.18."), T), '마감');

// 숫자 검증
const src = { 지원내용: '운전자금 최대 7천만원, 5년(거치 2년), 기준금리 + 0.6%p' };
assert.deepEqual(verifyNumbers({ what: '최대 7,000만원까지 5년간 빌릴 수 있어요', max_amount: '최대 7,000만원' }, src), []);
assert.equal(verifyNumbers({ what: '최대 1억원까지 빌릴 수 있어요' }, src).length, 1, '없는 숫자(1억)는 잡혀야 함');
assert.equal(verifyNumbers({ cautions: ['거치 2년, 금리 0.6%p'] }, src).length, 0);
// 오탐 방지: 전화번호 콤마 나열 / '19년 → 2019년 / 지원 70% ↔ 자부담 30%
const src2 = { 문의처: '재단/02-368-8768||재단/02-368-8769', 지원대상: "'19년 사업 시행일 이후 가입자", 지원내용: '공급가액의 70% 이내 지원' };
assert.deepEqual(verifyNumbers({ cautions: ['문의는 02-368-8768, 02-368-8769', '2019년 시행일 이후 가입한 분만', '나머지 30%는 사장님 부담이에요'] }, src2), []);
assert.equal(verifyNumbers({ cautions: ['나머지 40%는 부담'] }, src2).length, 1, '70%의 보수가 아닌 40%는 잡혀야 함');



// 소스 어댑터 매핑 (기업마당 / K-Startup) — 실제 응답 모양은 --probe 로 확인하되, 변환 로직은 여기서 고정
assert.equal(bizinfo.formatPeriod('20260101 ~ 20260131'), '2026-01-01 ~ 2026-01-31');
assert.equal(bizinfo.formatPeriod('상시'), '상시');
assert.equal(bizinfo.regionsFromTags('2026,금융,서울,중소벤처기업부'), '서울');
assert.equal(bizinfo.regionsFromTags('2026,내수,전남광주,전국'), '광주, 전국');
const bz = bizinfo.mapRow({
  pblancId: 'PBLN_000000000099999', pblancNm: '2026년 서울시 소상공인 스마트상점 지원', jrsdInsttNm: '서울특별시', excInsttNm: '서울신용보증재단',
  bsnsSumryCn: '<p>키오스크·테이블오더 도입비 <b>최대 500만원</b> 지원</p>', pldirSportRealmLclasCodeNm: '경영', trgetNm: '서울 소재 소상공인',
  hashTags: '2026,경영,서울', reqstBeginEndDe: '20261001 ~ 20261231', creatPnttm: '2026-09-30 10:11:12', pblancUrl: '/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000099999', refrncNm: '02-123-4567',
});
assert.equal(bz.서비스ID, 'PBLN_000000000099999');
assert.equal(bz.사용자구분, '소상공인');
assert.equal(bz.신청기한, '2026-10-01 ~ 2026-12-31');
assert.equal(bz.서비스목적요약, '키오스크·테이블오더 도입비 최대 500만원 지원');
assert.equal(bz.상세조회URL, 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000099999');
assert.equal(bz.지역, '서울'); assert.equal(bz.수정일시, '2026-09-30');
assert.equal(statusOf(parseDeadline(bz.신청기한), T), '접수중');
assert.equal(bizinfo.mapRow({ pblancId: 'X', pblancNm: 'AI 기술개발 R&D 지원', pldirSportRealmLclasCodeNm: '기술' }), null, '기술 분야는 제외');
assert.equal(bizinfo.mapRow({ pblancId: 'X', pblancNm: '시제품 제작 지원', pldirSportRealmLclasCodeNm: '경영' }), null, '시제품은 이름 제외');
const ks = kstartup.mapRow({
  pbanc_sn: '174052', biz_pbanc_nm: '2026년 예비창업패키지 (일반) 예비창업자 모집', pbanc_ctnt: '사업화 자금 최대 1억원', supt_biz_clsfc: '사업화',
  aply_trgt: '예비창업자', aply_trgt_ctnt: '공고일 기준 사업자등록이 없는 예비창업자', aply_excl_trgt_ctnt: '폐업 경험자 중 채무불이행', biz_enyy: '예비창업자',
  supt_regin: '전국', pbanc_rcpt_bgng_dt: '20261001', pbanc_rcpt_end_dt: '20261120', pbanc_ntrp_nm: '창업진흥원', rcrt_prgs_yn: 'Y',
  detl_pg_url: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=174052', prch_cnpl_no: '1357',
}, T);
assert.equal(ks.서비스ID, 'KS_174052');
assert.equal(ks.신청기한, '2026-10-01 ~ 2026-11-20');
assert.ok(ks.지원대상.includes('예비창업자') && ks.선정기준.startsWith('제외 대상:'));
assert.equal(ks.서비스분야, '고용·창업'); assert.equal(ks.지역, '전국');
assert.equal(kstartup.mapRow({ pbanc_sn: '1', biz_pbanc_nm: 'x', rcrt_prgs_yn: 'N' }, T), null, '모집 종료는 제외');
assert.equal(kstartup.mapRow({ pbanc_sn: '2', biz_pbanc_nm: 'x', pbanc_rcpt_end_dt: '20260101' }, T), null, '마감 지난 건 제외');
assert.equal(kstartup.mapRow({ pbanc_sn: '3', biz_pbanc_nm: '딥테크 팁스 모집' }, T), null, '딥테크·팁스 제외');
// 실제 응답에서 확인된 특이점: URL 엔티티 중복(&amp;amp;), 전화번호 하이픈 없음, 연령 전체 나열, 접수방법 aply_mthd_*
const { formatPhone, decodeEntities } = await import('./lib/http.js');
assert.equal(decodeEntities('a?x=1&amp;amp;y=2&amp;z=3'), 'a?x=1&y=2&z=3');
assert.equal(formatPhone('0428629583'), '042-862-9583'); assert.equal(formatPhone('021234567'), '02-123-4567'); assert.equal(formatPhone('1357'), '1357'); assert.equal(formatPhone('041-404-1332'), '041-404-1332');
const bz2 = bizinfo.mapRow({ pblancId: 'PBLN_000000000127088', pblancNm: '[충남] 2026년 디지털콘텐츠 제작지원 모집 공고', pldirSportRealmLclasCodeNm: '내수', trgetNm: '소상공인', hashtags: '내수,경영,충남,2026',
  reqstBeginEndDe: '2026-10-01 ~ 2026-10-23', creatPnttm: '2026-10-08 14:07:33', updtPnttm: '2026-10-08 15:22:02', rceptEngnHmpgUrl: 'https://fanfandaero.kr/x.do?a=1&amp;amp;b=2',
  bsnsSumryCn: '<p>충남경제진흥원에서는 도내 소상공인을 대상으로 모집합니다.</p><p><br></p><p>☞ 온라인 판매 희망 소상공인</p>' });
assert.equal(bz2.온라인신청사이트URL, 'https://fanfandaero.kr/x.do?a=1&b=2');
assert.equal(bz2.서비스목적요약, '충남경제진흥원에서는 도내 소상공인을 대상으로 모집합니다.');
assert.ok(bz2.지원내용.includes('☞ 온라인 판매 희망 소상공인'));
assert.equal(bz2.지역, '충남'); assert.equal(bz2.수정일시, '2026-10-08'); assert.equal(bz2.신청기한, '2026-10-01 ~ 2026-10-23');
const ks2 = kstartup.mapRow({ pbanc_sn: '179466', biz_pbanc_nm: '2026년 전북 초기창업 참가기업 모집', pbanc_ntrp_nm: '(주)로우파트너스', sprv_inst: '민간', prch_cnpl_no: '0428629583',
  biz_trgt_age: '만 20세 미만,만 20세 이상 ~ 만 39세 이하,만 40세 이상', aply_mthd_onli_rcpt_istc: 'https://forms.example/1', biz_aply_url: null, rcrt_prgs_yn: 'Y', pbanc_rcpt_end_dt: '20261020', id: 1 }, T);
assert.equal(ks2.서비스ID, 'KS_179466'); assert.equal(ks2.소관기관명, '(주)로우파트너스'); assert.equal(ks2.문의처, '042-862-9583');
assert.ok(!ks2.지원대상.includes('연령'), '전 연령 나열은 생략'); assert.equal(ks2.온라인신청사이트URL, 'https://forms.example/1'); assert.equal(ks2.신청방법, '온라인: https://forms.example/1');
console.log('✓ 어댑터 테스트 통과');
console.log('✓ 테스트 통과');
