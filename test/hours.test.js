'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isOpenAt, isWrap } = require('../server/hours');

const rows = [
  { stall_id: 'S', weekday: 'daily', segments: [{ open: '20:00', close: '02:00' }], effective_from: '2026-01-01', effective_to: '2026-12-31' },
];

function local(isoDate, weekday, minutes) {
  return { isoDate, weekday, minutes };
}

test('跨午夜段识别', () => {
  assert.equal(isWrap({ open: '20:00', close: '02:00' }), true);
  assert.equal(isWrap({ open: '09:00', close: '18:00' }), false);
});

test('跨午夜营业：当日深夜与次日凌晨都算营业', () => {
  // 2026-10-31 是周六(6)
  assert.equal(isOpenAt(rows, 'S', local('2026-10-31', 6, 21 * 60)), true);  // 周六 21:00
  assert.equal(isOpenAt(rows, 'S', local('2026-11-01', 0, 30)), true);       // 周日 00:30（周六段的延续）
  assert.equal(isOpenAt(rows, 'S', local('2026-11-01', 0, 1 * 60 + 59)), true); // 01:59
  assert.equal(isOpenAt(rows, 'S', local('2026-11-01', 0, 3 * 60)), false);  // 03:00 已收摊
  assert.equal(isOpenAt(rows, 'S', local('2026-10-31', 6, 19 * 60)), false); // 19:00 未开摊
});

test('普通段不跨日', () => {
  const r = [{ stall_id: 'S', weekday: 'daily', segments: [{ open: '09:00', close: '18:00' }], effective_from: '2026-01-01', effective_to: '2026-12-31' }];
  assert.equal(isOpenAt(r, 'S', local('2026-10-31', 6, 10 * 60)), true);
  assert.equal(isOpenAt(r, 'S', local('2026-10-31', 6, 18 * 60)), false);
  assert.equal(isOpenAt(r, 'S', local('2026-11-01', 0, 2 * 60)), false);
});

test('生效范围外的营业段不参与判断', () => {
  assert.equal(isOpenAt(rows, 'S', local('2027-01-05', 2, 21 * 60)), false);
});
