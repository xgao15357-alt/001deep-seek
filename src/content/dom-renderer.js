/**
 * content/dom-renderer.js —— 双语 DOM 渲染器（经典脚本，挂到 globalThis.__AIWT__）。
 *
 * 渲染策略（最小化 DOM 修改 + 显示模式完全非破坏性）：
 *  - 原文 Text Node 对象本身永不被修改：渲染时把原节点“移动”进一个 AIWT 自有
 *    wrapper span（.aiwt-original）中，节点对象与内容都不变
 *    （网站 JS 对原节点的引用继续有效，链接/事件不受影响）；
 *  - 译文以 span（.aiwt-translation）插入 wrapper 之后（block/inline 由上下文决定，
 *    布局结论记录在 record.layout，重渲染时保持一致）；
 *  - 所有 AIWT 节点带 data-aiwt-owned="true" + data-aiwt-block-id：
 *      · 提取器 / MutationObserver 据此忽略，杜绝自触发循环；
 *      · 恢复原文时据此精准还原；
 *  - 显示模式切换只切换 body 上的 aiwt-mode-* 类，由注入的 CSS 控制可见性：
 *      · 完全不修改原文内容、不删除译文节点、不改变任何 block 状态；
 *      · 因此 Observer 永远不会把模式切换误判为“网站修改了原文”
 *        （不再产生任何 characterData 变更，从根上消除误判路径）；
 *  - 恢复原文（只由“恢复原文”按钮触发，与显示模式彻底分离）：
 *    把原文 Text Node 放回 wrapper 原位置（节点对象不变）、删除全部 AIWT 节点、
 *    清除 body 模式类。
 *  - 所有 DOM 写入包裹在 mutating 标记中，Observer 在标记期间直接忽略事件
 *    （防自触发循环的额外保险）。
 */
(function (root) {
  'use strict';
  const NS = (root.__AIWT__ = root.__AIWT__ || {});
  if (NS.DomRenderer) return; // 幂等：重复注入时不覆盖

  const MODES = Object.freeze({ BILINGUAL: 'bilingual', TARGET_ONLY: 'targetOnly', ORIGINAL: 'original' });

  // 块级上下文：父元素是块级标签且其全部文本都来自这一个 Text Node 时，
  // 译文按块级显示（换行、清晰）；否则保守地按 inline 插入，避免破坏混排布局。
  const BLOCK_TAGS = new Set([
    'p', 'div', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'section', 'article', 'header', 'footer', 'dd', 'dt',
    'caption', 'figcaption', 'summary', 'main', 'aside',
  ]);

  class DomRenderer {
    constructor() {
      this.mode = MODES.BILINGUAL;
      this.isMutating = false; // Observer 据此忽略 AIWT 自身的写入
    }

    /** 包裹 DOM 写入：保证 mutating 标记一定被复位。 */
    withMutation(fn) {
      this.isMutating = true;
      try {
        return fn();
      } finally {
        this.isMutating = false;
      }
    }

    /**
     * 显示模式切换：只改 body 类，绝不触碰任何原文 / 译文节点与 block 状态。
     * 可见性由 aiwt-styles.js 注入的 CSS 规则决定：
     *   bilingual  → 原文可见 + 译文可见
     *   targetOnly → .aiwt-original { display:none }（仅译文）
     *   original   → .aiwt-translation { display:none }（仅原文）
     */
    applyMode(mode) {
      if (!Object.values(MODES).includes(mode)) return;
      this.mode = mode;
      const body = document.body;
      if (!body) return;
      body.classList.remove('aiwt-mode-bilingual', 'aiwt-mode-targetOnly', 'aiwt-mode-original');
      body.classList.add(`aiwt-mode-${mode}`);
    }

    /** 块级上下文判定（必须在原文节点被移入 wrapper 之前调用）。 */
    isBlockContext(node) {
      const parent = node.parentElement;
      if (!parent) return false;
      if (!BLOCK_TAGS.has(parent.tagName.toLowerCase())) return false;
      return (parent.textContent ?? '').trim() === (node.nodeValue ?? '').trim();
    }

    /**
     * 渲染 / 复用译文节点（幂等）：
     * 1) 首次：把原文 Text Node 移入 AIWT wrapper（节点对象不变）；
     * 2) 译文 span 插入 wrapper 之后。
     */
    ensureSpan(record) {
      if (record.span && record.span.isConnected) return record.span;
      return this.withMutation(() => {
        if (!record.wrapper || !record.wrapper.isConnected) {
          const layout = this.isBlockContext(record.node) ? 'block' : 'inline'; // 必须先于移动计算
          const wrapper = document.createElement('span');
          wrapper.className = 'aiwt-original';
          wrapper.setAttribute('data-aiwt-owned', 'true');
          wrapper.setAttribute('data-aiwt-block-id', record.id);
          record.node.parentElement.insertBefore(wrapper, record.node);
          wrapper.appendChild(record.node); // 移动而非复制：节点引用与内容都不变
          record.wrapper = wrapper;
          record.layout = layout;
        }
        const span = document.createElement('span');
        span.className = 'aiwt-translation';
        span.setAttribute('data-aiwt-owned', 'true');
        span.setAttribute('data-aiwt-block-id', record.id);
        span.textContent = record.translation ?? '';
        span.classList.add(record.layout === 'block' ? 'aiwt-block' : 'aiwt-inline');
        record.wrapper.parentElement.insertBefore(span, record.wrapper.nextSibling);
        record.span = span;
        return span;
      });
    }

    /** 移除单块译文节点（仅用于“网站修改了原文 → 旧译文失效”；保留 wrapper 与块状态）。 */
    removeTranslation(record) {
      if (!record.span) return;
      this.withMutation(() => {
        if (record.span.isConnected) record.span.remove();
        record.span = null;
      });
    }

    /**
     * 恢复原文（仅“恢复原文”按钮触发，与显示模式无关）：
     * 把原文 Text Node 放回 wrapper 原位置（节点对象不变）、删除全部 AIWT 节点、
     * 清除 body 模式类。块登记与计数由调用方（控制器）清除。
     */
    restoreAll(records) {
      this.withMutation(() => {
        for (const r of records) {
          if (r.wrapper && r.wrapper.isConnected && r.node.isConnected) {
            r.wrapper.parentElement.replaceChild(r.node, r.wrapper);
          }
          if (r.span && r.span.isConnected) r.span.remove();
          r.wrapper = null;
          r.span = null;
          r.layout = null;
        }
        const body = document.body;
        if (body) body.classList.remove('aiwt-mode-bilingual', 'aiwt-mode-targetOnly', 'aiwt-mode-original');
        this.mode = MODES.BILINGUAL;
      });
    }
  }

  NS.DomRenderer = DomRenderer;
  NS.DISPLAY_MODES = MODES;
})(globalThis);
