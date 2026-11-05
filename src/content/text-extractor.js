/**
 * content/text-extractor.js —— 安全正文提取器（经典脚本，挂到 globalThis.__AIWT__）。
 *
 * 原则：只遍历 Text Node，绝不读取 innerHTML / input.value / textarea.value /
 * placeholder / 表单值 / Cookie / 存储。不做任何“判断是否正文”的数据上传。
 *
 * 排除规则与可见性判断（BBC 覆盖率修复后的稳定实现）：
 *  - 元素级只做“明确隐藏/禁止区域”判断（display:none、visibility、hidden、aria-hidden、
 *    forbidden、owned），绝不用元素 getClientRects 判可见性（display:contents 等会误杀）；
 *  - Text Node 级用真实 Range（selectNodeContents + getClientRects）判断文字
 *    是否有可见布局区域（display:contents / grid-flex / content-visibility 正确）；
 *  - button / role=button 的静态标签文字允许翻译（绝不读取任何控件 value、绝不点击）。
 *
 * Phase 4 新增：
 *  - computeViewportPriority：只读 Range 几何 + window.innerHeight 计算 HIGH/MEDIUM/LOW
 *    （绝不滚动、绝不修改布局），供 viewport 优先调度；
 *  - beginScan：可暂停/续跑的分片扫描会话（MAX_NODES_PER_PASS 节点预算），
 *    超长网页不再单次同步阻塞主线程；支持 viewport 剪枝（滚动补扫只扫视口±缓冲区，
 *    远处子树直接 REJECT，避免无意义全页遍历）；
 *  - 诊断（仅开发开关，本地统计跳过原因，不含正文/Key）。
 */
