/**
 * 种子数据：演示全部边界语义。
 * 注意：时令一律是显式 [startMonth-Day, endMonth-Day] 窗口（可跨年、可按地区），
 * 不存在单一“月份”字段，也不允许由它推断“任何时候都可买”。
 */

const REGIONS = [
  { id: 'xian-urban', name: '西安主城区' },
  { id: 'xian-suburb', name: '西安周边区县' }
];

// 地区多边形（粗略，用于“当前位置→地区”的解析与演示）
const REGION_GEOM = {
  'xian-urban': [[108.75, 34.40], [109.10, 34.40], [109.10, 34.20], [108.75, 34.20]],
  'xian-suburb': [[108.30, 34.70], [109.40, 34.70], [109.40, 33.95], [108.30, 33.95]]
};

const INGREDIENTS = [
  {
    id: 'ing-liangpi', name: '凉皮', category: '小吃',
    windows: [
      // 地区差异：主城区传统上 4 月底到 10 月初
      { region: 'xian-urban', startMonth: 4, startDay: 25, endMonth: 10, endDay: 5 },
      // 周边区县窗口更长：4 月 1 日到 10 月 31 日
      { region: 'xian-suburb', startMonth: 4, startDay: 1, endMonth: 10, endDay: 31 }
    ]
  },
  {
    id: 'ing-shiliu', name: '临潼石榴', category: '果品',
    windows: [
      { region: 'xian-suburb', startMonth: 9, startDay: 10, endMonth: 11, endDay: 20 }
      // 主城区不产，仅周边有窗口 => 主城区永远不在季（不臆测）
    ]
  },
  {
    id: 'ing-laniurou', name: '腊牛肉', category: '腊味',
    windows: [
      // 跨年窗口：11 月下旬到次年 2 月底
      { region: '*', startMonth: 11, startDay: 20, endMonth: 2, endDay: 28, crossYear: true }
    ]
  },
  {
    id: 'ing-xiangzi', name: '糖炒栗子', category: '小吃',
    windows: [
      { region: '*', startMonth: 9, startDay: 1, endMonth: 3, endDay: 15, crossYear: true }
    ]
  }
];

// 同坐标故意放两个不同摊位身份（S001/S004），验证“聚合按摊位去重、不合并成同一商户”
const STALLS = [
  {
    id: 'S001', name: '老白家凉皮铺', owner: '白玉堂', region: 'xian-urban',
    address: '永兴坊 A12', lon: 108.9550, lat: 34.2650,
    segments: [
      { id: 'seg-1', start: '10:30', end: '21:00', days: [1, 2, 3, 4, 5] },
      { id: 'seg-2', start: '09:00', end: '22:00', days: [6, 7] }
    ],
    offers: [
      { ingredientId: 'ing-liangpi' },
      { ingredientId: 'ing-laniurou' }
    ],
    closures: []
  },
  {
    id: 'S002', name: '李记夜市腊牛肉', owner: '李建军', region: 'xian-urban',
    address: '洒金桥夜市北口', lon: 108.9420, lat: 34.2680,
    segments: [
      // 跨午夜营业
      { id: 'seg-3', start: '18:00', end: '02:30', days: [1, 2, 3, 4, 5, 6, 7] }
    ],
    offers: [{ ingredientId: 'ing-laniurou' }],
    closures: [
      {
        id: 'cl-1', reason: '家中急事临时停业', announcedAt: '2026-10-07T06:00',
        effectiveFrom: '2026-10-06', effectiveTo: '2026-10-08',
        startTime: '00:00', endTime: '23:59', revoked: false
      }
    ]
  },
  {
    id: 'S003', name: '临潼小杨石榴摊', owner: '杨广成', region: 'xian-suburb',
    address: '临潼区环城北路', lon: 109.2100, lat: 34.3700,
    segments: [
      { id: 'seg-4', start: '07:00', end: '12:00', days: [1, 2, 3, 4, 5, 6] },
      { id: 'seg-5', start: '15:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] }
    ],
    offers: [{ ingredientId: 'ing-shiliu' }],
    closures: []
  },
  {
    id: 'S004', name: '永兴坊炒货王（独立摊位）', owner: '王德福', region: 'xian-urban',
    address: '永兴坊 A12（与凉皮铺同址不同摊）', lon: 108.9550, lat: 34.2650,
    segments: [
      { id: 'seg-6', start: '16:00', end: '23:30', days: [1, 2, 3, 4, 5, 6, 7] }
    ],
    offers: [{ ingredientId: 'ing-xiangzi' }],
    closures: []
  }
];

// 排队快照：均为“采集”事实，带 collectedAt；TTL 过后只显示采集时间，绝不当实时事实
const QUEUES = [
  { id: 'q-1', stallId: 'S001', waitMinutes: 12, collectedAt: '2026-10-07T11:20:00', ttlMinutes: 60, source: '编辑现场采集' },
  { id: 'q-2', stallId: 'S003', waitMinutes: 5, collectedAt: '2026-09-30T08:00:00', ttlMinutes: 60, source: '编辑现场采集' }
];

// 路线仅为资料参考
const ROUTES = [
  {
    id: 'r-1', title: '永兴坊步行参考线',
    points: [[108.9500, 34.2660], [108.9525, 34.2655], [108.9550, 34.2650]],
    note: '资料性路线参考，实际路况与管制请以现场为准。'
  }
];

module.exports = { REGIONS, REGION_GEOM, INGREDIENTS, STALLS, QUEUES, ROUTES };
