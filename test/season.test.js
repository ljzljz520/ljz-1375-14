'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inInterval, inSeason, intervalTouchesMonth, findSeasonRow } = require('../server/season');

test('普通区间：起止同年', () => {
  const iv = { start: { m: 9, d: 15 }, end: { m: 10, d: 31 } };
  assert.equal(inInterval(10, 31, iv), true);
  assert.equal(inInterval(9, 15, iv), true);
  assert.equal(inInterval(9, 14, iv), false);
  assert.equal(inInterval(11, 1, iv), false);
});

test('跨年区间：11-01 至 02-28', () => {
  const iv = { start: { m: 11, d: 1 }, end: { m: 2, d: 28 } };
  assert.equal(inInterval(11, 1, iv), true);
  assert.equal(inInterval(12, 25, iv), true);
  assert.equal(inInterval(1, 15, iv), true);
  assert.equal(inInterval(2, 28, iv), true);
  assert.equal(inInterval(3, 1, iv), false);
  assert.equal(inInterval(10, 31, iv), false);
});

test('月份交集：跨年区间覆盖 11/12/1/2 月，不覆盖 10 月', () => {
  const iv = { start: { m: 11, d: 1 }, end: { m: 2, d: 28 } };
  assert.equal(intervalTouchesMonth(11, iv), true);
  assert.equal(intervalTouchesMonth(1, iv), true);
  assert.equal(intervalTouchesMonth(10, iv), false);
  assert.equal(intervalTouchesMonth(3, iv), false);
});

test('inSeason 多区间', () => {
  const ivs = [
    { start: { m: 3, d: 1 }, end: { m: 4, d: 30 } },
    { start: { m: 11, d: 1 }, end: { m: 2, d: 28 } },
  ];
  assert.equal(inSeason(1, 10, ivs), true);
  assert.equal(inSeason(5, 10, ivs), false);
});

test('地区差异：精确地区优先，通用 * 兜底，生效范围外的行不参与', () => {
  const seasons = [
    { ingredient_id: 'ing', region: '关中', intervals: [{ start: { m: 12, d: 1 }, end: { m: 4, d: 30 } }], effective_from: '2026-01-01', effective_to: '2026-12-31' },
    { ingredient_id: 'ing', region: '陕南', intervals: [{ start: { m: 11, d: 15 }, end: { m: 5, d: 15 } }], effective_from: '2026-01-01', effective_to: '2026-12-31' },
    { ingredient_id: 'ing', region: '*', intervals: [{ start: { m: 1, d: 1 }, end: { m: 12, d: 31 } }], effective_from: '2026-01-01', effective_to: '2026-12-31' },
  ];
  assert.equal(findSeasonRow(seasons, 'ing', '关中', '2026-11-20').region, '关中');
  assert.equal(findSeasonRow(seasons, 'ing', '陕南', '2026-11-20').region, '陕南');
  assert.equal(findSeasonRow(seasons, 'ing', '陕北', '2026-11-20').region, '*');
  // 生效范围之外：2027 年所有行都失效
  assert.equal(findSeasonRow(seasons, 'ing', '关中', '2027-01-10'), null);
});
