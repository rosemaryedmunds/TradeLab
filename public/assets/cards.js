// Dashboard "cards" system — decorates every <section class="panel"> with:
//   • a drag handle (arrange mode only)
//   • a hide/eye toggle (per-user persistence in localStorage)
//   • a height-up/down control (taller charts on demand, especially on mobile)
//   • a share checkbox (when the toolbar's share mode is on)
//
// Persisted state lives in localStorage under tl_cards_v1:<user_id>:<page_key>:
//   { order: [id...], hidden: [id...], height: { id: pixels } }
//
// Drag-and-drop uses pointer events directly (touch-friendly, no library).
//
// Sharing a multi-card PNG is done with html-to-image-style cloning into a
// canvas via a temp iframe — implemented in /assets/cards-share.js (loaded
// lazily the first time the user opens the share modal).
(function () {
  if (window.__tlCardsLoaded) return;
  window.__tlCardsLoaded = true;

  // The page_key namespaces persistence so /today's layout doesn't bleed into /overall.
  const PAGE_KEY = (location.pathname.replace(/\/+$/, '') || '/');
  let userId = null;
  let state = { order: [], hidden: [], height: {} };
  let arrangeMode = false;
  let shareMode = false;
  let shareSelected = new Set();

  // ---------- styles ----------
  const css = `
    .tl-card-toolbar { position:sticky; top:0; z-index:25;
      display:flex; gap:8px; flex-wrap:wrap; align-items:center;
      padding:10px 12px; margin: 0 0 18px;
      background:rgba(12,13,16,.95); backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,.09); border-radius:14px;
      box-shadow:0 4px 18px rgba(0,0,0,.25); }
    .tl-card-toolbar .tl-tb-btn { display:inline-flex; align-items:center; gap:7px;
      padding:9px 13px; border:1px solid #2a2e36; border-radius:999px;
      background:#13151a; color:#d8d2c5; font-size:12px; font-weight:600;
      letter-spacing:.04em; cursor:pointer; min-height:38px; font: inherit;
      transition: border-color .15s, color .15s, background .15s; }
    .tl-card-toolbar .tl-tb-btn:hover { border-color:#5b6473; color:#fff; }
    .tl-card-toolbar .tl-tb-btn.active { background:#ffd166; color:#0a0a0a;
      border-color:#ffd166; }
    .tl-card-toolbar .tl-tb-btn[disabled] { opacity:.45; cursor:not-allowed; }
    .tl-card-toolbar .tl-tb-spacer { flex:1; min-width:8px; }
    .tl-card-toolbar .tl-tb-count { font-size:11px; color:#9d9a91;
      letter-spacing:.08em; margin-left:4px; font-weight:600; }
    .tl-card-toolbar .tl-tb-sub { display:flex; flex-wrap:wrap; gap:8px; width:100%;
      padding-top:8px; margin-top:8px; border-top:1px solid #1d2026; }
    .tl-card-toolbar .tl-tb-sub.hidden { display:none; }

    /* card chrome */
    .panel.tl-card { position:relative; }
    .panel.tl-card.tl-arrange { box-shadow: 0 0 0 1px rgba(255,209,102,.4),
      0 18px 50px rgba(0,0,0,.30); cursor: grab; }
    .panel.tl-card.tl-arrange:active { cursor: grabbing; }
    .panel.tl-card.tl-arrange .tl-card-body * { pointer-events:none !important; }
    .panel.tl-card.tl-arrange .tl-card-chrome { pointer-events: auto; }
    .panel.tl-card.tl-arrange .tl-card-chrome * { pointer-events: auto !important; }
    .panel.tl-card.tl-dragging { opacity:.55; transform: scale(.99); }
    .panel.tl-card.tl-drop-target { box-shadow: 0 0 0 2px #ffd166,
      0 24px 60px rgba(255,209,102,.18); }
    .panel.tl-card-hidden { display:none !important; }

    .tl-card-chrome { position:absolute; top:14px; right:14px; z-index:5;
      display:flex; gap:6px; align-items:center; }
    .tl-card-chrome .tl-cbtn { display:inline-grid; place-items:center;
      width:32px; height:32px; border:1px solid #2a2e36; border-radius:999px;
      background: rgba(16,17,20,.85); color:#9d9a91; cursor:pointer;
      font:inherit; padding:0; transition: border-color .15s, color .15s; }
    .tl-card-chrome .tl-cbtn:hover { border-color:#ffd166; color:#ffd166; }
    .tl-card-chrome .tl-cbtn[aria-pressed="true"] { background:#ffd166;
      color:#0a0a0a; border-color:#ffd166; }
    .tl-card-chrome .tl-cbtn svg { width:14px; height:14px; }
    .tl-card-chrome .tl-share-check { display:inline-grid; place-items:center;
      width:32px; height:32px; border:1.5px solid #2a2e36; border-radius:8px;
      background: rgba(16,17,20,.85); color:#ffd166; cursor:pointer;
      font:inherit; padding:0; }
    .tl-card-chrome .tl-share-check.on { background:#ffd166; color:#0a0a0a;
      border-color:#ffd166; }
    .tl-card-chrome .tl-share-check svg { width:16px; height:16px; }

    /* height controls — only visible during arrange mode */
    .tl-height-ctl { display:none; position:absolute; bottom:8px; right:14px;
      gap:6px; z-index:5; }
    .panel.tl-card.tl-arrange .tl-height-ctl { display:flex; }
    .tl-height-ctl .tl-cbtn { width:28px; height:28px; font-size:14px;
      font-weight:700; }

    /* hidden-cards drawer */
    .tl-hidden-tray { display:none; flex-wrap:wrap; gap:8px; padding:12px;
      border:1px dashed #2a2e36; border-radius:14px; margin:0 0 18px;
      background: rgba(20,22,26,.5); }
    .tl-hidden-tray.show { display:flex; }
    .tl-hidden-tray .tl-restore { display:inline-flex; align-items:center;
      gap:6px; padding:6px 12px; border:1px solid #2a2e36; border-radius:999px;
      background:#13151a; color:#9d9a91; font-size:12px; cursor:pointer;
      font: inherit; }
    .tl-hidden-tray .tl-restore:hover { color:#ffd166; border-color:#ffd166; }
    .tl-hidden-tray .tl-restore .tl-x { color:#30d158; font-weight:700; }
    .tl-hidden-tray-label { font-size:11px; color:#9d9a91; letter-spacing:.12em;
      text-transform:uppercase; padding:8px 4px; }

    @media (max-width: 620px) {
      .tl-card-toolbar { gap:6px; padding:8px; margin: 0 0 14px; border-radius:12px; }
      .tl-card-toolbar .tl-tb-btn { padding:8px 11px; font-size:12px; min-height:36px; }
      .tl-card-chrome { top:8px; right:8px; }
      .tl-card-chrome .tl-cbtn { width:30px; height:30px; }
      .panel.tl-card { padding-top: 50px; }
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- helpers ----------
  function storageKey() {
    return `tl_cards_v1:${userId || 'anon'}:${PAGE_KEY}`;
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (raw) state = Object.assign({ order: [], hidden: [], height: {} }, JSON.parse(raw));
    } catch (e) { /* corrupt; ignore */ }
  }
  function saveState() {
    try { localStorage.setItem(storageKey(), JSON.stringify(state)); }
    catch (e) { /* quota; ignore */ }
  }
  function cardIdOf(el) {
    return el.dataset.cardId || el.id || null;
  }

  // ---------- toolbar ----------
  function ensureToolbar(container) {
    if (container.querySelector('.tl-card-toolbar')) return container.querySelector('.tl-card-toolbar');
    const bar = document.createElement('div');
    bar.className = 'tl-card-toolbar';
    bar.innerHTML = `
      <button class="tl-tb-btn" type="button" data-act="arrange" title="Rearrange or hide cards">
        ${iconRows()} Arrange
      </button>
      <button class="tl-tb-btn" type="button" data-act="share" title="Share one or multiple cards as a single PNG">
        ${iconShare()} Share <span class="tl-tb-count" id="tlShareCount"></span>
      </button>
      <span class="tl-tb-spacer"></span>
      <button class="tl-tb-btn" type="button" data-act="reset" title="Restore default layout">Reset layout</button>
      <div class="tl-tb-sub hidden" id="tlShareSub">
        <button class="tl-tb-btn" type="button" data-act="share-go" id="tlShareGo" disabled>Generate PNG</button>
        <button class="tl-tb-btn" type="button" data-act="share-all">Select all</button>
        <button class="tl-tb-btn" type="button" data-act="share-none">Clear</button>
        <span class="tl-tb-count">Click checkboxes on the cards you want to include.</span>
      </div>`;
    // Insert toolbar at the top of the cards container.
    container.parentNode.insertBefore(bar, container);
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'arrange') setArrangeMode(!arrangeMode);
      else if (act === 'share') setShareMode(!shareMode);
      else if (act === 'reset') resetLayout();
      else if (act === 'share-go') doShare();
      else if (act === 'share-all') selectAllForShare();
      else if (act === 'share-none') clearShareSelection();
    });
    return bar;
  }

  function iconRows() {
    return `<svg viewBox="0 0 14 14" aria-hidden="true" width="13" height="13"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 3.5h10M2 7h10M2 10.5h10"/></g></svg>`;
  }
  function iconShare() {
    return `<svg viewBox="0 0 14 14" aria-hidden="true" width="13" height="13"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2v7"/><path d="M4 5l3-3 3 3"/><path d="M2 9v2.5A0.5 0.5 0 002.5 12h9a0.5 0.5 0 00.5-0.5V9"/></g></svg>`;
  }
  function iconEye(on) {
    return on
      ? `<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></g></svg>`
      : `<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 2l12 12"/><path d="M3.5 5.5C2.3 6.7 1.5 8 1.5 8s2.5 5 6.5 5c1.2 0 2.3-.3 3.3-.8"/><path d="M6.6 4.2A6 6 0 018 4c4 0 6.5 5 6.5 5-.4 .8-1 1.6-1.8 2.3"/></g></svg>`;
  }
  function iconGrip() {
    return `<svg viewBox="0 0 14 14" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="3" r="1"/><circle cx="4" cy="7" r="1"/><circle cx="4" cy="11" r="1"/><circle cx="10" cy="3" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="10" cy="11" r="1"/></g></svg>`;
  }
  function iconCheck() {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  // ---------- card decoration ----------
  function decorateCard(card) {
    if (card.classList.contains('tl-card')) return;
    card.classList.add('tl-card');
    const id = cardIdOf(card);
    if (!card.dataset.cardId && id) card.dataset.cardId = id;

    // Wrap the existing content so we can disable pointer events on it during arrange.
    const body = document.createElement('div');
    body.className = 'tl-card-body';
    while (card.firstChild) body.appendChild(card.firstChild);
    card.appendChild(body);

    // Chrome: grip, eye, share-check.
    const chrome = document.createElement('div');
    chrome.className = 'tl-card-chrome';
    chrome.innerHTML = `
      <button class="tl-cbtn tl-grip" type="button" title="Drag to rearrange" tabindex="-1">${iconGrip()}</button>
      <button class="tl-cbtn tl-eye"  type="button" title="Hide this card" aria-pressed="false">${iconEye(true)}</button>
      <button class="tl-share-check" type="button" title="Include in share PNG" aria-pressed="false" hidden>${iconCheck()}</button>
    `;
    card.appendChild(chrome);

    const heightCtl = document.createElement('div');
    heightCtl.className = 'tl-height-ctl';
    heightCtl.innerHTML = `
      <button class="tl-cbtn" type="button" data-h="-" title="Shorter">−</button>
      <button class="tl-cbtn" type="button" data-h="+" title="Taller">+</button>
      <button class="tl-cbtn" type="button" data-h="0" title="Reset height">↺</button>
    `;
    card.appendChild(heightCtl);

    // Restore saved height.
    if (state.height[id]) applyHeight(card, state.height[id]);

    // Eye toggle.
    chrome.querySelector('.tl-eye').addEventListener('click', (e) => {
      e.stopPropagation();
      hideCard(id);
    });

    // Share checkbox.
    const sc = chrome.querySelector('.tl-share-check');
    sc.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleShareSelect(id);
    });

    // Height controls.
    heightCtl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-h]');
      if (!btn) return;
      e.stopPropagation();
      const cur = state.height[id] || card.getBoundingClientRect().height;
      let next;
      if (btn.dataset.h === '+') next = Math.min(1400, cur + 80);
      else if (btn.dataset.h === '-') next = Math.max(180, cur - 80);
      else next = null;
      if (next == null) {
        delete state.height[id];
        card.style.removeProperty('--tl-h');
        card.style.removeProperty('height');
        card.style.removeProperty('min-height');
        card.removeAttribute('data-tl-resized');
      } else {
        state.height[id] = next;
        applyHeight(card, next);
      }
      saveState();
      // Charts will re-render to match new height on the next render cycle of
      // their parent page; we also nudge a window resize so SVG-based charts
      // that listen to it can reflow.
      setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
    });

    // Drag.
    wireDrag(card);
  }
  function applyHeight(card, px) {
    card.style.minHeight = px + 'px';
    card.style.height = px + 'px';
    // The data-tl-resized attribute opts the card's inner SVG into height:100%
    // scaling (see mobile.css). Without this, the legacy dashboards' aspect-
    // scaled charts stay short and the extra height becomes whitespace.
    card.setAttribute('data-tl-resized', '1');
  }

  // ---------- arrange & share modes ----------
  function setArrangeMode(on) {
    arrangeMode = !!on;
    document.querySelectorAll('.panel.tl-card').forEach(el => el.classList.toggle('tl-arrange', arrangeMode));
    document.querySelectorAll('.tl-card-toolbar .tl-tb-btn[data-act="arrange"]').forEach(b => b.classList.toggle('active', arrangeMode));
    if (on && shareMode) setShareMode(false);
  }
  function setShareMode(on) {
    shareMode = !!on;
    document.querySelectorAll('.tl-card-toolbar .tl-tb-btn[data-act="share"]').forEach(b => b.classList.toggle('active', shareMode));
    const sub = document.querySelector('#tlShareSub');
    if (sub) sub.classList.toggle('hidden', !shareMode);
    document.querySelectorAll('.panel.tl-card .tl-share-check').forEach(el => { el.hidden = !shareMode; });
    if (!on) clearShareSelection();
    if (on && arrangeMode) setArrangeMode(false);
  }
  function toggleShareSelect(id) {
    if (!shareMode) return;
    if (shareSelected.has(id)) shareSelected.delete(id);
    else shareSelected.add(id);
    refreshShareUi();
  }
  function selectAllForShare() {
    if (!shareMode) return;
    document.querySelectorAll('.panel.tl-card:not(.tl-card-hidden)').forEach(c => shareSelected.add(cardIdOf(c)));
    refreshShareUi();
  }
  function clearShareSelection() {
    shareSelected.clear();
    refreshShareUi();
  }
  function refreshShareUi() {
    document.querySelectorAll('.panel.tl-card').forEach(c => {
      const id = cardIdOf(c);
      const sel = shareSelected.has(id);
      const sc = c.querySelector('.tl-share-check');
      if (sc) { sc.classList.toggle('on', sel); sc.setAttribute('aria-pressed', String(sel)); }
    });
    const cnt = document.getElementById('tlShareCount');
    if (cnt) cnt.textContent = shareSelected.size ? `${shareSelected.size} selected` : '';
    const go = document.getElementById('tlShareGo');
    if (go) go.disabled = shareSelected.size === 0;
  }

  // ---------- drag-to-reorder ----------
  function wireDrag(card) {
    card.addEventListener('pointerdown', (e) => {
      if (!arrangeMode) return;
      if (e.target.closest('.tl-card-chrome') || e.target.closest('.tl-height-ctl')) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      let dragging = false;
      let ghost = null;
      let dropTarget = null;
      const container = card.parentNode;

      function onMove(ev) {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > 6) {
          dragging = true;
          card.classList.add('tl-dragging');
          ghost = card.cloneNode(true);
          ghost.style.position = 'fixed';
          ghost.style.pointerEvents = 'none';
          ghost.style.opacity = '0.85';
          ghost.style.transform = 'rotate(-1deg) scale(0.98)';
          ghost.style.boxShadow = '0 30px 60px rgba(0,0,0,.45)';
          ghost.style.width = card.getBoundingClientRect().width + 'px';
          ghost.style.zIndex = '9999';
          document.body.appendChild(ghost);
        }
        if (!dragging) return;
        ghost.style.left = (ev.clientX - 40) + 'px';
        ghost.style.top  = (ev.clientY - 20) + 'px';

        // Find which card we're hovering over.
        ghost.style.display = 'none';
        const elBelow = document.elementFromPoint(ev.clientX, ev.clientY);
        ghost.style.display = '';
        const overCard = elBelow && elBelow.closest('.panel.tl-card');
        if (overCard && overCard !== card && overCard.parentNode === container) {
          document.querySelectorAll('.tl-drop-target').forEach(d => d.classList.remove('tl-drop-target'));
          overCard.classList.add('tl-drop-target');
          dropTarget = overCard;
        }
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        if (ghost) ghost.remove();
        card.classList.remove('tl-dragging');
        document.querySelectorAll('.tl-drop-target').forEach(d => d.classList.remove('tl-drop-target'));
        if (dragging && dropTarget && dropTarget !== card) {
          // Determine insert direction by visual position.
          const a = card.getBoundingClientRect(), b = dropTarget.getBoundingClientRect();
          if (a.top < b.top || (a.top === b.top && a.left < b.left)) {
            dropTarget.parentNode.insertBefore(card, dropTarget.nextSibling);
          } else {
            dropTarget.parentNode.insertBefore(card, dropTarget);
          }
          persistOrder(card.parentNode);
          setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
        }
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  }

  function persistOrder(container) {
    state.order = [...container.querySelectorAll('.panel.tl-card')].map(cardIdOf);
    saveState();
  }

  // ---------- hide/show ----------
  function hideCard(id) {
    if (!state.hidden.includes(id)) state.hidden.push(id);
    saveState();
    applyHiddenState();
    renderHiddenTray();
  }
  function unhideCard(id) {
    state.hidden = state.hidden.filter(x => x !== id);
    saveState();
    applyHiddenState();
    renderHiddenTray();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
  }
  function applyHiddenState() {
    document.querySelectorAll('.panel.tl-card').forEach(c => {
      c.classList.toggle('tl-card-hidden', state.hidden.includes(cardIdOf(c)));
    });
    if (carouselActive) refreshPager();
  }
  function renderHiddenTray() {
    const container = document.querySelector('[data-cards-root]') || document.querySelector('.grid');
    if (!container) return;
    let tray = document.querySelector('.tl-hidden-tray');
    if (!tray) {
      tray = document.createElement('div');
      tray.className = 'tl-hidden-tray';
      container.parentNode.insertBefore(tray, container);
    }
    if (!state.hidden.length) { tray.classList.remove('show'); tray.innerHTML = ''; return; }
    const labelFor = (id) => {
      const orig = document.querySelector(`.panel.tl-card[data-card-id="${id}"]`);
      const h2 = orig && orig.querySelector('h2');
      return (h2 && h2.textContent.trim()) || id;
    };
    tray.innerHTML = `<span class="tl-hidden-tray-label">Hidden cards</span>` + state.hidden.map(id =>
      `<button class="tl-restore" type="button" data-id="${id}"><span class="tl-x">+</span> ${labelFor(id)}</button>`
    ).join('');
    tray.classList.add('show');
    tray.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => unhideCard(b.dataset.id)));
  }

  // ---------- reset ----------
  function resetLayout() {
    if (!confirm('Reset all card positions, heights, and hidden state?')) return;
    state = { order: [], hidden: [], height: {} };
    saveState();
    location.reload();
  }

  // ---------- share ----------
  async function doShare() {
    if (!shareSelected.size) return;
    const ids = [...shareSelected];
    const cards = ids
      .map(id => document.querySelector(`.panel.tl-card[data-card-id="${id}"]`))
      .filter(Boolean);
    if (!cards.length) return;
    // Lazy-load the share helper the first time.
    if (!window.__tlShareReady) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/assets/cards-share.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      }).catch(() => { alert('Failed to load share helper.'); });
    }
    if (window.tlShareCards) window.tlShareCards(cards);
  }

  // ---------- mobile swipe carousel ----------
  // On phones (<= 720px) the .grid container is converted into a horizontal
  // scroll-snap carousel so the user swipes one card at a time. A pager at
  // the bottom shows dots + label + arrow buttons. The active index is
  // persisted per-page so a filter change doesn't reset the user's position.
  const MOBILE_BREAKPOINT = 720;
  let carouselActive = false;
  let carouselContainer = null;
  let carouselPager = null;
  let activeCardIdx = 0;
  let scrollRaf = false;

  function isMobile() {
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
  }

  function visibleCards() {
    if (!carouselContainer) return [];
    return [...carouselContainer.querySelectorAll('.panel.tl-card:not(.tl-card-hidden)')];
  }

  function activeIdxKey() { return storageKey() + ':carouselIdx'; }
  function loadActiveIdx() {
    try {
      const raw = localStorage.getItem(activeIdxKey());
      if (raw != null) activeCardIdx = Math.max(0, parseInt(raw, 10) || 0);
    } catch (e) { /* ignore */ }
  }
  function saveActiveIdx() {
    try { localStorage.setItem(activeIdxKey(), String(activeCardIdx)); }
    catch (e) { /* ignore */ }
  }

  function cardLabel(card) {
    const h2 = card.querySelector('h2');
    return (h2 && h2.textContent.trim()) || cardIdOf(card) || '';
  }

  function buildPager() {
    if (carouselPager) return carouselPager;
    const pager = document.createElement('div');
    pager.className = 'tl-pager';
    pager.innerHTML = `
      <div class="tl-pager-row">
        <button class="tl-pager-arrow" data-act="prev" title="Previous card" aria-label="Previous card">‹</button>
        <div class="tl-pager-label">
          <span class="tl-pager-counter"></span><span class="tl-pager-title"></span>
        </div>
        <button class="tl-pager-arrow" data-act="next" title="Next card" aria-label="Next card">›</button>
      </div>
      <div class="tl-pager-track" role="slider" aria-label="Card scrubber" tabindex="0">
        <div class="tl-pager-segments"></div>
        <div class="tl-pager-thumb"></div>
      </div>
    `;
    carouselContainer.parentNode.insertBefore(pager, carouselContainer.nextSibling);

    pager.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const cards = visibleCards();
      if (!cards.length) return;
      let idx = activeCardIdx;
      if (btn.dataset.act === 'prev') idx = Math.max(0, idx - 1);
      else if (btn.dataset.act === 'next') idx = Math.min(cards.length - 1, idx + 1);
      scrollToCard(idx, true);
    });

    // Draggable scrubber. We use pointer events on the track and translate the
    // pointer's x-fraction along the track into a card index. Dragging gives
    // immediate (non-smooth) feedback; on release we snap with smooth scroll.
    const track = pager.querySelector('.tl-pager-track');
    let dragging = false;
    let suppressTap = false;
    function idxFromPointerX(clientX) {
      const cards = visibleCards();
      if (!cards.length) return 0;
      const r = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      return Math.round(frac * (cards.length - 1));
    }
    function onPointerMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const idx = idxFromPointerX(e.clientX);
      if (idx !== activeCardIdx) scrollToCard(idx, false);
    }
    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      track.classList.remove('dragging');
      try { track.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      // Final snap with smooth animation.
      scrollToCard(activeCardIdx, true);
      // Suppress the click that follows a touch-drag end on some browsers.
      suppressTap = true;
      setTimeout(() => { suppressTap = false; }, 250);
    }
    track.addEventListener('pointerdown', (e) => {
      // Don't start a drag from a segment-only click; treat as immediate jump.
      dragging = true;
      track.classList.add('dragging');
      try { track.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
      // Immediate jump on tap.
      const idx = idxFromPointerX(e.clientX);
      if (idx !== activeCardIdx) scrollToCard(idx, false);
      e.preventDefault();
    });
    // Keyboard a11y on the track.
    track.addEventListener('keydown', (e) => {
      const cards = visibleCards();
      if (!cards.length) return;
      if (e.key === 'ArrowLeft') { scrollToCard(Math.max(0, activeCardIdx - 1), true); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { scrollToCard(Math.min(cards.length - 1, activeCardIdx + 1), true); e.preventDefault(); }
      else if (e.key === 'Home') { scrollToCard(0, true); e.preventDefault(); }
      else if (e.key === 'End') { scrollToCard(cards.length - 1, true); e.preventDefault(); }
    });
    // Save references for refreshPager.
    pager._isDragging = () => dragging;

    carouselPager = pager;
    return pager;
  }

  function refreshPager() {
    if (!carouselPager || !carouselContainer) return;
    const cards = visibleCards();
    const segments = carouselPager.querySelector('.tl-pager-segments');
    const thumb = carouselPager.querySelector('.tl-pager-thumb');
    const track = carouselPager.querySelector('.tl-pager-track');
    const counter = carouselPager.querySelector('.tl-pager-counter');
    const title = carouselPager.querySelector('.tl-pager-title');
    const prev = carouselPager.querySelector('[data-act="prev"]');
    const next = carouselPager.querySelector('[data-act="next"]');
    activeCardIdx = Math.min(activeCardIdx, Math.max(0, cards.length - 1));
    // Rebuild segment ticks only if count changed.
    if (segments.children.length !== cards.length) {
      segments.innerHTML = cards.map(() => `<div class="tl-pager-segment"></div>`).join('');
    }
    [...segments.children].forEach((seg, i) => seg.classList.toggle('active', i === activeCardIdx));
    // Position the thumb. n cards → thumb at fraction i/(n-1) of track width.
    const frac = cards.length > 1 ? activeCardIdx / (cards.length - 1) : 0.5;
    if (track) {
      const w = track.clientWidth || 1;
      thumb.style.left = (frac * w) + 'px';
    }
    if (counter) counter.textContent = cards.length ? `${activeCardIdx + 1}/${cards.length}  ` : '';
    if (title) title.textContent = cards[activeCardIdx] ? cardLabel(cards[activeCardIdx]) : '';
    aria: { if (track && cards.length) {
      track.setAttribute('aria-valuemin', '1');
      track.setAttribute('aria-valuemax', String(cards.length));
      track.setAttribute('aria-valuenow', String(activeCardIdx + 1));
      track.setAttribute('aria-valuetext', `${activeCardIdx + 1} of ${cards.length}: ${cardLabel(cards[activeCardIdx])}`);
    } }
    if (prev) prev.disabled = activeCardIdx <= 0;
    if (next) next.disabled = activeCardIdx >= cards.length - 1;
  }

  function scrollToCard(idx, smooth) {
    const cards = visibleCards();
    if (!cards.length) return;
    idx = Math.max(0, Math.min(cards.length - 1, idx));
    activeCardIdx = idx;
    saveActiveIdx();
    const target = cards[idx];
    if (!target) return;
    // offsetLeft gives the absolute X within the scroll container, which is
    // stable regardless of current scrollLeft (unlike getBoundingClientRect).
    // We subtract the container's scroll-padding-left so the snap-start lines
    // up with the card's left edge.
    const scrollPad = parseFloat(getComputedStyle(carouselContainer).scrollPaddingLeft) || 0;
    const left = target.offsetLeft - scrollPad;
    if (smooth && 'scrollTo' in carouselContainer) {
      try { carouselContainer.scrollTo({ left, behavior: 'smooth' }); }
      catch (e) { carouselContainer.scrollLeft = left; }
    } else {
      carouselContainer.scrollLeft = left;
    }
    refreshPager();
    // Nudge a resize so SVG charts that listen for it can reflow into the
    // newly-revealed card height.
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  }

  function onCarouselScroll() {
    if (scrollRaf) return;
    scrollRaf = true;
    requestAnimationFrame(() => {
      scrollRaf = false;
      if (!carouselContainer) return;
      const cards = visibleCards();
      if (!cards.length) return;
      const containerRect = carouselContainer.getBoundingClientRect();
      const centerX = containerRect.left + containerRect.width / 2;
      let bestIdx = 0, bestDist = Infinity;
      cards.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - centerX);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      if (bestIdx !== activeCardIdx) {
        activeCardIdx = bestIdx;
        saveActiveIdx();
        refreshPager();
      }
    });
  }

  function enableCarousel(container) {
    if (carouselActive) return;
    carouselActive = true;
    carouselContainer = container;
    container.classList.add('tl-carousel');
    buildPager();
    loadActiveIdx();
    refreshPager();
    // Initial position without animation.
    requestAnimationFrame(() => scrollToCard(activeCardIdx, false));
    container.addEventListener('scroll', onCarouselScroll, { passive: true });
  }
  function disableCarousel() {
    if (!carouselActive) return;
    carouselActive = false;
    if (carouselContainer) {
      carouselContainer.classList.remove('tl-carousel');
      carouselContainer.removeEventListener('scroll', onCarouselScroll);
    }
    if (carouselPager) { carouselPager.remove(); carouselPager = null; }
    carouselContainer = null;
  }

  function syncCarouselMode() {
    const container = document.querySelector('[data-cards-root]') || document.querySelector('.grid');
    if (!container) return;
    if (isMobile()) enableCarousel(container);
    else disableCarousel();
  }

  // Mobile orientation / resize → toggle carousel; also re-snap to active
  // card in case the viewport width changed.
  let resizeRaf = false;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = true;
    requestAnimationFrame(() => {
      resizeRaf = false;
      syncCarouselMode();
      if (carouselActive) scrollToCard(activeCardIdx, false);
    });
  });

  // ---------- init ----------
  function applyOrder(container) {
    if (!state.order.length) return;
    const byId = new Map();
    [...container.querySelectorAll('.panel.tl-card')].forEach(c => byId.set(cardIdOf(c), c));
    for (const id of state.order) {
      const c = byId.get(id);
      if (c) container.appendChild(c);
    }
  }

  async function init() {
    // Single-user app — no namespacing needed; userId stays at its default.
    loadState();

    const container = document.querySelector('[data-cards-root]') || document.querySelector('.grid');
    if (!container) return;
    container.querySelectorAll('.panel').forEach(p => {
      if (!cardIdOf(p)) p.dataset.cardId = p.id || ('panel-' + Math.random().toString(36).slice(2,7));
      decorateCard(p);
    });
    applyOrder(container);
    applyHiddenState();
    renderHiddenTray();
    ensureToolbar(container);
    refreshShareUi();

    // Mark the cards root so the share helper can find it.
    container.setAttribute('data-cards-root', '1');

    // Toggle the mobile swipe-carousel based on current viewport.
    syncCarouselMode();
  }

  // Expose a tiny API so dashboard code can re-hook after re-renders.
  window.tlCards = {
    redecorate: () => {
      const container = document.querySelector('[data-cards-root]') || document.querySelector('.grid');
      if (!container) return;
      container.querySelectorAll('.panel:not(.tl-card)').forEach(decorateCard);
      applyOrder(container);
      applyHiddenState();
      renderHiddenTray();
    },
    getState: () => Object.assign({}, state),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
