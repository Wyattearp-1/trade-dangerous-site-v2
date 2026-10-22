(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmtNum = (n) => Math.round(n).toLocaleString('en-US');
  const fmtCr = (n) => fmtNum(n) + ' cr';
  const STORAGE_KEY = 'td-web-settings-v3';
  const DATA_URL = 'trade-data.json';
  // Search effort: time budget and the widest beam the search may reach.
  const EFFORT = { quick: { ms: 2500, width: 12 }, thorough: { ms: 8000, width: 48 }, maximum: { ms: 30000, width: 128 } };

  /* ---------------- helpers ---------------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function splitList(str) {
    return (str || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function inaraSearchUrl(query) {
    return 'https://inara.cz/elite/stations/?search=' + encodeURIComponent(query);
  }
  function inaraStationUrl(key) {
    const i = key.indexOf('/');
    const system = encodeURIComponent(i < 0 ? key : key.slice(0, i));
    const station = encodeURIComponent(i < 0 ? '' : key.slice(i + 1));
    return 'https://inara.cz/elite/stations/?search=' + system + '+' + station;
  }

  function fmtAge(updatedSec) {
    if (!updatedSec) return 'age unknown';
    const s = Math.max(0, Date.now() / 1000 - updatedSec);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm old';
    if (s < 86400) return Math.round(s / 3600) + 'h old';
    return Math.round(s / 86400) + 'd old';
  }

  /* ---------------- backend: Web Worker with inline fallback ---------------- */

  function createWorkerBackend() {
    let worker;
    try {
      worker = new Worker('worker.js');
    } catch (e) { // e.g. file:// pages, or Workers disabled
      const err = new Error('Web Workers are unavailable: ' + e.message);
      err.workerFailure = true;
      throw err;
    }
    let nextId = 1;
    const pending = new Map();
    let loading = null;

    function failAll(err) {
      if (loading) { loading.reject(err); loading = null; }
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    }

    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') {
        if (m.id && pending.has(m.id)) { const cb = pending.get(m.id).onProgress; if (cb) cb(m.progress); }
        else if (loading && loading.onProgress) loading.onProgress(m.progress);
      }
      else if (m.type === 'ready' && loading) { loading.resolve(m.info); loading = null; }
      else if (m.type === 'result' && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
      else if (m.type === 'error') {
        const err = new Error(m.message);
        if (m.id && pending.has(m.id)) { pending.get(m.id).reject(err); pending.delete(m.id); }
        else if (loading) { loading.reject(err); loading = null; }
      }
    };
    worker.onerror = (ev) => {
      const err = new Error('Background worker failed' + (ev && ev.message ? ': ' + ev.message : ''));
      err.workerFailure = true;
      failAll(err);
    };

    function call(type, payload, onProgress) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage(Object.assign({ type, id }, payload));
      });
    }

    return {
      kind: 'worker',
      load(url, onProgress) {
        return new Promise((resolve, reject) => {
          loading = { resolve, reject, onProgress };
          worker.postMessage({ type: 'load', url });
        });
      },
      run: (opts, onProgress) => call('run', { opts }, onProgress),
      quick: (args, onProgress) => call('quick', { args }, onProgress),
    };
  }

  function createInlineBackend() {
    const engine = window.TDEngine.createEngine();
    const tick = () => new Promise((r) => setTimeout(r, 20));
    return {
      kind: 'inline',
      load: (url, onProgress) => engine.load(url, onProgress),
      run: async (opts, onProgress) => { await tick(); return engine.run(opts, onProgress); },
      quick: async (args, onProgress) => engine.quick(args, onProgress),
    };
  }

  /* ---------------- station index + search ---------------- */

  let INFO = null;
  let STATIONS = [];            // { key, sys, stn, pad, flags, updated }
  let KEY_SET = new Set();
  let BY_SYSTEM = new Map();    // SYSTEM -> [key]
  let BY_NAME = new Map();      // STATION NAME -> [key]

  function indexStations(info) {
    STATIONS = info.index.map(([key, pad, flags, updated]) => {
      const i = key.indexOf('/');
      return { key, sys: i < 0 ? key : key.slice(0, i), stn: i < 0 ? '' : key.slice(i + 1), pad, flags, updated };
    });
    KEY_SET = new Set(STATIONS.map((s) => s.key));
    BY_SYSTEM = new Map();
    BY_NAME = new Map();
    for (const s of STATIONS) {
      if (!BY_SYSTEM.has(s.sys)) BY_SYSTEM.set(s.sys, []);
      BY_SYSTEM.get(s.sys).push(s.key);
      if (!BY_NAME.has(s.stn)) BY_NAME.set(s.stn, []);
      BY_NAME.get(s.stn).push(s.key);
    }
  }

  function searchStations(query, limit) {
    limit = limit || 40;
    const upper = (query || '').trim().toUpperCase();
    if (!upper) return STATIONS.slice(0, limit).map((s) => ({ s, score: 0 }));
    const sysHit = BY_SYSTEM.has(upper);
    const out = [];
    for (const s of STATIONS) {
      let score;
      if (s.key === upper) score = 2000;
      else if (sysHit && s.sys === upper) score = 1000;
      else if (s.key.startsWith(upper)) score = 900;
      else if (s.stn.startsWith(upper)) score = 800;
      else if (s.sys.startsWith(upper)) score = 700;
      else if (s.key.includes(upper)) score = 500;
      else if (s.stn.includes(upper)) score = 450;
      else if (s.sys.includes(upper)) score = 400;
      else continue;
      if (s.flags & 2) score -= 5; // fleet carriers sort after regular stations
      out.push({ s, score: score - Math.min(s.key.length, 80) * 0.01 });
    }
    out.sort((a, b) => b.score - a.score || (a.s.key < b.s.key ? -1 : 1));
    return out.slice(0, limit);
  }

  function resolveStationKey(input) {
    const raw = (input || '').trim();
    if (!raw) return null;
    const upper = raw.toUpperCase().replace(/\s+/g, ' ');
    if (KEY_SET.has(upper)) return upper;
    const bracket = upper.match(/^(.*?)\s*\[(.*)\]\s*$/);
    if (bracket && KEY_SET.has(bracket[2].trim() + '/' + bracket[1].trim())) return bracket[2].trim() + '/' + bracket[1].trim();
    const byName = BY_NAME.get(upper);
    if (byName && byName.length === 1) return byName[0];
    const bySys = BY_SYSTEM.get(upper);
    if (bySys && bySys.length === 1) return bySys[0];
    return null;
  }

  /* ---------------- autocomplete (ARIA combobox) ---------------- */

  let acCounter = 0;
  function attachAutocomplete(input) {
    const uid = 'ac' + (++acCounter);
    const wrap = document.createElement('div');
    wrap.className = 'ac-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', uid + '-list');

    const panel = document.createElement('div');
    panel.className = 'ac-panel';
    panel.id = uid + '-list';
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;
    wrap.appendChild(panel);

    let activeIdx = -1;
    let items = [];
    let timer = null;

    function setExpanded(open) {
      panel.hidden = !open;
      input.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) input.removeAttribute('aria-activedescendant');
    }
    function close() { setExpanded(false); activeIdx = -1; panel.innerHTML = ''; }

    function paintActive() {
      panel.querySelectorAll('.ac-item').forEach((el, i) => {
        const on = i === activeIdx;
        el.classList.toggle('active', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
      });
    }

    function pick(key) {
      input.value = key;
      close();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function render() {
      const q = input.value;
      items = searchStations(q, 40);
      activeIdx = items.length ? 0 : -1;
      panel.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'ac-empty';
        empty.innerHTML = q.trim()
          ? 'No station matching “' + escapeHtml(q.trim()) + '” in the data.<br>' +
            '<a href="' + inaraSearchUrl(q.trim()) + '" target="_blank" rel="noopener">Search on Inara ↗</a>' +
            '<span class="ac-hint">Only stations that have a market (and, for fleet carriers, were updated recently) are included.</span>'
          : 'Type a system or station name…';
        panel.appendChild(empty);
        setExpanded(true);
        return;
      }
      items.forEach(({ s }, i) => {
        const row = document.createElement('div');
        row.className = 'ac-item';
        row.id = uid + '-opt' + i;
        row.setAttribute('role', 'option');
        const tags = (s.flags & 2 ? ' <span class="tag">carrier</span>' : '') + (s.flags & 1 ? ' <span class="tag">surface</span>' : '') +
          (s.updated ? ' <span class="tag age">' + fmtAge(s.updated) + '</span>' : '');
        row.innerHTML = '<span class="ac-stn">' + escapeHtml(s.stn || s.key) + tags + '</span>' +
          '<span class="ac-sys">' + escapeHtml(s.sys) + ' · ' + escapeHtml(s.pad) + '</span>';
        row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(s.key); });
        panel.appendChild(row);
      });
      const footer = document.createElement('div');
      footer.className = 'ac-footer';
      footer.innerHTML = items.length + ' shown · ' + STATIONS.length.toLocaleString() + ' stations in snapshot · ' +
        '<a href="' + inaraSearchUrl(q.trim()) + '" target="_blank" rel="noopener">Inara search ↗</a>';
      panel.appendChild(footer);
      setExpanded(true);
      paintActive();
    }

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 60); });
    input.addEventListener('focus', render);
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => {
      if (panel.hidden) { if (e.key === 'ArrowDown') { e.preventDefault(); render(); } return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); paintActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); paintActive(); }
      else if (e.key === 'Enter') { if (activeIdx >= 0 && items[activeIdx]) { e.preventDefault(); pick(items[activeIdx].s.key); } }
      else if (e.key === 'Escape') { close(); }
    });
  }

  /* ---------------- settings: defaults <- localStorage <- URL ---------------- */

  const TEXT_FIELDS = ['startStation', 'credits', 'insurance', 'capacity', 'lyPer', 'jumpsPer', 'hops',
    'towardSystem', 'avoidSystems', 'avoidStations', 'avoidCommodities', 'sortBy', 'minProfit',
    'minRouteProfit', 'padSize', 'maxStationLs', 'maxAge', 'effort', 'maxResults'];
  const CHECK_FIELDS = ['loop', 'noRevisit', 'includeOdyssey', 'includeCarriers'];
  const DEFAULTS = {};

  function captureDefaults() {
    TEXT_FIELDS.forEach((id) => { DEFAULTS[id] = $(id).value; });
    CHECK_FIELDS.forEach((id) => { DEFAULTS[id] = $(id).checked ? '1' : '0'; });
  }
  function readSettings() {
    const s = {};
    TEXT_FIELDS.forEach((id) => { s[id] = $(id).value; });
    CHECK_FIELDS.forEach((id) => { s[id] = $(id).checked ? '1' : '0'; });
    return s;
  }
  function applySettings(s) {
    TEXT_FIELDS.forEach((id) => { if (s[id] !== undefined && s[id] !== null) $(id).value = s[id]; });
    CHECK_FIELDS.forEach((id) => { if (s[id] !== undefined && s[id] !== null) $(id).checked = String(s[id]) === '1'; });
  }
  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(readSettings())); } catch (e) { /* storage unavailable */ }
  }
  function loadSavedSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) applySettings(JSON.parse(raw));
    } catch (e) { /* ignore corrupt/blocked storage */ }
  }
  function settingsFromUrl() {
    const params = new URLSearchParams(location.search);
    const s = {};
    let any = false;
    [...TEXT_FIELDS, ...CHECK_FIELDS].forEach((id) => { if (params.has(id)) { s[id] = params.get(id); any = true; } });
    if (any) applySettings(s);
    return any;
  }
  function settingsLink() {
    const cur = readSettings();
    const params = new URLSearchParams();
    for (const id of Object.keys(cur)) if (cur[id] !== DEFAULTS[id]) params.set(id, cur[id]);
    const qs = params.toString();
    return location.origin + location.pathname + (qs ? '?' + qs : '');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ---------------- tabs ---------------- */

  function setupTabs() {
    const btns = Array.from(document.querySelectorAll('.tab-btn'));
    function activate(btn, focus) {
      btns.forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        const panel = $('tab-' + b.dataset.tab);
        panel.classList.toggle('active', on);
        panel.hidden = !on;
      });
      if (focus) btn.focus();
    }
    btns.forEach((btn, i) => {
      btn.addEventListener('click', () => activate(btn, false));
      btn.addEventListener('keydown', (e) => {
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % btns.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + btns.length) % btns.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = btns.length - 1;
        if (j !== null) { e.preventDefault(); activate(btns[j], true); }
      });
    });
  }

  /* ---------------- rendering ---------------- */

  let lastRoutes = [];

  function routeMetrics(route) {
    const hops = route.hops || [];
    const dist = route.totalDist != null ? route.totalDist : hops.reduce((s, h) => s + (h.distLy || 0), 0);
    const n = hops.length || 1;
    let tons = 0;
    let jumps = 0;
    hops.forEach((h) => { jumps += h.jumps || 0; (h.load || []).forEach((l) => { tons += l.units || 0; }); });
    return { profit: route.totalProfit || 0, dist, hops: n, jumps, profitPerHop: (route.totalProfit || 0) / n, crPerTon: tons > 0 ? route.totalProfit / tons : 0 };
  }

  function sortRoutes(routes, sortBy) {
    const scored = routes.map((r) => ({ r, m: routeMetrics(r) }));
    const byProfit = (a, b) => b.m.profit - a.m.profit;
    const cmp = {
      profit: byProfit,
      profitPerHop: (a, b) => b.m.profitPerHop - a.m.profitPerHop || byProfit(a, b),
      crPerTon: (a, b) => b.m.crPerTon - a.m.crPerTon || byProfit(a, b),
      shortest: (a, b) => a.m.dist - b.m.dist || byProfit(a, b),
      fewestHops: (a, b) => a.m.hops - b.m.hops || byProfit(a, b),
    }[sortBy] || byProfit;
    scored.sort(cmp);
    return scored.map((x) => x.r);
  }

  const SORT_LABELS = { profit: 'total profit', profitPerHop: 'profit per hop', crPerTon: 'CR per ton', shortest: 'shortest distance', fewestHops: 'fewest hops' };

  function stationBadges(st) {
    const bits = [];
    if (st.pad) bits.push('<span class="tag">' + escapeHtml(st.pad) + ' pad</span>');
    if (st.distLs) bits.push('<span class="tag">' + fmtNum(st.distLs) + ' Ls</span>');
    if (st.carrier) bits.push('<span class="tag warn">carrier</span>');
    if (st.planetary) bits.push('<span class="tag">surface</span>');
    return bits.join('');
  }

  function stationLinkHtml(st) {
    const label = escapeHtml(st.key);
    return '<a class="station-link" href="' + inaraStationUrl(st.key) + '" target="_blank" rel="noopener" title="Open on Inara">' + label + '</a>';
  }

  function loadTableHtml(load) {
    if (!load || !load.length) return '<p class="muted empty-leg">No cargo on this leg (positioning flight).</p>';
    const rows = load.map((l) =>
      '<tr><td>' + escapeHtml(l.commodity) + '</td>' +
      '<td class="num">' + fmtNum(l.units) + '</td>' +
      '<td class="num">' + fmtNum(l.buy) + '</td>' +
      '<td class="num">' + fmtNum(l.sell) + '</td>' +
      '<td class="num dim">' + fmtNum(l.supply) + '</td>' +
      '<td class="num dim">' + fmtNum(l.demand) + '</td>' +
      '<td class="num">+' + fmtNum(l.profit) + '</td></tr>').join('');
    return '<div class="table-scroll"><table class="load-table">' +
      '<thead><tr><th>Commodity</th><th class="num">Units</th><th class="num">Buy</th><th class="num">Sell</th>' +
      '<th class="num" title="Stock available where you buy">Stock</th><th class="num" title="Demand where you sell">Demand</th><th class="num">Profit</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function routeToText(route, index) {
    const m = routeMetrics(route);
    const lines = ['Route ' + (index + 1) + ': +' + fmtCr(route.totalProfit) + ' over ' + m.hops + ' hop(s), ' + m.dist.toFixed(1) + ' ly'];
    route.hops.forEach((h, i) => {
      lines.push((i + 1) + '. ' + h.from.key + ' -> ' + h.to.key + ' (' + h.distLy.toFixed(1) + ' ly)  +' + fmtCr(h.profit));
      (h.load || []).forEach((l) => lines.push('     ' + l.units + 't ' + l.commodity + ' buy ' + fmtNum(l.buy) + ' / sell ' + fmtNum(l.sell)));
    });
    return lines.join('\n');
  }

  function renderRoutes(routes, sortBy, maxShow) {
    const container = $('runResults');
    container.innerHTML = '';
    lastRoutes = routes || [];
    if (!lastRoutes.length) {
      container.innerHTML = '<p class="status error">No profitable route found with these constraints. Try a larger jump range, more jumps per hop, more credits, or fewer avoid-rules.</p>';
      return;
    }
    const ordered = sortRoutes(lastRoutes, sortBy).slice(0, maxShow);

    const toolbar = document.createElement('div');
    toolbar.className = 'results-toolbar';
    toolbar.innerHTML = '<span class="muted">' + ordered.length + ' route' + (ordered.length === 1 ? '' : 's') +
      ' · sorted by ' + (SORT_LABELS[sortBy] || sortBy) + '</span>';
    container.appendChild(toolbar);

    ordered.forEach((route, i) => {
      const m = routeMetrics(route);
      const card = document.createElement('article');
      card.className = 'route-card';

      const head = document.createElement('div');
      head.className = 'route-card-head';
      head.innerHTML =
        '<span>Route ' + (i + 1) + '</span>' +
        '<span class="route-meta">' + m.hops + ' hop' + (m.hops === 1 ? '' : 's') + ' · ' + m.dist.toFixed(1) + ' ly · ~' + m.jumps + ' jump' + (m.jumps === 1 ? '' : 's') + '</span>' +
        '<span class="total">+' + fmtCr(route.totalProfit) + '</span>';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'secondary small';
      copyBtn.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', 'Copy route ' + (i + 1) + ' as text');
      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(routeToText(route, i));
        copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
      });
      head.appendChild(copyBtn);
      card.appendChild(head);

      route.hops.forEach((h, n) => {
        const hop = document.createElement('div');
        hop.className = 'hop';
        hop.innerHTML =
          '<div class="hop-route">' +
            '<span class="hop-num">' + (n + 1) + '</span>' +
            '<span class="hop-stations">' + stationLinkHtml(h.from) + '<span class="hop-arrow" aria-label="to">→</span>' + stationLinkHtml(h.to) + '</span>' +
            '<span class="dist">' + h.distLy.toFixed(1) + ' ly' + (h.jumps ? ' · ~' + h.jumps + ' jump' + (h.jumps === 1 ? '' : 's') : '') + '</span>' +
            '<span class="hop-profit">+' + fmtCr(h.profit) + '</span>' +
          '</div>' +
          '<div class="hop-meta"><span><span class="muted">Buy at</span> ' + stationBadges(h.from) + ' <span class="tag age">' + fmtAge(h.from.updated) + '</span></span>' +
          '<span><span class="muted">Sell at</span> ' + stationBadges(h.to) + ' <span class="tag age">' + fmtAge(h.to.updated) + '</span></span></div>' +
          loadTableHtml(h.load);
        card.appendChild(hop);
      });
      container.appendChild(card);
    });
  }

  /* ---------------- forms ---------------- */

  let backend = null;
  let runSeq = 0;

  function setReady(ready) {
    const run = $('runBtn'), quick = $('quickBtn');
    run.disabled = !ready; quick.disabled = !ready;
    run.textContent = ready ? 'Plot best routes' : 'Loading data…';
    quick.textContent = ready ? 'Find best load' : 'Loading data…';
  }

  function showWarnings(list) {
    const ul = $('runWarnings');
    ul.innerHTML = (list || []).map((w) => '<li>' + escapeHtml(w) + '</li>').join('');
  }

  function buildOptions(startKey) {
    const sortBy = $('sortBy').value;
    const maxResults = Math.min(30, Math.max(1, Number($('maxResults').value) || 8));
    return {
      opts: {
        startKey,
        credits: Number($('credits').value),
        insurance: Number($('insurance').value) || 0,
        capacity: Number($('capacity').value),
        lyPer: Number($('lyPer').value),
        jumpsPer: Number($('jumpsPer').value),
        hops: Number($('hops').value),
        loop: $('loop').checked,
        noRevisit: $('noRevisit').checked,
        noPlanetary: !$('includeOdyssey').checked,
        includeCarriers: $('includeCarriers').checked,
        towardSystem: $('towardSystem').value.trim() || undefined,
        avoidSystems: splitList($('avoidSystems').value),
        avoidStations: splitList($('avoidStations').value),
        avoidCommodities: splitList($('avoidCommodities').value),
        minProfitPerUnit: Number($('minProfit').value) || 1,
        minRouteProfit: Number($('minRouteProfit').value) || 0,
        beamWidth: 6,
        timeBudgetMs: EFFORT[$('effort').value] ? EFFORT[$('effort').value].ms : 8000,
        maxBeamWidth: EFFORT[$('effort').value] ? EFFORT[$('effort').value].width : 48,
        requirePad: $('padSize').value,
        maxStationLs: Number($('maxStationLs').value) || 0,
        maxAgeHours: Number($('maxAge').value) || 0,
        // Other sort orders pick from a bigger pool of top-earning routes.
        maxResults: sortBy === 'profit' ? maxResults : Math.min(60, maxResults * 4),
      },
      sortBy,
      maxShow: maxResults,
    };
  }

  function regionProgress(statusEl) {
    return (p) => {
      if (p.phase === 'search') {
        statusEl.textContent = 'Searching… pass ' + p.pass + (p.note ? ' (' + p.note + ')' : ' (width ' + p.width + ')') + ' · ' + (p.elapsed / 1000).toFixed(1) + 's';
        return;
      }
      if (p.phase !== 'tiles') return;
      statusEl.textContent = 'Loading map regions… ' + p.files + '/' + p.filesTotal + ' (' +
        (p.loaded / 1e6).toFixed(1) + (p.total ? ' / ' + (p.total / 1e6).toFixed(1) : '') + ' MB) — cached for next time';
    };
  }

  async function runPlanner() {
    const status = $('runStatus');
    const btn = $('runBtn');
    const seq = ++runSeq;
    status.className = 'status';
    showWarnings([]);

    const typed = $('startStation').value;
    const startKey = resolveStationKey(typed);
    if (!startKey) {
      status.className = 'status error';
      status.innerHTML = 'Unknown starting station in this market snapshot. Pick a suggestion from the list, or <a href="' +
        inaraSearchUrl(typed) + '" target="_blank" rel="noopener">search Inara ↗</a>';
      $('runResults').innerHTML = '';
      $('startStation').focus();
      return;
    }
    $('startStation').value = startKey;
    saveSettings();

    const { opts, sortBy, maxShow } = buildOptions(startKey);
    btn.disabled = true;
    btn.textContent = 'Plotting…';
    status.textContent = 'Plotting routes…';
    $('runResults').innerHTML = '';
    try {
      const res = await backend.run(opts, regionProgress(status));
      if (seq !== runSeq) return;
      status.textContent = 'Evaluated ' + fmtNum(res.stats.stationsConsidered) + ' stations · ' + res.passes + ' search pass' + (res.passes === 1 ? '' : 'es') + ' (up to width ' + res.width + ') in ' + (res.ms / 1000).toFixed(1) + 's · start ' + startKey + ' · ' + res.routes.length + ' route(s)';
      showWarnings(res.warnings);
      renderRoutes(res.routes, sortBy, maxShow);
    } catch (err) {
      if (seq !== runSeq) return;
      status.className = 'status error';
      status.textContent = err.message;
      $('runResults').innerHTML = '';
    } finally {
      if (seq === runSeq) { btn.disabled = false; btn.textContent = 'Plot best routes'; }
    }
  }

  async function runQuick() {
    const container = $('quickResults');
    try {
      const fromKey = resolveStationKey($('qFrom').value);
      const toKey = resolveStationKey($('qTo').value);
      if (!fromKey || !toKey) throw new Error('Pick both stations from the suggestions (they must exist in the current market snapshot).');
      $('qFrom').value = fromKey; $('qTo').value = toKey;
      container.innerHTML = '<p class="status">Loading…</p>';
      const res = await backend.quick({
        fromKey, toKey, credits: Number($('qCredits').value), capacity: Number($('qCapacity').value),
      }, regionProgress(container.firstChild || container));
      if (!res.load.length) {
        const rev = res.reverseProfit
          ? ' Going the other way (' + escapeHtml(toKey) + ' → ' + escapeHtml(fromKey) + ') would earn ' + fmtCr(res.reverseProfit) + '.'
          : '';
        container.innerHTML = '<p class="status error">No profitable commodity moves between those two stations.' + rev + '</p>';
        return;
      }
      container.innerHTML =
        '<article class="route-card"><div class="route-card-head"><span>' +
        stationLinkHtml({ key: fromKey }) + ' → ' + stationLinkHtml({ key: toKey }) +
        '</span><span class="total">+' + fmtCr(res.totalProfit) + '</span></div>' +
        '<div class="hop">' + loadTableHtml(res.load) + '</div></article>';
    } catch (err) {
      container.innerHTML = '<p class="status error">' + escapeHtml(err.message) + '</p>';
    }
  }

  function setupForms() {
    // Handlers are attached before data loads so Enter can never trigger a native page reload.
    $('runForm').addEventListener('submit', (e) => { e.preventDefault(); return (backend && INFO && !$('runBtn').disabled) ? runPlanner() : undefined; });
    $('quickForm').addEventListener('submit', (e) => { e.preventDefault(); return (backend && INFO && !$('quickBtn').disabled) ? runQuick() : undefined; });
    $('sortBy').addEventListener('change', () => {
      saveSettings();
      if (lastRoutes.length) renderRoutes(lastRoutes, $('sortBy').value, Math.min(30, Math.max(1, Number($('maxResults').value) || 8)));
    });
    $('runForm').addEventListener('change', saveSettings);
    $('shareBtn').addEventListener('click', async () => {
      const ok = await copyText(settingsLink());
      const b = $('shareBtn');
      b.textContent = ok ? 'Link copied ✓' : 'Copy failed';
      setTimeout(() => { b.textContent = 'Copy settings link'; }, 1800);
    });
  }

  /* ---------------- init ---------------- */

  function showProgress(p) {
    const bar = $('loadProgress');
    const stamp = $('dataStamp');
    if (p.phase === 'meta') { stamp.textContent = 'Loading dataset…'; return; }
    if (p.phase === 'index') { stamp.textContent = 'Indexing stations…'; bar.removeAttribute('value'); return; }
    if (p.total > 0) {
      bar.max = p.total; bar.value = p.loaded;
      stamp.textContent = 'Downloading dataset… ' + (p.loaded / 1e6).toFixed(1) + ' / ' + (p.total / 1e6).toFixed(1) + ' MB';
    } else {
      bar.removeAttribute('value');
      stamp.textContent = 'Downloading dataset… ' + (p.loaded / 1e6).toFixed(1) + ' MB';
    }
  }

  async function loadData() {
    try {
      backend = createWorkerBackend();
      return await backend.load(DATA_URL, showProgress);
    } catch (err) {
      if (!err.workerFailure) throw err;
      console.warn('Web Worker unavailable, running on the main thread:', err.message);
      backend = createInlineBackend();
      return await backend.load(DATA_URL, showProgress);
    }
  }

  async function init() {
    setupTabs();
    captureDefaults();
    loadSavedSettings();
    const fromUrl = settingsFromUrl();
    setupForms();
    try {
      INFO = await loadData();
    } catch (err) {
      $('dataStamp').textContent = 'Failed to load dataset: ' + err.message;
      $('loadProgress').hidden = true;
      return;
    }
    indexStations(INFO);
    $('loadProgress').hidden = true;

    const stamp = INFO.generated_at ? new Date(INFO.generated_at) : null;
    const ageDays = stamp ? (Date.now() - stamp.getTime()) / 86400000 : 0;
    const src = INFO.source ? ' · ' + INFO.source : '';
    $('dataStamp').textContent = INFO.stationCount.toLocaleString() + ' stations' + (INFO.tiled ? ' (all searchable)' : '') +
      (stamp ? ' · updated ' + stamp.toLocaleString() + (ageDays >= 2 ? ' (⚠ ' + Math.floor(ageDays) + ' days old)' : '') : '') + src;
    $('aboutStamp').textContent = stamp
      ? 'Current snapshot generated ' + stamp.toISOString() + (INFO.hasAges ? ' · prices carry per-station timestamps.' : ' · this snapshot has no price timestamps.') +
        (INFO.tiled ? ' Map regions are downloaded on demand around your start station and cached by your browser.' : '')
      : '';
    $('maxAge').disabled = !INFO.hasAges;
    if (!INFO.hasAges) $('maxAge').title = 'This snapshot has no price timestamps';

    const dl = $('systemList');
    dl.innerHTML = INFO.systemNames.slice(0, 5000).map((n) => '<option value="' + escapeHtml(n) + '"></option>').join('');

    ['startStation', 'qFrom', 'qTo'].forEach((id) => attachAutocomplete($(id)));
    setReady(true);

    if (fromUrl && resolveStationKey($('startStation').value)) runPlanner();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
