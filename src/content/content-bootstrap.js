/**
 * content/content-bootstrap.js —— Content Script 主控制器（经典脚本）。
 *
 * 注入顺序（由 Service Worker 按序注入，共享 isolated world 的 globalThis.__AIWT__）：
 *   messages.core.js → text-extractor.js → text-block-manager.js → dom-renderer.js → 本文件
 *
 * 职责：
 *  - 与 Service Worker 握手（CONTENT_PING / CONTENT_READY，只上报布尔型页面特征）；
 *  - 收到 BEGIN_SCAN 后：扫描正文 → 登记文本块 → 批量发送翻译请求（仅纯文本）；
 *  - 接收 TRANSLATE_RESULT，按 block.id 落回 DOM（绝不依赖返回顺序）；
 *  - MutationObserver：只观察网站自然产生的 DOM 变化（新增/文本变化），
 *    debounce 后增量扫描；绝不自动点击/滚动/翻页；
 *  - 停止 / 恢复原文 / 三种显示模式切换。
 *
 * 防 MutationObserver 自触发循环（三层保险）：
 *  1) renderer.isMutating 标记：AIWT 自身的全部 DOM 写入期间，观察回调直接忽略；
 *  2) AIWT 自有节点一律带 data-aiwt-owned="true"，提取器与观察回调都过滤；
 *  3) 译文 span 的内容变化（characterData）通过祖先 [data-aiwt-owned] 判定忽略。
 *
 * 隐私：只读 Text Node；不读 input.value/textarea.value/placeholder/Cookie/存储；
 * 发给后台的只有纯文本块，不含 URL/标题/HTML。
 */
