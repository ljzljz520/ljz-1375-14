'use strict';
// 初始种子数据：西安时令美食摊位。所有行都带来源日期与生效范围。
const SEED_SOURCE_DATE = '2026-09-01';
const EFF = { effective_from: '2026-01-01', effective_to: '2026-12-31' };

function row(extra) {
  return { version: 1, source_date: SEED_SOURCE_DATE, updated_by: 'seed', ...EFF, ...extra };
}

function buildSeed() {
  const stalls = {
    S1: row({ id: 'S1', name: '老孙家柿子饼', region: '关中', lng: 108.9420, lat: 34.2610 }),
    S2: row({ id: 'S2', name: '老米家泡馍', region: '关中', lng: 108.9400, lat: 34.2620 }),
    // S3 与 S2 同坐标：用于验证“同坐标多摊不合并为同一商户”
    S3: row({ id: 'S3', name: '夜市烤肉摊', region: '关中', lng: 108.9400, lat: 34.2620 }),
    S4: row({ id: 'S4', name: '秦镇米皮店', region: '关中', lng: 108.8500, lat: 34.2000 }),
    S5: row({ id: 'S5', name: '临潼石榴摊', region: '关中', lng: 109.2100, lat: 34.3700 }),
    S6: row({ id: 'S6', name: '陕南草莓园', region: '陕南', lng: 107.0200, lat: 33.0600 }),
    S7: row({ id: 'S7', name: '关中草莓摊', region: '关中', lng: 108.8000, lat: 34.3000 }),
  };
  const ingredients = {
    ing_shizi: { id: 'ing_shizi', name: '火晶柿子' },
    ing_yangrou: { id: 'ing_yangrou', name: '羊肉' },
    ing_shiliu: { id: 'ing_shiliu', name: '石榴' },
    ing_liangpi: { id: 'ing_liangpi', name: '秦镇米皮' },
    ing_caomei: { id: 'ing_caomei', name: '草莓' },
  };
  const seasons = {
    sea_shizi_gz: row({ id: 'sea_shizi_gz', ingredient_id: 'ing_shizi', region: '关中', intervals: [{ start: { m: 9, d: 15 }, end: { m: 10, d: 31 } }] }),
    // 跨年区间：11-01 至次年 02-28
    sea_yangrou_gz: row({ id: 'sea_yangrou_gz', ingredient_id: 'ing_yangrou', region: '关中', intervals: [{ start: { m: 11, d: 1 }, end: { m: 2, d: 28 } }] }),
    sea_shiliu_gz: row({ id: 'sea_shiliu_gz', ingredient_id: 'ing_shiliu', region: '关中', intervals: [{ start: { m: 9, d: 1 }, end: { m: 10, d: 31 } }] }),
    sea_liangpi_gz: row({ id: 'sea_liangpi_gz', ingredient_id: 'ing_liangpi', region: '关中', intervals: [{ start: { m: 1, d: 1 }, end: { m: 12, d: 31 } }] }),
    // 同一食材不同地区不同档期（地区差异 + 跨年）
    sea_caomei_gz: row({ id: 'sea_caomei_gz', ingredient_id: 'ing_caomei', region: '关中', intervals: [{ start: { m: 12, d: 1 }, end: { m: 4, d: 30 } }] }),
    sea_caomei_sn: row({ id: 'sea_caomei_sn', ingredient_id: 'ing_caomei', region: '陕南', intervals: [{ start: { m: 11, d: 15 }, end: { m: 5, d: 15 } }] }),
  };
  const offerings = {
    off_1: row({ id: 'off_1', stall_id: 'S1', ingredient_id: 'ing_shizi' }),
    off_2: row({ id: 'off_2', stall_id: 'S2', ingredient_id: 'ing_yangrou' }),
    off_3: row({ id: 'off_3', stall_id: 'S3', ingredient_id: 'ing_yangrou' }),
    off_4: row({ id: 'off_4', stall_id: 'S4', ingredient_id: 'ing_liangpi' }),
    off_5: row({ id: 'off_5', stall_id: 'S5', ingredient_id: 'ing_shiliu' }),
    off_6: row({ id: 'off_6', stall_id: 'S6', ingredient_id: 'ing_caomei' }),
    off_7: row({ id: 'off_7', stall_id: 'S7', ingredient_id: 'ing_caomei' }),
  };
  const hours = {
    hrs_S1: row({ id: 'hrs_S1', stall_id: 'S1', weekday: 'daily', segments: [{ open: '09:00', close: '22:00' }] }),
    // 跨午夜营业段
    hrs_S2: row({ id: 'hrs_S2', stall_id: 'S2', weekday: 'daily', segments: [{ open: '10:00', close: '02:00' }] }),
    hrs_S3: row({ id: 'hrs_S3', stall_id: 'S3', weekday: 'daily', segments: [{ open: '20:00', close: '02:00' }] }),
    hrs_S4: row({ id: 'hrs_S4', stall_id: 'S4', weekday: 'daily', segments: [{ open: '08:00', close: '20:00' }] }),
    hrs_S5: row({ id: 'hrs_S5', stall_id: 'S5', weekday: 'daily', segments: [{ open: '09:00', close: '18:00' }] }),
    hrs_S6: row({ id: 'hrs_S6', stall_id: 'S6', weekday: 'daily', segments: [{ open: '09:00', close: '17:00' }] }),
    hrs_S7: row({ id: 'hrs_S7', stall_id: 'S7', weekday: 'daily', segments: [{ open: '10:00', close: '21:00' }] }),
  };
  return {
    gen: 1,
    seq: 100,
    live: { stalls, ingredients, seasons, offerings, hours, closures: {} },
    queue: {
      S2: { minutes: 25, collected_at: new Date().toISOString() },
    },
    audit: [{ gen: 1, at: new Date().toISOString(), by: 'seed', note: '初始数据' }],
  };
}

if (require.main === module) {
  const path = require('path');
  const DB = require('./db');
  const force = process.argv.includes('--force');
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
  if (!force && require('fs').existsSync(file)) {
    console.error(`数据文件已存在: ${file}（使用 --force 覆盖）`);
    process.exit(1);
  }
  const db = new DB(null);
  db.file = file;
  db.loadSeed(buildSeed());
  console.log(`已写入种子数据: ${file} (gen=${db.data.gen})`);
}

module.exports = { buildSeed };
