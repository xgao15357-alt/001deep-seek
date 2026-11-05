/**
 * translation/translation-batcher.js
 * TranslationBatcher —— 纯函数模块（无 chrome.* / DOM 依赖，可直接单测）。
 * 职责：
 *  - 把文本块按「数量 + 字符」双上限切成 API batch（保持 block ID 与原文绑定）；
 *  - 对 DeepSeek 返回做集合完整性校验（成功 / 缺失 / 重复 / 未知 / 非法分类）；
 *  - 视口优先级的 pending 排序（只重排 pending，绝不影响在途 batch）。
 * 不在本模块做任何网络、DOM、UI 工作。
 */

/** 优先级秩（值小 = 先翻译）。 */
export const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

/**
 * 视口优先级稳定排序：HIGH → MEDIUM → LOW；
 * Array.prototype.sort 稳定 → 同一优先级内保持原始顺序（DOM 阅读顺序），
 * 使新闻标题与摘要尽量落在同一 batch，提升翻译一致性。
 * priorityOf(id) → 'high' | 'medium' | 'low'（未知按 low 处理）。
 */
export function sortBlockIdsByPriority(ids, priorityOf) {
  return [...ids].sort(
    (a, b) => (PRIORITY_RANK[priorityOf(a)] ?? 2) - (PRIORITY_RANK[priorityOf(b)] ?? 2)
  );
}

/**
 * 把 blocks [{id, text}] 切成多个 batch。
 * 规则：任一 batch 达到 maxBlocks 或累计字符达到 maxChars 即结束当前 batch；
 * 单个超长 block（超过 maxChars）独占一个 batch。
 */
export function buildBatches(blocks, { maxBlocks = 12, maxChars = 12000 } = {}) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const b of blocks) {
    const chars = typeof b?.text === 'string' ? b.text.length : 0;
    if (current.length > 0 && (current.length >= maxBlocks || currentChars + chars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(b);
    currentChars += chars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * DeepSeek 返回条目集合校验（requestedIds ↔ returnedItems）。
 * 返回分类：
 *  - successful：合法且 id 属于本次请求的译文 [{id, text}]
 *  - missing：请求了但未返回的 id
 *  - duplicate：重复出现的 id（视为响应非法）
 *  - unknown：不属于本次请求的 id（忽略，绝不转发给 Content Script）
 *  - invalid：结构非法条目（缺 id/text、text 非字符串、text 为空）
 * 绝不依赖数组顺序对应 block；一律按 block.id 精确匹配。
 */
export function classifyBatchResponse(requestedIds, returnedItems) {
  const requested = new Set(requestedIds);
  const seen = new Set();
  const successful = [];
  const missing = [];
  const duplicate = [];
  const unknown = [];
  const invalid = [];

  for (const item of returnedItems) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.text !== 'string') {
      invalid.push(item);
      continue;
    }
    if (seen.has(item.id)) {
      duplicate.push(item.id);
      continue;
    }
    seen.add(item.id);
    if (!requested.has(item.id)) {
      unknown.push(item.id); // 未知 id：忽略并视为内部异常，绝不发送给 Content Script
      continue;
    }
    if (item.text.trim().length === 0) {
      invalid.push(item.id);
      continue;
    }
    successful.push({ id: item.id, text: item.text });
  }
  for (const id of requestedIds) {
    if (!seen.has(id)) missing.push(id);
  }
  return { successful, missing, duplicate, unknown, invalid };
}
