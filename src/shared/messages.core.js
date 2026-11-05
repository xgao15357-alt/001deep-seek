/**
 * shared/messages.core.js
 * 消息协议的唯一事实来源（不含 import/export 的“双模式”文件）：
 *  - 作为经典脚本按序注入 Content Script，挂在 globalThis.__AIWT__ 命名空间上；
 *  - 被 src/shared/messages.js 以 ES Module 方式 import（同一份常量）。
 * 这样彻底消除 Phase 1 中“Service Worker 与 Content Script 手工同步字符串”的问题。
 * 安全约束：消息只在本扩展内部传递；payload 只允许可序列化的纯数据对象；
 * 任何敏感信息（API Key、原文之外的页面数据等）都禁止出现在消息中。
 */
(function (root) {
  'use strict';
  const NS = (root.__AIWT__ = root.__AIWT__ || {});
  if (NS.MESSAGE_TYPES) return; // 幂等：可能因重复注入被执行多次

  NS.MESSAGE_TYPES = Object.freeze({
    // Popup -> Service Worker
    GET_STATE: 'awt.getState',
    START_TRANSLATION: 'awt.startTranslation',
    STOP_TRANSLATION: 'awt.stopTranslation',
    RESTORE_ORIGINAL: 'awt.restoreOriginal',
    SET_DISPLAY_MODE: 'awt.setDisplayMode',
    CONFIRM_HIGH_RISK: 'awt.confirmHighRisk',
    CANCEL_HIGH_RISK: 'awt.cancelHighRisk',
    // Service Worker <-> Content Script
    CONTENT_PING: 'awt.contentPing',
    CONTENT_READY: 'awt.contentReady',
    BEGIN_SCAN: 'awt.beginScan',
    APPLY_MODE: 'awt.applyMode',
    CONTENT_STOP: 'awt.contentStop',
    CONTENT_RESTORE: 'awt.contentRestore',
    TRANSLATE_REQUEST: 'awt.translateRequest',
    TRANSLATE_RESULT: 'awt.translateResult',
    CONTENT_ERROR: 'awt.contentError',
    // Service Worker -> Popup（状态广播；Popup 未打开时静默失败）
    STATE_UPDATED: 'awt.stateUpdated',
  });

  // 协议级上限（防呆，避免异常页面拖垮扩展，不涉及敏感数据）
  NS.LIMITS = Object.freeze({
    MAX_TEXT_LENGTH: 4000,        // 单块文本长度上限（超长文本 Phase 3 再分块）
    MAX_BLOCKS_PER_BATCH: 200,    // 单批消息块数上限
    MAX_BLOCKS_PER_TAB: 5000,     // 单标签页会话内最大块数（内存防呆）
    SCAN_DEBOUNCE_MS: 150,        // 动态内容扫描防抖
    PROGRESS_BROADCAST_MS: 120,   // 进度广播节流
    MAX_SCAN_NODES_PER_PASS: 800, // Phase 4：单次扫描 pass 节点预算（超过即 yield）
    VIEWPORT_BUFFER_RATIO: 1.5,   // Phase 4：视口上下缓冲区（屏数）
  });

  NS.makeMessage = function (type, payload = {}) {
    return { type, payload };
  };

  const KNOWN_TYPES = new Set(Object.values(NS.MESSAGE_TYPES));

  /** 消息白名单校验：type 必须在协议内，payload 必须是普通对象（或省略）。 */
  NS.isKnownMessage = function (message) {
    return Boolean(
      message &&
        typeof message === 'object' &&
        KNOWN_TYPES.has(message.type) &&
        (message.payload === undefined ||
          (message.payload !== null &&
            typeof message.payload === 'object' &&
            !Array.isArray(message.payload)))
    );
  };
})(globalThis);
