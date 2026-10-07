const core = require('../public/js/core.js');

/**
 * 确定性 SVG 瓦片：同代际 + 同参数 => 同字节（可缓存/可离线打包）。
 * 瓦片只画“发布快照”里的点位；营业/在季状态在前端叠层，瓦片失败可降级。
 */
function tileSvg(gen, z, x, y, opts) {
  opts = opts || {};
  const size = 256;
  const n = Math.pow(2, z);
  // 瓦片经纬度边界（Web Mercator）
  function tile2lon(xx) { return xx / n * 360 - 180; }
  function tile2lat(yy) {
    const k = Math.PI - 2 * Math.PI * yy / n;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k)));
  }
  const minLon = tile2lon(x), maxLon = tile2lon(x + 1);
  const maxLat = tile2lat(y), minLat = tile2lat(y + 1);

  const hits = gen.spatialIndex
    ? gen.stalls.filter(s => s.lon >= minLon && s.lon <= maxLon && s.lat >= minLat && s.lat <= maxLat)
    : [];

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">');
  parts.push('<rect width="100%" height="100%" fill="#f6f1e7"/>');
  // 网格线
  parts.push('<g stroke="#e2d8c3" stroke-width="1">');
  for (let i = 1; i < 4; i++) {
    parts.push('<line x1="' + (i * 64) + '" y1="0" x2="' + (i * 64) + '" y2="256"/>');
    parts.push('<line x1="0" y1="' + (i * 64) + '" x2="256" y2="' + (i * 64) + '"/>');
  }
  parts.push('</g>');

  // 同坐标多摊：竖向堆叠画多个点，不画成一个点
  const seen = {};
  hits.forEach(s => {
    const [nx, ny] = core.lonLatToNorm(s.lon, s.lat);
    const px = ((nx * n - x) % 1 + 1) % 1 * size;
    const py = ((ny * n - y) % 1 + 1) % 1 * size;
    const k = s.lon.toFixed(6) + ',' + s.lat.toFixed(6);
    seen[k] = (seen[k] || 0);
    const dy = seen[k] * -9;
    seen[k]++;
    parts.push('<g id="stall-' + s.id + '">');
    parts.push('<circle cx="' + px.toFixed(1) + '" cy="' + (py + dy).toFixed(1) + '" r="7" fill="#8b2e2e" stroke="#fff" stroke-width="1.5"/>');
    parts.push('</g>');
  });
  parts.push('<text x="6" y="250" font-size="10" fill="#9a8d74">gen=' + gen.genId + ' z' + z + '/' + x + '/' + y + ' stalls=' + hits.length + '</text>');
  parts.push('</svg>');
  return parts.join('');
}

module.exports = { tileSvg };
