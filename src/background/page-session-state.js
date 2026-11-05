/**
 * background/page-session-state.js
 * 页面翻译状态（Page Translation State）的纯状态管理逻辑。
 *
 * 三种生命周期（必须严格区分）：
 *  - Tab 生命周期：tabId 只是记录键；标签页关闭 → onRemoved 删除整条记录；
 *  - Document / Page Session 生命周期：每个真实 Document 实例由 Content Script
 *    在启动时生成唯一 pageSessionId；刷新/导航 → 新 Document → 新 id，
 *    旧 id 对应的全部页面翻译状态立即失效（stale 清理）；
 *    每个 API batch 在发起时绑定 pageSessionId，结果回来时用 isCurrentPageSession
 *    再次校验——旧 Document 的 DeepSeek 结果绝不允许插进新 Document；
 *  - SessionCache 生命周期：全局会话级「源文本→译文」缓存，独立于 Document，
 *    reload 后仍然保留，重新翻译可命中（预期行为，绝不在页面失效时清除）。
 *
 * 本模块无任何 chrome.* 依赖，可在 Node 中直接做自动化测试。
 */

export function emptyStats() {
  return { total: 0, completed: 0, failed: 0, cancelled: 0 };
}

/** 创建一个全新的页面翻译状态（由 Service Worker 按 tabId 挂载）。 */
export function createPageState() {
  return {
    pageSessionId: null, // 当前已确认的 Document 实例 ID（null = 尚无活跃页面会话）
    status: 'idle', // idle | checking | awaiting_confirmation | scanning | translating | stopped | completed | partial | restored | unsupported | api_key_missing | api_error | error
    note: null,
    risk: null,
    riskReasons: [],
    confirmed: false,
    active: false,
    tab: null,
    page: null,
    scheduler: null,
    stats: emptyStats(),
    inflight: new Map(), // cacheKey -> Promise：并发重复文本共享同一次 Provider 调用
    // Phase 3 批量翻译状态（全部为页内状态，随 Document 失效）
    blocks: new Map(),   // blockId -> { status: queued|running|completed|failed|cancelled, text, retries }
    batchQueue: [],      // 待发送 block ids（FIFO）
    batchCounter: 0,
    draining: false,
    usage: null,         // { prompt_tokens, completion_tokens, total_tokens }（仅真实 API usage）
    lastError: null,     // 结构化错误（不含 API Key）
    lastScanDiagnostics: null, // 扫描诊断摘要 { found, skips }（仅开发开关；不含正文/Key）
    cacheHits: 0,        // Phase 4：本页缓存命中块数（只计成功路径）
    apiTranslatedBlocks: 0, // Phase 4：本页真实 API 翻译块数（只计成功路径）
    readyTimer: null,
    lastBroadcastAt: 0,
  };
}

/**
 * 使旧 Document 的全部页面翻译状态失效：
 * 状态 / 进度 / 恢复可用性 / 调度与批量队列 / 在途合并 / Token 统计 / 风险确认全部归零。
 * 注意：SessionCache 不在此管理、也不会被清除。
 */
export function resetPageState(state) {
  if (!state) return;
  clearTimeout(state.readyTimer);
  state.readyTimer = null;
  if (state.scheduler && typeof state.scheduler.stop === 'function') {
    state.scheduler.stop(); // 旧页面任务停止 + abort 在途 batch，防止向已销毁 Document 投递结果
  }
  state.scheduler = null;
  state.stats = emptyStats();
  state.inflight = new Map();
  state.blocks = new Map();
  state.batchQueue = [];
  state.batchCounter = 0;
  state.draining = false;
  state.usage = null;
  state.lastError = null;
  state.lastScanDiagnostics = null;
  state.cacheHits = 0;
  state.apiTranslatedBlocks = 0;
  state.status = 'idle';
  state.note = null;
  state.risk = null;
  state.riskReasons = [];
  state.confirmed = false;
  state.active = false;
  state.page = null;
}

