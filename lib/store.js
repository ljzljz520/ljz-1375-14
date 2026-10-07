const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const seed = require('./seed');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function gid(prefix) { return prefix + '-' + crypto.randomBytes(4).toString('hex'); }
function nowIso() { return new Date().toISOString(); }

function defaultDb() {
  return {
    schema: 1,
    // 已发布代际（访客只读它）；首版直接由种子生成
    published: null,
    // 草稿：编辑区修改的对象，发布时整体快照成新一代
    draft: null,
    // 编辑更正流水（“两编辑更正同一地点”可审计）
    editLog: []
  };
}

/** 由一批原始实体构建一个“代际快照”：索引 + 派生图，随发布不可变 */
function buildGeneration(entities, meta) {
  const ingredientsById = {};
  entities.ingredients.forEach(i => { ingredientsById[i.id] = i; });
  const stallsById = {};
  entities.stalls.forEach(s => { stallsById[s.id] = s; });
  const offersByIngredient = {};
  entities.stalls.forEach(s => {
    (s.offers || []).forEach(o => {
      (offersByIngredient[o.ingredientId] = offersByIngredient[o.ingredientId] || []).push(s.id);
    });
  });
  const queuesByStall = {};
  (entities.queues || []).forEach(q => {
    (queuesByStall[q.stallId] = queuesByStall[q.stallId] || []).push(q);
  });

  // —— 预计算“空间索引”：按经纬度网格分桶（仅空间，不含时间）——
  // 时间维（时令窗口/营业段）保持查询时求交，见 docs/design。
  const GRID_DEG = 0.02; // 约 2km
  const buckets = new Map();
  const keyOf = (lon, lat) => Math.floor(lon / GRID_DEG) + ':' + Math.floor(lat / GRID_DEG);
  entities.stalls.forEach(s => {
    const k = keyOf(s.lon, s.lat);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s.id);
  });
  const spatialIndex = {
    type: 'static-grid-v1', gridDeg: GRID_DEG,
    buckets: Object.fromEntries(buckets),
    // 边界框，供瓦片裁剪
    bbox: entities.stalls.reduce((bb, s) => ({
      minLon: Math.min(bb.minLon, s.lon), minLat: Math.min(bb.minLat, s.lat),
      maxLon: Math.max(bb.maxLon, s.lon), maxLat: Math.max(bb.maxLat, s.lat)
    }), { minLon: 180, minLat: 90, maxLon: -180, maxLat: -90 })
  };

  return {
    genId: meta.genId,
    publishedAt: meta.publishedAt,
    note: meta.note || '',
    regions: clone(entities.regions),
    regionGeom: clone(entities.regionGeom || {}),
    routes: clone(entities.routes || []),
    ingredients: clone(entities.ingredients),
    stalls: clone(entities.stalls),
    queues: clone(entities.queues || []),
    ingredientsById, stallsById, offersByIngredient, queuesByStall,
    spatialIndex
  };
}

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    const entities = {
      regions: seed.REGIONS, regionGeom: seed.REGION_GEOM,
      ingredients: seed.INGREDIENTS, stalls: seed.STALLS,
      queues: seed.QUEUES, routes: seed.ROUTES
    };
    const gen = buildGeneration(entities, { genId: 'g1', publishedAt: '2026-10-07T00:00:00.000Z', note: '初始发布（种子）' });
    db.published = gen;
    db.draft = draftFrom(gen);
    save(db);
  }
  return load();
}

/** 草稿只保留可编辑实体（去掉派生索引），编辑/发布互不污染 */
function draftFrom(gen) {
  return {
    baseGenId: gen.genId,
    regions: clone(gen.regions),
    regionGeom: clone(gen.regionGeom),
    routes: clone(gen.routes),
    ingredients: clone(gen.ingredients),
    stalls: clone(gen.stalls),
    queues: clone(gen.queues)
  };
}

function load() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

/** 原子写：tmp + rename，避免半写污染 */
function save(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function recordEdit(db, payload) {
  db.editLog.push({
    id: gid('edit'), at: nowIso(),
    editor: payload.editor || 'anonymous',
    entityType: payload.entityType, entityId: payload.entityId,
    action: payload.action, summary: payload.summary || '',
    baseVersion: payload.baseVersion || null,
    appliedVersion: payload.appliedVersion || null,
    conflict: !!payload.conflict
  });
  if (db.editLog.length > 1000) db.editLog = db.editLog.slice(-1000);
}

function publish(db, note, editor) {
  const d = db.draft;
  const nextNo = (parseInt((db.published?.genId || 'g0').slice(1), 10) || 0) + 1;
  const gen = buildGeneration(
    {
      regions: d.regions, regionGeom: d.regionGeom, routes: d.routes,
      ingredients: d.ingredients, stalls: d.stalls, queues: d.queues
    },
    { genId: 'g' + nextNo, publishedAt: nowIso(), note: note || '' }
  );
  const oldGenId = db.published ? db.published.genId : null;
  db.published = gen;
  db.draft = draftFrom(gen);
  recordEdit(db, {
    editor, entityType: '__generation__', entityId: gen.genId,
    action: 'publish', summary: '发布 ' + gen.genId + (note ? '：' + note : ''),
    baseVersion: oldGenId, appliedVersion: gen.genId
  });
  save(db);
  return gen;
}

module.exports = { init, load, save, publish, recordEdit, draftFrom, buildGeneration, gid, clone };
