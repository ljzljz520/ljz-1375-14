'use strict';

// 所有“当地时间”计算固定使用 +08:00（西安），避免服务器时区影响跨午夜与月底判断。
const DEFAULT_TZ_OFFSET_MIN = 8 * 60;

function pad2(n) { return String(n).padStart(2, '0'); }

function parseAt(s) {
  if (s === undefined || s === null || s === '') return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw Object.assign(new Error(`无法解析的时间: ${s}`), { status: 400 });
  }
  return ms;
}

// epoch ms -> 固定偏移时区的墙钟部件
function toLocal(ms, offsetMin = DEFAULT_TZ_OFFSET_MIN) {
  const d = new Date(ms + offsetMin * 60000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year,
    month,
    day,
    weekday: d.getUTCDay(), // 0=周日
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    isoDate: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

// 月-日比较（忽略年份，用于跨年区间）
function mdCmp(m1, d1, m2, d2) {
  return (m1 * 100 + d1) - (m2 * 100 + d2);
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m) throw Object.assign(new Error(`无效时间格式: ${s}`), { status: 400 });
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) {
    throw Object.assign(new Error(`无效时间: ${s}`), { status: 400 });
  }
  return h * 60 + mi;
}

function shiftISODate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

function todayISO(ms, offsetMin = DEFAULT_TZ_OFFSET_MIN) {
  return toLocal(ms, offsetMin).isoDate;
}

function monthRange(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const end = shiftISODate(`${ny}-${pad2(nm)}-01`, -1);
  return { start, end };
}

// 生效范围（日期粒度 YYYY-MM-DD；null/缺省表示开口）
function withinEffective(row, isoDate) {
  if (row.effective_from && isoDate < row.effective_from) return false;
  if (row.effective_to && isoDate > row.effective_to) return false;
  return true;
}

// 行的生效范围是否覆盖某年某月的任意一天
function rowCoversMonth(row, year, month) {
  const { start, end } = monthRange(year, month);
  if (row.effective_from && row.effective_from > end) return false;
  if (row.effective_to && row.effective_to < start) return false;
  return true;
}

module.exports = {
  DEFAULT_TZ_OFFSET_MIN,
  pad2,
  parseAt,
  toLocal,
  mdCmp,
  parseHM,
  shiftISODate,
  todayISO,
  monthRange,
  withinEffective,
  rowCoversMonth,
};
