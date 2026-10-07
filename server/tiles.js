'use strict';

// 演示用等经纬瓦片（非墨卡托），仅用于服务端聚合展示。
function tileBBox(z, x, y) {
  const n = 2 ** z;
  return {
    minLng: (x / n) * 360 - 180,
    maxLng: ((x + 1) / n) * 360 - 180,
    maxLat: 90 - (y / n) * 180,
    minLat: 90 - ((y + 1) / n) * 180,
  };
}

// 地图聚合：以“摊位身份(stall_id)”去重计数。
// 同坐标的多个摊位各自保留身份，绝不因坐标相同而合并为同一商户。
function aggregate(stalls, bbox, sub = 8) {
  const clusters = new Map(); // "cx,cy" -> {ids:Set, lngSum, latSum}
  for (const s of stalls) {
    if (s.lng < bbox.minLng || s.lng > bbox.maxLng || s.lat < bbox.minLat || s.lat > bbox.maxLat) {
      continue;
    }
    const cx = Math.min(sub - 1, Math.floor(((s.lng - bbox.minLng) / (bbox.maxLng - bbox.minLng)) * sub));
    const cy = Math.min(sub - 1, Math.floor(((bbox.maxLat - s.lat) / (bbox.maxLat - bbox.minLat)) * sub));
    const key = `${cx},${cy}`;
    if (!clusters.has(key)) clusters.set(key, { ids: new Set(), lngSum: 0, latSum: 0 });
    const c = clusters.get(key);
    if (!c.ids.has(s.id)) { // 按身份去重
      c.ids.add(s.id);
      c.lngSum += s.lng;
      c.latSum += s.lat;
    }
  }
  return [...clusters.values()].map((c) => ({
    lng: c.lngSum / c.ids.size,
    lat: c.latSum / c.ids.size,
    count: c.ids.size, // 不同摊位身份的数量，不是坐标点数
    stall_ids: [...c.ids].sort(),
  }));
}

module.exports = { tileBBox, aggregate };
