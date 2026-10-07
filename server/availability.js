'use strict';
const { toLocal } = require('./timeutil');
const { findSeasonRow, inSeason } = require('./season');
const { isOpenAt } = require('./hours');

// 临时停业按生效范围（时间粒度）判定；source_date / announced_at 只是来源信息，
// 即使正式公告尚未发布，只要当前时刻落在生效范围内就必须视为停业。
function activeClosure(closures, stallId, atMs) {
  return closures.find(
    (c) => c.stall_id === stallId
      && Date.parse(c.effective_from) <= atMs
      && atMs <= Date.parse(c.effective_to),
  ) || null;
}

// 核心：区分“季节性供应”与“当天实际营业”。
// available_now = 应季 ∧ 营业 ∧ 未停业，绝不由单一月份字段推断。
function stallAvailability(view, stall, atMs, tzOffset) {
  const local = toLocal(atMs, tzOffset);
  const offs = view.offerings.filter((o) => o.stall_id === stall.id);
  const seasonal = offs.map((o) => {
    const row = findSeasonRow(view.seasons, o.ingredient_id, stall.region, local.isoDate);
    return {
      ingredient_id: o.ingredient_id,
      in_season: row ? inSeason(local.month, local.day, row.intervals) : false,
      intervals: row ? row.intervals : null,
    };
  });
  const inSeasonNow = seasonal.some((s) => s.in_season);
  const closure = activeClosure(view.closures, stall.id, atMs);
  const openNow = !closure && isOpenAt(view.hours, stall.id, local);
  return {
    seasonal,
    in_season_now: inSeasonNow, // 季节性供应
    temporarily_closed: Boolean(closure), // 临时停业（按生效范围）
    closure,
    open_now: openNow, // 当天此时实际营业
    available_now: inSeasonNow && openNow, // 可购买性
  };
}

module.exports = { stallAvailability, activeClosure };
