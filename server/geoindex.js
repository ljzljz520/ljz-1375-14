'use strict';
const { intervalTouchesMonth } = require('./season');
const { rowCoversMonth } = require('./timeutil');

// 预计算时空索引（方案见 docs/ARCHITECTURE.md）：
//   预计算层 = 空间网格 + “月份×食材”应季集合 —— 只随数据发布变化，发布时重建；
//   查询时求交层 = 跨午夜营业段、临时停业、精确日期边缘 —— 随请求时钟变化，绝不预计算。
const CELL_DEG = 0.05; // 约 5km 网格

function cellKey(lng, lat) {
  return `${Math.floor(lng / CELL_DEG)},${Math.floor(lat / CELL_DEG)}`;
}

function buildIndex(live, gen, year) {
  const stalls = new Map();
  const grid = new Map(); // cellKey -> Set<stallId>
  for (const s of Object.values(live.stalls)) {
    stalls.set(s.id, s);
    const k = cellKey(s.lng, s.lat);
    if (!grid.has(k)) grid.set(k, new Set());
    grid.get(k).add(s.id);
  }
  const offerings = Object.values(live.offerings);
  const seasons = Object.values(live.seasons);
  const stallIngredients = new Map(); // stallId -> Set<ingredientId>
  for (const o of offerings) {
    if (!stallIngredients.has(o.stall_id)) stallIngredients.set(o.stall_id, new Set());
    stallIngredients.get(o.stall_id).add(o.ingredient_id);
  }
  const monthIng = new Map(); // "month:ingredientId" -> Set<stallId>
  const monthAny = new Map(); // month -> Set<stallId>
  for (let m = 1; m <= 12; m += 1) {
    monthAny.set(m, new Set());
    for (const o of offerings) {
      const stall = live.stalls[o.stall_id];
      if (!stall) continue;
      const rows = seasons.filter(
        (r) => r.ingredient_id === o.ingredient_id && rowCoversMonth(r, year, m),
      );
      const row = rows.find((r) => r.region === stall.region)
        || rows.find((r) => r.region === '*');
      if (!row) continue;
      if (!row.intervals.some((iv) => intervalTouchesMonth(m, iv))) continue;
      const k = `${m}:${o.ingredient_id}`;
      if (!monthIng.has(k)) monthIng.set(k, new Set());
      monthIng.get(k).add(stall.id);
      monthAny.get(m).add(stall.id);
    }
  }
  return { gen, year, stalls, grid, stallIngredients, monthIng, monthAny };
}

function cellsInBBox(bbox) {
  const keys = [];
  for (let i = Math.floor(bbox.minLng / CELL_DEG); i <= Math.floor(bbox.maxLng / CELL_DEG); i += 1) {
    for (let j = Math.floor(bbox.minLat / CELL_DEG); j <= Math.floor(bbox.maxLat / CELL_DEG); j += 1) {
      keys.push(`${i},${j}`);
    }
  }
  return keys;
}

function queryIndex(idx, { bbox, month, ingredientId }) {
  let ids;
  if (bbox) {
    ids = new Set();
    for (const k of cellsInBBox(bbox)) {
      const cell = idx.grid.get(k);
      if (cell) for (const id of cell) ids.add(id);
    }
    for (const id of [...ids]) { // 网格粗筛后做精确点过滤
      const s = idx.stalls.get(id);
      if (s.lng < bbox.minLng || s.lng > bbox.maxLng || s.lat < bbox.minLat || s.lat > bbox.maxLat) {
        ids.delete(id);
      }
    }
  } else {
    ids = new Set(idx.stalls.keys());
  }
  if (month) {
    const mset = ingredientId
      ? (idx.monthIng.get(`${month}:${ingredientId}`) || new Set())
      : idx.monthAny.get(month);
    ids = new Set([...ids].filter((id) => mset.has(id)));
  } else if (ingredientId) {
    ids = new Set([...ids].filter((id) => {
      const set = idx.stallIngredients.get(id);
      return set && set.has(ingredientId);
    }));
  }
  return ids;
}

module.exports = { CELL_DEG, buildIndex, queryIndex };
