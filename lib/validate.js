const core = require('../public/js/core.js');

function fail(msg) { const e = new Error(msg); e.badRequest = true; throw e; }

function str(v, name, max = 200) {
  if (typeof v !== 'string' || !v.trim()) fail(name + ' 必填且为字符串');
  if (v.length > max) fail(name + ' 过长(>' + max + ')');
  return v.trim();
}
function optStr(v, max = 200) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') fail('应为字符串或空');
  if (v.length > max) fail('字符串过长');
  return v.trim();
}
function num(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) fail(name + ' 必须为数字');
  if (n < min || n > max) fail(name + ' 超出范围 [' + min + ',' + max + ']');
  return n;
}
function dateStr(v, name) {
  try { core.parseDate(v); } catch (e) { fail(name + ' 必须为 YYYY-MM-DD'); }
  return v;
}
function hm(v, name) {
  try { core.parseHM(v); } catch (e) { fail(name + ' 必须为 HH:MM(00:00-24:00)'); }
  return v;
}
function iso(v, name) {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) fail(name + ' 必须为 ISO 时间');
  return v;
}
function daysArr(v) {
  if (!Array.isArray(v) || !v.length) return [1, 2, 3, 4, 5, 6, 7];
  const d = v.map(Number);
  if (d.some(x => !Number.isInteger(x) || x < 1 || x > 7)) fail('days 取值 1..7');
  return [...new Set(d)].sort();
}

function validateSegment(seg) {
  if (!seg || typeof seg !== 'object') fail('营业段格式错误');
  const out = {
    id: optStr(seg.id, 60) || 'seg-' + Math.random().toString(36).slice(2, 8),
    start: hm(seg.start, '营业开始'),
    end: hm(seg.end, '营业结束'),
    days: daysArr(seg.days)
  };
  // 24:00 结束合法（表示到当天午夜）；end==start 除 00:00/24:00 组合外不允许
  if (out.end === out.start) fail('营业段长度为 0；全天请使用 00:00-24:00');
  return out;
}

function validateClosure(c) {
  if (!c || typeof c !== 'object') fail('停业记录格式错误');
  const out = {
    id: optStr(c.id, 60) || 'cl-' + Math.random().toString(36).slice(2, 8),
    reason: str(c.reason, '停业原因', 200),
    effectiveFrom: dateStr(c.effectiveFrom, '生效起'),
    effectiveTo: dateStr(c.effectiveTo, '生效止'),
    startTime: c.startTime ? hm(c.startTime, '停业起时间') : null,
    endTime: c.endTime ? hm(c.endTime, '停业止时间') : null,
    announcedAt: c.announcedAt ? iso(c.announcedAt, '公告时间') : new Date().toISOString(),
    revoked: !!c.revoked
  };
  if (core.dateOrdinal(out.effectiveTo) < core.dateOrdinal(out.effectiveFrom)) fail('停业生效止早于生效起');
  return out;
}

function validateOffer(o, ingredientIds) {
  if (!o || typeof o !== 'object') fail('供应关系格式错误');
  const ingredientId = str(o.ingredientId, '食材 id', 60);
  if (!ingredientIds.has(ingredientId)) fail('引用了不存在的食材: ' + ingredientId);
  const out = { ingredientId };
  if (o.startDate) out.startDate = dateStr(o.startDate, '供应起');
  if (o.endDate) {
    out.endDate = dateStr(o.endDate, '供应止');
    if (out.startDate && core.dateOrdinal(out.endDate) < core.dateOrdinal(out.startDate)) fail('供应止早于供应起');
  }
  return out;
}

function validateWindow(w) {
  if (!w || typeof w !== 'object') fail('时令窗口格式错误');
  const out = {
    region: optStr(w.region, 40) || '*',
    startMonth: num(w.startMonth, '起始月', 1, 12),
    startDay: num(w.startDay, '起始日', 1, 31),
    endMonth: num(w.endMonth, '结束月', 1, 12),
    endDay: num(w.endDay, '结束日', 1, 31),
    crossYear: !!w.crossYear
  };
  // 校验月日真实存在（用闰年基准允许 2-29）
  [['start', out.startMonth, out.startDay], ['end', out.endMonth, out.endDay]].forEach(([k, mo, d]) => {
    const daysIn = new Date(Date.UTC(2000, mo, 0)).getUTCDate();
    if (d > daysIn) fail(k + ' 月日不存在: ' + mo + '-' + d);
  });
  const s = core.monthDayOrdinal(out.startMonth, out.startDay);
  const e = core.monthDayOrdinal(out.endMonth, out.endDay);
  if (e < s && !out.crossYear) out.crossYear = true; // 自动识别跨年
  if (out.crossYear && e >= s) fail('标记跨年但结束不在起点之前');
  return out;
}

function validateStall(body, ingredientIds) {
  return {
    name: str(body.name, '摊位名称'),
    owner: optStr(body.owner, 80),
    region: str(body.region, '地区 id', 40),
    address: optStr(body.address, 200),
    lon: num(body.lon, '经度', -180, 180),
    lat: num(body.lat, '纬度', -85, 85),
    segments: (Array.isArray(body.segments) ? body.segments : []).map(validateSegment),
    offers: (Array.isArray(body.offers) ? body.offers : []).map(o => validateOffer(o, ingredientIds)),
    closures: (Array.isArray(body.closures) ? body.closures : []).map(validateClosure)
  };
}

function validateIngredient(body) {
  return {
    name: str(body.name, '食材名称', 80),
    category: optStr(body.category, 40),
    windows: (Array.isArray(body.windows) ? body.windows : []).map(validateWindow)
  };
}

function validateQueue(body, stallIds) {
  const stallId = str(body.stallId, '摊位 id', 60);
  if (!stallIds.has(stallId)) fail('引用了不存在的摊位: ' + stallId);
  return {
    stallId,
    waitMinutes: num(body.waitMinutes, '排队分钟', 0, 1440),
    collectedAt: body.collectedAt ? iso(body.collectedAt, '采集时间') : new Date().toISOString(),
    ttlMinutes: num(body.ttlMinutes || 60, 'TTL 分钟', 1, 1440 * 7),
    source: optStr(body.source, 120) || '编辑现场采集'
  };
}

module.exports = {
  validateStall, validateIngredient, validateQueue,
  validateSegment, validateClosure, validateWindow
};
