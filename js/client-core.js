// 访客端核心逻辑：与浏览器、Node 测试双兼容（UMD 风格）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ClientCore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  // 客户端状态：当前已接受的数据代 + 共享筛选条件
  function createState() {
    return {
      gen: null,
      filters: { month: null, ingredient_id: '', region: '', open_now: false },
    };
  }

  // 旧筛选请求晚到：只接受与当前代一致、且未被服务端标记 stale 的响应。
  // 返回 false 时调用方应丢弃该响应（其筛选语境已过期）。
  function shouldAccept(state, resp) {
    if (!resp || typeof resp.gen !== 'number') return false;
    if (resp.stale) return false;
    if (state.gen == null) return true;
    return resp.gen === state.gen;
  }

  function adoptGen(state, gen) {
    state.gen = gen;
  }

  // 瓦片失败降级策略：瓦片不可用 -> 直接查询摊位接口
  function markerPlan(tileOk) {
    return tileOk ? 'tiles' : 'stalls-fallback';
  }

  return { createState, shouldAccept, adoptGen, markerPlan };
}));
