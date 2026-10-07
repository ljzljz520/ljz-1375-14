/**
 * core.js —— 共享领域逻辑（服务器 Node 与浏览器同一份代码）
 *
 * 关键语义：
 * 1. 食材“时令区间”是 (region, 起止月日, 跨年) 的显式窗口，绝不从单个月份字段推断。
 * 2. “季节性供应 inSeason” 与 “当天此刻是否营业 isOpen” 是两个独立判断，
 *    摊位存在某个在季食材 ≠ 摊位此刻开门；反之亦然。
 * 3. 营业段 startMinute/endMinute 以“营业日 00:00 起的分钟数”表达；end<=start 表示跨午夜。
 *    跨午夜段在判定时同时考虑“当天开始、前夜延续”两个候选日。
 * 4. 临时停业 (closure) 带 [effectiveFrom, effectiveTo] 与 announcedAt，
 *    早于正式公告时间也必须生效（闭店告示提前贴出即有效）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FoodCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_PER_DAY = 24 * 60;

  function pad2(n) { return String(n).padStart(2, '0'); }

  /** 解析 'YYYY-MM-DD' 为 UTC 日期分量（服务/前端统一按“当地日历日”比较，不涉及时区漂移） */
  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) throw new Error('非法日期: ' + s);
    return { y: +m[1], mo: +m[2], d: +m[3] };
  }

  /** 日历日序（相对于任意纪元的整数天），仅用于日期先后/包含判断 */
  function dayOrdinal(y, mo, d) {
    // Date.UTC 得到稳定整数，除以日毫秒数
    return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
  }

  function dateOrdinal(s) {
    const p = parseDate(s);
    return dayOrdinal(p.y, p.mo, p.d);
  }

  function ordinalToDate(ord) {
    const t = new Date(ord * 86400000);
    return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
  }

  /** 月日转年内序号（1..366），用于时令窗口跨年比较 */
  function monthDayOrdinal(mo, d) {
    // 以闰年为基准使 02-29 可表达，非闰年数据不应包含该日
    return dayOrdinal(2000, mo, d) - dayOrdinal(2000, 1, 1) + 1;
  }

  /**
   * 判断某个时令窗口在给定日历日是否在季。
   * window: { startMonth,startDay,endMonth,endDay, crossYear? }
   * crossYear 为 true（或按 end<start 自动判定）时窗口从年末跨到年初。
   */
  function isWindowActiveAt(win, dateStr) {
    const p = parseDate(dateStr);
    const start = monthDayOrdinal(win.startMonth, win.startDay);
    const end = monthDayOrdinal(win.endMonth, win.endDay);
    const cur = monthDayOrdinal(p.mo, p.d);
    const cross = win.crossYear != null ? win.crossYear : end < start;
    if (cross) return cur >= start || cur <= end;
    return cur >= start && cur <= end;
  }

  /**
   * 食材在某天、某地区是否在季。
   * ingredient: { id, name, windows: [{region?,startMonth,...,endMonth,...}] }
   * region 允许差异：窗口可限定 region；'*' 或缺省表示全域默认。
   * 优先采用精确地区窗口；无精确窗口时回退全域窗口（但不会由月份字段臆测）。
   */
  function isIngredientInSeason(ingredient, region, dateStr) {
    const wins = (ingredient.windows || []).filter(function (w) {
      return isWindowActiveAt(w, dateStr);
    });
    const exact = wins.filter(function (w) { return w.region && w.region !== '*' && w.region === region; });
    if (exact.length) return true;
    // 该日只有“别的地区”的窗口在生效，则本地区并不在季
    const regional = wins.filter(function (w) { return w.region && w.region !== '*'; });
    if (regional.length) return false;
    return wins.some(function (w) { return !w.region || w.region === '*'; });
  }

  /** 解析 'HH:MM' 为分钟 */
  function parseHM(hm) {
    const m = /^(\d{2}):(\d{2})$/.exec(hm || '');
    if (!m) throw new Error('非法时间: ' + hm);
    const h = +m[1], mm = +m[2];
    if (h > 24 || mm > 59 || (h === 24 && mm !== 0)) throw new Error('非法时间: ' + hm);
    return h * 60 + mm;
  }

  /**
   * 营业段是否覆盖给定“分钟时刻”。
   * seg: { start:'HH:MM', end:'HH:MM', days?:[1..7] }，end<=start 视为跨午夜。
   * dayOfWeek: 该分钟所在营业锚点日的星期（周一=1..周日=7）。
   */
  function segmentCovers(seg, minute, dayOfWeek) {
    const s = parseHM(seg.start), e = parseHM(seg.end);
    if (Array.isArray(seg.days) && seg.days.length && !seg.days.includes(dayOfWeek)) return false;
    if (e > s) return minute >= s && minute < e;
    if (e === s) return false; // 零长段不营业（24 小时须显式 00:00-24:00）
    return minute >= s || minute < e; // 跨午夜
  }

  /**
   * 此刻是否有任意营业段覆盖（考虑跨午夜的前夜段）。
   * at: Date
   */
  function isOpenAt(segments, at) {
    if (!segments || !segments.length) return false;
    const minute = at.getHours() * 60 + at.getMinutes();
    const dow = at.getDay() === 0 ? 7 : at.getDay();
    for (const seg of segments) {
      const s = parseHM(seg.start), e = parseHM(seg.end);
      if (e <= s) {
        // 跨午夜：可能属于“当天开始的段”，也可能是“前夜开始延续到今天”的段
        if (segmentCovers(seg, minute, dow)) return true;
        if (minute < e) {
          // 处于前夜延续区：用昨天星期再校验一次 days 约束
          const y = new Date(at.getTime() - 86400000);
          const ydow = y.getDay() === 0 ? 7 : y.getDay();
          const days = Array.isArray(seg.days) && seg.days.length ? seg.days : null;
          if (!days || days.includes(ydow)) return true;
        }
      } else if (segmentCovers(seg, minute, dow)) {
        return true;
      }
    }
    return false;
  }

  /** 日期闭包包含 */
  function dateRangeContains(fromStr, toStr, dateStr) {
    const c = dateOrdinal(dateStr);
    if (fromStr && c < dateOrdinal(fromStr)) return false;
    if (toStr && c > dateOrdinal(toStr)) return false;
    return true;
  }

  /**
   * 临时停业是否对 at 生效。
   * closure: { effectiveFrom, effectiveTo, announcedAt }
   * 规则：at 的日历日落入 [effectiveFrom, effectiveTo] 即停业；
   * announcedAt 仅作信息标注——即使早于“正式公告”（at < announcedAt），
   * 只要编辑已写入生效范围，就以数据为准（临时停业早于正式公告也要生效）。
   */
  function closureActiveAt(closure, at) {
    const ds = at.getFullYear() + '-' + pad2(at.getMonth() + 1) + '-' + pad2(at.getDate());
    const inRange = dateRangeContains(closure.effectiveFrom, closure.effectiveTo, ds);
    if (!inRange) return false;
    if (closure.startTime || closure.endTime) {
      const minute = at.getHours() * 60 + at.getMinutes();
      if (closure.startTime && minute < parseHM(closure.startTime)) return false;
      if (closure.endTime && minute >= parseHM(closure.endTime)) return false;
    }
    return true;
  }

  /**
   * 综合摊位营业状态。
   * stall: { id, segments:[...], closures:[...] }
   * 返回 { status: 'open'|'closed'|'suspended', reason }
   * 与“在季”完全解耦。
   */
  function evaluateStatus(stall, at) {
    const closures = (stall.closures || []).filter(function (c) { return !c.revoked; });
    for (const c of closures) {
      if (closureActiveAt(c, at)) {
        return {
          status: 'suspended',
          reason: c.reason || '临时停业',
          closureId: c.id,
          effectiveFrom: c.effectiveFrom,
          effectiveTo: c.effectiveTo,
          announcedAt: c.announcedAt || null
        };
      }
    }
    if (isOpenAt(stall.segments, at)) return { status: 'open', reason: null };
    return { status: 'closed', reason: '当前不在营业时段' };
  }

  /** 摊位在某天供应的在季食材 id 列表（offer 还可带自身的供应窗口/停供，作交集） */
  function inSeasonOffers(stall, ingredientsById, region, dateStr) {
    return (stall.offers || []).filter(function (o) {
      if (o.startDate && dateOrdinal(dateStr) < dateOrdinal(o.startDate)) return false;
      if (o.endDate && dateOrdinal(dateStr) > dateOrdinal(o.endDate)) return false;
      const ing = ingredientsById[o.ingredientId];
      if (!ing) return false;
      return isIngredientInSeason(ing, region || stall.region || '*', dateStr);
    }).map(function (o) { return o.ingredientId; });
  }

  /** 经纬度（度）转 Web Mercator 归一化坐标 0..1 */
  function lonLatToNorm(lon, lat) {
    const x = (lon + 180) / 360;
    const s = Math.sin(lat * Math.PI / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [x, y];
  }

  /** GeoJSON-ish 点是否在多边形内（ray casting），ring: [[lon,lat],...] */
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  return {
    parseDate: parseDate, parseHM: parseHM, pad2: pad2,
    dateOrdinal: dateOrdinal, ordinalToDate: ordinalToDate, dayOrdinal: dayOrdinal,
    monthDayOrdinal: monthDayOrdinal,
    isWindowActiveAt: isWindowActiveAt,
    isIngredientInSeason: isIngredientInSeason,
    segmentCovers: segmentCovers, isOpenAt: isOpenAt,
    dateRangeContains: dateRangeContains, closureActiveAt: closureActiveAt,
    evaluateStatus: evaluateStatus, inSeasonOffers: inSeasonOffers,
    lonLatToNorm: lonLatToNorm, pointInRing: pointInRing
  };
});
