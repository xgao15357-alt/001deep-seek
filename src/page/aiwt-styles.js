/**
 * page/aiwt-styles.js
 * AIWT 译文样式（字符串）。
 * 由 Service Worker 通过 chrome.scripting.insertCSS 注入：
 *  - 可绕过页面 CSP 对 <style> 内联样式的限制，行为稳定；
 *  - 页面自身的脚本无法修改扩展注入的规则。
 * 显示模式 = body 上的 aiwt-mode-* 类 + 以下纯 CSS 规则（完全非破坏性）：
 *  - bilingual：原文与译文都可见（默认）；
 *  - targetOnly：隐藏 AIWT 原文 wrapper（.aiwt-original），只显示译文；
 *  - original：隐藏全部译文（.aiwt-translation），只显示原文。
 * 显示模式切换绝不修改原文 Text Node 内容、绝不删除任何 AIWT 节点。
 */
export const AIWT_STYLES = `
/* AIWT 原文 wrapper（原 Text Node 被移动进该 span，节点对象与内容不变） */
.aiwt-original {
  /* 默认可见；targetOnly 模式下由下方规则隐藏 */
}
/* AIWT 译文统一标记（同时带 data-aiwt-owned="true" 属性） */
.aiwt-translation {
  color: #0f766e;
  font-size: 0.92em;
}
.aiwt-translation.aiwt-inline {
  margin-left: 0.35em;
}
.aiwt-translation.aiwt-block {
  display: block;
  margin-top: 2px;
  line-height: 1.5;
}
/* 仅中文模式：隐藏原文（原文节点仍完整保留在 DOM 中，可即时切回） */
body.aiwt-mode-targetOnly .aiwt-original {
  display: none !important;
}
/* 原文显示模式：隐藏全部译文（节点保留在内存，可瞬间切回双语） */
body.aiwt-mode-original .aiwt-translation {
  display: none !important;
}
`;
