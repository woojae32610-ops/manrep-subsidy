// 규칙 기반 분류 — AI 요약이 없거나 실패한 항목의 fallback.
// AI 결과가 있으면 그쪽이 우선이고, 여기 결과는 보조로만 쓰인다.
import config from '../../config.js';
import { hasAny } from './util.js';

const { taxonomy } = config;

export function ruleRegion(item) {
  // 기업마당·K-Startup 은 지역 필드가 따로 온다 ("서울", "광주, 전남", "전국")
  const given = String(item.지역 ?? '');
  if (given) { const hit = taxonomy.regions.find((r) => given.includes(r)); if (hit) return hit; }
  const org = `${item.소관기관명 ?? ''} ${item.접수기관명 ?? ''} ${item.접수기관 ?? ''}`;
  for (const [region, words] of Object.entries(taxonomy.regionKeywords)) {
    if (hasAny(org, words)) return region;
  }
  return '전국';
}

// 정부24 지원유형 값 → 우리 분류 (실제 값: 현금, 현물, 현금(융자), 현금(감면), 기타(교육), 기타(상담), 서비스(일자리), 기술지원 ...)
const TYPE_MAP = [
  ['융자', '자금·대출'], ['보증', '자금·대출'], ['감면', '세금·수수료'],
  ['교육', '교육·컨설팅'], ['상담', '교육·컨설팅'], ['일자리', '고용·인건비'],
];
export function ruleSupportTypes(item) {
  const text = `${item.서비스명 ?? ''} ${item.서비스목적요약 ?? ''} ${item.지원내용 ?? ''}`;
  const found = [];
  for (const [word, type] of TYPE_MAP) if ((item.지원유형 ?? '').includes(word)) found.push(type);
  for (const [type, words] of Object.entries(taxonomy.supportKeywords)) {
    if (hasAny(text, words)) found.push(type);
  }
  const uniq = [...new Set(found)];
  return uniq.length ? uniq : ['기타'];
}

export function ruleTargets(item) {
  const text = `${item.서비스명 ?? ''} ${item.지원대상 ?? ''} ${item.서비스목적요약 ?? ''} ${item.사용자구분 ?? ''}`;
  const found = [];
  for (const [target, words] of Object.entries(taxonomy.targetKeywords)) {
    if (hasAny(text, words)) found.push(target);
  }
  // 소상공인은 기본 포함 (이 사이트의 기본 대상)
  if (!found.length || hasAny(text, ['소상공인', '자영업', '사업자', '점포', '상인'])) found.unshift('소상공인');
  return [...new Set(found)];
}

/** 원문에서 "최대 N만원/억원" 류 금액 표현을 찾아 가장 큰 것을 반환 (없으면 null) */
export function ruleMaxAmount(item) {
  const text = `${item.지원내용 ?? ''} ${item.서비스목적요약 ?? ''}`;
  const unit = { '억': 1e8, '천만': 1e7, '백만': 1e6, '만': 1e4, '': 1 };
  let best = null;
  for (const m of text.matchAll(/(?:최대|최고|한도)\s*([0-9][0-9,.]*)\s*(억|천만|백만|만)?\s*원/g)) {
    const value = parseFloat(m[1].replace(/,/g, '')) * (unit[m[2] ?? ''] ?? 1);
    if (!best || value > best.value) best = { value, text: `최대 ${m[1]}${m[2] ?? ''}원` };
  }
  return best ? best.text : null;
}
