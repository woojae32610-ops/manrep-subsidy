/* 목록 페이지 — 필터/검색/정렬/더보기. 데이터는 index.html 에 JSON으로 박혀 있음(파일로 열어도 동작). */
(function () {
  const D = JSON.parse(document.getElementById('data').textContent);
  const items = D.items;
  const TAX = D.taxonomy;
  const PAGE = 12;

  const state = { target: '', region: '', type: '', q: '', sort: 'deadline', stat: '', shown: PAGE };

  // URL 해시 ↔ 상태 (필터 링크 공유용: #지역=서울&내용=자금·대출)
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.target = p.get('대상') || ''; state.region = p.get('지역') || ''; state.type = p.get('내용') || '';
    state.q = p.get('q') || ''; state.sort = p.get('정렬') || 'deadline'; state.stat = p.get('상태') || '';
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.target) p.set('대상', state.target); if (state.region) p.set('지역', state.region);
    if (state.type) p.set('내용', state.type); if (state.q) p.set('q', state.q);
    if (state.sort !== 'deadline') p.set('정렬', state.sort); if (state.stat) p.set('상태', state.stat);
    const h = p.toString();
    history.replaceState(null, '', h ? '#' + h : location.pathname);
  }

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mmdd = (iso) => iso ? `${Number(iso.slice(5, 7))}.${Number(iso.slice(8, 10))}` : '';
  const STATUS_ORDER = { 마감임박: 0, 접수중: 1, 상시: 2, 공고별: 3, 예정: 4 };
  const STATUS_LABEL = { 마감임박: '마감 임박', 접수중: '접수 중', 상시: '상시', 공고별: '공고 확인', 예정: '접수 예정' };

  function chips(group, list, key, withAll) {
    const all = withAll ? [['', withAll]] : [];
    return [...all, ...list.map((v) => [v, v])].map(([v, label]) =>
      `<button class="chip${state[key] === v ? ' on' : ''}" data-k="${key}" data-v="${esc(v)}">${esc(label)}</button>`).join('');
  }
  function renderFilters() {
    $('#f-target').innerHTML = chips('target', TAX.targets, 'target', '전체');
    $('#f-region').innerHTML = chips('region', TAX.regions, 'region', '전체');
    $('#f-type').innerHTML = chips('type', TAX.supportTypes, 'type', '전체');
    $('#q').value = state.q;
    document.querySelectorAll('.sort button').forEach((b) => b.classList.toggle('on', b.dataset.sort === state.sort));
    document.querySelectorAll('.stat').forEach((b) => b.classList.toggle('active', b.dataset.stat === state.stat));
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    let list = items.filter((it) => {
      if (state.target && !it.targets.includes(state.target)) return false;
      if (state.region && state.region !== '전국' && it.region !== state.region && it.region !== '전국') return false;
      if (state.region === '전국' && it.region !== '전국') return false;
      if (state.type && !it.types.includes(state.type)) return false;
      if (state.stat === 'soon' && it.status !== '마감임박') return false;
      if (state.stat === 'open' && !['접수중', '마감임박'].includes(it.status)) return false;
      if (state.stat === 'always' && it.status !== '상시') return false;
      if (state.stat === 'new' && !it.isNew) return false;
      if (state.stat === 'check' && it.status !== '공고별') return false;
      if (q && !(it.title + ' ' + it.summary + ' ' + it.org).toLowerCase().includes(q)) return false;
      return true;
    });
    if (state.sort === 'new') {
      list.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    } else {
      list.sort((a, b) => {
        const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (s) return s;
        if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
        if (a.deadline) return -1; if (b.deadline) return 1;
        return (b.updated || '').localeCompare(a.updated || '');
      });
    }
    return list;
  }

  // 한 줄 목록 (게시판 느낌): [상태] [지역] 제목 … 금액 / 기한
  function card(it) {
    const tags = [...it.targets.slice(0, 1), ...it.types.slice(0, 2)].map((t) => `<span class="tag t2">${esc(t)}</span>`).join('');
    const when = it.deadline ? `${mmdd(it.deadline)} 마감` : (it.status === '상시' ? '상시 접수' : it.status === '공고별' ? '기한 공고 확인' : it.status === '예정' ? '접수 예정' : '');
    return `<a class="row ${it.isNew ? 'is-new' : ''}" href="${it.url}">
      <div class="row-head"><span class="badge ${it.status}">${STATUS_LABEL[it.status] || it.status}</span><span class="region">${esc(it.region)}</span><span class="src">${esc(it.sourceLabel || '')}</span></div>
      <div class="row-main">
        <h3>${esc(it.title)}${it.isNew ? '<span class="new">NEW</span>' : ''}</h3>
        <p>${esc(it.summary)}</p>
        <div class="tags">${tags}</div>
      </div>
      <div class="row-side">${it.amount ? `<span class="amount">${esc(it.amount)}</span>` : ''}<span class="when ${it.status}">${esc(when)}</span></div>
    </a>`;
  }

  function renderList() {
    const list = filtered();
    $('#count').textContent = `총 ${list.length}건`;
    const grid = $('#grid');
    grid.classList.toggle('list', list.length > 0);
    if (!list.length) { grid.innerHTML = '<div class="empty">조건에 맞는 공고가 없어요. 필터를 조금 풀어보세요.</div>'; $('#more').hidden = true; return; }
    grid.innerHTML = list.slice(0, state.shown).map(card).join('');
    const rest = list.length - state.shown;
    $('#more').hidden = rest <= 0;
    $('#more').textContent = `더 보기 (${Math.max(rest, 0)}건 남음)`;
  }

  function update(reset = true) { if (reset) state.shown = PAGE; writeHash(); renderFilters(); renderList(); }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) { state[chip.dataset.k] = chip.dataset.v; update(); return; }
    const sort = e.target.closest('.sort button');
    if (sort) { state.sort = sort.dataset.sort; update(); return; }
    const stat = e.target.closest('.stat');
    if (stat) { state.stat = state.stat === stat.dataset.stat ? '' : stat.dataset.stat; update(); return; }
    if (e.target.id === 'more') { state.shown += PAGE; update(false); return; }
    if (e.target.id === 'reset') { Object.assign(state, { target: '', region: '', type: '', q: '', stat: '' }); update(); return; }
  });
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; update(); });
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); update(); });
  window.addEventListener('hashchange', () => { readHash(); update(); });

  // 수집이 멈춘 걸 방문자도 운영자도 바로 알 수 있게: 수집일이 3일 넘게 지났으면 띠 표시
  try {
    const age = Math.floor((Date.now() - Date.parse(D.collectedAt + 'T00:00:00+09:00')) / 86400000);
    if (age >= 3) {
      const el = document.createElement('div');
      el.className = 'sample-banner';
      el.textContent = `마지막 공고 수집이 ${age}일 전이에요. 자동 업데이트가 멈춰 있을 수 있으니, 최신 공고는 정부24 원문에서 한 번 더 확인해 주세요.`;
      document.querySelector('.hero').insertAdjacentElement('afterend', el);
    }
  } catch { /* 무시 */ }

  readHash(); update();
})();
