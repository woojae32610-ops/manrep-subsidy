// AI 요약의 숫자가 전부 원문에 있는지 코드로 대조 (LLM 없이, 결정적으로)
// → 틀린 숫자를 지어낸 경우를 잡아 flags 에 기록. 사람이 그것만 보면 된다.
//
// 실제 돌려보고 잡은 오탐들:
//   - "02-368-8768, 02-368-8769" 처럼 콤마로 이어진 전화번호 → 콤마를 다 지우면 "876802" 가 됨 → 천단위 콤마만 지운다
//   - 원문 "'19년" 을 AI 가 "2019년" 으로 풀어 씀 → '19 → 2019 로 정규화
//   - 원문 "70% 지원" 을 AI 가 "자부담 30%" 로 바꿔 씀 → 100-N 이 원문에 있으면 통과

function norm(s) {
  return String(s ?? '')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')  // 천단위 콤마만 제거: 7,000 → 7000 (전화번호 나열 "8768, 02" 는 유지)
    .replace(/['‘’](\d{2})(?=[.\-/년])/g, '20$1') // '19년 → 2019년, ‘11년 → 2011년, '25.2.24 → 2025.2.24
    .replace(/\s+/g, '')
    .replace(/(\d)천만/g, '$1000만')   // 7천만원 → 7000만원 (AI가 "7,000만원"이라 써도 같게)
    .replace(/(\d)천/g, '$1000')
    .replace(/(\d)백만/g, '$100만')
    .replace(/(\d)백/g, '$100');
}

/** 텍스트에서 숫자 토큰 추출 */
function numbers(s) {
  return [...norm(s).matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

/** 퍼센트 보수: AI 가 "30%" 라 썼고 원문에 "70%" 가 있으면 자부담/지원 비율을 뒤집어 쓴 것 → 허용 */
function isComplementPercent(n, aiText, sourceText) {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0 || v >= 100) return false;
  if (!new RegExp(`${n}\\s*%|${n}퍼센트`).test(aiText.replace(/\s+/g, ''))) return false;
  const c = String(100 - v);
  return new RegExp(`${c}\\s*%|${c}퍼센트`).test(sourceText);
}

/**
 * @param {object} ai  AI 출력 (summary, who, what, max_amount, checklist, cautions)
 * @param {object} src 원문 필드들
 * @returns {string[]} flags
 */
export function verifyNumbers(ai, src) {
  const sourceText = norm(Object.values(src).filter((v) => typeof v === 'string').join(' '));
  const fields = {
    summary: ai.summary, who: ai.who, what: ai.what, max_amount: ai.max_amount,
    checklist: (ai.checklist ?? []).map((c) => c.text).join(' '),
    cautions: (ai.cautions ?? []).join(' '),
  };
  const flags = [];
  for (const [name, text] of Object.entries(fields)) {
    if (!text) continue;
    const missing = [...new Set(numbers(text))]
      .filter((n) => !sourceText.includes(n))
      .filter((n) => !isComplementPercent(n, String(text), sourceText));
    if (missing.length) flags.push(`${name}: 원문에 없는 숫자 ${missing.join(', ')}`);
  }
  return flags;
}
