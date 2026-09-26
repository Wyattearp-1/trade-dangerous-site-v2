(function () {
  let DATA = null;

  const $ = (id) => document.getElementById(id);
  const fmtCr = (n) => Math.round(n).toLocaleString('en-US') + ' cr';

  function splitList(str) {
    return (str || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  /** Deep-link to Inara station search (no bulk API available). */
  function inaraStationUrl(stationKey) {
    const parts = stationKey.split('/');
    const system = encodeURIComponent(parts[0] || '');
    const station = encodeURIComponent(parts.slice(1).join('/') || '');
    // Inara search: system + station name
    return `https://inara.cz/elite/stations/?search=${system}+${station}`;
  }

  function stationLabel(key) {
    const link = `<a class="station-link" href="${inaraStationUrl(key)}" target="_blank" rel="noopener" title="Open on Inara">Inara ↗</a>`;
    return `${key}${link}`;
  }

  async function loadData() {
    const res = await fetch('data/trade-data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not load data/trade-data.json (' + res.status + ')');
    DATA = await res.json();

    const stamp = DATA.generated_at ? new Date(DATA.generated_at) : null;
    const n = Object.keys(DATA.stations || {}).length;
    const src = DATA.source ? ` · source ${DATA.source}` : '';
    const label = stamp
      ? `${n.toLocaleString()} stations · updated ${stamp.toLocaleString()}${src}`
      : `${n.toLocaleString()} stations${src}`;
    $('dataStamp').textContent = label;
    $('aboutStamp').textContent = stamp
      ? `Current snapshot generated ${stamp.toISOString()}${DATA.source ? ' from ' + DATA.source : ''}.`
      : '';

    const dl = $('stationList');
    dl.innerHTML = '';
    const keys = Object.keys(DATA.stations).sort();
    for (const key of keys) {
      const opt = document.createElement('option');
      opt.value = key;
      dl.appendChild(opt);
    }
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

  function renderRoutes(routes) {
    const container = $('runResults');
    container.innerHTML = '';
    if (!routes.length) {
      container.innerHTML = '<p class="status error">No profitable route found with these constraints. Try a larger jump range, more hops, or fewer avoid-rules.</p>';
      return;
    }
    routes.forEach((route, i) => {
      const card = document.createElement('div');
      card.className = 'route-card';

      const head = document.createElement('div');
      head.className = 'route-card-head';
      head.innerHTML = `<span>Route ${i + 1}</span><span class="total">+${fmtCr(route.totalProfit)}</span>`;
      card.appendChild(head);

      route.hops.forEach(h => {
        const hop = document.createElement('div');
        hop.className = 'hop';
        const rows = h.load.map(l =>
          `<tr><td>${l.commodity}</td><td class="num">${l.units}</td><td class="num">${l.buy}</td><td class="num">${l.sell}</td><td class="num">+${Math.round(l.profit).toLocaleString()}</td></tr>`
        ).join('');
        hop.innerHTML = `
          <div class="hop-route">
            <span>${stationLabel(h.from.key)} → ${stationLabel(h.to.key)}</span>
            <span class="dist">${h.distLy.toFixed(1)} ly</span>
            <span class="hop-profit">+${fmtCr(h.profit)}</span>
          </div>
          <table class="load-table">
            <thead><tr><th>Commodity</th><th class="num">Units</th><th class="num">Buy</th><th class="num">Sell</th><th class="num">Profit</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`;
        card.appendChild(hop);
      });

      container.appendChild(card);
    });
  }

  function resolveStationKey(input) {
    if (!input) return null;
    if (DATA.stations[input]) return input;
    const upper = input.trim().toUpperCase();
    const match = Object.keys(DATA.stations).find(k => k.toUpperCase() === upper);
    return match || null;
  }

  function setupRunForm() {
    $('runForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const status = $('runStatus');
      const btn = e.target.querySelector('button[type=submit]');
      status.className = 'status';
      status.textContent = 'Plotting…';
      btn.disabled = true;

      setTimeout(() => {
        try {
          const startKey = resolveStationKey($('startStation').value);
          if (!startKey) throw new Error('Unknown starting station — pick one from the list.');

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
            towardSystem: $('towardSystem').value.trim() || undefined,
            avoidSystems: splitList($('avoidSystems').value),
            avoidCommodities: splitList($('avoidCommodities').value),
            minProfitPerUnit: Number($('minProfit').value),
            distancePenalty: Number($('distancePenalty').value),
            beamWidth: Number($('beamWidth').value),
          };

          const t0 = performance.now();
          const routes = findRoutes(DATA, opts);
          const ms = Math.round(performance.now() - t0);

          status.textContent = `Evaluated in ${ms}ms.`;
          renderRoutes(routes);
        } catch (err) {
          status.className = 'status error';
          status.textContent = err.message;
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
        if (!fromKey || !toKey) throw new Error('Pick both stations from the list.');

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
            <div class="route-card-head"><span>${stationLabel(fromKey)} → ${stationLabel(toKey)}</span><span class="total">+${fmtCr(totalProfit)}</span></div>
            <div class="hop">
              <table class="load-table">
                <thead><tr><th>Commodity</th><th class="num">Units</th><th class="num">Buy</th><th class="num">Sell</th><th class="num">Profit</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
      } catch (err) {
        container.innerHTML = `<p class="status error">${err.message}</p>`;
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
