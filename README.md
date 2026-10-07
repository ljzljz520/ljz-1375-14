# 西安文化介绍网站 + 时令美食地图服务

本站由两部分组成：

1. **静态文化展示页**（`index.html` / `activities.html` / `travel.html`）：西安历史、民俗与旅游美食介绍。
2. **时令美食地图 · 数据编辑与查询服务**（新增）：编辑后台维护食材季节、摊位位置与营业段；
   访客端地图与列表共享同一组筛选条件查询数据。

## 快速开始

```bash
npm start          # 启动服务（首次自动写入种子数据到 data/db.json），默认端口 8080
npm test           # 运行单元测试与验收测试（node:test，零依赖）
npm run seed       # 强制重置种子数据
```

- 访客地图：<http://localhost:8080/map.html>
- 编辑后台：<http://localhost:8080/admin.html>
- 架构与索引方案决策（预计算时空索引 vs 查询时求交）：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 核心规则

- **时令区间**按地区分别维护，允许跨年（起点晚于终点，如 11-01 至 02-28）；
- **营业段**允许跨午夜（结束早于开始，如 20:00–02:00，段归属开始当日）；
- **季节性供应 ≠ 当天实际营业**：可购买 = 应季 ∧ 营业 ∧ 未临时停业，不能由单一月份字段推断；
- 每次写入都记录**来源日期**与**生效范围**；临时停业按生效范围生效，正式公告时间仅作来源信息；
- 编辑走草稿，**发布**时索引、卡片、地图同代切换（gen+1）；旧筛选请求晚到会被标记 `stale` 并由客户端丢弃；
- 地图聚合按**摊位身份**去重，同坐标多摊不合并为同一商户；
- 过期排队信息只展示**采集时间**，不当作实时事实；离线包注明**有效范围**；路线只作资料参考。

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meta` | 当前数据代、食材与区域列表 |
| GET | `/api/stalls?bbox&month&ingredient_id&region&open_now&at&gen` | 地图与列表共享的筛选查询 |
| GET | `/api/stalls/:id?at` | 摊位卡片（供应/营业/停业/排队） |
| GET | `/api/tiles/:z/:x/:y?...` | 聚合瓦片（按摊位身份去重；`X-Debug-Fail: 1` 可模拟失败） |
| GET | `/api/offline-pack?region&month` | 离线包（注明有效范围与数据代） |
| GET | `/api/route?ids=a,b,c` | 路线参考（不含食品安全/营养结论） |
| PUT | `/api/admin/stalls/:id/location` | 更正摊位位置（乐观锁 `base_version`） |
| PUT | `/api/admin/hours/:id` | 维护营业段 |
| POST/PUT | `/api/admin/seasons[/:id]` | 维护食材季节（地区 + 跨年区间） |
| POST | `/api/admin/closures` | 登记临时停业（来源日期 + 生效范围 + 公告时间） |
| POST | `/api/admin/queue` | 排队上报（带采集时间） |
| POST | `/api/admin/publish` | 发布：索引/卡片/地图同代切换 |

## 验收场景对应测试（`test/acceptance.test.js`）

月底切换、临时停业早于正式公告、两编辑更正同一地点（乐观锁冲突）、瓦片失败降级、
旧筛选请求晚到（stale 丢弃）、发布同代切换、同坐标多摊去重、过期排队信息、离线包与路线约束。

## 技术栈

- 后端：Node.js 原生 `http`（零依赖），JSON 文件存储（草稿/线上分离，原子写）
- 前端：原生 HTML/CSS/JS + SVG 地图
- 测试：`node:test` + `fetch`
