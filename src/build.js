// ─────────────────────────────────────────────────────────────
// 3단계: 사이트 생성
//   data/items.json → site/ (index.html + s/<id>.html + assets + data.json)
//   - 마감된 공고는 목록에서 빠지고, keepExpiredDays 동안은 상세 페이지만 "마감" 표시로 유지
//   - AI 요약이 없는 공고는 원문 필드로 대체 표시 (사이트는 항상 뜸)
// 사용: node src/build.js
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { ruleRegion, ruleSupportTypes, ruleTargets, ruleMaxAmount } from './lib/classify.js';
import { legalPages } from './site/legal.js';
import { ROOT, SITE_DIR, loadItems, todayKST, fmtDateKo, daysBetween, esc, log } from './lib/util.js';

const { site, taxonomy, filter, sources: SRC } = config;
const srcLabel = (s) => SRC[s]?.label ?? '정부24';
// 공지사항: 저장소 루트의 notice.md (주석 빼고 비어 있으면 안 띄움). 첫 줄 "# 제목", 빈 줄로 문단, [글자](주소)·맨주소는 링크
function renderNotice() {
  let md = '';
  try { md = fs.readFileSync(path.join(ROOT, 'notice.md'), 'utf8'); } catch { return ''; }
  const text = md.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const title = /^#\s+/.test(lines[0]) ? lines.shift().replace(/^#\s+/, '').trim() : '';
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const paras = lines.join('\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${inline(p).replace(/\n/g, '<br>')}</p>`);
  return `<section class="notice"><span class="nlabel">공지</span><div class="nbody">${title ? `<b>${esc(title)}</b>` : ''}${paras.join('')}</div></section>`;
}

// 문의 창구 링크 (카페 문의·신고 게시판)
const contactUrl = site.contact?.url || site.cafeUrl;
const contactLink = `<a href="${esc(contactUrl)}" target="_blank" rel="noopener">${esc(site.cafeName)} 카페 ${esc(site.contact?.name ?? '')}</a>`.replace(/\s+<\/a>/, '</a>');
const contactNote = String(site.contact?.note ?? '').split('{link}').map(esc).join(contactLink);
// 브랜드 이미지(캐릭터·배너): src/site/brand/ 에 파일이 있을 때만 씀
const BRAND_DIR = path.join(ROOT, 'src', 'site', 'brand');
const brandAsset = (name) => (name && fs.existsSync(path.join(BRAND_DIR, name))) ? `assets/brand/${name}` : null;
const logoImg = brandAsset(site.brand?.logo);
const bannerImg = brandAsset(site.brand?.banner);
const bannerMobileImg = brandAsset(site.brand?.bannerMobile);
const today = todayKST();
const items = Object.values(loadItems());
if (!items.length) { console.error('✖ data/items.json 이 비어 있어요. 먼저 node src/collect.js (또는 --sample)'); process.exit(1); }
// "새 공고" = 처음 수집한 날 이후에 새로 나타난 것 (첫 수집일엔 전부 새것이라 의미가 없으니 제외)
const importDay = items.reduce((m, it) => (it.firstSeen < m ? it.firstSeen : m), today);

// AI가 "대체인력 월 50만원 / 아이돌봄 최대 50만원"처럼 길게 쓰면 목록이 깨지므로 "최대 N원" 꼴만 남긴다
function shortAmount(v) {
  if (!v) return null;
  const m = String(v).match(/(최대|최고|한도)\s*([0-9][0-9,.]*\s*(억|천만|백만|만)?\s*원)/);
  if (m) return `최대 ${m[2].replace(/\s+/g, '')}`;
  const n = String(v).match(/[0-9][0-9,.]*\s*(억|천만|백만|만)?\s*원/);
  return n ? `최대 ${n[0].replace(/\s+/g, '')}` : null;
}

// ── 표시용 모델 (AI 요약 우선, 없으면 규칙/원문 fallback) ──
function present(it) {
  const s = it.src, ai = it.ai && it.ai.relevant !== false ? it.ai : null;
  const ymd = (v) => (v && /^\d{8}/.test(v)) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : (v || '');
  return {
    id: it.id,
    url: `s/${it.id}.html`,
    status: it.status, deadline: it.deadline, start: it.start,
    title: ai?.easy_title || s.서비스명,
    summary: ai?.summary || s.서비스목적요약 || s.서비스목적 || '',
    who: ai?.who || s.지원대상 || '',
    what: ai?.what || s.지원내용 || '',
    amount: shortAmount(ai ? ai.max_amount : ruleMaxAmount(s)),
    checklist: ai?.checklist?.length ? ai.checklist : (s.선정기준 ? [{ kind: '필수', text: s.선정기준 }] : []),
    cautions: ai?.cautions ?? [],
    targets: ai?.targets?.length ? ai.targets : ruleTargets(s),
    types: ai?.support_types?.length ? ai.support_types : ruleSupportTypes(s),
    region: ai?.region || ruleRegion(s),
    org: [s.소관기관명, s.접수기관명 || s.접수기관].filter(Boolean).join(' · '),
    updated: ymd(s.수정일시) || it.lastSeen,
    source: it.source ?? 'gov24',
    sourceLabel: srcLabel(it.source ?? 'gov24'),
    isNew: it.firstSeen > importDay && daysBetween(it.firstSeen, today) <= 7,
    aiModel: ai?.model ?? null,
    irrelevant: it.gate?.relevant === false || it.ai?.relevant === false, // 게이트나 요약 AI가 "사장님과 무관" 판정 → 숨김
    links: it.links || null,
    src: s,
    sample: !!it.sample,
  };
}

const all = items.filter((it) => !it.removed).map(present).filter((p) => !p.irrelevant);
const visible = all.filter((p) => p.status !== '마감');
// 첫 화면 기본값: 사장님 대상(소상공인·예비창업자·폐업·재창업)만. 스타트업·중소기업 전용은 칩을 눌러야 보임 (app.js 와 같은 규칙)
const CORE = ['소상공인', '예비창업자', '폐업·재창업'];
const core = visible.filter((p) => p.targets.some((t) => CORE.includes(t)));
const expiredKeep = all.filter((p) => p.status === '마감' && p.deadline && daysBetween(p.deadline, today) <= filter.keepExpiredDays);
const isSample = all.some((p) => p.sample);
const collectedAt = items.reduce((m, it) => (it.lastSeen > m ? it.lastSeen : m), '');
// 실제로 데이터가 있는 소스만 출처로 표기 (config 순서대로)
const usedSources = Object.keys(SRC).filter((s) => all.some((p) => p.source === s));
const sourceLabels = usedSources.map((s) => SRC[s].label).join('·') || '정부24';
const sourceNames = usedSources.map((s) => `${SRC[s].label}(${SRC[s].org})`).join(', ') || '정부24(행정안전부)';

// ── 공통 레이아웃 ──
const FONT = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">';
function layout({ title, description, body, rel = '', canonical = '', scripts = '' }) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:locale" content="ko_KR">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
${FONT}
<link rel="stylesheet" href="${rel}assets/style.css">
</head>
<body>
<header class="header"><div class="wrap">
  <a class="logo" href="${rel}index.html">${logoImg ? `<img class="brandimg" src="${rel}${logoImg}" alt="">` : '<span class="mark">만</span>'}<span class="brandname">${esc(site.name)}</span></a>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="footer"><div class="wrap">
  <b>이 사이트에 대해</b><br>
  ${esc(site.name)}은 ${esc(site.cafeName)} 카페가 회원 사장님들을 위해 운영하는 안내 페이지입니다. 공고 데이터는 ${esc(sourceNames)}의 공공데이터(이용 제한 없음)를 매일 자동으로 받아오고, 요약과 체크리스트는 AI가 작성한 뒤 숫자를 원문과 대조합니다. 그래도 틀린 부분이 있을 수 있으니 신청 자격·금액·기한은 각 페이지의 <b>공고 원문</b>과 <b>접수 기관</b>에서 마지막으로 확인해 주세요. ${contactNote}
  <div class="links"><a href="${rel}terms.html">이용약관</a> · <a href="${rel}privacy.html">개인정보처리방침</a> · <a href="${esc(site.cafeUrl)}" target="_blank" rel="noopener">${esc(site.cafeName)} 카페</a> · <span>출처: ${esc(sourceNames)}</span></div>
  <div style="margin-top:10px">© ${today.slice(0, 4)} ${esc(site.name)}</div>
</div></footer>
${scripts}
</body>
</html>`;
}

// ── 목록 페이지 ──
function indexPage() {
  const n = (f) => core.filter(f).length;
  const stats = [
    ['open', 'green', n((p) => p.status === '접수중' || p.status === '마감임박'), '접수 중'],
    ['soon', 'orange', n((p) => p.status === '마감임박'), '마감 임박 (7일 이내)'],
    ['always', 'blue', n((p) => p.status === '상시'), '상시 접수'],
    ['check', 'purple', n((p) => p.status === '공고별'), '기한은 공고 확인'],
  ].map(([k, c, v, l]) => `<button class="stat ${c}" data-stat="${k}"><div class="n">${v}</div><div class="l">${l}</div></button>`).join('');

  const data = {
    collectedAt, taxonomy, core: CORE,
    items: visible.map(({ src, checklist, cautions, who, what, ...rest }) => rest),
  };
  const cb = site.cafeBanner ?? {};
  const banner = `
<section class="cafeband">
  <a class="cafeband-link" href="${esc(site.cafeUrl)}" target="_blank" rel="noopener" aria-label="${esc(site.cafeName)} 카페 바로가기">
    ${bannerImg
      ? `<picture>${bannerMobileImg ? `<source media="(max-width: 560px)" srcset="${bannerMobileImg}">` : ''}<img src="${bannerImg}" alt="${esc(cb.title ?? site.cafeName)}"></picture>`
      : `<div class="cafeband-text">${logoImg ? `<img class="cafeband-emblem-img" src="${logoImg}" alt="">` : '<div class="cafeband-emblem">만</div>'}<div><b>${esc(cb.title ?? site.cafeName)}</b><p>${esc(cb.text ?? '')}</p></div></div>`}
    <span class="cafeband-btn">${esc(cb.button ?? '카페 바로가기')} →</span>
  </a>
</section>`;
  const body = `
${banner}
${renderNotice()}
<section class="hero compact">
  <div><h1>전국 소상공인 지원사업, 한눈에</h1><p>${esc(site.tagline)}</p></div>
  <div class="meta"><span>공고 수집 ${esc(fmtDateKo(collectedAt))}</span><span>사장님 대상 ${core.length}건</span><span>출처 ${esc(sourceLabels)}</span></div>
</section>
${isSample ? '<div class="sample-banner">지금 보이는 건 샘플 데이터예요. 정부24 API 키를 .env 에 넣고 다시 수집하면 실제 공고로 바뀝니다.</div>' : ''}
<section class="stats">${stats}</section>
<section class="card filters">
  <div class="fgroup"><div class="ft">대상</div><div class="chips" id="f-target"></div></div>
  <div class="fgroup"><div class="ft">지역</div><div class="chips" id="f-region"></div></div>
  <div class="fgroup"><div class="ft">지원 내용</div><div class="chips" id="f-type"></div></div>
  <form class="search" id="search-form"><input id="q" type="search" placeholder="공고명, 키워드로 검색 (예: 키오스크, 노란우산, 청년)"><button type="submit">검색</button><button type="button" class="ghost" id="reset">초기화</button></form>
</section>
<div class="listhead"><h2>지원사업 목록 <small id="count"></small></h2><div class="sort"><button data-sort="deadline">마감 임박순</button><button data-sort="new">최신순</button></div></div>
<section id="grid"></section>
<button class="more" id="more" hidden>더 보기</button>
<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
  return layout({ title: `${site.name} | 소상공인 지원사업 한눈에 보기`, description: site.description, body, canonical: site.url ? `${site.url}/` : '', scripts: '<script src="assets/app.js"></script>' });
}

