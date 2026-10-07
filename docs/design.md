# 设计说明：时令美食数据编辑与查询服务

## 1. 要解决的核心问题

旧版“时令美食地图”是静态展示页。新系统定位为**数据编辑与查询服务**：

- 后台维护三类基础事实：**食材季节窗口、摊位（身份+位置）、营业段**，外加临时停业与排队采集快照；
- 公开 API 把**来源日期（collectedAt/announcedAt）与生效范围（effectiveFrom/effectiveTo、月日窗口）**写入存储并原样返回；
- 访客端地图与列表**共享同一筛选与同一结果集**；
- 明确区分两个不能互相推导的判断：
  - **季节性供应（inSeason）**：由食材显式时令窗口 × 地区 × 日期求交；
  - **当天此刻是否营业（isOpen/suspended）**：由营业段（可跨午夜）与临时停业记录按“当前时刻”求值。

> 规则：**不存在“一个月份字段 → 任何时候都可买”的推断路径**。没有窗口就不在季；窗口只在其他地区生效时，本地区也不在季。

## 2. 数据模型（草稿实体）

| 实体 | 关键字段 | 要点 |
|---|---|---|
| ingredient | `windows[]` | 每个窗口 `{region, startMonth, startDay, endMonth, endDay, crossYear}`；`region='*'` 为全域默认；`end<start` 自动识别跨年 |
| stall | `id, name, lon, lat, region, version, segments[], offers[], closures[]` | `id` 是摊位身份；坐标相同也不是同一商户；`version` 做乐观锁 |
| segment | `{start:'HH:MM', end:'HH:MM', days:[1..7]}` | `end<=start` 表示跨午夜；全天必须显式 `00:00–24:00`；零长段拒绝 |
| closure | `{reason, effectiveFrom, effectiveTo, startTime?, endTime?, announcedAt, revoked}` | 生效范围优先；**即使 at < announcedAt（正式公告未到）也照范围停业** |
| offer | `{ingredientId, startDate?, endDate?}` | 摊位供应关系；与食材时令窗口再求交 |
| queue | `{stallId, waitMinutes, collectedAt, ttlMinutes, source}` | 采集事实，不是实时事实；超过 `collectedAt+ttl` 即标 `stale` |
| route | `{title, points[], note}` | 仅资料参考 |

时令窗口用“闰年基准的月日序”比较，因此跨年窗口（如 11-20 ~ 次年 02-28）天然成立，且与具体年份无关地循环。

## 3. 预计算时空索引 vs 查询时求交 —— 方案选择

时间维度（时令窗口、跨午夜营业段、临时停业）与空间维度性质不同，**本系统采用“空间预计算 + 时间查询时求交”的混合方案**，而不是全量预计算时空立方。

### 3.1 备选 A：预计算时空索引（如逐日 × 逐摊位 × 逐小时位图）

- 优点：查询 O(1) 读位图，适合超高 QPS、固定日历粒度。
- 缺点（在本业务下代价过高）：
  1. **更新及时性差**：临时停业“早于正式公告”随时录入，若走预计算，要使位图立即一致必须同步重算受影响日期/瓦片链路，写入放大明显；
  2. **跨年与地区差异使维度爆炸**：每个 (地区, 食材, 年, 日) 都要物化，年底还要预生成下一年；
  3. **时间粒度冲突**：营业以分钟表达且可跨午夜，按小时物例会丢失精度或再放大 24 倍；
  4. 存储与发布成本：代际快照里携带大量稀疏位图，离线包变大。

### 3.2 备选 B：全部查询时求交

- 优点：写入零放大、发布即可见、语义集中在一份纯函数（`public/js/core.js`，前后端共用）。
- 缺点：数据量增大后，每次对全量摊位做窗口求交与 bbox 扫描，CPU 与延迟上升。

### 3.3 采用方案 C：空间静态网格（随代际预计算） + 时间在查询时求交

发布时在不可变代际内构建：

- `spatialIndex`：经纬度静态网格桶（0.02°，约 2km）+ 全量 bbox，用于 bbox/瓦片裁剪；位置不变则零成本；
- 关系反查：`offersByIngredient`、`queuesByStall` 等，缩小求交候选集。

查询时只对候选摊位执行纯函数求交：`isIngredientInSeason`（月日序，O(窗口数)）与 `evaluateStatus`（营业段+停业，O(段数+停业数)）。

**更新及时性**：编辑只改草稿；**发布动作冻结一个不可变代际**，重建网格与反查表（数据规模小，毫秒级），随后 API、统计、瓦片 ETag 一次性指向新 `genId`——不需要任何异步刷新窗口，因此“临时停业早于公告”“月底切换”发布后立即可见。

**成本**：

