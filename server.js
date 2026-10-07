const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const store = require('./lib/store');
const core = require('./public/js/core.js');
const V = require('./lib/validate');
const Q = require('./lib/query');
const { tileSvg } = require('./lib/tile');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-token';
const PUBLIC_DIR = path.join(__dirname, 'public');

const db = store.init();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon'
};

function send(res, code, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(code, h);
  res.end(body);
}
function sendJson(res, code, obj, headers) {
  send(res, code, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
}
function badRequest(res, msg) { sendJson(res, 400, { error: msg }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2_000_000) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res) {
  const token = req.headers['x-editor-token'] || url.parse(req.url, true).query.token;
  if (token !== ADMIN_TOKEN) { sendJson(res, 401, { error: '需要编辑令牌（X-Editor-Token）' }); return false; }
  return true;
}

// ---------- 公开查询参数 ----------
function parseFilters(u) {
  const q = u.query;
  const f = {};
  if (q.at) {
    if (Number.isNaN(Date.parse(q.at))) throw new Error('at 必须为 ISO 时间');
    f.atIso = q.at;
  }
  if (q.region) f.region = q.region;
  if (q.ingredient) f.ingredientId = q.ingredient;
  if (q.inSeason === '1') f.inSeasonOnly = true;
  if (q.open === '1') f.openOnly = true;
  if (q.q) f.q = q.q;
  if (q.minLon != null) {
    ['minLon', 'minLat', 'maxLon', 'maxLat'].forEach(k => {
      const n = Number(q[k]);
      if (!Number.isFinite(n)) throw new Error(k + ' 必须为数字');
    });
    f.bbox = { minLon: +q.minLon, minLat: +q.minLat, maxLon: +q.maxLon, maxLat: +q.maxLat };
  }
  return f;
}

function genMeta(gen) {
  return { genId: gen.genId, publishedAt: gen.publishedAt, note: gen.note };
}

function offlineBundle(gen) {
  // 有效范围：覆盖实体中出现的最早/最晚日期；时令窗口是“月日规则”，按当前发布年说明
  let minD = null, maxD = null;
  const consider = d => {
    if (!d) return;
    const o = core.dateOrdinal(d);
    if (minD === null || o < minD) minD = o;
    if (maxD === null || o > maxD) maxD = o;
  };
  gen.stalls.forEach(s => (s.closures || []).forEach(c => { consider(c.effectiveFrom); consider(c.effectiveTo); }));
  (gen.queues || []).forEach(q => { /* 排队快照不延长有效范围，只标注采集时间 */ });
  const year = new Date().getUTCFullYear();
  return {
    schema: 'offline-bundle-v1',
    genId: gen.genId,
    publishedAt: gen.publishedAt,
    generatedAt: new Date().toISOString(),
    validity: {
      coversDateFrom: minD === null ? null : core.ordinalToDate(minD),
      dateTo: maxD === null ? null : core.ordinalToDate(maxD),
      seasonRulesYearNote: '时令窗口以“月日/跨年”规则表达，适用于规则所述年度循环；跨地区窗口见各自 region。',
      queuePolicy: '排队数据为采集快照，超过 ttlMinutes 即视为历史信息，禁止当作实时事实。',
      routePolicy: '路线仅为资料参考。'
    },
    regions: gen.regions,
    ingredients: gen.ingredients,
    stalls: gen.stalls.map(s => ({
      id: s.id, name: s.name, owner: s.owner, region: s.region, address: s.address,
      lon: s.lon, lat: s.lat, segments: s.segments, offers: s.offers, closures: s.closures
    })),
    routes: gen.routes,
    disclaimers: [
      '本包不提供、也不得据此自动生成食品安全或营养结论。',
      '“季节性供应”与“当天实际营业”为不同判断，使用前请按当前时间重算。'
    ]
  };
}

// ---------- 路由 ----------
async function handle(req, res) {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  const method = req.method;

  // 静态
  if (method === 'GET' && (p === '/' || p === '/index.html')) { staticServe(res, path.join(PUBLIC_DIR, 'index.html')); return; }
  if (method === 'GET' && (p === '/admin' || p === '/admin.html')) { staticServe(res, path.join(PUBLIC_DIR, 'admin.html')); return; }
  if (method === 'GET' && (p.startsWith('/css/') || p.startsWith('/js/'))) {
    staticServe(res, path.join(PUBLIC_DIR, p)); return;
  }
  if (method === 'GET' && p.startsWith('/legacy/')) {
    const rel = p.replace('/legacy/', '').split('?')[0];
    staticServe(res, path.join(__dirname, 'legacy', rel)); return;
  }

  // ---- 公开 API ----
  if (method === 'GET' && p === '/api/health') return sendJson(res, 200, { ok: true, at: new Date().toISOString(), genId: db.published.genId });

  if (method === 'GET' && p === '/api/meta') {
    const gen = db.published;
    return sendJson(res, 200, {
      generation: genMeta(gen),
      regions: gen.regions,
      ingredients: gen.ingredients.map(i => ({ id: i.id, name: i.name, category: i.category, windows: i.windows })),
      routes: gen.routes.map(r => ({ id: r.id, title: r.title, note: r.note })),
      disclaimers: ['路线仅为资料参考', '本服务不提供食品安全或营养结论']
    });
  }

  if (method === 'GET' && p === '/api/stalls') {
    let f;
    try { f = parseFilters(u); } catch (e) { return badRequest(res, e.message); }
    const rows = Q.queryStalls(db.published, f);
    return sendJson(res, 200, {
      generation: genMeta(db.published),
      evaluatedAt: (f.atIso ? new Date(f.atIso) : new Date()).toISOString(),
      filters: f,
      count: rows.length,
      stalls: rows
    });
  }

  if (method === 'GET' && p === '/api/stats') {
    let f;
    try { f = parseFilters(u); } catch (e) { return badRequest(res, e.message); }
    const rows = Q.queryStalls(db.published, f);
    return sendJson(res, 200, {
      generation: genMeta(db.published),
      evaluatedAt: (f.atIso ? new Date(f.atIso) : new Date()).toISOString(),
      filters: f,
      aggregate: Q.aggregate(rows)
    });
  }

  if (method === 'GET' && /^\/api\/tiles\/\d+\/\d+\/\d+\.svg$/.test(p)) {
    // 瓦片失败模拟（验收：瓦片失败）
    if (u.query.fail === '1' || process.env.TILE_FAIL === '1' || req.headers['x-simulate-tile-fail'] === '1') {
      return sendJson(res, 503, { error: '瓦片服务暂时不可用（模拟）' });
    }
    const m = p.match(/^\/api\/tiles\/(\d+)\/(\d+)\/(\d+)\.svg$/);
    const z = +m[1], x = +m[2], y = +m[3];
    if (z > 18) return sendJson(res, 400, { error: '缩放级别过高' });
    const svg = tileSvg(db.published, z, x, y);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      // 瓦片与代际绑定：发布后 URL 内容随 gen 变化，故加代际标记缓存
      'Cache-Control': 'public, max-age=300',
      'ETag': '"' + db.published.genId + '-svg-' + z + '-' + x + '-' + y + '"'
    });
    return res.end(svg);
  }

  if (method === 'GET' && p === '/api/offline/manifest') {
    const b = offlineBundle(db.published);
    return sendJson(res, 200, {
      schema: b.schema, genId: b.genId, publishedAt: b.publishedAt, generatedAt: b.generatedAt,
      validity: b.validity, disclaimers: b.disclaimers,
      bundleUrl: '/api/offline/bundle'
    });
  }
  if (method === 'GET' && p === '/api/offline/bundle') {
    return sendJson(res, 200, offlineBundle(db.published));
  }

  // ---- 管理 API ----
  if (p.startsWith('/api/admin/')) {
    if (!requireAdmin(req, res)) return;
    return handleAdmin(req, res, u, p, method);
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: '未知 API: ' + p });
  staticServe(res, path.join(PUBLIC_DIR, 'index.html')); return; // SPA 回退
}

