'use strict';
const { mdCmp, withinEffective } = require('./timeutil');

// 时令区间 {start:{m,d}, end:{m,d}}；start 晚于 end 表示跨年（如 11-01 至 02-28）。
// 不允许用单一月份字段表达时令：区间是带起止月日的列表，且按地区分别维护。
function inInterval(month, day, iv) {
  const s = iv.start;
  const e = iv.end;
  if (mdCmp(s.m, s.d, e.m, e.d) <= 0) {
    return mdCmp(s.m, s.d, month, day) <= 0 && mdCmp(month, day, e.m, e.d) <= 0;
  }
  // 跨年：大于等于起点 或 小于等于终点
  return mdCmp(s.m, s.d, month, day) <= 0 || mdCmp(month, day, e.m, e.d) <= 0;
}

function inSeason(month, day, intervals) {
  return Array.isArray(intervals) && intervals.some((iv) => inInterval(month, day, iv));
}

// 区间是否与某月有交集（用于“按月份浏览”的粗筛，不等于当日可购买）
function intervalTouchesMonth(month, iv) {
  for (let d = 1; d <= 31; d += 1) {
    if (inInterval(month, d, iv)) return true;
  }
  return false;
}

// 地区差异：优先精确地区行，其次 '*' 通用行；两者都必须在生效范围内
function findSeasonRow(seasons, ingredientId, region, isoDate) {
  const rows = seasons.filter(
    (r) => r.ingredient_id === ingredientId && withinEffective(r, isoDate),
  );
  return rows.find((r) => r.region === region)
    || rows.find((r) => r.region === '*')
    || null;
}

module.exports = { inInterval, inSeason, intervalTouchesMonth, findSeasonRow };
