// 가벼운 단위 테스트: node src/test.js
import assert from 'node:assert/strict';
import { parseDeadline, statusOf } from './lib/dates.js';
import { verifyNumbers } from './lib/verify.js';

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

console.log('✓ 테스트 통과');
