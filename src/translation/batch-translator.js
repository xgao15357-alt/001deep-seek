/**
 * translation/batch-translator.js
 * 批量翻译执行器（纯函数模块，无 chrome.* 依赖；provider 依赖注入，可 Node 单测）。
 *
 * 职责：
 *  - 其他临时错误（NETWORK/TIMEOUT/429/500/503 等）沿用 withRetry 的有限重试；
 *  - OUTPUT_TRUNCATED（finish_reason=length）成本优先：**绝不原样重试同一 batch**，
 *    第一次截断即立即拆半重试（12→6+6→3+3→1+2…，递归有界）：
 *      · 截断的 JSON 绝不投递、绝不标记 batch completed；
 *      · 拆半只影响本 batch，已成功的其他 batch 不受影响；
 *      · 单块仍截断 → 直接以 OUTPUT_TRUNCATED 失败（该块标记 failed），绝不无限重试。
 */
import { TranslationError, ERROR_CODES } from '../shared/errors.js';
import { withRetry } from './retry-policy.js';

function mergeUsage(a, b) {
  if (!a && !b) return null;
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + (b?.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (b?.completion_tokens ?? 0),
    total_tokens: (a?.total_tokens ?? 0) + (b?.total_tokens ?? 0),
  };
}

/** 合并两次子批次的结构化结果（results / missingIds / unknownIds / usage）。 */
export function mergeBatchResults(a, b) {
  return {
    results: [...(a?.results ?? []), ...(b?.results ?? [])],
    missingIds: [...(a?.missingIds ?? []), ...(b?.missingIds ?? [])],
    unknownIds: [...(a?.unknownIds ?? []), ...(b?.unknownIds ?? [])],
    usage: mergeUsage(a?.usage, b?.usage),
  };
}

/**
 * 批量翻译 + 截断立即拆半兜底（成本优先）。
 * provider.translateBatch({ blocks, signal }) → { results, missingIds, unknownIds, usage }
 * backoffBaseMs 透传给 withRetry（测试可调小）。
 */
export async function translateBatchWithSplitRetry(
  provider,
  blocks,
  { maxRetries = 2, signal = null, backoffBaseMs = 500 } = {}
) {
  try {
    // OUTPUT_TRUNCATED 不在可重试集合：第一次截断即抛错 → 下方立即拆半，绝不原样重试
    return await withRetry(() => provider.translateBatch({ blocks, signal }), {
      maxRetries,
      signal,
      backoffBaseMs,
    });
  } catch (err) {
    if (
      err instanceof TranslationError &&
      err.code === ERROR_CODES.OUTPUT_TRUNCATED &&
      blocks.length > 1
    ) {
      // 12 → 6+6 → 3+3 → 1+2 …：递归有界，单块即停止拆分
      const mid = Math.ceil(blocks.length / 2);
      const first = await translateBatchWithSplitRetry(provider, blocks.slice(0, mid), { maxRetries, signal, backoffBaseMs });
      const second = await translateBatchWithSplitRetry(provider, blocks.slice(mid), { maxRetries, signal, backoffBaseMs });
      return mergeBatchResults(first, second);
    }
    throw err;
  }
}
