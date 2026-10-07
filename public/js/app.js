/* 访客端：地图与列表共享筛选；旧/过期请求丢弃；瓦片失败降级；同坐标不合并 */
(function () {
  'use strict';
  const C = window.FoodCore;
  const $ = s => document.querySelector(s);

  const state = {
    meta: null,
    genId: null,
    regions: [], ingredients: [],
    filters: { at: '', region: '', ingredient: '', q: '', inSeason: false, open: false },
    view: { lon: 108.95, lat: 34.28, zoom: 12 },
    stalls: [],
    tileFailed: false,
    querySeq: 0
  };

  function flash(msg) {
    const el = $('#flash');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(flash._t); flash._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function qs() {
    const f = state.filters, p = new URLSearchParams();
    if (f.at) p.set('at', f.at);
    if (f.region) p.set('region', f.region);
    if (f.ingredient) p.set('ingredient', f.ingredient);
    if (f.q) p.set('q', f.q);
    if (f.inSeason) p.set('inSeason', '1');
    if (f.open) p.set('open', '1');
    return p.toString();
  }

  async function getJson(url, opts) {
    opts = opts || {};
    if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function loadMeta() {
    const m = await getJson('/api/meta');
    const first = !state.meta;
    const oldGen = state.genId;
    state.meta = m; state.genId = m.generation.genId;
    state.regions = m.regions; state.ingredients = m.ingredients;
    if (first) populateSelects();
    $('#gen-info').textContent = '数据代际：' + m.generation.genId + '（发布于 ' + fmt(m.generation.publishedAt) + '）' + (m.generation.note ? ' 备注：' + m.generation.note : '');
    renderRoutes(m.routes);
    return { first, oldGen };
  }

  function fmt(iso) {
    if (!iso) return '—';
    return iso.replace('T', ' ').slice(0, 16);
  }

  function populateSelects() {
    const rs = $('#f-region'), is = $('#f-ing');
    state.regions.forEach(r => rs.add(new Option(r.name, r.id)));
    state.ingredients.forEach(i => {
      const wins = i.windows.map(w =>
        C.pad2(w.startMonth) + '-' + C.pad2(w.startDay) + '~' + C.pad2(w.endMonth) + '-' + C.pad2(w.endDay) +
        (w.crossYear ? '跨年' : '') + (w.region && w.region !== '*' ? '·' + regionName(w.region) : '')
      ).join('；');
      is.add(new Option(i.name + '（' + (wins || '无显式窗口') + '）', i.id));
    });
  }
  function regionName(id) { const r = state.regions.find(x => x.id === id); return r ? r.name : id; }

  function readFiltersFromDom() {
    state.filters = {
      at: $('#f-at').value ? $('#f-at').value + ':00' : '',
      region: $('#f-region').value,
      ingredient: $('#f-ing').value,
      q: $('#f-q').value.trim(),
      inSeason: $('#f-inseason').checked,
      open: $('#f-open').checked
    };
  }

  /**
   * 应用筛选：地图/列表/统计共用同一查询串。
   * seq 防止“旧筛选请求晚到”覆盖新结果；代际不符则丢弃并按新代际重查。
   */
  async function applyFilters(opts) {
    opts = opts || {};
    readFiltersFromDom();
    const seq = ++state.querySeq;
    const q = qs();
    try {
      const [data, stats] = await Promise.all([
        getJson('/api/stalls?' + q, { delay: opts.late ? 1500 : 0 }),
        getJson('/api/stats?' + q, { delay: opts.late ? 1500 : 0 })
      ]);
      if (seq !== state.querySeq) {
        console.info('[丢弃] 旧筛选结果晚到 seq=' + seq + '，当前 seq=' + state.querySeq);
        return; // 旧请求晚到：不渲染、不覆盖
      }
      if (data.generation.genId !== state.genId) {
        flash('数据刚刚发布（' + state.genId + ' → ' + data.generation.genId + '），已为你按新代际刷新');
        state.genId = data.generation.genId;
        $('#gen-info').textContent = '数据代际：' + data.generation.genId + '（发布于 ' + fmt(data.generation.publishedAt) + '）';
      }
      state.stalls = data.stalls;
      $('#eval-at').textContent = fmt(data.evaluatedAt);
      renderStats(stats.aggregate);
      renderCards();
      drawMap();
    } catch (e) {
      if (seq === state.querySeq) flash('查询失败：' + e.message);
    }
  }

  function renderStats(a) {
    const el = $('#stats');
    const cell = (n, t, color) => '<div class="stat"><b style="color:' + (color || '') + '">' + n + '</b>' + t + '</div>';
    el.innerHTML =
      cell(a.totalStalls, '摊位总数（按身份去重）') +
      cell(a.open, '此刻营业', 'var(--green)') +
      cell(a.suspended, '临时停业', 'var(--amber)') +
      cell(a.closed, '非营业时段', 'var(--gray)') +
      cell(a.inSeasonStalls, '有在季供应') +
      cell(a.distinctCoordinates, '不同坐标数') +
      (a.coLocated.length ? '<div class="stat" style="min-width:160px;text-align:left"><b style="font-size:13px;color:var(--gold)">同坐标多摊 ×' + a.coLocated.length + '</b><span class="colocated-note">' +
        a.coLocated.map(c => c.stallIds.join(' + ')).join('；') + '<br>各算独立商户，不合并</span></div>' : '');
  }

  function statusTag(s) {
    const map = {
      open: ['open', '营业中'], closed: ['closed', '非营业时段'], suspended: ['suspended', '临时停业']
    };
    const [cls, txt] = map[s.status.status];
    return '<span class="tag ' + cls + '">' + txt + '</span>';
  }

  function renderCards() {
    const box = $('#cards');
    $('#list-count').textContent = '（' + state.stalls.length + ' 个摊位）';
    if (!state.stalls.length) { box.innerHTML = '<p class="note">无匹配摊位。注意：在季与营业是两件事。</p>'; return; }
    box.innerHTML = state.stalls.map(s => {
      const offers = s.offers.map(o =>
        '<span class="tag ' + (o.inSeason ? 'season' : 'offseason') + '">' +
        escapeHtml(o.name) + (o.inSeason ? '·在季' : '·非季') + '</span>').join('');
      const segs = s.segments.map(g => {
        const cross = g.end <= g.start ? '（跨午夜）' : '';
        return g.start + '–' + g.end + cross + ' 周' + (g.days || [1, 2, 3, 4, 5, 6, 7]).map(d => '日一二三四五六'[d % 7]).join('');
      }).join('；');
      let closure = '';
      if (s.status.status === 'suspended') {
        closure = '<div class="closurebox">临时停业：' + escapeHtml(s.status.reason) +
          '<br>生效范围 ' + s.status.effectiveFrom + ' ~ ' + s.status.effectiveTo +
          ' · 告示时间 ' + fmt(s.status.announcedAt) +
          '<br><span class="note">以编辑写入的生效范围为准，即使早于正式公告也生效。</span></div>';
      }
      const queues = s.queues.map(q => {
        if (q.fresh) {
          return '<div class="queue">排队约 ' + q.waitMinutes + ' 分钟（采集于 ' + fmt(q.collectedAt) +
            '，有效期至 ' + fmt(q.freshUntil) + '，来源：' + escapeHtml(q.source) + '）</div>';
        }
        return '<div class="queue stale">⚠ 历史排队信息：' + q.waitMinutes + ' 分钟，<b>采集于 ' + fmt(q.collectedAt) +
          '</b>，已过期，<u>不是实时事实</u>，仅供参考。</div>';
      }).join('');
      return '<div class="card" data-id="' + s.id + '">' +
        '<h3>' + escapeHtml(s.name) + ' ' + statusTag(s) + '</h3>' +
        '<div class="meta">' + escapeHtml(s.address || '') + ' · ' + escapeHtml(regionName(s.region)) +
        ' · 摊位身份 ' + s.id + (s.owner ? ' · ' + escapeHtml(s.owner) : '') + '</div>' +
        '<div class="tags">' + offers + '</div>' +
        '<div class="segs">营业段：' + segs + '</div>' + closure + queues + '</div>';
    }).join('');
  }

  function escapeHtml(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  /* ---------------- 地图（瓦片 + 标记叠加，同坐标多摊错位绘制） ---------------- */
  // Web Mercator 正方形像素：两个方向都以“每像素的归一化跨度 span”一致映射
  function project(lon, lat, w, h) {
    const n = Math.pow(2, state.view.zoom);
    const [cx, cy] = C.lonLatToNorm(state.view.lon, state.view.lat);
    const [x, y] = C.lonLatToNorm(lon, lat);
    const span = 1 / (n * 256); // 每像素的归一化跨度
    return [w / 2 + (x - cx) / span, h / 2 + (y - cy) / span];
  }

  function inverseProject(px, py, w, h) {
    const n = Math.pow(2, state.view.zoom);
    const [cx, cy] = C.lonLatToNorm(state.view.lon, state.view.lat);
    const span = 1 / (n * 256);
    const nx = cx + (px - w / 2) * span;
    const ny = cy + (py - h / 2) * span;
    // norm -> lon/lat
    const lon = nx * 360 - 180;
    const lat = (2 * Math.atan(Math.exp((0.5 - ny) * 4 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
    return [lon, lat];
  }

  function drawMap() {
    const box = $('#mapbox'), svg = $('#map');
    const w = box.clientWidth || 560, h = box.clientHeight || 460;
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    let html = '';

    // 瓦片层
    if (!state.tileFailed) {
      const z = state.view.zoom, n = Math.pow(2, z);
      const [lonL, latT] = inverseProject(0, 0, w, h);
      const [lonR, latB] = inverseProject(w, h, w, h);
      const [nx0] = C.lonLatToNorm(lonL, latT), [nx1, ny1] = C.lonLatToNorm(lonR, latB);
      const [, ny0] = C.lonLatToNorm(lonL, latT);
      const tx0 = Math.max(0, Math.floor(nx0 * n)), tx1 = Math.min(n - 1, Math.floor(nx1 * n));
      const ty0 = Math.max(0, Math.floor(ny0 * n)), ty1 = Math.min(n - 1, Math.floor(ny1 * n));
      for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
        const px0 = tx / n, py0 = ty / n, px1 = (tx + 1) / n, py1 = (ty + 1) / n;
        const [xa] = projectPx(px0, py0); const [, yb] = projectPx(px0, py1); const [xb] = projectPx(px1, py0); const [, ya] = projectPx(px0, py0);
        const href = '/api/tiles/' + z + '/' + tx + '/' + ty + '.svg';
        html += '<image x="' + xa + '" y="' + ya + '" width="' + (xb - xa) + '" height="' + (yb - ya) + '" href="' + href + '" onerror="window.__tileFail && window.__tileFail(this)"><title>' + z + '/' + tx + '/' + ty + '</title></image>';
      }
    }
    function projectPx(nx, ny) {
      const [cx, cy] = C.lonLatToNorm(state.view.lon, state.view.lat);
      const span = 1 / (Math.pow(2, state.view.zoom) * 256);
      return [w / 2 + (nx - cx) / span, h / 2 + (ny - cy) / span];
    }

    // 标记层：按坐标分组，组内各摊错位上下排列，颜色=状态，绝不合成一个点
    const groups = {};
    state.stalls.forEach(s => {
      const k = s.lon.toFixed(6) + ',' + s.lat.toFixed(6);
      (groups[k] = groups[k] || []).push(s);
    });
    html += '<g>';
    Object.keys(groups).forEach(k => {
      const list = groups[k];
      list.forEach((s, i) => {
        const [px, py] = project(s.lon, s.lat, w, h);
        const dy = (i - (list.length - 1) / 2) * 18;
        const color = s.status.status === 'open' ? '#2e7d32' : s.status.status === 'suspended' ? '#b26a00' : '#9aa0a6';
        html += '<g class="mk" data-id="' + s.id + '" style="cursor:pointer">' +
          '<circle cx="' + px + '" cy="' + (py + dy) + '" r="8" fill="' + color + '" stroke="#fff" stroke-width="2"/>' +
          '<text x="' + px + '" y="' + (py + dy + 3) + '" text-anchor="middle" font-size="9" fill="#fff" pointer-events="none">' + (i + 1) + '</text>' +
          '<title>' + escapeHtml(s.name) + '（' + s.id + '）</title></g>';
      });
      if (list.length > 1) {
        const [px, py] = project(list[0].lon, list[0].lat, w, h);
        html += '<text x="' + px + '" y="' + (py - 24) + '" text-anchor="middle" font-size="10" fill="#8a5a00">' + list.length + ' 个独立摊位（同坐标）</text>';
      }
    });
    html += '</g>';
    svg.innerHTML = html;

    svg.querySelectorAll('.mk').forEach(g => g.addEventListener('click', () => {
      const id = g.getAttribute('data-id');
      const card = document.querySelector('.card[data-id="' + id + '"]');
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); card.style.outline = '2px solid var(--gold)'; setTimeout(() => card.style.outline = '', 1200); }
    }));
  }

  window.__tileFail = function () {
    if (state.tileFailed) return;
    state.tileFailed = true;
    $('#map-fail').classList.add('show');
    drawMap(); // 去掉瓦片层，保留标记
  };

  function renderRoutes(routes) {
    $('#routes').innerHTML = routes.map(r => '<li><b>' + escapeHtml(r.title) + '</b> — ' + escapeHtml(r.note || '资料参考') + '</li>').join('');
  }

  async function loadOffline() {
    try {
      const m = await getJson('/api/offline/manifest');
      $('#offline').innerHTML = '离线包代际 <b>' + m.genId + '</b>，发布于 ' + fmt(m.publishedAt) +
        '；结构化数据有效日期范围 <b>' + (m.validity.coversDateFrom || '—') + ' ~ ' + (m.validity.dateTo || '—') + '</b>。' +
        '<br>' + escapeHtml(m.validity.seasonRulesYearNote) +
        '<br>' + escapeHtml(m.validity.queuePolicy) +
        '<br><a href="' + m.bundleUrl + '">下载离线数据包</a>';
    } catch (e) { $('#offline').textContent = '离线 manifest 读取失败：' + e.message; }
  }

  /* ---------------- 事件 ---------------- */
  $('#btn-apply').addEventListener('click', () => applyFilters());
  $('#btn-reset').addEventListener('click', () => {
    ['f-at', 'f-region', 'f-ing', 'f-q'].forEach(id => $('#' + id).value = '');
    $('#f-inseason').checked = $('#f-open').checked = false;
    applyFilters();
  });
  // 演示“旧筛选请求晚到”：本次人为延迟 1.5s，请紧接着再改条件点应用
  $('#f-slow').addEventListener('change', e => {
    if (e.target.checked) {
      flash('已开启晚到模拟：本次查询将延迟 1.5s，请立刻修改条件再次应用');
      applyFilters({ late: true });
      e.target.checked = false;
    }
  });
  $('#zoom-in').addEventListener('click', () => { state.view.zoom = Math.min(16, state.view.zoom + 1); drawMap(); });
  $('#zoom-out').addEventListener('click', () => { state.view.zoom = Math.max(9, state.view.zoom - 1); drawMap(); });
  $('#btn-retry-tile').addEventListener('click', () => { state.tileFailed = false; $('#map-fail').classList.remove('show'); drawMap(); });
  // 拖拽平移
  (function () {
    const svg = $('#map'); let drag = null;
    svg.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', e => {
      if (!drag) return;
      const w = svg.clientWidth, h = svg.clientHeight;
      const [lon1, lat1] = inverseProject(drag.x - svg.getBoundingClientRect().x, drag.y - svg.getBoundingClientRect().y, w, h);
      const [lon2, lat2] = inverseProject(e.clientX - svg.getBoundingClientRect().x, e.clientY - svg.getBoundingClientRect().y, w, h);
      state.view.lon += lon1 - lon2; state.view.lat += lat1 - lat2;
      drag = { x: e.clientX, y: e.clientY };
      drawMap();
    });
    svg.addEventListener('pointerup', () => { drag = null; });
  })();

  // 后台发布后自动切换：轮询代际，变化则重新查询
  setInterval(async () => {
    try {
      const before = state.genId;
      const r = await getJson('/api/meta');
      if (r.generation.genId !== before) {
        state.meta = r; state.genId = r.generation.genId;
        state.ingredients = r.ingredients; state.regions = r.regions;
        flash('检测到新发布 ' + r.generation.genId + '：索引/卡片/地图同代切换');
        applyFilters();
      }
    } catch (e) { /* 忽略轮询失败 */ }
  }, 15000);

  window.addEventListener('resize', drawMap);

  (async function init() {
    await loadMeta();
    await loadOffline();
    await applyFilters();
  })();
})();
