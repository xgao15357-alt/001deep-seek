/**
 * content/text-block-manager.js —— 页面内文本块登记表（经典脚本，挂到 globalThis.__AIWT__）。
 *
 * 为什么块记录必须放在 Content Script 侧：块持有原文 Text Node 的引用，
 * 译文必须按 block.id 精确落回 DOM，Node 引用无法跨进程传递。
 *
 * 每个块：
 *   block.id            页内唯一稳定 ID（aiwt-block-000001 起，六位序号）
 *   block.text          原文（trim 后）
 *   block.normalizedText 归一化原文（空白折叠，用于缓存键与请求）
 *   block.translation   译文（未完成时为 null）
 *   block.node          原文 Text Node 引用
 *   block.span          AIWT 插入的译文 span 引用
 *   block.state         pending | running | completed | failed | cancelled
 *
 * 译文结果按 ID 匹配，绝不依赖 API 返回顺序——Phase 3 接 DeepSeek 时直接复用。
 */
(function (root) {
  'use strict';
  const NS = (root.__AIWT__ = root.__AIWT__ || {});
  if (NS.TextBlockManager) return; // 幂等：重复注入时不覆盖

  NS.BLOCK_STATUS = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  });

  class TextBlockManager {
    constructor() {
      this.byId = new Map();   // id -> record
      this.byNode = new Map(); // Text Node -> record
    }

    register({ id, node, text, normalizedText, priority = null }) {
      if (this.byId.has(id)) return this.byId.get(id);
      const record = {
        id,
        node,
        text,
        normalizedText,
        priority, // Phase 4：viewport 优先级（high/medium/low，pending 排序用）
        status: NS.BLOCK_STATUS.PENDING,
        translation: null,
        span: null,   // AIWT 译文 span
        wrapper: null, // AIWT 原文 wrapper span（显示模式切换只靠 CSS 控制其可见性）
        layout: null, // 'block' | 'inline'：首次渲染时确定，重渲染保持一致
      };
      this.byId.set(id, record);
      this.byNode.set(node, record);
      return record;
    }

    findByNode(node) {
      return this.byNode.get(node) ?? null;
    }

    get(id) {
      return this.byId.get(id) ?? null;
    }

    records() {
      return Array.from(this.byId.values());
    }

    /**
     * 需要（重新）请求翻译的候选块：
     * 未完成 且 状态可重试 且 原文节点仍在页面中。
     * 用于：停止后重新开始、失败重试、原文被网站修改后的重译。
     */
    pendingCandidates() {
      const { PENDING, CANCELLED, FAILED } = NS.BLOCK_STATUS;
      return this.records().filter(
        (r) =>
          !r.translation &&
          (r.status === PENDING || r.status === CANCELLED || r.status === FAILED) &&
          r.node.isConnected &&
          (r.text ?? '').length >= 2
      );
    }

    remove(id) {
      const record = this.byId.get(id);
      if (!record) return false;
      this.byId.delete(id);
      this.byNode.delete(record.node);
      return true;
    }

    clear() {
      this.byId.clear();
      this.byNode.clear();
    }

    get size() {
      return this.byId.size;
    }
  }

  NS.TextBlockManager = TextBlockManager;
})(globalThis);
