'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  parseAt, toLocal, todayISO, monthRange, withinEffective, DEFAULT_TZ_OFFSET_MIN,
} = require('./timeutil');
const { buildIndex, queryIndex } = require('./geoindex');
const { tileBBox, aggregate } = require('./tiles');
const { stallAvailability } = require('./availability');

const QUEUE_TTL_MIN = 15; // 排队信息超过该时长即视为过期，只能展示采集时间

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function createApp({ db, rootDir, nowFn = () => Date.now(), tzOffset = DEFAULT_TZ_OFFSET_MIN }) {
  // 预计算索引：随发布重建；与 live 快照、gen 一起构成“同代”
  let index = buildIndex(db.data.live, db.data.gen, toLocal(nowFn(), tzOffset).year);
  const rebuildIndex = () => {
    index = buildIndex(db.data.live, db.data.gen, toLocal(nowFn(), tzOffset).year);
  };

  const liveView = () => {
    const l = db.data.live;
    return {
      stalls: l.stalls,
      ingredients: l.ingredients,
      offerings: Object.values(l.offerings),
      seasons: Object.values(l.seasons),
      hours: Object.values(l.hours),
      closures: Object.values(l.closures),
    };
  };

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Data-Gen': String(db.data.gen),
    });
    res.end(body);
  };

  const genFlags = (url) => {
    const g = url.searchParams.get('gen');
    const requested = g === null || g === '' ? null : Number(g);
    if (requested !== null && Number.isNaN(requested)) {
      throw Object.assign(new Error('gen 参数无效'), { status: 400 });
    }
    // 旧筛选请求晚到：请求携带的代与当前代不一致 -> 标记 stale，由客户端丢弃重取
    return { requested, stale: requested !== null && requested !== db.data.gen };
  };

  const parseBbox = (url) => {
    const raw = url.searchParams.get('bbox');
    if (!raw) return null;
    const parts = raw.split(',').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      throw Object.assign(new Error('bbox 格式应为 minLng,minLat,maxLng,maxLat'), { status: 400 });
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng > maxLng || minLat > maxLat) {
      throw Object.assign(new Error('bbox 范围无效'), { status: 400 });
    }
    return { minLng, minLat, maxLng, maxLat };
  };

  const parseMonth = (url) => {
    const raw = url.searchParams.get('month');
    if (!raw || raw === '0') return null;
    const m = Number(raw);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw Object.assign(new Error('month 应为 1-12'), { status: 400 });
    }
    return m;
  };

  // 访客地图与列表共享的筛选管线：bbox/月份/食材/区域（预计算层） + 营业状态（查询时求交层）
  const sharedFilter = (url) => {
    const bbox = parseBbox(url);
    const month = parseMonth(url);
    const ingredientId = url.searchParams.get('ingredient_id') || null;
    const region = url.searchParams.get('region') || null;
    const openNowOnly = url.searchParams.get('open_now') === '1';
    const atMs = parseAt(url.searchParams.get('at')) ?? nowFn();
    const ids = queryIndex(index, { bbox, month, ingredientId });
    const view = liveView();
    let stalls = [...ids].map((id) => view.stalls[id]).filter(Boolean);
    if (region) stalls = stalls.filter((s) => s.region === region);
    let items = stalls.map((s) => {
      const av = stallAvailability(view, s, atMs, tzOffset);
      return {
        id: s.id, name: s.name, region: s.region, lng: s.lng, lat: s.lat,
        ingredients: av.seasonal.map((x) => x.ingredient_id),
        in_season_now: av.in_season_now,
        open_now: av.open_now,
        temporarily_closed: av.temporarily_closed,
        available_now: av.available_now,
      };
    });
    if (openNowOnly) items = items.filter((s) => s.open_now);
    return { items, atMs, view };
  };

  const queueInfo = (stallId) => {
    const q = db.data.queue[stallId];
    if (!q) return null;
    const ageMin = (nowFn() - Date.parse(q.collected_at)) / 60000;
    return {
      minutes: q.minutes,
      collected_at: q.collected_at, // 过期排队信息必须展示采集时间，不得当作实时事实
      age_minutes: Math.max(0, Math.round(ageMin)),
      stale: ageMin > QUEUE_TTL_MIN,
      ttl_minutes: QUEUE_TTL_MIN,
    };
  };

  const cardFor = (stall, view, atMs) => {
    const av = stallAvailability(view, stall, atMs, tzOffset);
    const local = toLocal(atMs, tzOffset);
    return {
      id: stall.id,
      name: stall.name,
      region: stall.region,
      lng: stall.lng,
      lat: stall.lat,
      version: stall.version,
      offerings: av.seasonal.map((s) => ({
        ingredient_id: s.ingredient_id,
        ingredient_name: (view.ingredients[s.ingredient_id] || {}).name || s.ingredient_id,
        in_season: s.in_season,
        intervals: s.intervals,
      })),
      in_season_now: av.in_season_now,
      open_now: av.open_now,
      temporarily_closed: av.temporarily_closed,
      available_now: av.available_now,
      closures: view.closures
        .filter((c) => c.stall_id === stall.id)
        .map((c) => ({
          effective_from: c.effective_from,
          effective_to: c.effective_to,
          reason: c.reason,
          source_date: c.source_date,
          announced_at: c.announced_at || null,
        })),
      hours: view.hours
        .filter((h) => h.stall_id === stall.id && withinEffective(h, local.isoDate))
        .map((h) => ({ weekday: h.weekday, segments: h.segments })),
      queue: queueInfo(stall.id),
    };
  };

  // ---------- 管理端写操作 ----------
  // X-Editor 头按 URI 编码传输（HTTP 头不能直接携带非 Latin-1 字符）
  const editorOf = (req) => {
    const raw = req.headers['x-editor'];
    if (!raw) return 'anonymous';
    try { return decodeURIComponent(raw); } catch { return raw; }
  };

  const sourceFields = (body) => {
    const sourceDate = body.source_date || todayISO(nowFn(), tzOffset);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) {
      throw Object.assign(new Error('source_date 应为 YYYY-MM-DD'), { status: 400 });
    }
    return {
      source_date: sourceDate, // 来源日期：信息是哪天获得的
      effective_from: body.effective_from || sourceDate, // 生效范围
      effective_to: body.effective_to || null,
    };
  };

  const checkVersion = (row, base) => {
    if (typeof base !== 'number' || base !== row.version) {
      throw Object.assign(new Error('数据已被他人修改，请刷新后重试'), {
        status: 409,
        payload: { error: 'version_conflict', current_version: row.version, current: row },
      });
    }
  };

  const admin = {
    'GET /api/admin/drafts': () => ({
      gen: db.data.gen,
      drafts: db.data.drafts,
      queue: db.data.queue,
      audit: db.data.audit.slice(-20),
      edit_log: db.data.edit_log.slice(-50),
    }),

    'PUT /api/admin/stalls/:id/location': (req, res, m, body) => {
      const row = db.data.drafts.stalls[m.id];
      if (!row) throw Object.assign(new Error('摊位不存在'), { status: 404 });
      checkVersion(row, body.base_version);
      const { lng, lat } = body;
      if (typeof lng !== 'number' || typeof lat !== 'number'
        || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw Object.assign(new Error('经纬度无效'), { status: 400 });
      }
      Object.assign(row, { lng, lat, ...sourceFields(body) });
      row.version += 1;
      row.updated_by = editorOf(req);
      db.logEdit({ by: editorOf(req), table: 'stalls', id: m.id, action: 'location', version: row.version });
      db.save();
      return { ok: true, version: row.version };
    },

    'PUT /api/admin/hours/:id': (req, res, m, body) => {
      const row = db.data.drafts.hours[m.id];
      if (!row) throw Object.assign(new Error('营业段记录不存在'), { status: 404 });
      checkVersion(row, body.base_version);
      if (!Array.isArray(body.segments) || body.segments.length === 0) {
        throw Object.assign(new Error('segments 不能为空'), { status: 400 });
      }
      for (const seg of body.segments) {
        if (!/^\d{1,2}:\d{2}$/.test(seg.open || '') || !/^\d{1,2}:\d{2}$/.test(seg.close || '')) {
          throw Object.assign(new Error('营业段格式应为 HH:MM'), { status: 400 });
        }
        if (seg.open === seg.close) {
          throw Object.assign(new Error('营业段开始与结束不能相同'), { status: 400 });
        }
      }
      Object.assign(row, { segments: body.segments, ...sourceFields(body) });
      row.version += 1;
      row.updated_by = editorOf(req);
      db.logEdit({ by: editorOf(req), table: 'hours', id: m.id, action: 'update', version: row.version });
      db.save();
      return { ok: true, version: row.version };
    },

    'POST /api/admin/seasons': (req, res, m, body) => {
      validateIntervals(body.intervals);
      if (!body.ingredient_id || !db.data.drafts.ingredients[body.ingredient_id]) {
        throw Object.assign(new Error('ingredient_id 无效'), { status: 400 });
      }
      if (!body.region) throw Object.assign(new Error('region 必填'), { status: 400 });
      const id = db.nextId('sea');
      db.data.drafts.seasons[id] = {
        id, ingredient_id: body.ingredient_id, region: body.region,
        intervals: body.intervals, version: 1,
        updated_by: editorOf(req), ...sourceFields(body),
      };
      db.logEdit({ by: editorOf(req), table: 'seasons', id, action: 'create', version: 1 });
      db.save();
      return { ok: true, id };
    },

    'PUT /api/admin/seasons/:id': (req, res, m, body) => {
      const row = db.data.drafts.seasons[m.id];
      if (!row) throw Object.assign(new Error('时令记录不存在'), { status: 404 });
      checkVersion(row, body.base_version);
      validateIntervals(body.intervals);
      if (body.region !== undefined && !body.region) {
        throw Object.assign(new Error('region 不能为空'), { status: 400 });
      }
      Object.assign(row, {
        intervals: body.intervals,
        region: body.region || row.region,
        ...sourceFields(body),
      });
      row.version += 1;
      row.updated_by = editorOf(req);
      db.logEdit({ by: editorOf(req), table: 'seasons', id: m.id, action: 'update', version: row.version });
      db.save();
      return { ok: true, version: row.version };
    },

    'POST /api/admin/closures': (req, res, m, body) => {
      if (!db.data.drafts.stalls[body.stall_id]) {
        throw Object.assign(new Error('摊位不存在'), { status: 404 });
      }
      const from = Date.parse(body.effective_from);
      const to = Date.parse(body.effective_to);
      if (Number.isNaN(from) || Number.isNaN(to) || from >= to) {
        throw Object.assign(new Error('停业生效范围无效（需为时间且 from < to）'), { status: 400 });
      }
      if (body.announced_at && Number.isNaN(Date.parse(body.announced_at))) {
        throw Object.assign(new Error('announced_at 无法解析'), { status: 400 });
      }
      const id = db.nextId('clo');
      db.data.drafts.closures[id] = {
        id,
        stall_id: body.stall_id,
        effective_from: body.effective_from,
        effective_to: body.effective_to,
        reason: body.reason || '',
        announced_at: body.announced_at || null, // 正式公告时间，可能晚于生效起点
        version: 1,
        updated_by: editorOf(req),
        ...sourceFields(body),
      };
      db.logEdit({ by: editorOf(req), table: 'closures', id, action: 'create', version: 1 });
      db.save();
      return { ok: true, id };
    },

    // 排队信息是易失运营数据：直接写入 live（不走发布），但必须带采集时间
    'POST /api/admin/queue': (req, res, m, body) => {
      if (!db.data.live.stalls[body.stall_id]) {
        throw Object.assign(new Error('摊位不存在'), { status: 404 });
      }
      const minutes = Number(body.minutes);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 600) {
        throw Object.assign(new Error('minutes 应为 0-600'), { status: 400 });
      }
      const collectedAt = body.collected_at || new Date(nowFn()).toISOString();
      if (Number.isNaN(Date.parse(collectedAt))) {
        throw Object.assign(new Error('collected_at 无法解析'), { status: 400 });
      }
      db.data.queue[body.stall_id] = { minutes, collected_at: collectedAt };
      db.logEdit({ by: editorOf(req), table: 'queue', id: body.stall_id, action: 'report' });
      db.save();
      return { ok: true };
    },

    // 发布：索引、卡片、地图同代切换到 gen+1
    'POST /api/admin/publish': (req, res, m, body) => {
      const gen = db.publish({ by: editorOf(req), note: body && body.note });
      rebuildIndex();
      return { ok: true, gen };
    },
  };

  function validateIntervals(intervals) {
    if (!Array.isArray(intervals) || intervals.length === 0) {
      throw Object.assign(new Error('intervals 不能为空'), { status: 400 });
    }
    for (const iv of intervals) {
      for (const k of ['start', 'end']) {
        const p = iv[k] || {};
        if (!Number.isInteger(p.m) || p.m < 1 || p.m > 12
          || !Number.isInteger(p.d) || p.d < 1 || p.d > 31) {
          throw Object.assign(new Error(`区间${k === 'start' ? '起点' : '终点'}无效`), { status: 400 });
        }
      }
    }
  }

  // ---------- 路由 ----------
  const routes = [
    ['GET', /^\/api\/meta$/, (req, res, url) => {
      const view = liveView();
      send(res, 200, {
        gen: db.data.gen,
        ingredients: Object.values(view.ingredients).map((i) => ({ id: i.id, name: i.name })),
        regions: [...new Set(Object.values(view.stalls).map((s) => s.region))],
        queue_ttl_minutes: QUEUE_TTL_MIN,
        now: new Date(nowFn()).toISOString(),
      });
    }],

    ['GET', /^\/api\/stalls$/, (req, res, url) => {
      const flags = genFlags(url);
      const { items } = sharedFilter(url);
      send(res, 200, { gen: db.data.gen, stale: flags.stale, stalls: items });
    }],

    ['GET', /^\/api\/stalls\/(?<id>[\w-]+)$/, (req, res, url, m) => {
      const flags = genFlags(url);
      const view = liveView();
      const stall = view.stalls[m.groups.id];
      if (!stall) throw Object.assign(new Error('摊位不存在'), { status: 404 });
      const atMs = parseAt(url.searchParams.get('at')) ?? nowFn();
      send(res, 200, { gen: db.data.gen, stale: flags.stale, stall: cardFor(stall, view, atMs) });
    }],

    ['GET', /^\/api\/tiles\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)$/, (req, res, url, m) => {
      // 测试钩子：模拟瓦片服务失败，客户端必须回退到 /api/stalls
      if (req.headers['x-debug-fail'] === '1') {
        send(res, 503, { error: 'tile_unavailable', message: '瓦片服务暂时不可用，请回退到 /api/stalls' });
        return;
      }
      const z = Number(m.groups.z);
      const x = Number(m.groups.x);
      const y = Number(m.groups.y);
      if (z > 22 || x >= 2 ** z || y >= 2 ** z) {
        throw Object.assign(new Error('瓦片坐标无效'), { status: 400 });
      }
      const flags = genFlags(url);
      const bbox = tileBBox(z, x, y);
      const month = parseMonth(url);
      const ingredientId = url.searchParams.get('ingredient_id') || null;
      const region = url.searchParams.get('region') || null;
      const openNowOnly = url.searchParams.get('open_now') === '1';
      const atMs = parseAt(url.searchParams.get('at')) ?? nowFn();
      const ids = queryIndex(index, { bbox, month, ingredientId });
      const view = liveView();
      let stalls = [...ids].map((id) => view.stalls[id]).filter(Boolean);
      if (region) stalls = stalls.filter((s) => s.region === region);
      if (openNowOnly) {
        stalls = stalls.filter(
          (s) => stallAvailability(view, s, atMs, tzOffset).open_now,
        );
      }
      const clusters = aggregate(stalls, bbox);
      send(res, 200, { gen: db.data.gen, stale: flags.stale, z, x, y, clusters });
    }],

    ['GET', /^\/api\/offline-pack$/, (req, res, url) => {
      const region = url.searchParams.get('region') || null;
      const month = parseMonth(url);
      if (!month) throw Object.assign(new Error('离线包必须指定 month（1-12）'), { status: 400 });
      const local = toLocal(nowFn(), tzOffset);
      const year = month < local.month ? local.year + 1 : local.year;
      const { end } = monthRange(year, month);
      const ids = queryIndex(index, { month });
      const view = liveView();
      let stalls = [...ids].map((id) => view.stalls[id]).filter(Boolean);
      if (region) stalls = stalls.filter((s) => s.region === region);
      send(res, 200, {
        gen: db.data.gen,
        produced_at: new Date(nowFn()).toISOString(),
        region: region || '全部',
        month,
        // 离线包必须注明有效范围
        valid: { from: local.isoDate, to: end },
        note: '离线包仅覆盖所列区域与月份；临时停业、排队等时效信息以线上最新一代为准。',
        disclaimer: '本包数据仅为资料参考，不构成食品安全或营养结论。',
        stalls: stalls.map((s) => ({
          id: s.id, name: s.name, region: s.region, lng: s.lng, lat: s.lat,
          ingredients: view.offerings.filter((o) => o.stall_id === s.id).map((o) => o.ingredient_id),
        })),
      });
    }],

    ['GET', /^\/api\/route$/, (req, res, url) => {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      if (ids.length < 2) throw Object.assign(new Error('ids 至少需要两个摊位'), { status: 400 });
      const view = liveView();
      const pts = ids.map((id) => {
        const s = view.stalls[id];
        if (!s) throw Object.assign(new Error(`摊位不存在: ${id}`), { status: 404 });
        return s;
      });
      const legs = [];
      let total = 0;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const km = haversine(pts[i], pts[i + 1]);
        total += km;
        legs.push({ from: pts[i].id, to: pts[i + 1].id, distance_km: Math.round(km * 100) / 100 });
      }
      send(res, 200, {
        gen: db.data.gen,
        reference_only: true, // 路线只作资料参考
        legs,
        total_km: Math.round(total * 100) / 100,
        disclaimer: '路线仅为资料参考，实际通行与营业情况以现场为准；本服务不自动给出食品安全或营养结论。',
      });
    }],

    // 管理端
    ['GET', /^\/api\/admin\/drafts$/, (req, res) => send(res, 200, admin['GET /api/admin/drafts']())],
    ['PUT', /^\/api\/admin\/stalls\/(?<id>[\w-]+)\/location$/, (req, res, url, m, body) => send(res, 200, admin['PUT /api/admin/stalls/:id/location'](req, res, { id: m.groups.id }, body))],
    ['PUT', /^\/api\/admin\/hours\/(?<id>[\w-]+)$/, (req, res, url, m, body) => send(res, 200, admin['PUT /api/admin/hours/:id'](req, res, { id: m.groups.id }, body))],
    ['POST', /^\/api\/admin\/seasons$/, (req, res, url, m, body) => send(res, 200, admin['POST /api/admin/seasons'](req, res, {}, body))],
    ['PUT', /^\/api\/admin\/seasons\/(?<id>[\w-]+)$/, (req, res, url, m, body) => send(res, 200, admin['PUT /api/admin/seasons/:id'](req, res, { id: m.groups.id }, body))],
    ['POST', /^\/api\/admin\/closures$/, (req, res, url, m, body) => send(res, 200, admin['POST /api/admin/closures'](req, res, {}, body))],
    ['POST', /^\/api\/admin\/queue$/, (req, res, url, m, body) => send(res, 200, admin['POST /api/admin/queue'](req, res, {}, body))],
    ['POST', /^\/api\/admin\/publish$/, (req, res, url, m, body) => send(res, 200, admin['POST /api/admin/publish'](req, res, {}, body))],
  ];

  const server = http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body = null;
        if (req.method === 'POST' || req.method === 'PUT') {
          body = await readBody(req);
        }
        for (const [method, re, handler] of routes) {
          const m = re.exec(url.pathname);
          if (method === req.method && m) {
            return handler(req, res, url, m, body);
          }
        }
        throw Object.assign(new Error('接口不存在'), { status: 404 });
      }
      return serveStatic(req, res, url);
    })().catch((err) => {
      const status = err.status || 500;
      send(res, status, err.payload || { error: err.message || 'internal_error' });
    });
  });

  function serveStatic(req, res, url) {
    if (req.method !== 'GET') {
      res.writeHead(405); res.end(); return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(rootDir, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(rootDir)) {
      res.writeHead(403); res.end(); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function haversine(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = { createApp, QUEUE_TTL_MIN };