/**
 * 会话握手核心：采纳 Content Script 上报的 pageSessionId。
 *  - reportedId 与已记录 id 相同 → 同一 Document，状态保持有效；
 *  - 不同 / 缺失 / null → 旧 Document 已销毁或不可信，先清旧状态再采纳新 id。
 * 返回是否发生了重置（供测试与判断）。
 */
export function adoptPageSession(state, reportedId) {
  const normalized = typeof reportedId === 'string' && reportedId.length > 0 ? reportedId : null;
  if (state.pageSessionId !== null && state.pageSessionId === normalized) {
    return false; // 同一 Document：状态有效，无需任何处理
  }
  resetPageState(state);
  state.pageSessionId = normalized;
  return true;
}

/**
 * API batch 结果投递前的生命周期闸门：
 * batch 发起时绑定的 pageSessionId 必须等于当前 Document 的 pageSessionId，
 * 否则结果属于旧页面（reload/导航后），必须丢弃。
 */
export function isCurrentPageSession(state, batchPageSessionId) {
  return Boolean(
    state &&
      typeof batchPageSessionId === 'string' &&
      batchPageSessionId.length > 0 &&
      state.pageSessionId === batchPageSessionId
  );
}

/** 不可恢复的瞬态状态：SW 冷启动恢复时跳过（旧任务已随 SW 终止，保持全新 idle）。 */
const TRANSIENT_STATUSES = new Set(['checking', 'scanning', 'translating', 'awaiting_confirmation']);

/**
 * 把 Page Translation State 摘要序列化为可持久化对象（写入 chrome.storage.session）。
 * 只含状态 / 计数 / Token 用量等摘要；不包含 blocks / batchQueue / scheduler 等瞬态字段，
 * 也绝不包含页面文字与 API Key。
 */
export function pageStateToStorable(state) {
  return {
    pageSessionId: state.pageSessionId,
    status: state.status,
    note: state.note,
    stats: state.stats,
    usage: state.usage,
    lastError: state.lastError,
    risk: state.risk,
    riskReasons: state.riskReasons,
    confirmed: state.confirmed,
    cacheHits: state.cacheHits ?? 0,
    apiTranslatedBlocks: state.apiTranslatedBlocks ?? 0,
  };
}

/**
 * 从持久化摘要恢复 Page Translation State（仅在 SW 冷启动、内存无状态时调用）。
 * 语义：
 *  - 内存已有 pageSessionId → 不覆盖（当前进程已有活跃会话）；
 *  - 持久化条目无 pageSessionId → 忽略；
 *  - 持久化状态是瞬态（翻译进行中）→ 忽略（保持全新 idle）；
 *  - 否则恢复摘要；随后的握手（adoptPageSession）会用当前 Content Script 的真实
 *    pageSessionId 二次校验：同 id → 状态保留；不同 id（真正 reload）→ stale reset。
 * 返回是否发生了恢复。
 */
export function hydratePageStateFromStored(state, stored) {
  if (!state || !stored || !stored.pageSessionId) return false;
  if (state.pageSessionId !== null) return false; // 当前进程已有活跃会话，不覆盖
  if (TRANSIENT_STATUSES.has(stored.status)) return false; // 瞬态不恢复
  state.pageSessionId = stored.pageSessionId;
  state.status = typeof stored.status === 'string' ? stored.status : 'idle';
  state.note = stored.note ?? null;
  state.stats = stored.stats ?? emptyStats();
  state.usage = stored.usage ?? null;
  state.lastError = stored.lastError ?? null;
  state.risk = stored.risk ?? null;
  state.riskReasons = Array.isArray(stored.riskReasons) ? stored.riskReasons : [];
  state.confirmed = Boolean(stored.confirmed);
  state.cacheHits = stored.cacheHits ?? 0;
  state.apiTranslatedBlocks = stored.apiTranslatedBlocks ?? 0;
  return true;
}
