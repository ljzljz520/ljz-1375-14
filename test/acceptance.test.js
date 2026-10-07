'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DB = require('../server/db');
const { buildSeed } = require('../server/seed');
const { createApp } = require('../server/app');
const { aggregate, tileBBox } = require('../server/tiles');
const ClientCore = require('../js/client-core.js');

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-'));
  const db = new DB(path.join(dir, 'db.json'));
  db.loadSeed(buildSeed());
  const app = createApp({ db, rootDir: path.join(__dirname, '..') });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { app, db, base };
}

async function get(base, p, headers) {
  const r = await fetch(base + p, { headers });
  return { status: r.status, gen: r.headers.get('x-data-gen'), body: await r.json() };
}

async function send(base, method, p, body, editor) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Editor': encodeURIComponent(editor || 'tester') },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, gen: r.headers.get('x-data-gen'), body: await r.json() };
}

test('验收1 月底切换：10/31 23:59 与 11/01 00:00 的应季集合与跨午夜营业', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const oct = await get(base, '/api/stalls?month=10&at=2026-10-31T23:59:00%2B08:00');
  const octIds = oct.body.stalls.map((s) => s.id);
  assert.ok(octIds.includes('S1'), '10 月应含柿子摊');
  assert.ok(!octIds.includes('S2'), '10 月不应含羊肉摊（跨年区间 11-02 月）');

  const nov = await get(base, '/api/stalls?month=11&at=2026-11-01T00:00:00%2B08:00');
  const novIds = nov.body.stalls.map((s) => s.id);
  assert.ok(novIds.includes('S2') && novIds.includes('S3'), '11 月应含羊肉摊');
  assert.ok(!novIds.includes('S1'), '11 月不应含柿子摊（10-31 结束）');

  // S3 营业段 20:00–02:00（跨午夜），羊肉 11-01 起应季
  const before = await get(base, '/api/stalls/S3?at=2026-10-31T23:30:00%2B08:00');
  assert.equal(before.body.stall.open_now, true, '10/31 23:30 在营业段内');
  assert.equal(before.body.stall.in_season_now, false, '10/31 羊肉尚未应季');
  assert.equal(before.body.stall.available_now, false, '应季与营业需同时满足');

  const after = await get(base, '/api/stalls/S3?at=2026-11-01T00:30:00%2B08:00');
  assert.equal(after.body.stall.open_now, true, '11/01 00:30 仍属昨日跨午夜段');
  assert.equal(after.body.stall.in_season_now, true, '11/01 羊肉应季');
  assert.equal(after.body.stall.available_now, true);

  const closed = await get(base, '/api/stalls/S3?at=2026-11-01T03:00:00%2B08:00');
  assert.equal(closed.body.stall.open_now, false, '03:00 已收摊');
  assert.equal(closed.body.stall.available_now, false);

  // 不能由单一月份字段推断可购买：全年应季的米皮店凌晨不营业
  const s4 = await get(base, '/api/stalls/S4?at=2026-10-15T03:00:00%2B08:00');
  assert.equal(s4.body.stall.in_season_now, true);
  assert.equal(s4.body.stall.open_now, false);
  assert.equal(s4.body.stall.available_now, false);
});

test('验收2 临时停业早于正式公告：按生效范围生效，公告时间仅作来源信息', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const c = await send(base, 'POST', '/api/admin/closures', {
    stall_id: 'S2',
    effective_from: '2026-10-05T00:00:00+08:00',
    effective_to: '2026-10-08T23:59:00+08:00',
    reason: '设备检修',
    source_date: '2026-10-03', // 10-03 已得知
    announced_at: '2026-10-08T09:00:00+08:00', // 正式公告 10-08 才发
  }, 'editor-a');
  assert.equal(c.status, 200);
  await send(base, 'POST', '/api/admin/publish', { note: '登记停业' });

  const during = await get(base, '/api/stalls/S2?at=2026-10-06T12:00:00%2B08:00');
  assert.equal(during.body.stall.temporarily_closed, true, '公告发布前也应按生效范围停业');
  assert.equal(during.body.stall.open_now, false);
  const clo = during.body.stall.closures[0];
  assert.equal(clo.source_date, '2026-10-03');
  assert.ok(Date.parse(clo.announced_at) > Date.parse(clo.effective_from), '公告晚于生效起点');

  const after = await get(base, '/api/stalls/S2?at=2026-10-09T12:00:00%2B08:00');
  assert.equal(after.body.stall.temporarily_closed, false, '生效范围结束后恢复');
});