function staticServe(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(file);
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

// ---------------- 管理端处理 ----------------
async function handleAdmin(req, res, u, p, method) {
  const draft = () => db.draft;
  let body = {};
  if (method === 'POST' || method === 'PUT') {
    try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }
  }
  const editor = req.headers['x-editor-name'] || 'anonymous';
  const ingredientIds = new Set(draft().ingredients.map(i => i.id));
  const stallIds = new Set(draft().stalls.map(s => s.id));

  try {
    // 草稿视图
    if (method === 'GET' && p === '/api/admin/draft') {
      return sendJson(res, 200, { baseGenId: draft().baseGenId, regions: draft().regions, ingredients: draft().ingredients, stalls: draft().stalls, queues: draft().queues });
    }
    if (method === 'GET' && p === '/api/admin/edits') {
      return sendJson(res, 200, { edits: db.editLog.slice(-100).reverse() });
    }

    // 食材
    if (method === 'POST' && p === '/api/admin/ingredients') {
      const data = V.validateIngredient(body);
      const ing = Object.assign({ id: store.gid('ing'), windows: [] }, data);
      draft().ingredients.push(ing);
      store.recordEdit(db, { editor, entityType: 'ingredient', entityId: ing.id, action: 'create', summary: '新增食材 ' + ing.name });
      store.save(db);
      return sendJson(res, 201, ing);
    }
    if (method === 'PUT' && /^\/api\/admin\/ingredients\/[^/]+$/.test(p)) {
      const id = p.split('/').pop();
      const ing = draft().ingredients.find(x => x.id === id);
      if (!ing) return sendJson(res, 404, { error: '食材不存在（草稿中）' });
      const data = V.validateIngredient(body);
      ing.name = data.name; ing.category = data.category; ing.windows = data.windows;
      store.recordEdit(db, { editor, entityType: 'ingredient', entityId: id, action: 'update', summary: '更正食材 ' + ing.name });
      store.save(db);
      return sendJson(res, 200, ing);
    }
    if (method === 'DELETE' && /^\/api\/admin\/ingredients\/[^/]+$/.test(p)) {
      const id = p.split('/').pop();
      const used = draft().stalls.some(s => (s.offers || []).some(o => o.ingredientId === id));
      if (used) return sendJson(res, 409, { error: '仍有摊位供应此食材，不能删除' });
      const idx = draft().ingredients.findIndex(x => x.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '食材不存在' });
      draft().ingredients.splice(idx, 1);
      store.recordEdit(db, { editor, entityType: 'ingredient', entityId: id, action: 'delete' });
      store.save(db);
      return sendJson(res, 200, { ok: true });
    }

    // 摊位
    if (method === 'POST' && p === '/api/admin/stalls') {
      const data = V.validateStall(body, ingredientIds);
      const stall = Object.assign({ id: store.gid('S'), version: 1 }, data);
      draft().stalls.push(stall);
      store.recordEdit(db, { editor, entityType: 'stall', entityId: stall.id, action: 'create', summary: '新增摊位 ' + stall.name });
      store.save(db);
      return sendJson(res, 201, stall);
    }
    if (method === 'PUT' && /^\/api\/admin\/stalls\/[^/]+$/.test(p)) {
      const id = p.split('/').pop();
      const stall = draft().stalls.find(x => x.id === id);
      if (!stall) return sendJson(res, 404, { error: '摊位不存在（草稿中）' });
      // —— 乐观锁：两编辑更正同一地点，后提交者拿到 409 与当前版本 ——
      const baseVersion = Number(body.version);
      if (!Number.isInteger(baseVersion)) return badRequest(res, '必须携带 version 进行乐观并发控制');
      if (baseVersion !== (stall.version || 1)) {
        store.recordEdit(db, { editor, entityType: 'stall', entityId: id, action: 'update-conflict', conflict: true, baseVersion, appliedVersion: stall.version || 1 });
        store.save(db);
        return sendJson(res, 409, { error: '版本冲突：该地点已被其他编辑更正，请基于当前版本重试', current: stall });
      }
      const data = V.validateStall(body, ingredientIds);
      Object.assign(stall, data);
      stall.version = baseVersion + 1;
      store.recordEdit(db, { editor, entityType: 'stall', entityId: id, action: 'update', summary: '更正摊位 ' + stall.name, baseVersion, appliedVersion: stall.version });
      store.save(db);
      return sendJson(res, 200, stall);
    }
    if (method === 'DELETE' && /^\/api\/admin\/stalls\/[^/]+$/.test(p)) {
      const id = p.split('/').pop();
      if ((draft().queues || []).some(q => q.stallId === id)) return sendJson(res, 409, { error: '该摊位存在排队快照，请先移除' });
      const idx = draft().stalls.findIndex(x => x.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '摊位不存在' });
      draft().stalls.splice(idx, 1);
      store.recordEdit(db, { editor, entityType: 'stall', entityId: id, action: 'delete' });
      store.save(db);
      return sendJson(res, 200, { ok: true });
    }

    // 临时停业（挂到摊位；独立入口便于“早于正式公告”快速录入）
    if (method === 'POST' && /^\/api\/admin\/stalls\/[^/]+\/closures$/.test(p)) {
      const id = p.split('/')[4];
      const stall = draft().stalls.find(x => x.id === id);
      if (!stall) return sendJson(res, 404, { error: '摊位不存在' });
      const c = V.validateClosure(body);
      stall.closures = stall.closures || [];
      stall.closures.push(c);
      stall.version = (stall.version || 1) + 1;
      store.recordEdit(db, { editor, entityType: 'stall', entityId: id, action: 'add-closure', summary: c.reason + ' ' + c.effectiveFrom + '~' + c.effectiveTo + '（公告 ' + c.announcedAt + '）', appliedVersion: stall.version });
      store.save(db);
      return sendJson(res, 201, stall);
    }
    if (method === 'POST' && /^\/api\/admin\/closures\/[^/]+\/revoke$/.test(p)) {
      const cid = p.split('/')[4];
      for (const s of draft().stalls) {
        const c = (s.closures || []).find(x => x.id === cid);
        if (c) {
          c.revoked = true; s.version = (s.version || 1) + 1;
          store.recordEdit(db, { editor, entityType: 'closure', entityId: cid, action: 'revoke', summary: '撤销停业 ' + cid, appliedVersion: s.version });
          store.save(db);
          return sendJson(res, 200, s);
        }
      }
      return sendJson(res, 404, { error: '停业记录不存在' });
    }

    // 排队采集
    if (method === 'POST' && p === '/api/admin/queues') {
      const qv = V.validateQueue(body, stallIds);
      const q = Object.assign({ id: store.gid('q') }, qv);
      draft().queues.push(q);
      store.recordEdit(db, { editor, entityType: 'queue', entityId: q.id, action: 'create', summary: '排队采集 @' + q.collectedAt + ' ' + q.waitMinutes + '分钟' });
      store.save(db);
      return sendJson(res, 201, q);
    }

    // 发布：草稿 → 不可变代际（索引/卡片/地图同代切换）
    if (method === 'POST' && p === '/api/admin/publish') {
      const gen = store.publish(db, body.note || '', editor);
      return sendJson(res, 200, { ok: true, generation: { genId: gen.genId, publishedAt: gen.publishedAt, note: gen.note } });
    }

    return sendJson(res, 404, { error: '未知管理接口: ' + p });
  } catch (e) {
    if (e.badRequest) return sendJson(res, 400, { error: e.message });
    console.error(e);
    return sendJson(res, 500, { error: '服务器内部错误' });
  }
}

const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch(err => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
  });
});

// 修正：根/静态分支改用 staticServe
module.exports = server;
if (require.main === module) {
  server.listen(PORT, () => console.log('时令美食数据编辑与查询服务 http://localhost:' + PORT));
}