(function (root) {
  'use strict';
  const NS = (root.__AIWT__ = root.__AIWT__ || {});
  if (window.__AIWT_CONTENT_LOADED__) return; // 重复注入：首个实例继续工作即可
  window.__AIWT_CONTENT_LOADED__ = true;

  const MSG = NS.MESSAGE_TYPES;
  const LIMITS = NS.LIMITS;

  const store = new NS.TextBlockManager();
  const renderer = new NS.DomRenderer();

  let mode = NS.DISPLAY_MODES.BILINGUAL;
  let active = false;        // 是否处于“允许扫描/翻译”状态（停止/恢复后为 false）
  let observer = null;
  let scanTimer = null;
  let blockCounter = 0;
  let processed = new WeakSet(); // 已登记的原文 Text Node（WeakSet 无法 clear，恢复时整体换新）
  let lastBatchWasEmpty = false; // 防止空批次在观察回调下无限重复
  let errorNotified = false;
  // 覆盖率补扫（BBC 漏扫修复）：
  let scanDiagnosticsEnabled = false;   // 仅开发开关（BEGIN_SCAN 下发），生产默认关闭
  const pendingSubtrees = new Set();    // 属性变化触发的定向补扫目标（debounce 合并）
  let stabilizationTimers = [];         // 初始扫描后的有限稳定化补扫（有界，无永久 loop）
  let viewportListenersAttached = false; // scroll/resize 监听（只响应“用户自己滚动”，绝不主动滚动）
  // Phase 4 长网页性能：分片扫描会话 + 独立计时器
  let scanSession = null;               // TextExtractor.beginScan 会话（可暂停/续跑）
  let scanSessionMode = null;           // 'full' | 'viewport'（诊断用）
  let chunkTimer = null;                // 扫描分片续跑计时器
  let subtreeTimer = null;              // 属性定向补扫计时器
  let priorityTimer = null;             // 滚动后 pending 优先级更新防抖

  /**
   * 当前 Document 实例的唯一 ID（页面会话身份，pageSessionId）。
   * 每次注入都生成新值：刷新/导航后新 Document 中的新实例会得到新 ID，
   * 后台据此识别旧 Document 的翻译状态已 stale 并立即失效。
   */
  const pageSessionId = (() => {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch {
      /* 回退到随机串 */
    }
    return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  })();

  function nextBlockId() {
    blockCounter += 1;
    return `aiwt-block-${String(blockCounter).padStart(6, '0')}`;
  }

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload }, () => {
        void chrome.runtime.lastError; // 无接收方时静默
      });
    } catch {
      /* 扩展刚更新等极端情况：静默失败，不影响页面 */
    }
  }

  function pageSnapshot() {
    return {
      pageSessionId, // 页面会话身份：SW 用它做 stale 状态失效握手
      readyState: document.readyState,
      isTopFrame: window === window.top,
      // 以下仅“是否存在”的布尔事实，不读取任何值/内容
      hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
      hasSensitiveForm: Boolean(document.querySelector('input[autocomplete^="cc-"]')),
    };
  }

  function notifyError(message) {
    if (errorNotified) return;
    errorNotified = true;
    send(MSG.CONTENT_ERROR, { message: String(message ?? '内容脚本内部错误') });
  }

  /** 视口优先级（Phase 4）：只读 Range 几何，绝不滚动/修改布局。 */
  function computePriorityForNode(node) {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      return NS.computeViewportPriority(
        { top: box.top, bottom: box.bottom },
        window.innerHeight,
        LIMITS.VIEWPORT_BUFFER_RATIO
      );
    } catch {
      return NS.BLOCK_PRIORITIES.LOW;
    }
  }

  /** 登记新文本块并组装请求数组（含 viewport 优先级；只含 id 与纯文本）。 */
  function registerBlocks(found) {
    const out = [];
    for (const { node, text } of found) {
      processed.add(node);
      const record = store.register({
        id: nextBlockId(),
        node,
        text,
        normalizedText: normalize(text),
        priority: computePriorityForNode(node),
      });
      out.push({ id: record.id, text: record.normalizedText, priority: record.priority });
    }
    return out;
  }

  function flushRequests(blocks, diagnostics = null) {
    // 诊断（仅开发开关开启时附带）：本地跳过原因统计，供确认漏扫根因；不含任何正文
    const diagPayload =
      scanDiagnosticsEnabled && diagnostics
        ? { found: diagnostics.found ?? 0, skips: diagnostics.skips ?? {} }
        : undefined;
    if (blocks.length === 0) {
      // 空批次：仅在“上次非空”时上报一次，让后台把状态收敛为“已完成（无可翻译文本）”
      if (lastBatchWasEmpty) return;
      lastBatchWasEmpty = true;
      send(MSG.TRANSLATE_REQUEST, { blocks: [], diagnostics: diagPayload });
      return;
    }
    lastBatchWasEmpty = false;
    for (let i = 0; i < blocks.length; i += LIMITS.MAX_BLOCKS_PER_BATCH) {
      send(MSG.TRANSLATE_REQUEST, {
        blocks: blocks.slice(i, i + LIMITS.MAX_BLOCKS_PER_BATCH),
        diagnostics: diagPayload,
      });
    }
  }

  /** 开发诊断收集器（生产默认关闭）：只统计跳过原因计数。 */
  function startDiagnostics() {
    if (!scanDiagnosticsEnabled) return null;
    const skips = {};
    return {
      found: 0,
      skips,
      recordSkip: (reason) => {
        skips[reason] = (skips[reason] ?? 0) + 1;
      },
    };
  }

  /** 剪除已失联的登记块（SPA 大范围替换内容时防引用泄漏与译文残留）。 */
  function pruneDetached() {
    for (const r of store.records()) {
      if (r.node.isConnected) continue;
      if (r.span && r.span.isConnected) r.span.remove();
      if (r.wrapper && r.wrapper.isConnected) r.wrapper.remove();
      store.remove(r.id);
    }
  }

  /** 分片扫描会话的视口范围（滚动补扫用：视口 ± 1.5 屏）。 */
  function viewportRangeForScan() {
    const vh = window.innerHeight || 800;
    const buffer = vh * LIMITS.VIEWPORT_BUFFER_RATIO;
    return { top: -buffer, bottom: vh + buffer };
  }

  /** 启动一个分片扫描会话。mode: 'full'（全页，初始扫描）| 'viewport'（视口±缓冲区，滚动补扫）。 */
  function startScanSession(mode) {
    scanSession?.abort();
    const extractor = new NS.TextExtractor();
    const rootNode = document.body ?? document.documentElement;
    scanSession = rootNode
      ? extractor.beginScan(rootNode, processed, {
          maxNodesPerPass: LIMITS.MAX_SCAN_NODES_PER_PASS,
          viewport: mode === 'viewport' ? viewportRangeForScan() : null,
        })
      : null;
    scanSessionMode = mode;
  }

  /** 扫描会话诊断快照（开发开关开启时随批次上报）。 */
  function scanSessionDiagnostics() {
    if (!scanDiagnosticsEnabled || !scanSession) return null;
    const d = scanSession.diagnostics();
    return { found: d.found, skips: { ...d.skips } };
  }

  /**
   * 分片扫描主循环：每个 pass 只访问 MAX_SCAN_NODES_PER_PASS 个节点，
   * 未走完即 yield 到下一事件循环继续（避免超长网页阻塞主线程）。
   */
  function runScanChunk() {
    if (!active) return;
    try {
      pruneDetached();
      if (!scanSession) startScanSession('full');
      const { found, done } = scanSession.next(LIMITS.MAX_SCAN_NODES_PER_PASS);
      const blocks = registerBlocks(found);
      if (blocks.length > 0) flushRequests(blocks, scanSessionDiagnostics());
      if (!done) {
        chunkTimer = setTimeout(runScanChunk, 0); // yield：下一事件循环继续
        return;
      }
      scanSession = null;
      // 收尾：旧块重排队（带最新优先级）；空则上报一次空批次收敛状态
      const retry = [];
      for (const r of store.pendingCandidates()) {
        retry.push({ id: r.id, text: r.normalizedText, priority: computePriorityForNode(r.node) });
      }
      flushRequests(retry, scanSessionDiagnostics());
    } catch (err) {
      notifyError(err && err.message);
      scanSession = null;
    }
  }

  function scheduleScan() {
    if (!active) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(runScanChunk, LIMITS.SCAN_DEBOUNCE_MS);
  }

  /** 属性变化定向补扫：只重扫受影响子树（debounce 合并），AIWT 节点完全忽略。 */
  function queueSubtreeRescan(el) {
    if (!active || !el || el.nodeType !== 1) return;
    pendingSubtrees.add(el);
    clearTimeout(subtreeTimer);
    subtreeTimer = setTimeout(processSubtreeRescans, LIMITS.SCAN_DEBOUNCE_MS);
  }

  function processSubtreeRescans() {
    if (!active || pendingSubtrees.size === 0) return;
    try {
      const extractor = new NS.TextExtractor();
      const diag = startDiagnostics();
      const diagOpt = diag ? { diagnostics: { recordSkip: diag.recordSkip } } : {};
      const fresh = [];
      for (const el of pendingSubtrees) {
        if (el.isConnected) fresh.push(...extractor.extract(el, processed, diagOpt));
      }
      pendingSubtrees.clear();
      if (diag) diag.found = fresh.length;
      const blocks = registerBlocks(fresh);
      if (blocks.length > 0) flushRequests(blocks, diag);
    } catch (err) {
      notifyError(err && err.message);
    }
  }

  /**
   * 用户自己滚动 / 窗口变化（插件绝不主动滚动）：
   * 1) 视口±缓冲区分片补扫发现新可见文字（子树剪枝，不整页遍历）；
   * 2) debounce 后更新尚未翻译块的优先级（只重排 pending，绝不 abort 在途、绝不重翻已完成）。
   */
  function onViewportChange() {
    if (!active) return;
    if (!scanSession) startScanSession('viewport');
    clearTimeout(scanTimer);
    scanTimer = setTimeout(runScanChunk, LIMITS.SCAN_DEBOUNCE_MS);
    clearTimeout(priorityTimer);
    priorityTimer = setTimeout(updatePendingPriorities, 300);
  }

  /** 把尚未翻译块的（重算后的）优先级发给 SW：SW 只更新 pending 排序。 */
  function updatePendingPriorities() {
    if (!active) return;
    const blocks = [];
    for (const r of store.records()) {
      if (!r.translation && r.node.isConnected && (r.text ?? '').length >= 2) {
        blocks.push({ id: r.id, text: r.normalizedText, priority: computePriorityForNode(r.node) });
      }
    }
    if (blocks.length > 0) {
      send(MSG.TRANSLATE_REQUEST, { blocks });
    }
  }

  function startViewportListeners() {
    if (viewportListenersAttached) return;
    viewportListenersAttached = true;
    window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
  }

  function stopViewportListeners() {
    if (!viewportListenersAttached) return;
    viewportListenersAttached = false;
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
  }

  /** 初始扫描后的有限稳定化补扫：捕获 React/hydration 稍晚可见的文字（有界，非永久 loop）。 */
  function scheduleStabilizationRescans() {
    clearStabilizationRescans();
    stabilizationTimers = [
      setTimeout(() => {
        if (active && !scanSession) {
          startScanSession('viewport');
          runScanChunk();
        }
      }, 400),
      setTimeout(() => {
        if (active && !scanSession) {
          startScanSession('viewport');
          runScanChunk();
        }
      }, 1400),
    ];
  }

  function clearStabilizationRescans() {
    for (const t of stabilizationTimers) clearTimeout(t);
    stabilizationTimers = [];
  }

  function onMutation(mutations) {
    if (renderer.isMutating) return; // AIWT 自己的写入：直接忽略（防循环第一道保险）
    let interesting = false;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const record = store.findByNode(m.target);
        if (record) {
          // 网站修改了已翻译的原文 → 旧译文失效，更新块内容并（debounce 后）重译。
          // 注意：显示模式切换不产生任何 characterData（原文节点内容永不被 AIWT 修改），
          // 因此这里绝不会把模式切换误判为“网站修改原文”。
          const newText = (m.target.nodeValue ?? '').trim();
          if (record.translation && newText !== record.text) {
            renderer.removeTranslation(record); // 只移除旧译文 span；wrapper 与块状态保留
            record.translation = null;
            record.text = newText;
            record.normalizedText = normalize(newText);
            record.status = NS.BLOCK_STATUS.PENDING;
            scheduleScan();
          }
          continue;
        }
        const parent = m.target.parentElement;
        if (parent && parent.closest && parent.closest('[data-aiwt-owned="true"]')) {
          continue; // 译文 span 内部的文本变化：属于 AIWT 自己的节点
        }
        interesting = true; // 未登记文本节点发生变化 → 交给扫描判断
      } else if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            const owned = n.hasAttribute ? n.hasAttribute('data-aiwt-owned') : false;
            if (owned || (n.closest && n.closest('[data-aiwt-owned="true"]'))) continue;
          }
          interesting = true;
        }
        // 区分“移除”与“文档内移动”：AIWT 渲染会把原文节点移进 wrapper，
        // 这种移动表现为 removedNodes 但节点仍 isConnected，不应触发扫描；
        // 真正被销毁的子树其节点 isConnected 为 false，才需要剪枝。
        for (const n of m.removedNodes) {
          if (!n.isConnected) {
            interesting = true;
            break;
          }
        }
      } else if (m.type === 'attributes') {
        // 已有 Text Node 因 class/style/hidden/aria-hidden 改变而从隐藏变为可见（或反之）：
        // 定向重扫受影响子树（debounce 合并）；AIWT 自有节点完全忽略。
        const t = m.target;
        if (t && t.nodeType === 1 && !(t.closest && t.closest('[data-aiwt-owned="true"]'))) {
          queueSubtreeRescan(t);
        }
      }
    }
    if (interesting) scheduleScan();
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      // 可见性相关的属性变化（class/style/hidden/aria-hidden）→ 定向补扫受影响子树
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function applyMode(nextMode) {
    mode = nextMode;
    renderer.applyMode(nextMode); // 纯 CSS 可见性切换：不触碰任何节点与 block 状态
  }

  /** 停止：不接收新任务、断开观察器与补扫监听、未完成块标记为 cancelled（已完成结果保留）。 */
  function stopAll() {
    active = false;
    stopObserver();
    stopViewportListeners();
    clearStabilizationRescans();
    clearTimeout(scanTimer);
    clearTimeout(chunkTimer);
    clearTimeout(subtreeTimer);
    clearTimeout(priorityTimer);
    scanSession?.abort();
    scanSession = null;
    pendingSubtrees.clear();
    for (const r of store.records()) {
      if (!r.translation) r.status = NS.BLOCK_STATUS.CANCELLED;
    }
  }

  /** 恢复原文：删除全部 AIWT 节点、还原原文、清除本页块状态与运行状态。 */
  function restoreAll() {
    active = false;
    stopObserver();
    stopViewportListeners();
    clearStabilizationRescans();
    clearTimeout(scanTimer);
    clearTimeout(chunkTimer);
    clearTimeout(subtreeTimer);
    clearTimeout(priorityTimer);
    scanSession?.abort();
    scanSession = null;
    pendingSubtrees.clear();
    renderer.restoreAll(store.records());
    store.clear();
    processed = new WeakSet();
    blockCounter = 0;
    mode = NS.DISPLAY_MODES.BILINGUAL;
    errorNotified = false;
  }

  function onMessage(message, _sender, sendResponse) {
    if (!message || !NS.isKnownMessage(message)) return false;
    const payload = message.payload ?? {};
    switch (message.type) {
      case MSG.CONTENT_PING:
        sendResponse({ ok: true, payload: pageSnapshot() });
        return false;
      case MSG.BEGIN_SCAN: {
        active = true;
        errorNotified = false;
        scanDiagnosticsEnabled = payload.diagnostics === true; // 仅开发开关，生产默认关闭
        applyMode(payload.mode ?? mode);
        startObserver();
        startViewportListeners();
        startScanSession('full'); // 分片全页扫描（节点预算 + yield，不阻塞主线程）
        runScanChunk();
        scheduleStabilizationRescans(); // 有限稳定化补扫（捕获稍晚可见的文字，有界非 loop）
        sendResponse({ ok: true });
        return false;
      }
      case MSG.APPLY_MODE:
        applyMode(payload.mode ?? NS.DISPLAY_MODES.BILINGUAL);
        sendResponse({ ok: true });
        return false;
      case MSG.CONTENT_STOP:
        stopAll();
        sendResponse({ ok: true });
        return false;
      case MSG.CONTENT_RESTORE:
        restoreAll();
        sendResponse({ ok: true });
        return false;
      case MSG.TRANSLATE_RESULT: {
        const record = store.get(payload.id);
        if (record && payload.ok && typeof payload.translation === 'string') {
          record.translation = payload.translation;
          record.status = NS.BLOCK_STATUS.COMPLETED;
          renderer.ensureSpan(record);
        } else if (record && !payload.ok) {
          record.status = NS.BLOCK_STATUS.FAILED; // 失败块在重新开始时自动重试
        }
        sendResponse({ ok: true });
        return false;
      }
      default:
        return false;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);

  // 主动上报就绪 + 页面安全特征（仅布尔值），由 Service Worker 决定是否进入确认闸门
  send(MSG.CONTENT_READY, pageSnapshot());
})(globalThis);