test('验收3 两编辑更正同一地点：乐观锁冲突后重试', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const drafts = await get(base, '/api/admin/drafts');
  const v = drafts.body.drafts.stalls.S1.version;

  const a = await send(base, 'PUT', '/api/admin/stalls/S1/location',
    { lng: 108.9500, lat: 34.2700, base_version: v, source_date: '2026-10-07' }, '编辑甲');
  assert.equal(a.status, 200);
  assert.equal(a.body.version, v + 1);

  const b = await send(base, 'PUT', '/api/admin/stalls/S1/location',
    { lng: 108.9510, lat: 34.2710, base_version: v, source_date: '2026-10-07' }, '编辑乙');
  assert.equal(b.status, 409, '基于旧版本的写入必须冲突');
  assert.equal(b.body.error, 'version_conflict');
  assert.equal(b.body.current_version, v + 1);

  const retry = await send(base, 'PUT', '/api/admin/stalls/S1/location',
    { lng: 108.9510, lat: 34.2710, base_version: v + 1, source_date: '2026-10-07' }, '编辑乙');
  assert.equal(retry.status, 200);

  await send(base, 'POST', '/api/admin/publish', { note: '更正位置' });
  const card = await get(base, '/api/stalls/S1');
  assert.equal(card.body.stall.lng, 108.9510, '以重试后的写入为准');
  assert.equal(card.body.stall.lat, 34.2710);

  const log = (await get(base, '/api/admin/drafts')).body.edit_log;
  const editors = log.filter((e) => e.table === 'stalls' && e.id === 'S1').map((e) => e.by);
  assert.ok(editors.includes('编辑甲') && editors.includes('编辑乙'), '两位编辑的修改都有审计记录');
});

test('验收4 瓦片失败：客户端降级到摊位查询', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const fail = await get(base, '/api/tiles/3/6/2?month=10', { 'X-Debug-Fail': '1' });
  assert.equal(fail.status, 503);
  assert.equal(fail.body.error, 'tile_unavailable');

  // 客户端核心逻辑：瓦片不可用 -> stalls-fallback
  assert.equal(ClientCore.markerPlan(false), 'stalls-fallback');
  assert.equal(ClientCore.markerPlan(true), 'tiles');

  const fallback = await get(base, '/api/stalls?bbox=106.5,32.8,109.6,34.6&month=10');
  assert.equal(fallback.status, 200);
  assert.ok(fallback.body.stalls.length > 0, '降级后仍能拿到摊位数据');
});

test('验收5 旧筛选请求晚到：响应标记 stale，客户端丢弃', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const meta = await get(base, '/api/meta');
  const g = meta.body.gen;
  await send(base, 'POST', '/api/admin/publish', { note: '新一代' });

  const late = await get(base, `/api/stalls?month=10&gen=${g}`);
  assert.equal(late.body.stale, true, '携带旧代的请求必须被标记');
  assert.equal(late.body.gen, g + 1);
  assert.equal(late.gen, String(g + 1), '响应头也携带当前代');

  const state = ClientCore.createState();
  ClientCore.adoptGen(state, g);
  assert.equal(ClientCore.shouldAccept(state, late.body), false, '客户端应丢弃旧筛选语境的响应');

  const fresh = await get(base, '/api/stalls?month=10');
  assert.equal(fresh.body.stale, false);
  ClientCore.adoptGen(state, g + 1);
  assert.equal(ClientCore.shouldAccept(state, fresh.body), true);
});

test('验收6 发布同代切换：索引、卡片、地图同为新一代', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const drafts = await get(base, '/api/admin/drafts');
  const v = drafts.body.drafts.stalls.S4.version;
  await send(base, 'PUT', '/api/admin/stalls/S4/location',
    { lng: 108.8600, lat: 34.2100, base_version: v, source_date: '2026-10-07' });
  const pub = await send(base, 'POST', '/api/admin/publish', { note: '搬迁 S4' });
  const g = pub.body.gen;

  const list = await get(base, '/api/stalls');
  const card = await get(base, '/api/stalls/S4');
  const tile = await get(base, '/api/tiles/3/6/2');
  assert.equal(list.body.gen, g);
  assert.equal(card.body.gen, g);
  assert.equal(tile.body.gen, g);
  assert.equal(list.gen, String(g));
  assert.equal(card.gen, String(g));
  assert.equal(tile.gen, String(g), '三类读取同代');

  const s4 = list.body.stalls.find((s) => s.id === 'S4');
  assert.equal(s4.lng, 108.8600);
  assert.equal(card.body.stall.lat, 34.2100);
  // 用仅含 S4 新位置的细粒度瓦片验证索引同步（聚合内无其他摊位）
  const z = 12;
  const tx = Math.floor((108.86 + 180) / (360 / 2 ** z));
  const ty = Math.floor((90 - 34.21) / (180 / 2 ** z));
  const fine = await get(base, `/api/tiles/${z}/${tx}/${ty}`);
  assert.equal(fine.body.gen, g);
  const cluster = fine.body.clusters.find((c) => c.stall_ids.includes('S4'));
  assert.deepEqual(cluster.stall_ids, ['S4']);
  assert.ok(Math.abs(cluster.lng - 108.8600) < 0.001, '瓦片聚合也使用新位置');
});