- 写入：草稿就地更新 + 一次原子发布（整代重建），写放大 ≈ 1 倍快照，无逐日物化；
- 读取：空间用索引裁剪，时间为小常数求交（每摊几个段/窗口）；单进程即可支撑演示与中小城市量级；
- 规模上去后的演进路径：把“静态网格”替换为 R-tree/H3（只改 `buildGeneration`），或对可预知年份做**只读缓存层**（缓存键含 `genId+date+region+filters`），写路径仍保持立即一致，缓存由代际失效——而不是让预计算阻塞更新。

## 4. 代际（generation）与同代切换

- `db.published`：当前**不可变**快照（实体 + 空间索引 + 反查表 + `genId/publishedAt/note`）；
- `db.draft`：可编辑实体；所有后台 CRUD 只动草稿，访客不可见；
- `POST /api/admin/publish`：整代重建 → 原子替换 `published` → 草稿重置为基于新代际。
- 访客每次响应都带 `generation`；瓦片 `ETag` 含 `genId`；前端每 15s 轮询 `/api/meta`，发现新代际即重查。
  因此**索引、卡片、地图同代切换**，不会出现“卡片是新数据、瓦片是旧点位”的撕裂。
- 持久化使用 `tmp + rename` 原子写，避免半写文件。

## 5. 关键语义如何落地（前后端共用一份代码）

`public/js/core.js` 同时被 Node 与浏览器加载：

- 跨年：月日序比较，`cur>=start || cur<=end`（跨年侧）；
- 地区差异：先找“该地区精确窗口”，没有精确窗口时不会被其他地区窗口冒充；全域窗口 `*` 仅在无任何地区窗口命中时兜底；
- 跨午夜：`end<=start` 时，当前时刻既可能属于“当天开始的段”，也可能是“前夜段延续”；后者用**昨天星期**再校验 `days`；
- 临时停业优先于营业段；撤销（revoked）后恢复；
- 排队：`fresh = now <= collectedAt + ttlMinutes`；过期只展示采集时间并明确标注“非实时事实”。

## 6. API 摘要

公开（读已发布代际）：

- `GET /api/meta` 代际/地区/食材/路线/免责声明
- `GET /api/stalls?at&region&ingredient&inSeason=1&open=1&q&bbox` 列表+状态+在季+排队
- `GET /api/stats`（同参数）聚合，**按 stall.id 去重**，输出 `coLocated`
- `GET /api/tiles/{z}/{x}/{y}.svg` 确定性瓦片；`?fail=1` 或头 `X-Simulate-Tile-Fail:1` 模拟失败
- `GET /api/offline/manifest`、`/api/offline/bundle` 离线包（含有效范围与免责声明）

管理（头 `X-Editor-Token`，默认 `dev-token`）：

- 草稿 CRUD：`/api/admin/ingredients[/id]`、`/api/admin/stalls[/id]`、`/api/admin/queues`
- 停业：`POST /api/admin/stalls/{id}/closures`、`POST /api/admin/closures/{id}/revoke`
- `POST /api/admin/publish`、`GET /api/admin/draft`、`GET /api/admin/edits`
- 摊位更新强制带 `version`，与服务端不一致返回 **409 + 当前实体**（两编辑更正同一地点）。

## 7. 前端的两个竞态/失败处理

- **旧筛选请求晚到**：每次应用筛选递增 `querySeq`，响应回来时序号过期即丢弃，不允许旧结果覆盖新结果（复选框可人为注入 1.5s 延迟演示）；
- **瓦片失败**：`<image onerror>` 切到“纯标记降级视图”，卡片/列表不受影响，可手动重试；
- 响应代际落后时，按新代际自动重查。

## 8. 安全边界（不做的事）

- 路线仅资料参考；
- **不自动给出任何食品安全或营养结论**（页脚、离线包、meta 三处声明）；
- 排队过期信息不当实时事实。

## 9. 验收点对照

| 验收项 | 落点 |
|---|---|
| 月底切换 | 窗口含端点；`2026-10-31` 与 `2026-11-01` 测试 |
| 临时停业早于正式公告 | 闭店范围生效不依赖 announcedAt；API/UI 展示两者 |
| 两编辑更正同一地点 | stall.version 乐观锁，后写 409 并回送当前版本；编辑日志标冲突 |
| 瓦片失败 | 503 模拟 + onerror 降级纯标记 |
| 旧筛选请求晚到 | querySeq 丢弃过期响应（测试见浏览器控制台） |
| 同坐标多摊 | 统计按 id 去重、coLocated 列出、瓦片/地图错位画多点 |
| 跨年营业/时令 | 跨午夜段（含 days 锚点）、crossYear 窗口测试 |
| 发布同代切换 | genId 贯穿 API 响应与瓦片 ETag |
| 离线包有效范围 | manifest/bundle 输出日期范围与策略声明 |
