/**
 * translation/translation-text-sanitizer.js
 * TranslationTextSanitizer —— 翻译输入文本清洗层（纯函数模块，无 chrome.* / DOM 依赖）。
 *
 * 位置：DOM 原始文字 → TextBlock.originalText（网页原文，永不被修改）
 *       → TranslationTextSanitizer → translationInput（仅发送给翻译 API 的副本）。
 * 本模块绝不修改网页原文；只处理“要发给 DeepSeek 的副本”。
 *
 * 原则（禁止粗暴 HTML strip，禁止误伤数学/代码文本）：
 *  - 仅清洗“严格白名单”的纯表现标签（strong/b/em/i/u/span/small/mark，大小写不敏感，
 *    可带属性）：<STRONG>PAGE-TURNERS</STRONG> → PAGE-TURNERS；
 *    未知标签（如 <username>）与数学表达式（x < y、vector<int>、C++ template）绝不触碰；
 *  - 只做安全标准化：折叠连续空白、去除零宽字符与非必要控制字符、归一化多余换行；
 *    绝不改变数字、URL、邮箱、代码符号、Emoji、专有名词大小写；
 *  - 若清洗后结果为空（如整段只有表现标签）→ 回退为归一化后的原文，保证不丢块。
 */
const PRESENTATIONAL_TAG_RE = /<\/?(?:strong|b|em|i|u|span|small|mark)(?:\s[^<>]*)?>/gi;

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export class TranslationTextSanitizer {
  /**
   * 清洗发送给翻译 API 的文本副本。
   * 输入即副本（调用方保证 originalText 不被传入/不被修改）。
   */
  static sanitize(input) {
    if (typeof input !== 'string') return '';
    let out = input;
    out = out.replace(ZERO_WIDTH_RE, '');
    out = out.replace(CONTROL_RE, ' ');
    out = out.replace(PRESENTATIONAL_TAG_RE, '');
    out = out.replace(/\s+/g, ' ').trim();
    if (out.length === 0 && input.trim().length > 0) {
      // 清洗后为空（整段只有白名单标签）：回退为归一化原文，绝不丢块
      return input.replace(/\s+/g, ' ').trim();
    }
    return out;
  }
}

/** 便捷函数（SW 侧使用）。 */
export function sanitizeTranslationInput(text) {
  return TranslationTextSanitizer.sanitize(text);
}
