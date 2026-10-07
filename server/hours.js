'use strict';
const { parseHM, shiftISODate, withinEffective } = require('./timeutil');

// 营业段 {open:'20:00', close:'02:00'}；close <= open 视为跨午夜，段归属于开始当日。
function isWrap(seg) {
  return parseHM(seg.close) <= parseHM(seg.open);
}

function rowsFor(hoursRows, stallId, weekday, isoDate) {
  return hoursRows.filter(
    (r) => r.stall_id === stallId
      && (r.weekday === 'daily' || r.weekday === weekday)
      && withinEffective(r, isoDate),
  );
}

// local: {weekday, minutes, isoDate}（当地墙钟）
function isOpenAt(hoursRows, stallId, local) {
  const t = local.minutes;
  // 1) 当日开始的段
  for (const r of rowsFor(hoursRows, stallId, local.weekday, local.isoDate)) {
    for (const seg of r.segments) {
      const o = parseHM(seg.open);
      const c = parseHM(seg.close);
      if (c <= o) {
        if (t >= o) return true; // 跨午夜段的前半部分
      } else if (t >= o && t < c) {
        return true;
      }
    }
  }
  // 2) 昨日开始、跨到今日凌晨的段
  const yW = (local.weekday + 6) % 7;
  const yDate = shiftISODate(local.isoDate, -1);
  for (const r of rowsFor(hoursRows, stallId, yW, yDate)) {
    for (const seg of r.segments) {
      const o = parseHM(seg.open);
      const c = parseHM(seg.close);
      if (c <= o && t < c) return true;
    }
  }
  return false;
}

module.exports = { isOpenAt, isWrap };