// ── 상세 페이지 ──
//   왼쪽: 나한테 해당될까?(체크박스) → 어떤 지원인가요? → 꼭 알아둘 것 → 신청 준비물 → 원문 그대로 보기(접이식)
//   오른쪽(고정): 핵심 정보 패널 — 금액·접수기간·지역·접수처·전화·버튼.  폰에서는 패널이 맨 위로.
const STATUS_LABEL = { 접수중: '접수 중', 마감임박: '마감 임박', 상시: '상시 접수', 예정: '접수 예정', 공고별: '공고 확인', 마감: '마감' };
const KIND_LABEL = { 필수: '꼭 필요', 택1: '하나만 되면 OK', 가점: '있으면 유리', 제외: '해당되면 불가' };
function detailPage(p) {
  const s = p.src;
  const docs = (s.구비서류 ?? '').split(/[,\n·•]/).map((x) => x.trim()).filter(Boolean);
  // 문의처 원문 예: "중소기업통합콜센터/1357||소상공인시장진흥공단 통합콜센터/1533-0100" → 줄마다 "이름 번호"
  const phoneLines = [...new Set([s.문의처, s.전화문의].filter(Boolean).flatMap((v) => v.split(/\|\||\n/)).map((v) => v.replace(/\s*\/\s*/g, ' ').trim()).filter(Boolean))]
    .filter((v, i, a) => !a.slice(0, i).some((p) => p.includes(v)));
  const tel = (t) => esc(t).replace(/(\d{2,4}-\d{3,4}-\d{4}|\b1\d{3}(?:-\d{4})?\b)/g, '<a href="tel:$1">$1</a>');
  // 링크 점검 결과 (checklinks.js): 죽은 링크 버튼은 숨기고 안내
  const L = p.links || {};
  const applyOk = s.온라인신청사이트URL && L.apply !== 'dead';
  const detailOk = s.상세조회URL && L.detail !== 'dead';
  const applyUrl = applyOk ? s.온라인신청사이트URL : (detailOk ? s.상세조회URL : null);
  const linkNote = (L.apply === 'dead' || L.detail === 'dead')
    ? `<p class="linknote">${L.apply === 'dead' ? '신청 페이지 링크가 지금 안 열려요. ' : ''}${L.detail === 'dead' ? `${p.sourceLabel}에서 이 공고 페이지가 내려간 것 같아요. ` : ''}전화로 접수처에 확인해 보세요.</p>` : '';
  const periodRaw = s.신청기한 || '';
  const periodMain = p.deadline ? `${fmtDateKo(p.deadline)} 마감` : p.status === '상시' ? '상시 접수' : p.status === '예정' ? `${fmtDateKo(p.start)} 시작` : '개별 공고 확인';

  // ── 체크리스트: 종류별로 묶어서 체크박스로 ──
  const groups = [['필수', '아래는 전부 해당돼야 해요'], ['택1', '아래 중 하나만 해당되면 돼요'], ['가점', '있으면 유리해요'], ['제외', '하나라도 해당되면 신청이 안 돼요']];
  const checklistHtml = p.checklist.length ? groups.map(([kind, hint]) => {
    const rows = p.checklist.filter((c) => c.kind === kind);
    if (!rows.length) return '';
    return `<div class="cgroup" data-kind="${kind}"><div class="chint"><span class="kind ${kind}">${KIND_LABEL[kind]}</span>${hint}</div>
      ${rows.map((c, i) => `<label class="citem"><input type="checkbox" data-kind="${kind}"><span>${esc(c.text)}</span></label>`).join('')}</div>`;
  }).join('') + `<div class="verdict" id="verdict">해당되는 항목에 체크해 보세요.</div><p class="note">AI가 공고를 읽고 만든 참고용 체크리스트예요. 최종 자격은 접수처에서 확인해 주세요.</p>` : '';

  const sections = [];
  if (checklistHtml) sections.push(`<section class="card sec"><h2>나한테 해당될까?</h2>${checklistHtml}</section>`);

  sections.push(`<section class="card sec"><h2>어떤 지원인가요?</h2>
    <div class="qa"><b>누가</b><p>${esc(p.who)}</p></div>
    <div class="qa"><b>무엇을</b><p>${esc(p.what)}</p></div></section>`);

  if (p.cautions.length) sections.push(`<section class="card sec warn"><h2>꼭 알아둘 것</h2><ul class="plain">${p.cautions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>`);

  if (s.신청방법 || docs.length) sections.push(`<section class="card sec"><h2>신청 준비물</h2>
    ${s.신청방법 ? `<div class="qa"><b>방법</b><p class="pre">${esc(s.신청방법)}</p></div>` : ''}
    ${docs.length ? `<div class="qa"><b>서류</b><ul class="plain">${docs.map((d) => `<li>${esc(d)}</li>`).join('')}</ul><p class="note">정확한 제출서류는 공고 원문·첨부파일 기준이에요.</p></div>` : ''}</section>`);

  const raw = [['지원대상', s.지원대상], ['선정기준', s.선정기준], ['지원내용', s.지원내용], ['신청기한', s.신청기한], ['구비서류', s.구비서류]].filter(([, v]) => v);
  sections.push(`<details class="card sec raw"><summary>공고 원문 그대로 보기 <small>${esc(p.sourceLabel)}에 등록된 문구</small></summary>
    ${raw.map(([k, v]) => `<div class="qa"><b>${k}</b><p class="pre">${esc(v)}</p></div>`).join('')}</details>`);

  // ── 핵심 정보 패널 ──
  const side = `<aside class="dside"><div class="keybox">
    ${p.amount ? `<div class="kv2 amt"><span>지원 금액</span><b>${esc(p.amount)}</b></div>` : ''}
    <div class="kv2"><span>접수</span><b class="st-${p.status}">${esc(periodMain)}</b>${periodRaw && periodRaw !== periodMain ? `<small>${esc(periodRaw)}</small>` : ''}</div>
    <div class="kv2"><span>지역</span><b>${esc(p.region)}</b></div>
    ${s.접수기관명 || s.접수기관 ? `<div class="kv2"><span>접수처</span><b>${esc(s.접수기관명 || s.접수기관)}</b></div>` : ''}
    ${s.소관기관명 ? `<div class="kv2"><span>주관</span><b>${esc(s.소관기관명)}${s.부서명 ? `<small>${esc(s.부서명)}</small>` : ''}</b></div>` : ''}
    ${phoneLines.length ? `<div class="kv2"><span>전화</span><b>${phoneLines.map(tel).join('<br>')}</b></div>` : ''}
    ${applyUrl ? `<a class="cta" href="${esc(applyUrl)}" target="_blank" rel="noopener">${applyOk ? '신청 페이지로 가기' : `${esc(p.sourceLabel)}에서 보기`} →</a>` : ''}
    ${applyOk && detailOk ? `<a class="cta ghost" href="${esc(s.상세조회URL)}" target="_blank" rel="noopener">${esc(p.sourceLabel)} 원문</a>` : ''}
    ${linkNote}
    <p class="source">출처 ${esc(p.sourceLabel)} · ${esc(p.updated)} 기준${p.aiModel ? ' · 요약은 AI 작성' : ''}</p>
  </div></aside>`;

  const body = `
<nav class="crumb"><a href="../index.html">전체 공고</a> › <a href="../index.html#내용=${encodeURIComponent(p.types[0])}">${esc(p.types[0])}</a></nav>
<article class="detail">
  ${p.status === '마감' ? `<div class="expired">이 공고는 ${esc(fmtDateKo(p.deadline))}에 접수가 끝났어요. 비슷한 공고는 <a href="../index.html">전체 목록</a>에서 찾아보세요.</div>` : ''}
  <header class="dhead">
    <span class="badge ${p.status}">${STATUS_LABEL[p.status]}</span>
    <h1>${esc(p.title)}</h1>
    <p class="lead">${esc(p.summary)}</p>
    <div class="tags">${[...p.targets.map((t) => `<span class="tag">${esc(t)}</span>`), ...p.types.map((t) => `<span class="tag t2">${esc(t)}</span>`)].join('')}</div>
  </header>
  <div class="dgrid">
    <div class="dmain">${sections.join('\n')}</div>
    ${side}
  </div>
</article>`;
  const script = `<script>
(function(){var boxes=[].slice.call(document.querySelectorAll('.citem input'));var v=document.getElementById('verdict');if(!boxes.length||!v)return;
function run(){var on=function(k){return boxes.filter(function(b){return b.dataset.kind===k});};
var must=on('필수'),one=on('택1'),bad=on('제외');var mOk=must.filter(function(b){return b.checked}).length,oOk=one.some(function(b){return b.checked}),bOn=bad.filter(function(b){return b.checked}).length;
var any=boxes.some(function(b){return b.checked});
if(!any){v.className='verdict';v.textContent='해당되는 항목에 체크해 보세요.';return;}
if(bOn){v.className='verdict no';v.textContent='제외 조건에 해당돼요. 이 공고는 어려울 것 같아요.';return;}
var miss=[];if(must.length&&mOk<must.length)miss.push('꼭 필요한 조건 '+(must.length-mOk)+'개');if(one.length&&!oOk)miss.push('택1 조건');
if(miss.length){v.className='verdict mid';v.textContent='아직 '+miss.join(', ')+'가 남았어요.';return;}
v.className='verdict ok';v.textContent='조건이 맞아 보여요. 접수처에 한 번 확인하고 신청해 보세요.';}
boxes.forEach(function(b){b.addEventListener('change',run)});})();
</script>`;
  const desc = `${p.summary}${p.amount ? ` ${p.amount}.` : ''}${p.deadline ? ` ${fmtDateKo(p.deadline)} 마감.` : ''}`.slice(0, 150);
  return layout({ title: `${p.title} | ${site.name}`, description: desc, body, rel: '../', canonical: site.url ? `${site.url}/${p.url}` : '', scripts: script });
}

