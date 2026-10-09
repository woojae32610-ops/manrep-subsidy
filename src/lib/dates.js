// 신청기한 문자열 → 마감일(YYYY-MM-DD) / 상시 여부 판정
// 실제 정부24 신청기한 예 (data/field-report.md):
//   "2026.2.2.~2026.11.30. (예산 소진 시 발급 마감)", "(1차) '25.2.24.~3.7. (2차) '25.7.10.~7.18.",
//   "(3분기) 2026.6.30.(화)~7.15.(수) / (4분기) 2026.8.31.(월)~9.15.(화)", "2026-10-14까지",
//   "상시", "연중신청가능", "예산 소진 시까지", "사업공고에 따름", "별도 공고기한내", "5~6월", "상반기"
// 원칙: 문장 안의 모든 날짜를 순서대로 읽고, 마지막 날짜를 마감일로. 연도 없는 "7.15." 는 직전 연도를 따른다.

const FULL = /(?:(\d{4})|'(\d{2}))\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?!\d)/g; // 2026.6.30 / '25.2.24 / 2026-10-14 / 2026년 9월 1일
const PART = /(?<![\d.'])(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?![\d.]*\d{4})(?!\d)/g;          // 7.15 (연도 없음)
const ALWAYS_WORDS = ['상시', '연중', '수시', '소진', '제한없음', '상시접수', '연중접수', '상시신청', '언제든'];

function valid(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** @returns {{deadline: string|null, start: string|null, always: boolean}} */
export function parseDeadline(text) {
  const s = String(text ?? '').trim();
  if (!s) return { deadline: null, start: null, always: false };

  // 1) 연도 있는 날짜 전부 (위치 기록)
  const found = [];
  for (const m of s.matchAll(FULL)) {
    const y = m[1] ? Number(m[1]) : 2000 + Number(m[2]);
    const [mo, d] = [Number(m[3]), Number(m[4])];
    if (valid(y, mo, d)) found.push({ at: m.index, end: m.index + m[0].length, y, iso: iso(y, mo, d), full: true });
  }
  // 2) 연도 없는 "M.D" 는 "~" 뒤에 오는 것만, 직전 연도 있는 날짜의 연도를 붙인다
  for (const m of s.matchAll(PART)) {
    const before = s.slice(Math.max(0, m.index - 4), m.index);
    if (!/[~∼〜-]\s*$/.test(before)) continue;
    if (found.some((f) => m.index >= f.at && m.index < f.end)) continue; // 연도 날짜의 일부
    const prev = [...found].filter((f) => f.full && f.at < m.index).pop();
    if (!prev) continue;
    const [mo, d] = [Number(m[1]), Number(m[2])];
    if (valid(prev.y, mo, d)) found.push({ at: m.index, end: m.index + m[0].length, y: prev.y, iso: iso(prev.y, mo, d), full: false });
  }
  found.sort((a, b) => a.at - b.at);

  let deadline = null, start = null;
  if (found.length >= 2) {
    start = found[0].iso;
    deadline = found[found.length - 1].iso;
  } else if (found.length === 1) {
    const only = found[0];
    const after = s.slice(only.end, only.end + 6);
    // "2026.3.1.부터" / "2026.3.1. ~" 처럼 시작만 적힌 경우
    if (/^\s*(부터|이후|~|∼|〜|-)\s*$/.test(after) || /부터|시작|개시/.test(after)) start = only.iso;
    else deadline = only.iso;
  }

  const compact = s.replace(/\s/g, '');
  const always = !deadline && ALWAYS_WORDS.some((w) => compact.includes(w));
  return { deadline, start, always };
}

/** 상태: 접수중 / 마감임박 / 상시 / 마감 / 예정 / 공고별(기한을 알 수 없음 — "사업공고에 따름" 등) */
export function statusOf({ deadline, start, always }, today) {
  if (deadline && deadline < today) return '마감';
  if (start && start > today) return '예정';
  if (deadline) {
    const days = Math.round((Date.parse(deadline) - Date.parse(today)) / 86400000);
    return days <= 7 ? '마감임박' : '접수중';
  }
  return always ? '상시' : '공고별';
}
