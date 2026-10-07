/* 编辑后台：维护食材季节、摊位位置、营业段、临时停业、排队上报与发布。 */
(function () {
  var drafts = null; // 草稿快照（含版本号，用于乐观锁）

  function $(id) { return document.getElementById(id); }
  function editor() { return $('editor').value || 'anonymous'; }
  function today() { return new Date().toISOString().slice(0, 10); }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Editor': encodeURIComponent(editor()) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        return { ok: r.ok, status: r.status, body: b };
      });
    });
  }

  function msg(id, text, ok) {
    var el = $(id);
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'ok' : 'err');
  }

  function fillSelect(sel, items, labelOf, valueOf) {
    sel.innerHTML = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = valueOf(it);
      o.textContent = labelOf(it);
      sel.appendChild(o);
    });
  }

  function stallList() {
    return Object.values(drafts.drafts.stalls).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  }

  function reload() {
    return api('GET', '/api/admin/drafts').then(function (r) {
      drafts = r.body;
      $('admin-gen').textContent = '线上数据代 gen=' + drafts.gen;
      var stalls = stallList();
      ['loc-stall', 'hrs-stall', 'clo-stall', 'q-stall'].forEach(function (id) {
        var keep = $(id).value;
        fillSelect($(id), stalls, function (s) { return s.id + ' ' + s.name; }, function (s) { return s.id; });
        if (keep) $(id).value = keep;
      });
      fillSelect($('sea-ing'), Object.values(drafts.drafts.ingredients),
        function (i) { return i.name; }, function (i) { return i.id; });
      var seasons = Object.values(drafts.drafts.seasons);
      fillSelect($('sea-select'), seasons, function (s) {
        var ing = drafts.drafts.ingredients[s.ingredient_id];
        return s.id + '（' + (ing ? ing.name : s.ingredient_id) + ' · ' + s.region + '）';
      }, function (s) { return s.id; });
      renderAudit();
      loadLocationForm();
      loadHoursForm();
      loadSeasonForm();
    });
  }

  function renderAudit() {
    var tb = $('audit-body');
    tb.innerHTML = '';
    (drafts.audit || []).slice().reverse().forEach(function (a) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + a.gen + '</td><td>' + a.at + '</td><td>' + a.by + '</td><td>' + (a.note || '') + '</td>';
      tb.appendChild(tr);
    });
  }

  // ---- 摊位位置 ----
  function loadLocationForm() {
    var s = drafts.drafts.stalls[$('loc-stall').value];
    if (!s) return;
    $('loc-lng').value = s.lng;
    $('loc-lat').value = s.lat;
    if (!$('loc-source').value) $('loc-source').value = today();
  }

  $('loc-stall').addEventListener('change', loadLocationForm);
  $('loc-save').addEventListener('click', function () {
    var id = $('loc-stall').value;
    var s = drafts.drafts.stalls[id];
    api('PUT', '/api/admin/stalls/' + id + '/location', {
      lng: Number($('loc-lng').value),
      lat: Number($('loc-lat').value),
      base_version: s.version,
      source_date: $('loc-source').value || today(),
    }).then(function (r) {
      if (r.status === 409) {
        msg('loc-msg', '冲突：数据已被他人修改（当前版本 ' + r.body.current_version + '），已为你刷新。', false);
        reload();
        return;
      }
      if (!r.ok) { msg('loc-msg', '保存失败：' + (r.body.error || r.status), false); return; }
      msg('loc-msg', '已保存到草稿（版本 ' + r.body.version + '），发布后生效。', true);
      reload();
    });
  });

  // ---- 营业段 ----
  function hoursRowFor(stallId) {
    return Object.values(drafts.drafts.hours).find(function (h) { return h.stall_id === stallId; });
  }

  function segRow(seg) {
    var div = document.createElement('div');
    div.className = 'seg-row';
    div.innerHTML = '<input type="time" class="seg-open" value="' + (seg ? seg.open : '09:00') + '">'
      + '<span>至</span>'
      + '<input type="time" class="seg-close" value="' + (seg ? seg.close : '18:00') + '">'
      + '<button type="button" class="ghost seg-del">删除</button>';
    div.querySelector('.seg-del').addEventListener('click', function () { div.remove(); });
    return div;
  }

  function loadHoursForm() {
    var box = $('hrs-segs');
    box.innerHTML = '';
    var row = hoursRowFor($('hrs-stall').value);
    (row ? row.segments : []).forEach(function (seg) { box.appendChild(segRow(seg)); });
    if (!$('hrs-source').value) $('hrs-source').value = today();
  }

  $('hrs-stall').addEventListener('change', loadHoursForm);
  $('hrs-add').addEventListener('click', function () { $('hrs-segs').appendChild(segRow(null)); });
  $('hrs-save').addEventListener('click', function () {
    var stallId = $('hrs-stall').value;
    var row = hoursRowFor(stallId);
    if (!row) { msg('hrs-msg', '该摊位暂无营业段记录', false); return; }
    var segs = Array.prototype.map.call($('hrs-segs').querySelectorAll('.seg-row'), function (div) {
      return { open: div.querySelector('.seg-open').value, close: div.querySelector('.seg-close').value };
    });
    api('PUT', '/api/admin/hours/' + row.id, {
      segments: segs,
      base_version: row.version,
      source_date: $('hrs-source').value || today(),
    }).then(function (r) {
      if (r.status === 409) { msg('hrs-msg', '冲突：已被他人修改，已刷新。', false); reload(); return; }
      if (!r.ok) { msg('hrs-msg', '保存失败：' + (r.body.error || r.status), false); return; }
      msg('hrs-msg', '已保存到草稿，发布后生效。', true);
      reload();
    });
  });

  // ---- 食材季节 ----
  function ivRow(iv) {
    var div = document.createElement('div');
    div.className = 'iv-row';
    function opt(v, max) {
      var s = '';
      for (var i = 1; i <= max; i += 1) s += '<option value="' + i + '"' + (i === v ? ' selected' : '') + '>' + i + '</option>';
      return s;
    }
    div.innerHTML = '<select class="iv-sm">' + opt(iv ? iv.start.m : 1, 12) + '</select>月'
      + '<select class="iv-sd">' + opt(iv ? iv.start.d : 1, 31) + '</select>日'
      + '<span>至</span>'
      + '<select class="iv-em">' + opt(iv ? iv.end.m : 12, 12) + '</select>月'
      + '<select class="iv-ed">' + opt(iv ? iv.end.d : 31, 31) + '</select>日'
      + '<button type="button" class="ghost iv-del">删除</button>';
    div.querySelector('.iv-del').addEventListener('click', function () { div.remove(); });
    return div;
  }

  function loadSeasonForm() {
    var id = $('sea-select').value;
    var row = drafts.drafts.seasons[id];
    var box = $('sea-ivs');
    box.innerHTML = '';
    if (row) {
      $('sea-ing').value = row.ingredient_id;
      $('sea-region').value = row.region;
      row.intervals.forEach(function (iv) { box.appendChild(ivRow(iv)); });
      $('sea-eff-from').value = row.effective_from || '';
      $('sea-eff-to').value = row.effective_to || '';
    }
    if (!$('sea-source').value) $('sea-source').value = today();
  }

  function collectIntervals() {
    return Array.prototype.map.call($('sea-ivs').querySelectorAll('.iv-row'), function (div) {
      return {
        start: { m: Number(div.querySelector('.iv-sm').value), d: Number(div.querySelector('.iv-sd').value) },
        end: { m: Number(div.querySelector('.iv-em').value), d: Number(div.querySelector('.iv-ed').value) },
      };
    });
  }

  $('sea-select').addEventListener('change', loadSeasonForm);
  $('sea-add-iv').addEventListener('click', function () { $('sea-ivs').appendChild(ivRow(null)); });

  $('sea-save-new').addEventListener('click', function () {
    api('POST', '/api/admin/seasons', {
      ingredient_id: $('sea-ing').value,
      region: $('sea-region').value.trim(),
      intervals: collectIntervals(),
      source_date: $('sea-source').value || today(),
      effective_from: $('sea-eff-from').value || undefined,
      effective_to: $('sea-eff-to').value || undefined,
    }).then(function (r) {
      if (!r.ok) { msg('sea-msg', '保存失败：' + (r.body.error || r.status), false); return; }
      msg('sea-msg', '已创建新时令记录 ' + r.body.id + '，发布后生效。', true);
      reload();
    });
  });

  $('sea-save').addEventListener('click', function () {
    var id = $('sea-select').value;
    var row = drafts.drafts.seasons[id];
    if (!row) { msg('sea-msg', '请先选择记录', false); return; }
    api('PUT', '/api/admin/seasons/' + id, {
      intervals: collectIntervals(),
      region: $('sea-region').value.trim(),
      base_version: row.version,
      source_date: $('sea-source').value || today(),
      effective_from: $('sea-eff-from').value || undefined,
      effective_to: $('sea-eff-to').value || undefined,
    }).then(function (r) {
      if (r.status === 409) { msg('sea-msg', '冲突：已被他人修改，已刷新。', false); reload(); return; }
      if (!r.ok) { msg('sea-msg', '保存失败：' + (r.body.error || r.status), false); return; }
      msg('sea-msg', '已保存到草稿，发布后生效。', true);
      reload();
    });
  });

  // ---- 临时停业 ----
  $('clo-save').addEventListener('click', function () {
    function iso(id) {
      var v = $(id).value;
      return v ? new Date(v).toISOString() : undefined;
    }
    api('POST', '/api/admin/closures', {
      stall_id: $('clo-stall').value,
      effective_from: iso('clo-from'),
      effective_to: iso('clo-to'),
      reason: $('clo-reason').value,
      source_date: $('clo-source').value || today(),
      announced_at: iso('clo-announced'),
    }).then(function (r) {
      if (!r.ok) { msg('clo-msg', '登记失败：' + (r.body.error || r.status), false); return; }
      msg('clo-msg', '已登记（草稿），发布后按生效范围生效。', true);
      reload();
    });
  });

  // ---- 排队上报 ----
  $('q-save').addEventListener('click', function () {
    var v = $('q-collected').value;
    api('POST', '/api/admin/queue', {
      stall_id: $('q-stall').value,
      minutes: Number($('q-minutes').value),
      collected_at: v ? new Date(v).toISOString() : undefined,
    }).then(function (r) {
      if (!r.ok) { msg('q-msg', '上报失败：' + (r.body.error || r.status), false); return; }
      msg('q-msg', '已上报（即时生效，带采集时间）。', true);
    });
  });

  // ---- 发布 ----
  $('pub-btn').addEventListener('click', function () {
    api('POST', '/api/admin/publish', { note: $('pub-note').value }).then(function (r) {
      if (!r.ok) { msg('pub-msg', '发布失败：' + (r.body.error || r.status), false); return; }
      msg('pub-msg', '已发布，索引 / 卡片 / 地图同代切换到 gen=' + r.body.gen + '。', true);
      reload();
    });
  });

  document.addEventListener('DOMContentLoaded', reload);
}());
