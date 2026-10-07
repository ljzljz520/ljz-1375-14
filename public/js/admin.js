/* 后台：草稿 CRUD + 乐观锁 + 停业录入 + 排队快照 + 发布同代切换 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  let draft = null, editingStallId = null, editingIngId = null;

  function headers(json) {
    const h = { 'X-Editor-Token': $('#token').value.trim(), 'X-Editor-Name': $('#editor').value.trim() || 'anonymous' };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  function flash(m, bad) {
    const el = $('#flash'); el.textContent = m;
    el.style.background = bad ? '#8a1f1f' : '#3d342c';
    el.classList.add('show'); clearTimeout(flash._t); flash._t = setTimeout(() => el.classList.remove('show'), 3200);
  }
  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || ('HTTP ' + res.status)); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
  function pprint(o) { return JSON.stringify(o, null, 2); }

  async function loadDraft() {
    draft = await api('GET', '/api/admin/draft');
    $('#draft-info').textContent = '草稿基于代际 ' + draft.baseGenId + ' ｜ 食材 ' + draft.ingredients.length + ' ｜ 摊位 ' + draft.stalls.length;
    renderStalls(); renderIngredients(); renderQueues();
  }

  /* ---------- 摊位 ---------- */
  function templateStall() {
    return {
      name: '', owner: '', region: draft.regions[0] ? draft.regions[0].id : '',
      address: '', lon: 108.95, lat: 34.27,
      segments: [{ start: '10:00', end: '21:00', days: [1, 2, 3, 4, 5] }],
      offers: [], closures: [], version: 1
    };
  }

  function renderStalls() {
    $('#stall-list').innerHTML = draft.stalls.map(s => {
      const segs = s.segments.map(g => g.start + '–' + g.end + (g.end <= g.start ? '跨午夜' : '')).join('，');
      const activeClosure = (s.closures || []).find(c => !c.revoked);
      return '<div class="rowline">' +
        '<b>' + esc(s.name) + '</b><span class="ver">v' + (s.version || 1) + ' · ' + s.id + '</span>' +
        '<span class="ver">' + esc(s.region) + ' · 营业：' + esc(segs || '无') + '</span>' +
        (activeClosure ? '<span class="tag suspended">停业 ' + activeClosure.effectiveFrom + '~' + activeClosure.effectiveTo + '</span>' : '') +
        '<span style="margin-left:auto"><button class="mini" data-edit="' + s.id + '">编辑</button></span>' +
        '</div>';
    }).join('');
    $$('#stall-list [data-edit]').forEach(b => b.addEventListener('click', () => editStall(b.getAttribute('data-edit'))));
  }

  function editStall(id) {
    const s = draft.stalls.find(x => x.id === id);
    editingStallId = id;
    $('#stall-form-title').textContent = '更正摊位：' + s.name + '（' + s.id + '）';
    $('#stall-version').textContent = '当前版本 version=' + (s.version || 1) + '。两位编辑同时更正同一地点时，后提交（旧 version）会收到 409。';
    $('#stall-json').value = pprint(stripInternals(s));
  }
  function stripInternals(s) {
    // 表单编辑展示：保留 version；内部 id 可留（新增时忽略 id）
    const o = JSON.parse(JSON.stringify(s));
    return o;
  }

  $('#stall-new').addEventListener('click', () => {
    editingStallId = null;
    $('#stall-form-title').textContent = '新增摊位';
    $('#stall-version').textContent = '新增无需 version。';
    $('#stall-json').value = pprint(templateStall());
  });
  $('#stall-save').addEventListener('click', async () => {
    let body;
    try { body = JSON.parse($('#stall-json').value); } catch (e) { return flash('JSON 格式错误', true); }
    try {
      if (editingStallId) {
        if (!Number.isInteger(body.version)) body.version = draft.stalls.find(s => s.id === editingStallId).version || 1;
        const s = await api('PUT', '/api/admin/stalls/' + editingStallId, body);
        flash('已保存更正（v' + s.version + '），尚未发布');
      } else {
        const s = await api('POST', '/api/admin/stalls', body);
        flash('已新增摊位 ' + s.id + '（草稿，尚未发布）');
      }
      await loadDraft();
    } catch (e) {
      if (e.status === 409) {
        flash('版本冲突：' + e.message, true);
        if (e.data && e.data.current) {
          editingStallId = e.data.current.id;
          $('#stall-json').value = pprint(e.data.current);
          $('#stall-version').textContent = '已载入服务端最新版本 v' + (e.data.current.version || 1) + '，请合并你的改动后再提交。';
        }
      } else flash(e.message, true);
    }
  });

  /* ---------- 食材 ---------- */
  function templateIng() {
    return { name: '', category: '', windows: [{ region: '*', startMonth: 4, startDay: 1, endMonth: 6, endDay: 30, crossYear: false }] };
  }
  function renderIngredients() {
    $('#ing-list').innerHTML = draft.ingredients.map(i => {
      const ws = i.windows.map(w =>
        (w.region && w.region !== '*' ? esc(w.region) : '全域') + ' ' +
        String(w.startMonth).padStart(2, '0') + '-' + String(w.startDay).padStart(2, '0') + '~' +
        String(w.endMonth).padStart(2, '0') + '-' + String(w.endDay).padStart(2, '0') + (w.crossYear ? ' 跨年' : '')
      ).join('；');
      return '<div class="rowline"><b>' + esc(i.name) + '</b><span class="ver">' + esc(i.category || '') + '</span>' +
        '<span class="ver">' + (ws || '无任何窗口（任何地区都不在季）') + '</span>' +
        '<span style="margin-left:auto"><button class="mini" data-iedit="' + i.id + '">编辑</button></span></div>';
    }).join('');
    $$('#ing-list [data-iedit]').forEach(b => b.addEventListener('click', () => editIng(b.getAttribute('data-iedit'))));
  }
  function editIng(id) {
    const i = draft.ingredients.find(x => x.id === id);
    editingIngId = id;
    $('#ing-form-title').textContent = '更正食材：' + i.name;
    $('#ing-json').value = pprint({ name: i.name, category: i.category || '', windows: i.windows });
  }
  $('#ing-new').addEventListener('click', () => {
    editingIngId = null; $('#ing-form-title').textContent = '新增食材'; $('#ing-json').value = pprint(templateIng());
  });
  $('#ing-save').addEventListener('click', async () => {
    let body;
    try { body = JSON.parse($('#ing-json').value); } catch (e) { return flash('JSON 格式错误', true); }
    try {
      if (editingIngId) await api('PUT', '/api/admin/ingredients/' + editingIngId, body);
      else await api('POST', '/api/admin/ingredients', body);
      flash('食材已保存到草稿（发布后生效）');
      await loadDraft();
    } catch (e) { flash(e.message, true); }
  });

  /* ---------- 排队 ---------- */
  function renderQueues() {
    $('#queue-list').innerHTML = draft.queues.length ? draft.queues.map(q =>
      '<div class="rowline"><b>' + esc(q.stallId) + '</b>' +
      '<span class="ver">约 ' + q.waitMinutes + ' 分钟 · 采集 ' + esc(q.collectedAt) + ' · TTL ' + q.ttlMinutes + ' 分钟 · ' + esc(q.source) + '</span></div>'
    ).join('') : '<p class="hint">暂无采集。</p>';
    $('#queue-json').value = pprint({ stallId: draft.stalls[0] ? draft.stalls[0].id : 'S001', waitMinutes: 10, ttlMinutes: 60, collectedAt: new Date().toISOString().slice(0, 16) + ':00', source: '编辑现场采集' });
  }
  $('#queue-save').addEventListener('click', async () => {
    let body;
    try { body = JSON.parse($('#queue-json').value); } catch (e) { return flash('JSON 格式错误', true); }
    try { await api('POST', '/api/admin/queues', body); flash('排队快照已录入（草稿，发布后访客可见）'); await loadDraft(); }
    catch (e) { flash(e.message, true); }
  });

  /* ---------- 发布 ---------- */
  $('#pub-btn').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/admin/publish', { note: $('#pub-note').value.trim() });
      $('#pub-result').innerHTML = '✅ 已发布 <b>' + r.generation.genId + '</b> 于 ' + r.generation.publishedAt + '。访客端索引/卡片/地图将在下次查询或 15 秒轮询后同代切换。';
      flash('发布成功 ' + r.generation.genId);
      await loadDraft();
      loadOffline();
    } catch (e) { flash(e.message, true); }
  });
  async function loadOffline() {
    const m = await fetch('/api/offline/manifest').then(r => r.json());
    $('#offline-preview').textContent =
      'gen=' + m.genId + '\n有效日期范围: ' + m.validity.coversDateFrom + ' ~ ' + m.validity.dateTo +
      '\n' + m.validity.seasonRulesYearNote + '\n' + m.validity.queuePolicy;
  }

  /* ---------- 日志 ---------- */
  async function loadLog() {
    const r = await api('GET', '/api/admin/edits');
    $('#log-body').innerHTML = r.edits.map(e =>
      '<tr class="' + (e.conflict ? 'conflict' : '') + '"><td>' + esc(e.at) + '</td><td>' + esc(e.editor) +
      '</td><td>' + esc(e.entityType) + '/' + esc(e.entityId) + '</td><td>' + esc(e.action) +
      '</td><td>' + esc(e.summary) + '</td><td>' + esc(e.baseVersion || '') + '→' + esc(e.appliedVersion || '') + '</td></tr>'
    ).join('');
  }

  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.classList.remove('on'));
    $$('.tabpane').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    $('#tab-' + b.getAttribute('data-tab')).classList.add('on');
    if (b.getAttribute('data-tab') === 'log') loadLog();
    if (b.getAttribute('data-tab') === 'publish') loadOffline();
  }));

  (async function init() {
    try {
      await loadDraft();
      loadOffline();
    } catch (e) { flash('加载草稿失败（检查令牌）：' + e.message, true); }
  })();
})();
