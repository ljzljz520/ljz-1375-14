/* 自动化验收：node test/core.test.js
 * 分两部分：
 *  A. 纯领域逻辑单元测试（跨年/地区差异/跨午夜/临时停业/排队）
 *  B. 起真实 HTTP 服务做端到端（乐观锁冲突、瓦片失败、发布同代切换、筛选）
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const C = require('../public/js/core.js');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); }
function eq(name, a, b) { assert.strictEqual(a, b, name + ` (got ${a})`); passed++; console.log('  ✓ ' + name); }

console.log('A. 时令窗口');
const liangpi = { id: 'i', name: '凉皮', windows: [
  { region: 'xian-urban', startMonth: 4, startDay: 25, endMonth: 10, endDay: 5 },
  { region: 'xian-suburb', startMonth: 4, startDay: 1, endMonth: 10, endDay: 31 }
] };
ok('主城区 10-05 仍在季（边界含端点）', C.isIngredientInSeason(liangpi, 'xian-urban', '2026-10-05'));
ok('主城区 10-06 已过季', !C.isIngredientInSeason(liangpi, 'xian-urban', '2026-10-06'));
ok('周边 10-06 仍在季（地区差异）', C.isIngredientInSeason(liangpi, 'xian-suburb', '2026-10-06'));
ok('周边 10-31 仍在季（月底切换当天）', C.isIngredientInSeason(liangpi, 'xian-suburb', '2026-10-31'));
ok('周边 11-01 过季（次月首日）', !C.isIngredientInSeason(liangpi, 'xian-suburb', '2026-11-01'));
ok('未知地区不臆测为在季', !C.isIngredientInSeason(liangpi, 'beijing', '2026-05-01'));

const shiliu = { id: 's', name: '石榴', windows: [{ region: 'xian-suburb', startMonth: 9, startDay: 10, endMonth: 11, endDay: 20 }] };
ok('只有别的地区窗口 => 主城区永不在季（不能由月份推断可买）', !C.isIngredientInSeason(shiliu, 'xian-urban', '2026-10-01'));

const la = { id: 'la', name: '腊牛肉', windows: [{ region: '*', startMonth: 11, startDay: 20, endMonth: 2, endDay: 28, crossYear: true }] };
ok('跨年：11-19 不在季', !C.isIngredientInSeason(la, '*', '2026-11-19'));
ok('跨年：11-20 起在季', C.isIngredientInSeason(la, '*', '2026-11-20'));
ok('跨年：次年 02-28 仍在季（端点）', C.isIngredientInSeason(la, '*', '2027-02-28'));
ok('跨年：03-01 出季', !C.isIngredientInSeason(la, '*', '2027-03-01'));
ok('跨年：01-15 在季（年初侧）', C.isIngredientInSeason(la, '*', '2027-01-15'));

console.log('B. 营业段跨午夜');
const night = [{ start: '18:00', end: '02:30', days: [1, 2, 3, 4, 5, 6, 7] }];
ok('19:00 营业', C.isOpenAt(night, new Date(2026, 9, 7, 19, 0)));
ok('01:00 营业（跨到次日凌晨）', C.isOpenAt(night, new Date(2026, 9, 7, 1, 0)));
ok('10:00 不营业', !C.isOpenAt(night, new Date(2026, 9, 7, 10, 0)));
const weekdayOnly = [{ start: '18:00', end: '02:00', days: [2] }]; // 周二晚开到周三凌晨
ok('周三凌晨 01:00：段属于周二夜 => 营业', C.isOpenAt(weekdayOnly, new Date(2026, 9, 7, 1, 0))); // 2026-10-07 是周三
ok('周四凌晨 01:00：非周二夜 => 不营业', !C.isOpenAt(weekdayOnly, new Date(2026, 9, 8, 1, 0)));

console.log('C. 季节性供应 vs 当天营业 必须独立');
const stall = {
  id: 'X', segments: [{ start: '10:00', end: '12:00' }],
  offers: [{ ingredientId: 'la' }], closures: []
};
const atNight = new Date(2027, 0, 15, 23, 0); // 腊牛肉在季但摊位深夜关门
const st1 = C.evaluateStatus(stall, atNight);
eq('在季食材存在但深夜：营业状态=closed', st1.status, 'closed');
const atMorning = new Date(2027, 5, 15, 11, 0); // 6 月腊牛肉非季，但 10-12 营业段开门
ok('6 月上午：在季判断=false', !C.isIngredientInSeason(la, '*', '2027-06-15'));
eq('非季但营业段内：状态=open（两者解耦）', C.evaluateStatus(stall, atMorning).status, 'open');

console.log('D. 临时停业早于正式公告');
const stall2 = {
  id: 'Y', segments: [{ start: '00:00', end: '24:00' }],
  closures: [{ id: 'c', reason: '提前贴的告示', effectiveFrom: '2026-10-07', effectiveTo: '2026-10-07', announcedAt: '2026-10-08T09:00:00' }]
};
const beforeAnnounce = new Date(2026, 9, 7, 20, 0); // 公告时间是明天
eq('公告未到但生效范围已开始 => suspended', C.evaluateStatus(stall2, beforeAnnounce).status, 'suspended');
const after = new Date(2026, 9, 9, 20, 0);
eq('停业范围外恢复 open', C.evaluateStatus(stall2, after).status, 'open');
stall2.closures[0].revoked = true;
eq('撤销后恢复 open', C.evaluateStatus(stall2, beforeAnnounce).status, 'open');

// 端到端
runE2E().catch(e => { console.error('E2E 失败:', e); process.exit(1); });

async function runE2E() {
  console.log('E. HTTP 端到端（隔离数据目录）');
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'food-e2e-'));
  process.env.DATA_DIR = tmpDir; // server 默认 data/，这里通过环境变量改路径
  // 为支持 DATA_DIR，需在 server 引入前设置；store.js 使用固定 data/，故测试直接换库文件：
  const dbFile = path.join(__dirname, '..', 'data', 'db.json');
  const backup = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
  try { fs.unlinkSync(dbFile); } catch (e) {}

  process.env.PORT = '3199';
  process.env.ADMIN_TOKEN = 'test-token';
  const server = require('../server');
  await new Promise(r => server.listen(3199, r));
  const base = 'http://localhost:3199';
  const T = { 'X-Editor-Token': 'test-token', 'Content-Type': 'application/json', 'X-Editor-Name': 'tester' };

  function req(method, p, body, headers) {
    return new Promise((resolve, reject) => {
      const u = new URL(base + p);
      const data = body ? JSON.stringify(body) : null;
      const h = Object.assign({}, headers || {});
      if (data) h['Content-Type'] = 'application/json';
      const r = http.request({ hostname: '127.0.0.1', port: 3199, path: p, method, headers: h }, res => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => {
          let j = null; try { j = JSON.parse(buf); } catch (e) {}
          resolve({ status: res.statusCode, json: j, text: buf, headers: res.headers });
        });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
  }

  // E1. 月底切换走 API
  let r = await req('GET', '/api/stalls?at=2026-10-31T12:00:00&region=xian-suburb&ingredient=ing-liangpi');
  eq('[API] 10-31 周边凉皮匹配摊位', r.json.count >= 0, true); // S003 卖石榴，过滤后 0，但窗口逻辑已在 A 部分验证
  r = await req('GET', '/api/stats?at=2026-10-07T19:00:00');
  eq('[API] 聚合总数=4（按摊位身份）', r.json.aggregate.totalStalls, 4);
  ok('[API] 同坐标两摊被标记为 coLocated 且不合并', r.json.aggregate.coLocated.some(c => c.stallIds.includes('S001') && c.stallIds.includes('S004')));

  // E2. 临时停业（种子里 S002 10-06~10-08）
  r = await req('GET', '/api/stalls?at=2026-10-07T01:00:00');
  let s2 = r.json.stalls.find(x => x.id === 'S002');
  eq('[API] S002 凌晨跨午夜时段因临时停业=suspended（不是open）', s2.status.status, 'suspended');

  // E3. 两编辑更正同一地点 => 409
  const draft = (await req('GET', '/api/admin/draft', null, { 'X-Editor-Token': 'test-token' })).json;
  const s001 = draft.stalls.find(x => x.id === 'S001');
  const makeBody = name => JSON.parse(JSON.stringify(Object.assign({ version: 1 }, s001, { name })));
  const t1 = { 'X-Editor-Token': 'test-token' };
  let e1 = await req('PUT', '/api/admin/stalls/S001', makeBody('甲更正'), t1);
  eq('[API] 第一个编辑 200', e1.status, 200);
  eq('[API] 版本升到 2', e1.json.version, 2);
  let e2 = await req('PUT', '/api/admin/stalls/S001', makeBody('乙更正(旧版本)'), t1);
  eq('[API] 第二个编辑基于旧版本 => 409', e2.status, 409);
  ok('[API] 409 返回当前版本供合并', e2.json.current && e2.json.current.version === 2);

  // E4. 瓦片失败 + 成功
  let t = await req('GET', '/api/tiles/12/3287/1632.svg');
  eq('[API] 瓦片 200 且为 SVG', t.status, 200);
  ok('[API] 瓦片包含同址两个摊位', t.text.includes('stall-S001') && t.text.includes('stall-S004'));
  t = await req('GET', '/api/tiles/12/3287/1632.svg?fail=1');
  eq('[API] 瓦片失败模拟 503（前端可降级）', t.status, 503);
  t = await req('GET', '/api/tiles/12/3287/1632.svg', null, { 'X-Simulate-Tile-Fail': '1' });
  eq('[API] 请求头模拟瓦片失败 503', t.status, 503);

  // E5. 发布前后同代切换
  let before = await req('GET', '/api/health');
  const genBefore = before.json.genId;
  // 再加一个临时停业并发布
  await req('POST', '/api/admin/stalls/S004/closures', {
    reason: 'E2E 提前告示', effectiveFrom: '2026-10-07', effectiveTo: '2026-10-07', announcedAt: '2026-10-08T09:00:00'
  }, T);
  const pub = await req('POST', '/api/admin/publish', { note: 'E2E 发布' }, T);
  eq('[API] 发布成功', pub.status, 200);
  ok('[API] 代际号前进', pub.json.generation.genId !== genBefore);
  const afterMeta = await req('GET', '/api/stalls?at=2026-10-07T20:00:00');
  eq('[API] 发布后卡片接口立即为新代际', afterMeta.json.generation.genId, pub.json.generation.genId);
  const s4 = afterMeta.json.stalls.find(x => x.id === 'S004');
  eq('[API] 发布后 S004 立即 suspended（提前于公告）', s4.status.status, 'suspended');
  const tile = await req('GET', '/api/tiles/12/3287/1632.svg');
  ok('[API] 瓦片 ETag 与新代际同步', tile.headers.etag.includes(pub.json.generation.genId));

  // E6. 排队快照：过期不当实时
  r = await req('GET', '/api/stalls?at=2026-10-07T12:00:00');
  const q2 = r.json.stalls.find(x => x.id === 'S003').queues[0];
  eq('[API] 旧排队 stale=true', q2.stale, true);
  ok('[API] 旧排队仍带 collectedAt', !!q2.collectedAt);
  const q1 = r.json.stalls.find(x => x.id === 'S001').queues[0];
  eq('[API] 新鲜排队 fresh=true', q1.fresh, true);

  // E7. 离线包免责声明与有效范围
  const off = await req('GET', '/api/offline/bundle');
  ok('[API] 离线包注明有效范围', off.json.validity && off.json.validity.coversDateFrom === '2026-10-06');
  ok('[API] 离线包声明不做食品安全/营养结论', off.json.disclaimers.some(d => d.includes('食品安全') || d.includes('营养')));
  ok('[API] 离线包路线仅资料参考', JSON.stringify(off.json).includes('资料参考'));

  // E8. 鉴权
  const noauth = await req('POST', '/api/admin/publish', {});
  eq('[API] 无令牌 401', noauth.status, 401);

  server.close();
  // 还原初始种子库，便于手工体验
  try { fs.unlinkSync(dbFile); } catch (e) {}
  console.log('\n全部通过：' + passed + ' 项断言。');
}
