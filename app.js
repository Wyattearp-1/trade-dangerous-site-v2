(function () {
  let DATA = null;
  /** @type {string[]} */
  let STATION_KEYS = [];
  /** system (upper) -> station keys */
  let BY_SYSTEM = new Map();

  const $ = (id) => document.getElementById(id);
  const fmtCr = (n) => Math.round(n).toLocaleString('en-US') + ' cr';

  function splitList(str) {
    return (str || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  function inaraStationUrl(stationKey) {
    const parts = stationKey.split('/');
    const system = encodeURIComponent(parts[0] || '');
    const station = encodeURIComponent(parts.slice(1).join('/') || '');
    return `https://inara.cz/elite/stations/?search=${system}+${station}`;
  }

  function inaraSearchUrl(query) {
    return `https://inara.cz/elite/stations/?search=${encodeURIComponent(query)}`;
  }

  function stationLabel(key) {
    return key || '';
  }

  function stationLinkHtml(key) {
    const label = escapeHtml(stationLabel(key));
    const url = inaraStationUrl(key);
    return `<a class="station-link" href="${url}" target="_blank" rel="noopener" title="Open on Inara">${label}</a>`;
  }

  function indexStations() {
    STATION_KEYS = Object.keys(DATA.stations || {}).sort();
    BY_SYSTEM = new Map();
    for (const key of STATION_KEYS) {
      const sys = (DATA.stations[key].system || key.split('/')[0] || '').toUpperCase();
      if (!BY_SYSTEM.has(sys)) BY_SYSTEM.set(sys, []);
      BY_SYSTEM.get(sys).push(key);
    }
  }

  /**
   * Ranked search over local station keys.
   * Matches: exact key, "system/station", station name, system name (lists all stations in system).
   */
  function searchStations(query, limit) {
    limit = limit || 40;
    const q = (query || '').trim();
    if (!q) {
      return STATION_KEYS.slice(0, limit).map(k => ({ key: k, score: 0, reason: '' }));
    }
    const upper = q.toUpperCase();
    const scored = [];

    // System-only match: show every station in that system
    if (BY_SYSTEM.has(upper)) {
      for (const k of BY_SYSTEM.get(upper)) {
        scored.push({ key: k, score: 1000, reason: 'system' });
      }
    }

    for (const key of STATION_KEYS) {
      const ku = key.toUpperCase();
      if (ku === upper) {
        scored.push({ key, score: 2000, reason: 'exact' });
        continue;
      }
      const slash = ku.indexOf('/');
      const sys = slash >= 0 ? ku.slice(0, slash) : ku;
      const stn = slash >= 0 ? ku.slice(slash + 1) : '';

      let score = 0;
      if (ku.startsWith(upper)) score = 900;
      else if (stn.startsWith(upper)) score = 800;
      else if (sys.startsWith(upper)) score = 700;
      else if (ku.includes(upper)) score = 500;
      else if (stn.includes(upper)) score = 450;
      else if (sys.includes(upper)) score = 400;
      else continue;

      // prefer shorter names slightly
      score -= Math.min(key.length, 80) * 0.01;
      scored.push({ key, score, reason: 'match' });
    }

    // de-dupe keeping best score
    const best = new Map();
    for (const s of scored) {
      const prev = best.get(s.key);
      if (!prev || s.score > prev.score) best.set(s.key, s);
    }
    return Array.from(best.values())
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  function resolveStationKey(input) {
    if (!input || !DATA) return null;
    const raw = input.trim();
    if (!raw) return null;
    if (DATA.stations[raw]) return raw;
    const upper = raw.toUpperCase();
    if (DATA.stations[upper]) return upper;
    // exact case-insensitive key match
    const exact = STATION_KEYS.find(k => k.toUpperCase() === upper);
    if (exact) return exact;
    // "Station Name [System]" style
    const bracket = upper.match(/^(.*)\s*\[(.*)\]\s*$/);
    if (bracket) {
      const stn = bracket[1].trim();
      const sys = bracket[2].trim();
      const hit = STATION_KEYS.find(k => {
        const parts = k.toUpperCase().split('/');
        return parts[0] === sys && parts.slice(1).join('/') === stn;
      });
      if (hit) return hit;
    }
    // unique station-name match (e.g. user typed only "Jameson Memorial")
    const byName = STATION_KEYS.filter(k => {
      const stn = k.includes('/') ? k.slice(k.indexOf('/') + 1) : k;
      return stn.toUpperCase() === upper;
    });
    if (byName.length === 1) return byName[0];
    // unique system with single station
    if (BY_SYSTEM.has(upper) && BY_SYSTEM.get(upper).length === 1) {
      return BY_SYSTEM.get(upper)[0];
    }
    // system/station partial: normalize spaces
    const compact = upper.replace(/\s+/g, ' ');
    const soft = STATION_KEYS.find(k => k.toUpperCase().replace(/\s+/g, ' ') === compact);
    if (soft) return soft;
    return null;
  }

  /* ---------- Autocomplete widget ---------- */

  function attachAutocomplete(input) {
    const wrap = document.createElement('div');
    wrap.className = 'ac-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.removeAttribute('list');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    const panel = document.createElement('div');
    panel.className = 'ac-panel';
    panel.hidden = true;
    wrap.appendChild(panel);

    let activeIdx = -1;
    let currentItems = [];
    let debounceTimer = null;

    function close() {
      panel.hidden = true;
      activeIdx = -1;
      panel.innerHTML = '';
    }

    function openWith(items, query) {
      currentItems = items;
      activeIdx = items.length ? 0 : -1;
      panel.innerHTML = '';

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'ac-empty';
        const q = (query || '').trim();
        empty.innerHTML = q
          ? `No match in the current market snapshot for “${escapeHtml(q)}”.<br>
             <a href="${inaraSearchUrl(q)}" target="_blank" rel="noopener">Search on Inara ↗</a>
             <span class="ac-hint">— list only includes stations with trade data in this build.</span>`
          : 'Type a system or station name…';
        panel.appendChild(empty);
        panel.hidden = false;
        return;
      }

      items.forEach((item, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ac-item' + (i === activeIdx ? ' active' : '');
        row.setAttribute('data-idx', String(i));
        const parts = item.key.split('/');
        const sys = parts[0] || '';
        const stn = parts.slice(1).join('/') || item.key;
        row.innerHTML =
          `<span class="ac-stn">${escapeHtml(stn)}</span>` +
          `<span class="ac-sys">${escapeHtml(sys)}</span>`;
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(item.key);
        });
        panel.appendChild(row);
      });

      const footer = document.createElement('div');
      footer.className = 'ac-footer';
      footer.innerHTML =
        `${items.length} shown · ${STATION_KEYS.length.toLocaleString()} stations in snapshot · ` +
        `<a href="${inaraSearchUrl(query || '')}" target="_blank" rel="noopener">Inara search ↗</a>`;
      panel.appendChild(footer);
      panel.hidden = false;
    }

    function pick(key) {
      input.value = key;
      close();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function refresh() {
      const q = input.value;
      const items = searchStations(q, 40);
      openWith(items, q);
    }

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, 60);
    });
    input.addEventListener('focus', () => {
      refresh();
    });
    input.addEventListener('blur', () => {
      // delay so mousedown on item can fire
      setTimeout(close, 150);
    });
    input.addEventListener('keydown', (e) => {
      if (panel.hidden) {
        if (e.key === 'ArrowDown') {
          refresh();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, currentItems.length - 1);
        paintActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        paintActive();
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && currentItems[activeIdx]) {
          e.preventDefault();
          pick(currentItems[activeIdx].key);
        }
      } else if (e.key === 'Escape') {
        close();
      }
    });

    function paintActive() {
      panel.querySelectorAll('.ac-item').forEach((el, i) => {
        el.classList.toggle('active', i === activeIdx);
        if (i === activeIdx) el.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- Data load ---------- */

  async function loadData() {
    const res = await fetch('trade-data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not load trade-data.json (' + res.status + ')');
    const meta = await res.json();

    // Sharded format: meta has systems + shards[]; legacy format has stations inline
    if (meta.shards && meta.shards.length) {
      DATA = { generated_at: meta.generated_at, source: meta.source, systems: meta.systems || {}, stations: {} };
      for (const name of meta.shards) {
        const r = await fetch(name, { cache: 'no-store' });
        if (!r.ok) throw new Error('Could not load shard ' + name + ' (' + r.status + ')');
        const part = await r.json();
        Object.assign(DATA.stations, part.stations || part);
      }
    } else if (meta.stations) {
      DATA = meta;
    } else {
      throw new Error('trade-data.json has no stations or shards');
    }
    indexStations();

    const stamp = DATA.generated_at ? new Date(DATA.generated_at) : null;
    const n = STATION_KEYS.length;
    const src = DATA.source ? ` · source ${DATA.source}` : '';
    const label = stamp
      ? `${n.toLocaleString()} stations · updated ${stamp.toLocaleString()}${src}`
      : `${n.toLocaleString()} stations${src}`;
    $('dataStamp').textContent = label;
    $('aboutStamp').textContent = stamp
      ? `Current snapshot generated ${stamp.toISOString()}${DATA.source ? ' from ' + DATA.source : ''}.`
      : '';

    // Remove legacy datalist if present
    const dl = $('stationList');
    if (dl) dl.remove();

    ['startStation', 'qFrom', 'qTo'].forEach((id) => {
      const el = $(id);
      if (el) attachAutocomplete(el);
    });
  }

  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        $('tab-' + btn.dataset.tab).classList.add('active');
      });
    });
  }

  let lastRoutes = [];

  function routeMetrics(route) {
    const hops = route.hops || [];
    const dist = hops.reduce((s, h) => s + (h.distLy || 0), 0);
    const n = hops.length || 1;
    const profit = route.totalProfit || 0;
    let tons = 0;
    hops.forEach(h => (h.load || []).forEach(l => { tons += l.units || 0; }));
    return {
      profit,
      dist,
      hops: n,
      profitPerHop: profit / n,
      profitPerLy: dist > 0 ? profit / dist : profit,
      crPerTon: tons > 0 ? profit / tons : 0,
    };
  }

  function sortRoutes(routes, sortBy) {
    const scored = routes.map(r => ({ r, m: routeMetrics(r) }));
    const cmp = {
      profit: (a, b) => b.m.profit - a.m.profit,
      profitPerHop: (a, b) => b.m.profitPerHop - a.m.profitPerHop,
      profitPerLy: (a, b) => b.m.profitPerLy - a.m.profitPerLy,
      shortest: (a, b) => a.m.dist - b.m.dist || b.m.profit - a.m.profit,
      fewestHops: (a, b) => a.m.hops - b.m.hops || b.m.profit - a.m.profit,
      crPerTon: (a, b) => b.m.crPerTon - a.m.crPerTon,
    }[sortBy] || ((a, b) => b.m.profit - a.m.profit);
    scored.sort(cmp);
    return scored.map(x => x.r);
  }

  function renderRoutes(routes, sortBy) {
    const container = $('runResults');
    container.innerHTML = '';
    lastRoutes = routes || [];
    if (!lastRoutes.length) {
      container.innerHTML = '<p class="status error">No profitable route found with these constraints. Try a larger jump range, more hops, or fewer avoid-rules.</p>';
      return;
    }

    const sort = sortBy || ($('sortBy') && $('sortBy').value) || 'profit';
    const maxN = Number(($('maxResults') && $('maxResults').value) || 8);
    const ordered = sortRoutes(lastRoutes, sort).slice(0, maxN);

    const toolbar = document.createElement('div');
    toolbar.className = 'results-toolbar';
    toolbar.innerHTML = `<span class="muted">${ordered.length} route${ordered.length === 1 ? '' : 's'} (sorted by ${sort})</span>`;
    container.appendChild(toolbar);

    ordered.forEach((route, i) => {
      const m = routeMetrics(route);
      const card = document.createElement('div');
      card.className = 'route-card';

      const head = document.createElement('div');
      head.className = 'route-card-head';
      head.innerHTML =
        `<span>Route ${i + 1}</span>` +
        `<span class="route-meta">${m.dist.toFixed(1)} ly · ${m.hops} hop${m.hops === 1 ? '' : 's'} · ${fmtCr(Math.round(m.profitPerLy))}/ly</span>` +
        `<span class="total">+${fmtCr(route.totalProfit)}</span>`;
      card.appendChild(head);

      route.hops.forEach(h => {
        const hop = document.createElement('div');
        hop.className = 'hop';
        const rows = h.load.map(l =>
          `<tr><td>${escapeHtml(l.commodity)}</td><td class="num">${l.units}</td><td class="num">${l.buy}</td><td class="num">${l.sell}</td><td class="num">+${Math.round(l.profit).toLocaleString()}</td></tr>`
        ).join('');
        const fromLink = inaraStationUrl(h.from.key);
        const toLink = inaraStationUrl(h.to.key);
        hop.innerHTML = `
          <div class="hop-route">
            <span class="hop-stations">
              ${stationLinkHtml(h.from.key)}
              <span class="hop-arrow">→</span>
              ${stationLinkHtml(h.to.key)}
            </span>
            <span class="dist">${h.distLy.toFixed(1)} ly</span>
            <span class="hop-profit">+${fmtCr(h.profit)}</span>
          </div>
          <table class="load-table">
            <thead><tr><th>Commodity</th><th class="num">Units</th><th class="num">Buy</th><th class="num">Sell</th><th class="num">Profit</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        `;
        card.appendChild(hop);
      });

      container.appendChild(card);
    });
  }

  function setupRunForm() {
    if ($('sortBy')) {
      $('sortBy').addEventListener('change', () => {
        if (lastRoutes && lastRoutes.length) renderRoutes(lastRoutes, $('sortBy').value);
      });
    }

    $('runForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const status = $('runStatus');
      const btn = e.target.querySelector('button[type=submit]');
      status.className = 'status';
      status.textContent = 'Plotting…';
      btn.disabled = true;

      setTimeout(() => {
        try {
          const typed = $('startStation').value;
          const startKey = resolveStationKey(typed);
          if (!startKey) {
            const inara = inaraSearchUrl(typed);
            throw new Error(
              'Unknown starting station in this market snapshot. ' +
              'Pick a suggestion from the list, or search Inara: ' + inara
            );
          }

          const opts = {
            startKey,
            credits: Number($('credits').value),
            insurance: Number($('insurance').value),
            capacity: Number($('capacity').value),
            lyPer: Number($('lyPer').value),
            jumpsPer: Number($('jumpsPer').value),
            hops: Number($('hops').value),
            loop: $('loop').checked,
            noRevisit: $('noRevisit').checked,
            noPlanetary: !($('includeOdyssey') && $('includeOdyssey').checked),
            towardSystem: $('towardSystem').value.trim() || undefined,
            avoidSystems: splitList($('avoidSystems').value),
            avoidStations: splitList($('avoidStations') ? $('avoidStations').value : ''),
            avoidCommodities: splitList($('avoidCommodities').value),
            minProfitPerUnit: Number($('minProfit').value),
            distancePenalty: Number($('distancePenalty').value),
            beamWidth: Number($('beamWidth').value),
            requirePad: ($('padSize') && $('padSize').value) || 'any',
            maxStationLs: Number(($('maxStationLs') && $('maxStationLs').value) || 0),
          };

          const t0 = performance.now();
          let routes = findRoutes(DATA, opts);
          const minTotal = Number(($('minRouteProfit') && $('minRouteProfit').value) || 0);
          if (minTotal > 0) {
            routes = routes.filter(r => (r.totalProfit || 0) >= minTotal);
          }
          const ms = Math.round(performance.now() - t0);

          status.textContent = `Evaluated in ${ms}ms · start ${startKey} · ${routes.length} route(s)`;
          renderRoutes(routes, $('sortBy') && $('sortBy').value);
        } catch (err) {
          status.className = 'status error';
          status.innerHTML = escapeHtml(err.message).replace(
            /(https:\/\/inara\.cz\/[^\s]+)/g,
            '<a href="$1" target="_blank" rel="noopener">$1</a>'
          );
          $('runResults').innerHTML = '';
        } finally {
          btn.disabled = false;
        }
      }, 20);
    });
  }

  function setupQuickForm() {
    $('quickForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const container = $('quickResults');
      try {
        const fromKey = resolveStationKey($('qFrom').value);
        const toKey = resolveStationKey($('qTo').value);
        if (!fromKey || !toKey) {
          throw new Error('Pick both stations from the suggestions (must exist in the current market snapshot).');
        }

        const { load, totalProfit } = bestSingleTrade(
          DATA, fromKey, toKey,
          Number($('qCredits').value),
          Number($('qCapacity').value)
        );

        if (!load.length) {
          container.innerHTML = '<p class="status error">No profitable commodity moves between those two stations.</p>';
          return;
        }

        const rows = load.map(l =>
          `<tr><td>${l.commodity}</td><td class="num">${l.units}</td><td class="num">${l.buy}</td><td class="num">${l.sell}</td><td class="num">+${Math.round(l.profit).toLocaleString()}</td></tr>`
        ).join('');

        container.innerHTML = `
          <div class="route-card">
            <div class="route-card-head"><span>${stationLinkHtml(fromKey)} → ${stationLinkHtml(toKey)}</span><span class="total">+${fmtCr(totalProfit)}</span></div>
            <div class="hop">
              <table class="load-table">
                <thead><tr><th>Commodity</th><th class="num">Units</th><th class="num">Buy</th><th class="num">Sell</th><th class="num">Profit</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
      } catch (err) {
        container.innerHTML = `<p class="status error">${escapeHtml(err.message)}</p>`;
      }
    });
  }

  async function init() {
    setupTabs();
    try {
      await loadData();
      setupRunForm();
      setupQuickForm();
    } catch (err) {
      $('dataStamp').textContent = 'Failed to load dataset: ' + err.message;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
