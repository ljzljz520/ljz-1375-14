/* 访客地图页：地图与列表共享同一组筛选条件；瓦片失败自动降级；旧代响应丢弃。 */
(function () {
  var VIEW = { minLng: 106.5, minLat: 32.8, maxLng: 109.6, maxLat: 34.6 };
  var TILE = { z: 3, x: 6, y: 2 }; // 覆盖 VIEW 的演示瓦片
  var state = ClientCore.createState();
  var ingredientNames = {};

  function $(id) { return document.getElementById(id); }

  function filters() {
    return {
      month: $('f-month').value,
      ingredient_id: $('f-ingredient').value,
      region: $('f-region').value,
      open_now: $('f-opennow').checked,
    };
  }

  function queryString(extra) {
    var p = new URLSearchParams();
    var f = filters();
    if (f.month && f.month !== '0') p.set('month', f.month);
    if (f.ingredient_id) p.set('ingredient_id', f.ingredient_id);
    if (f.region) p.set('region', f.region);
    if (f.open_now) p.set('open_now', '1');
    if (state.gen != null) p.set('gen', String(state.gen));
    if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
    return p.toString();
  }

  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return { ok: r.ok, status: r.status, body: body };
      });
    });
  }

  function showNotice(text) {
    var n = $('notice');
    if (!text) { n.hidden = true; return; }
    n.textContent = text;
    n.hidden = false;
  }

  function setGenBadge(gen) {
    $('gen-badge').textContent = '数据代 gen=' + gen;
  }

  // 服务端标记 stale（旧筛选请求晚到）-> 采用新代并重取一次
  function acceptOrReload(body, reload) {
    if (ClientCore.shouldAccept(state, body)) {
      ClientCore.adoptGen(state, body.gen);
      return true;
    }
    if (typeof body.gen === 'number') {
      ClientCore.adoptGen(state, body.gen);
      reload();
    }
    return false;
  }

  // ---- 列表（与地图共享筛选） ----
  function loadList() {
    return fetchJSON('/api/stalls?' + queryString()).then(function (r) {
      if (!acceptOrReload(r.body, loadList)) return;
      setGenBadge(r.body.gen);
      renderList(r.body.stalls || []);
    });
  }

  function renderList(stalls) {
    var el = $('list');
    el.innerHTML = '';
    if (!stalls.length) {
      el.innerHTML = '<p>当前筛选条件下没有摊位。</p>';
      return;
    }
    stalls.forEach(function (s) {
      var card = document.createElement('div');
      card.className = 'card';
      var badges = [];
      badges.push(s.in_season_now
        ? '<span class="tag ok">应季供应中</span>'
        : '<span class="tag no">非应季</span>');
      badges.push(s.open_now
        ? '<span class="tag ok">当前营业</span>'
        : '<span class="tag no">当前休息</span>');
      if (s.temporarily_closed) badges.push('<span class="tag warn">临时停业</span>');
      card.innerHTML = '<div class="card-body"><h3>' + esc(s.name) + '</h3>'
        + '<div class="badge-row">' + badges.join('') + '</div>'
        + '<p>' + esc(s.region) + ' · ' + s.lng.toFixed(4) + ', ' + s.lat.toFixed(4) + '</p>'
        + '<p>' + (s.available_now ? '当前可购买' : '当前不可购买（应季与营业需同时满足）') + '</p>'
        + '</div>';
      card.addEventListener('click', function () { showDetail(s.id); });
      el.appendChild(card);
    });
  }

  // ---- 地图标记：优先瓦片聚合，失败降级为直接查询 ----
  function loadMarkers() {
    var tileUrl = '/api/tiles/' + TILE.z + '/' + TILE.x + '/' + TILE.y + '?' + queryString();
    return fetchJSON(tileUrl).then(function (r) {
      if (!r.ok) {
        // 瓦片失败：回退到摊位查询接口
        var plan = ClientCore.markerPlan(false);
        if (plan === 'stalls-fallback') {
          showNotice('地图瓦片加载失败，已切换为直接加载摊位数据。');
          return fetchJSON('/api/stalls?' + queryString({
            bbox: [VIEW.minLng, VIEW.minLat, VIEW.maxLng, VIEW.maxLat].join(','),
          })).then(function (r2) {
            if (!acceptOrReload(r2.body, loadMarkers)) return;
            renderPoints(r2.body.stalls || []);
          });
        }
        return;
      }
      if (!acceptOrReload(r.body, loadMarkers)) return;
      renderClusters(r.body.clusters || []);
    });
  }

  function project(lng, lat) {
    var x = ((lng - VIEW.minLng) / (VIEW.maxLng - VIEW.minLng)) * 960;
    var y = ((VIEW.maxLat - lat) / (VIEW.maxLat - VIEW.minLat)) * 480;
    return { x: x, y: y };
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function renderClusters(clusters) {
    var map = $('map');
    map.innerHTML = '';
    clusters.forEach(function (c) {
      var p = project(c.lng, c.lat);
      var g = svgEl('g', { 'class': 'cluster' });
      g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 12 + Math.min(10, c.count * 2) }));
      var t = svgEl('text', { x: p.x, y: p.y });
      t.textContent = String(c.count);
      g.appendChild(t);
      g.addEventListener('click', function () { showCluster(c); });
      map.appendChild(g);
    });
  }

  function renderPoints(stalls) {
    var map = $('map');
    map.innerHTML = '';
    stalls.forEach(function (s) {
      var p = project(s.lng, s.lat);
      var c = svgEl('circle', {
        'class': 'stall-dot' + (s.open_now ? '' : ' closed'),
        cx: p.x, cy: p.y, r: 7,
      });
      c.addEventListener('click', function () { showDetail(s.id); });
      map.appendChild(c);
    });
  }

  function showCluster(c) {
    var d = $('detail');
    d.hidden = false;
    d.innerHTML = '<h3>该网格共 ' + c.count + ' 个摊位</h3><p>同坐标多摊分别计数，不合并商户。</p>';
    var ul = document.createElement('ul');
    c.stall_ids.forEach(function (id) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = 'javascript:void(0)';
      a.textContent = id;
      a.addEventListener('click', function () { showDetail(id); });
      li.appendChild(a);
      ul.appendChild(li);
    });
    d.appendChild(ul);
  }

  function fmtIntervals(ivs) {
    if (!ivs) return '无地区时令数据';
    return ivs.map(function (iv) {
      var wrap = (iv.start.m * 100 + iv.start.d) > (iv.end.m * 100 + iv.end.d);
      return pad(iv.start.m) + '-' + pad(iv.start.d) + ' 至 ' + pad(iv.end.m) + '-' + pad(iv.end.d)
        + (wrap ? '（跨年）' : '');
    }).join('；');
  }

  function fmtSegments(hours) {
    if (!hours.length) return '无营业段数据';
    return hours.map(function (h) {
      return h.segments.map(function (seg) {
        var wrap = seg.close <= seg.open;
        return seg.open + '–' + seg.close + (wrap ? '（跨午夜）' : '');
      }).join('，');
    }).join('；');
  }

  function showDetail(id) {
    return fetchJSON('/api/stalls/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok || !r.body.stall) return;
      var s = r.body.stall;
      var d = $('detail');
      d.hidden = false;
      var html = '<h3>' + esc(s.name) + '</h3>'
        + '<p>' + esc(s.region) + ' · ' + s.lng.toFixed(4) + ', ' + s.lat.toFixed(4) + '</p>';
      html += '<p><b>供应（季节性）：</b><br>' + s.offerings.map(function (o) {
        return esc(o.ingredient_name) + ' '
          + (o.in_season ? '<span class="tag ok">应季中</span>' : '<span class="tag no">不应季</span>')
          + '<br><small>' + fmtIntervals(o.intervals) + '</small>';
      }).join('<br>') + '</p>';
      html += '<p><b>营业（当天实际）：</b> '
        + (s.open_now ? '<span class="tag ok">营业中</span>' : '<span class="tag no">休息中</span>')
        + '<br><small>' + fmtSegments(s.hours) + '</small></p>';
      if (s.temporarily_closed && s.closures.length) {
        var c = s.closures[0];
        html += '<p><span class="tag warn">临时停业</span> 至 ' + esc(c.effective_to)
          + '<br><small>来源日期 ' + esc(c.source_date)
          + (c.announced_at ? ' · 公告时间 ' + esc(c.announced_at) : ' · 公告未发布') + '</small></p>';
      }
      if (s.queue) {
        var t = new Date(s.queue.collected_at);
        var hhmm = pad(t.getHours()) + ':' + pad(t.getMinutes());
        html += '<p><b>排队：</b>约 ' + s.queue.minutes + ' 分钟（采集于 ' + hhmm
          + (s.queue.stale ? '，可能已过时' : '') + '）</p>';
      }
      html += '<p><b>' + (s.available_now ? '当前可购买' : '当前不可购买')
        + '</b><br><small>可购买 = 应季供应 ∧ 实际营业，不能只看月份。</small></p>';
      d.innerHTML = html;
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  function refresh() {
    showNotice('');
    loadList();
    loadMarkers();
  }

  // 初始化筛选器
  function init() {
    var mSel = $('f-month');
    mSel.innerHTML = '<option value="0">全年</option>';
    for (var m = 1; m <= 12; m += 1) {
      var o = document.createElement('option');
      o.value = String(m);
      o.textContent = m + ' 月';
      mSel.appendChild(o);
    }
    mSel.value = String(new Date().getMonth() + 1);
    fetchJSON('/api/meta').then(function (r) {
      if (!r.ok) return;
      (r.body.ingredients || []).forEach(function (i) {
        ingredientNames[i.id] = i.name;
        var o = document.createElement('option');
        o.value = i.id;
        o.textContent = i.name;
        $('f-ingredient').appendChild(o);
      });
      (r.body.regions || []).forEach(function (rg) {
        var o = document.createElement('option');
        o.value = rg;
        o.textContent = rg;
        $('f-region').appendChild(o);
      });
      ClientCore.adoptGen(state, r.body.gen);
      refresh();
    });
    ['f-month', 'f-ingredient', 'f-region', 'f-opennow'].forEach(function (id) {
      $(id).addEventListener('change', refresh);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
}());
