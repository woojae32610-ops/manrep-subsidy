// AI 요약 프롬프트 + 출력 스키마
import config from '../../config.js';

const { targets, supportTypes, regions } = config.taxonomy;

export const SYSTEM_PROMPT = `당신은 대한민국 소상공인·자영업자 커뮤니티 "${config.site.cafeName}"를 위해 정부 지원사업 공고를 사장님 눈높이로 다시 쓰는 편집자입니다.

지켜야 할 원칙:
1. 원문에 없는 내용은 절대 만들지 않습니다. 금액·기간·비율·나이·매출 기준 같은 숫자는 원문에 있는 것만 쓰고, 원문에 없으면 쓰지 않거나 null로 둡니다. 추측·일반상식으로 채우지 않습니다.
2. 사장님이 바쁜 와중에 읽는다고 생각하고 짧고 쉬운 말로 씁니다. 공문체("~에 대하여", "~을 실시", "~를 도모")는 쓰지 않습니다. 존댓말("~입니다", "~있어요")을 씁니다.
3. checklist는 "내가 해당되나?"를 한 줄씩 바로 판단할 수 있게 씁니다. kind는 필수(반드시 충족) / 택1(여러 조건 중 하나만 해당하면 됨 — 그 조건들 각각에 택1을 붙임) / 가점(있으면 유리) / 제외(해당되면 신청 불가)로 나눕니다. "아래 중 하나" 같은 안내 문장은 항목으로 넣지 말고 택1로 표시합니다. 원문에 근거가 있는 항목만 넣습니다.
4. cautions는 사장님이 놓치기 쉬운 것만, 중요한 순으로 최대 5개: 자부담 비율, 중복 수혜 제한, 선착순·예산 소진, 사업자등록 요건, 지역 제한, 대출의 경우 상환 조건 등. 없으면 빈 배열.
5. relevant: 소상공인·자영업자·예비창업자·폐업(예정)자·소규모 기업이 사업자로서 신청할 수 있으면 true. 개인 복지(아동수당, 급식비 등), 구직자 개인 대상, 농어업 전용, 대기업·공공기관 내부 사업, 단순 민원 안내, 이미 종료되었거나 "신규 지원 없음"인 공고면 false.
6. 분류(targets, support_types, region)는 주어진 목록에서만 고릅니다. region은 [지역] 필드가 있으면 그것을, 없으면 소관기관과 대상 지역을 보고 정하고, 중앙부처·전국 단위면 "전국"입니다.
7. max_amount는 원문에 지원 상한이 숫자로 명시된 경우에만 "최대 1,000만원"처럼 짧게 씁니다. 융자(대출)라면 대출 한도를 씁니다. 여러 유형이 있으면 가장 큰 한도 하나만 씁니다. 없으면 null.
8. easy_title은 원래 이름을 유지하되, 너무 행정적이면 괄호로 짧은 설명을 덧붙입니다. 예: "희망리턴패키지 (폐업·재기 지원)".`;

export function buildUserPrompt(src) {
  const f = (k) => (src[k] ? `[${k}]\n${src[k]}\n` : '');
  // 사용자구분·서비스분야는 정부24 고유 필드. 기업마당·K-Startup 은 규칙 필터용으로 채워 넣은 값이라 AI에게는 안 보여준다
  const g = (k) => (src.출처 ? '' : f(k));
  return [
    '다음 공고를 원칙에 따라 정리해 주세요.\n',
    f('출처'), f('서비스명'), f('서비스목적요약'), f('서비스목적'), f('지원대상'), f('선정기준'),
    f('지원내용'), f('지원유형'), f('신청기한'), f('신청방법'), f('구비서류'),
    f('접수기관명'), f('접수기관'), f('소관기관명'), f('부서명'), f('문의처'), f('전화문의'),
    g('사용자구분'), g('서비스분야'), f('지역'),
  ].join('\n');
}

// ── 1단계 게이트 (싼 모델): 사장님에게 해당되는 공고인지만 판정 ──
export const GATE_SYSTEM = `당신은 소상공인·자영업자 커뮤니티 운영자를 돕는 분류기입니다. 정부 공공서비스 공고 하나를 보고, 이 커뮤니티 회원(가게·식당·카페·소매점·온라인몰 등을 운영하는 사장님, 예비창업자, 폐업했거나 폐업 예정인 사장님, 소규모 기업 대표)이 사업자로서 신청할 수 있는 공고인지 판정합니다.

relevant = true: 소상공인·자영업자·예비창업자·폐업(예정)자·소기업·중소기업·스타트업이 사업 목적으로 신청 가능한 지원(자금, 시설, 고용, 판로, 교육, 공제, 세금, 재난 등).
relevant = false: 개인 생활 복지(수당, 장학, 의료, 돌봄, 주거), 구직자·근로자 개인 대상(취업수당, 직업훈련, 내일배움카드), 농어민 전용, 대기업·연구기관·공공기관 내부 사업, 지역화폐 소비자 안내, 이미 종료되었거나 "신규 지원 없음"·과거 연도만 적힌 공고.
애매하면 true (뒤 단계에서 다시 봅니다). reason 은 40자 이내 한 문장 (예: "개인 구직자 대상 면접수당", "소상공인 운전자금 융자").`;

export function buildGatePrompt(src) {
  const cut = (s, n) => String(s ?? '').slice(0, n);
  const meta = src.출처 ? `[출처] ${src.출처}` : `[서비스분야] ${src.서비스분야 ?? ''}  [사용자구분] ${src.사용자구분 ?? ''}`;
  return `[서비스명] ${src.서비스명}
${meta}  [소관기관] ${src.소관기관명 ?? ''}  [지역] ${src.지역 ?? ''}
[요약] ${cut(src.서비스목적요약, 300)}
[지원대상] ${cut(src.지원대상, 400)}
[지원내용] ${cut(src.지원내용, 400)}
[신청기한] ${cut(src.신청기한, 100)}`;
}

export const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['relevant', 'reason'],
  properties: {
    relevant: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

// ── 2단계 요약 출력 스키마 ──
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['relevant', 'easy_title', 'summary', 'who', 'what', 'max_amount', 'checklist', 'cautions', 'targets', 'support_types', 'region', 'confidence'],
  properties: {
    relevant: { type: 'boolean', description: '소상공인·자영업자·예비창업자에게 실질적으로 해당하는 공고인지' },
    easy_title: { type: 'string', description: '사장님용 제목 (원래 이름 유지, 필요시 괄호 설명)' },
    summary: { type: 'string', description: '이 공고가 뭔지 1~2문장, 쉬운 말' },
    who: { type: 'string', description: '누가 받을 수 있는지 1~2문장' },
    what: { type: 'string', description: '무엇을 얼마나 지원하는지 1~2문장' },
    max_amount: { type: ['string', 'null'], description: '원문에 명시된 지원 상한. 예: "최대 1,000만원". 없으면 null' },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: ['필수', '택1', '가점', '제외'] },
          text: { type: 'string' },
        },
      },
    },
    cautions: { type: 'array', items: { type: 'string' } },
    targets: { type: 'array', items: { type: 'string', enum: targets } },
    support_types: { type: 'array', items: { type: 'string', enum: supportTypes } },
    region: { type: 'string', enum: regions },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '원문이 모호하거나 정보가 부족하면 low' },
  },
};
