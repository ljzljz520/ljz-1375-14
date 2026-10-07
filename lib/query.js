const core = require('../public/js/core.js');

function resolveRegion(gen, lon, lat) {
  if (lon == null || lat == null) return null;
  // 先精确匹配小区域（主城区在内环），再回退大区域
  const order = ['xian-urban', 'xian-suburb'];
  for (const rid of order) {
    const ring = gen.regionGeom[rid];
    if (ring && core.pointInRing(lon, lat, ring)) return rid;
  }
  return null;
}

function queueView(q, at) {
  const collected = new Date(q.collectedAt).getTime();
  const freshUntil = collected + q.ttlMinutes * 60000;
  const fresh = at.getTime() <= freshUntil;
  return {
    id: q.id, stallId: q.stallId, waitMinutes: q.waitMinutes,
    collectedAt: q.collectedAt, ttlMinutes: q.ttlMinutes, source: q.source,
    fresh: fresh,
    stale: !fresh,
    freshUntil: new Date(freshUntil).toISOString()
  };
}

/**
 * 统一查询：地图与列表共享同一筛选与同一结果集。
 * f: { atIso, region, ingredientId, openOnly, inSeasonOnly, bbox:{minLon,minLat,maxLon,maxLat}, q(文本) }
 */
function queryStalls(gen, f) {
  const at = f.atIso ? new Date(f.atIso) : new Date();
  const dateStr = at.getFullYear() + '-' + core.pad2(at.getMonth() + 1) + '-' + core.pad2(at.getDate());
  const rows = gen.stalls.map(function (s) {
    const status = core.evaluateStatus(s, at);
    const inSeasonIds = core.inSeasonOffers(s, gen.ingredientsById, s.region, dateStr);
    return { stall: s, status: status, inSeasonIds: inSeasonIds };
  });

  return rows.filter(function (r) {
    const s = r.stall;
    if (f.region && s.region !== f.region) return false;
    if (f.ingredientId) {
      const hasOffer = (s.offers || []).some(o => o.ingredientId === f.ingredientId);
      if (!hasOffer) return false;
      if (f.inSeasonOnly && !r.inSeasonIds.includes(f.ingredientId)) return false;
    } else if (f.inSeasonOnly && r.inSeasonIds.length === 0) {
      return false;
    }
    if (f.openOnly) {
      // “营业中”仅 open；suspended/closed 都不算
      if (r.status.status !== 'open') return false;
    }
    if (f.bbox) {
      const b = f.bbox;
      if (s.lon < b.minLon || s.lon > b.maxLon || s.lat < b.minLat || s.lat > b.maxLat) return false;
    }
    if (f.q) {
      const hay = [s.name, s.address, s.owner].filter(Boolean).join(' ');
      if (!hay.toLowerCase().includes(String(f.q).toLowerCase())) return false;
    }
    return true;
  }).map(function (r) {
    const s = r.stall;
    return {
      id: s.id, name: s.name, owner: s.owner, region: s.region,
      address: s.address, lon: s.lon, lat: s.lat,
      segments: s.segments,
      status: r.status,
      inSeasonIngredientIds: r.inSeasonIds,
      inSeasonIngredients: r.inSeasonIds.map(id => gen.ingredientsById[id]).filter(Boolean).map(i => ({ id: i.id, name: i.name })),
      offers: (s.offers || []).map(o => {
        const ing = gen.ingredientsById[o.ingredientId];
        return {
          ingredientId: o.ingredientId,
          name: ing ? ing.name : o.ingredientId,
          inSeason: r.inSeasonIds.includes(o.ingredientId)
        };
      }),
      queues: (gen.queuesByStall[s.id] || []).map(q => queueView(q, at))
    };
  });
}

/**
 * 地图聚合统计：以摊位身份(stall.id)去重计数。
 * 同坐标多摊 → count=2 且给出各自 id，绝不合并成同一商户。
 */
function aggregate(stats) {
  const byCoord = new Map();
  let open = 0, suspended = 0, closed = 0, withSeason = 0;
  for (const r of stats) {
    if (r.status.status === 'open') open++;
    else if (r.status.status === 'suspended') suspended++;
    else closed++;
    if (r.inSeasonIngredientIds.length) withSeason++;
    const key = r.lon.toFixed(6) + ',' + r.lat.toFixed(6);
    if (!byCoord.has(key)) byCoord.set(key, { lon: r.lon, lat: r.lat, stallIds: [], names: [] });
    const c = byCoord.get(key);
    if (!c.stallIds.includes(r.id)) { c.stallIds.push(r.id); c.names.push(r.name); }
  }
  return {
    totalStalls: stats.length,
    open: open, suspended: suspended, closed: closed,
    inSeasonStalls: withSeason,
    // distinct 坐标只是参考；商户数以 totalStalls 为准
    distinctCoordinates: byCoord.size,
    coLocated: [...byCoord.values()].filter(c => c.stallIds.length > 1)
  };
}

module.exports = { queryStalls, aggregate, resolveRegion, queueView };