// ── 쓰기 ──
// 상세 페이지 폴더: 통째로 지우지 않고(환경에 따라 삭제가 막혀 있을 수 있음) 이번에 안 만드는 파일만 치운다
fs.mkdirSync(path.join(SITE_DIR, 's'), { recursive: true });
const keep = new Set([...visible, ...expiredKeep].map((p) => `${p.id}.html`));
for (const f of fs.readdirSync(path.join(SITE_DIR, 's'))) {
  if (!keep.has(f)) { try { fs.unlinkSync(path.join(SITE_DIR, 's', f)); } catch { /* 삭제 불가 환경이면 그냥 둠 */ } }
}
fs.mkdirSync(path.join(SITE_DIR, 'assets'), { recursive: true });
for (const f of ['style.css', 'app.js']) fs.copyFileSync(path.join(ROOT, 'src', 'site', f), path.join(SITE_DIR, 'assets', f));
if (fs.existsSync(BRAND_DIR)) {
  fs.mkdirSync(path.join(SITE_DIR, 'assets', 'brand'), { recursive: true });
  for (const f of fs.readdirSync(BRAND_DIR)) if (/\.(png|jpe?g|svg|webp|gif)$/i.test(f)) fs.copyFileSync(path.join(BRAND_DIR, f), path.join(SITE_DIR, 'assets', 'brand', f));
}
const legal = legalPages({ site, sourceNames, today });
for (const pg of legal) fs.writeFileSync(path.join(SITE_DIR, pg.file), layout({ title: `${pg.title} | ${site.name}`, description: pg.description, body: `<article class="card legal">${pg.body}</article>`, canonical: site.url ? `${site.url}/${pg.file}` : '' }), 'utf8');
fs.writeFileSync(path.join(SITE_DIR, 'index.html'), indexPage(), 'utf8');
for (const p of [...visible, ...expiredKeep]) fs.writeFileSync(path.join(SITE_DIR, 's', `${p.id}.html`), detailPage(p), 'utf8');
fs.writeFileSync(path.join(SITE_DIR, 'data.json'), JSON.stringify({ collectedAt, items: visible.map(({ src, ...rest }) => rest) }, null, 2), 'utf8');
fs.writeFileSync(path.join(SITE_DIR, 'robots.txt'), `User-agent: *\nAllow: /\n${site.url ? `Sitemap: ${site.url}/sitemap.xml\n` : ''}`, 'utf8');
if (site.url) {
  const urls = ['', ...legal.map((pg) => pg.file), ...visible.map((p) => p.url)].map((u) => `<url><loc>${esc(site.url)}/${u}</loc><lastmod>${today}</lastmod></url>`).join('\n');
  fs.writeFileSync(path.join(SITE_DIR, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, 'utf8');
}
fs.writeFileSync(path.join(SITE_DIR, '.nojekyll'), '', 'utf8');

log(`사이트 생성 완료 → site/  (목록 ${visible.length}건, 마감 유지 ${expiredKeep.length}건, AI 요약 ${visible.filter((p) => p.aiModel).length}건)`);