(function (root) {
  'use strict';
  const NS = (root.__AIWT__ = root.__AIWT__ || {});
  if (NS.TextExtractor) return; // 幂等：重复注入时不覆盖

  const EXCLUDED_TAGS = new Set([
    'script', 'style', 'noscript', 'input', 'textarea', 'select', 'option',
    'code', 'pre', 'canvas', 'svg', 'math', 'iframe', 'form',
  ]);
  // 仅排除可编辑/输入类角色；button 与 role=button 的静态标签文字允许翻译
  const EXCLUDED_ROLES = new Set(['textbox']);
  const LATIN_RE = /[A-Za-z]{2,}/; // 至少两个连续拉丁字母才视为英文正文候选

  NS.SKIP_REASONS = Object.freeze({
    OWNED_NODE: 'OWNED_NODE',               // AIWT 自有节点
    FORBIDDEN_ANCESTOR: 'FORBIDDEN_ANCESTOR', // script/input/form 等禁止区域
    HIDDEN: 'HIDDEN',                       // display:none / visibility / hidden
    NO_LATIN_TEXT: 'NO_LATIN_TEXT',         // 无连续拉丁字母
    EMPTY: 'EMPTY',                         // 空白/过短
    ALREADY_MANAGED: 'ALREADY_MANAGED',     // 已登记过的 Text Node
    ARIA_HIDDEN: 'ARIA_HIDDEN',             // aria-hidden=true
    NO_CLIENT_RECTS: 'NO_CLIENT_RECTS',     // Text Node 无可见渲染区域（Range rects 为空）
    OUT_OF_VIEWPORT: 'OUT_OF_VIEWPORT',     // 滚动补扫时子树整体在视口缓冲区外（性能剪枝）
    OTHER: 'OTHER',                         // 超长等其它情况
  });

  NS.BLOCK_PRIORITIES = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

  /**
   * 视口优先级分类（纯几何，只读取 Range rect 与 window.innerHeight，
   * 绝不滚动、绝不修改布局）：
   *  - HIGH：与视口相交（rect.top < viewportHeight && rect.bottom > 0）；
   *  - MEDIUM：视口上下 bufferRatio 屏内；
   *  - LOW：更远处。
   */
  function computeViewportPriority(rect, viewportHeight, bufferRatio = 1.5) {
    const vh = viewportHeight > 0 ? viewportHeight : 800;
    const top = rect?.top ?? 0;
    const bottom = rect?.bottom ?? 0;
    if (top < vh && bottom > 0) return NS.BLOCK_PRIORITIES.HIGH;
    const buffer = vh * bufferRatio;
    if (top < vh + buffer && bottom > -buffer) return NS.BLOCK_PRIORITIES.MEDIUM;
    return NS.BLOCK_PRIORITIES.LOW;
  }
  NS.computeViewportPriority = computeViewportPriority;

  class TextExtractor {
    constructor() {
      this.styleCache = new WeakMap(); // 元素 → computed style（每次扫描内缓存）
    }

    computedStyle(el) {
      let cs = this.styleCache.get(el);
      if (!cs) {
        try {
          cs = window.getComputedStyle(el);
        } catch {
          cs = null;
        }
        this.styleCache.set(el, cs);
      }
      return cs;
    }

    /** 元素级排除：明确隐藏/禁止区域/owned/aria-hidden（不含 getClientRects 判据）。 */
    shouldSkipElement(el, recordSkip) {
      if (!el || el.nodeType !== 1) return false;
      if (typeof el.closest === 'function' && el.closest('[data-aiwt-owned="true"]')) {
        recordSkip(NS.SKIP_REASONS.OWNED_NODE);
        return true;
      }
      if (EXCLUDED_TAGS.has(el.tagName.toLowerCase())) {
        recordSkip(NS.SKIP_REASONS.FORBIDDEN_ANCESTOR);
        return true;
      }
      if (el.isContentEditable) {
        recordSkip(NS.SKIP_REASONS.FORBIDDEN_ANCESTOR);
        return true;
      }
      const type = el.getAttribute('type');
      if (type === 'password' || type === 'hidden') {
        recordSkip(NS.SKIP_REASONS.FORBIDDEN_ANCESTOR);
        return true;
      }
      const role = el.getAttribute('role');
      if (role && EXCLUDED_ROLES.has(role.toLowerCase())) {
        recordSkip(NS.SKIP_REASONS.FORBIDDEN_ANCESTOR);
        return true;
      }
      if (el.getAttribute('aria-hidden') === 'true') {
        recordSkip(NS.SKIP_REASONS.ARIA_HIDDEN);
        return true;
      }
      if (el.hidden === true) {
        recordSkip(NS.SKIP_REASONS.HIDDEN);
        return true;
      }
      const style = this.computedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) {
        recordSkip(NS.SKIP_REASONS.HIDDEN);
        return true;
      }
      return false;
    }

    /** Text Node 级可见性：真实 Range 判定文字是否有可见布局区域。 */
    hasVisibleRange(textNode) {
      try {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rects = range.getClientRects();
        if (!rects || rects.length === 0) return false;
        const box = range.getBoundingClientRect();
        return Boolean(box && (box.width > 0 || box.height > 0));
      } catch {
        return false;
      }
    }

    /**
     * 共享的 TreeWalker 过滤逻辑（extract 与 beginScan 复用）。
     * options.viewport：滚动补扫时提供 { top, bottom }（含缓冲区），
     * 子树整体在范围外的元素直接 REJECT（性能剪枝；display:contents 等零盒元素不剪）。
     */
    buildAcceptNode(processed, recordSkip, viewport) {
      const self = this;
      return (node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (self.shouldSkipElement(node, recordSkip)) return NodeFilter.FILTER_REJECT;
          if (viewport) {
            let r = null;
            try {
              r = node.getBoundingClientRect();
            } catch {
              r = null;
            }
            if (r && (r.width > 0 || r.height > 0) && (r.bottom < viewport.top || r.top > viewport.bottom)) {
              recordSkip(NS.SKIP_REASONS.OUT_OF_VIEWPORT);
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        // Text Node 级过滤
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (processed && processed.has(node)) {
          recordSkip(NS.SKIP_REASONS.ALREADY_MANAGED);
          return NodeFilter.FILTER_REJECT;
        }
        const text = (node.nodeValue ?? '').trim();
        if (text.length < 2) {
          recordSkip(NS.SKIP_REASONS.EMPTY);
          return NodeFilter.FILTER_REJECT;
        }
        if (!LATIN_RE.test(text)) {
          recordSkip(NS.SKIP_REASONS.NO_LATIN_TEXT);
          return NodeFilter.FILTER_REJECT;
        }
        if (text.length > NS.LIMITS.MAX_TEXT_LENGTH) {
          recordSkip(NS.SKIP_REASONS.OTHER);
          return NodeFilter.FILTER_REJECT;
        }
        if (!self.hasVisibleRange(node)) {
          recordSkip(NS.SKIP_REASONS.NO_CLIENT_RECTS);
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      };
    }

    /** 全量提取（子树定向补扫用；整页请用 beginScan 分片）。 */
    extract(root, processed, options = {}) {
      const recordSkip =
        options.diagnostics && typeof options.diagnostics.recordSkip === 'function'
          ? options.diagnostics.recordSkip
          : () => {};
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        { acceptNode: this.buildAcceptNode(processed, recordSkip, null) }
      );
      const found = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          found.push({ node, text: node.nodeValue.trim(), parent: node.parentElement });
        }
      }
      return found;
    }

    /**
     * 分片扫描会话（Phase 4 性能预算）：单次 next() 最多访问 maxNodes 个节点，
     * 未走完时把位置留在 TreeWalker，调用方 yield 到下一事件循环再继续，
     * 避免超长网页长时间阻塞主线程。
     * 诊断始终收集到会话内部（session.diagnostics()），不依赖 options.diagnostics。
     * 返回 { next(maxNodes), diagnostics(), abort() }。
     */
    beginScan(root, processed, options = {}) {
      const self = this;
      const maxNodesPerPass = options.maxNodesPerPass ?? 800;
      const viewport = options.viewport ?? null;
      const diag = {
        found: 0,
        skips: {},
        visited: 0,
        scanDurationMs: 0,
        done: false,
      };
      const recordSkip = (reason) => {
        diag.skips[reason] = (diag.skips[reason] ?? 0) + 1;
      };
      const startedAt = Date.now();
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        { acceptNode: self.buildAcceptNode(processed, recordSkip, viewport) }
      );
      return {
        next(maxNodes = maxNodesPerPass) {
          if (diag.done) return { found: [], done: true };
          const found = [];
          let visited = 0;
          let node;
          while (visited < maxNodes && (node = walker.nextNode())) {
            visited += 1;
            if (node.nodeType === Node.TEXT_NODE) {
              found.push({ node, text: node.nodeValue.trim(), parent: node.parentElement });
            }
          }
          if (!node) diag.done = true; // walker 走到末尾
          diag.visited += visited;
          diag.found += found.length;
          diag.scanDurationMs = Date.now() - startedAt;
          return { found, done: diag.done };
        },
        diagnostics() {
          return diag;
        },
        abort() {
          diag.done = true;
        },
      };
    }
  }

  NS.TextExtractor = TextExtractor;
})(globalThis);