test('验收7 同坐标多摊：聚合按摊位身份去重，不合并商户', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const list = await get(base, '/api/stalls?bbox=108.93,34.25,108.95,34.27&month=11');
  const ids = list.body.stalls.map((s) => s.id);
  assert.ok(ids.includes('S2') && ids.includes('S3'), '同坐标两摊各自出现');

  const tile = await get(base, '/api/tiles/3/6/2?month=11');
  const cluster = tile.body.clusters.find((c) => c.stall_ids.includes('S2'));
  assert.ok(cluster.stall_ids.includes('S3'), '同坐标摊位在同一聚合内保留各自身份');
  assert.ok(cluster.count >= 2);
  const totalIds = new Set(tile.body.clusters.flatMap((c) => c.stall_ids));
  const totalCount = tile.body.clusters.reduce((n, c) => n + c.count, 0);
  assert.equal(totalCount, totalIds.size, '计数之和等于不同摊位身份数（无重复无合并）');

  // 单元级：同坐标两点 -> 一个聚合、count=2、身份并列
  const bbox = tileBBox(3, 6, 2);
  const agg = aggregate([
    { id: 'a', lng: 108.94, lat: 34.262 },
    { id: 'b', lng: 108.94, lat: 34.262 },
  ], bbox);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].count, 2);
  assert.deepEqual(agg[0].stall_ids, ['a', 'b']);
});

test('验收8 过期排队信息：展示采集时间，不当作实时事实', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  await send(base, 'POST', '/api/admin/queue', {
    stall_id: 'S2', minutes: 20,
    collected_at: new Date(Date.now() - 30 * 60000).toISOString(),
  });
  const staleCard = await get(base, '/api/stalls/S2');
  assert.equal(staleCard.body.stall.queue.stale, true, '超过 TTL 必须标记过期');
  assert.ok(staleCard.body.stall.queue.collected_at, '必须带采集时间');
  assert.ok(staleCard.body.stall.queue.age_minutes >= 29);

  await send(base, 'POST', '/api/admin/queue', {
    stall_id: 'S2', minutes: 10,
    collected_at: new Date(Date.now() - 2 * 60000).toISOString(),
  });
  const freshCard = await get(base, '/api/stalls/S2');
  assert.equal(freshCard.body.stall.queue.stale, false);
});

test('验收9 离线包注明有效范围；路线只作资料参考', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const pack = await get(base, '/api/offline-pack?region=关中&month=10');
  assert.equal(pack.status, 200);
  assert.ok(pack.body.valid && pack.body.valid.from && pack.body.valid.to, '必须注明有效范围');
  assert.ok(pack.body.valid.to.endsWith('-31') || pack.body.valid.to.endsWith('-30'));
  assert.equal(typeof pack.body.gen, 'number');
  assert.ok(pack.body.stalls.every((s) => s.region === '关中'));
  assert.ok(pack.body.disclaimer.includes('参考'));

  const route = await get(base, '/api/route?ids=S1,S2,S5');
  assert.equal(route.status, 200);
  assert.equal(route.body.reference_only, true);
  assert.equal(route.body.legs.length, 2);
  assert.ok(route.body.total_km > 0);
  assert.ok(route.body.disclaimer.includes('资料参考'));
  assert.ok(route.body.disclaimer.includes('食品安全'));
  const raw = JSON.stringify(route.body);
  assert.ok(!raw.includes('nutrition') && !raw.includes('营养结论"'), '不输出营养/安全结论字段');

  const bad = await get(base, '/api/route?ids=S1,NOPE');
  assert.equal(bad.status, 404);
});

test('写操作校验：来源日期与生效范围入库，非法输入 400', async (t) => {
  const { app, base } = await startServer();
  t.after(() => app.close());

  const bad = await send(base, 'PUT', '/api/admin/stalls/S1/location',
    { lng: 999, lat: 0, base_version: 1, source_date: '2026-10-07' });
  assert.equal(bad.status, 400);

  const ok = await send(base, 'PUT', '/api/admin/stalls/S1/location',
    { lng: 108.95, lat: 34.27, base_version: 1, source_date: '2026-10-06' });
  assert.equal(ok.status, 200);
  const drafts = await get(base, '/api/admin/drafts');
  const s1 = drafts.body.drafts.stalls.S1;
  assert.equal(s1.source_date, '2026-10-06', '来源日期入库');
  assert.equal(s1.effective_from, '2026-10-06', '生效范围默认取自来源日期');

  const badClo = await send(base, 'POST', '/api/admin/closures', {
    stall_id: 'S1',
    effective_from: '2026-10-08T00:00:00+08:00',
    effective_to: '2026-10-05T00:00:00+08:00',
  });
  assert.equal(badClo.status, 400, '生效范围 from>=to 必须拒绝');
});
