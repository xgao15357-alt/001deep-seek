/**
 * translation/retry-policy.js
 * 重试策略（纯函数模块，无 chrome.* 依赖）。
 * 只对合理的临时错误做有限重试（指数退避 + jitter），绝不无限重试。
 * 可重试：NETWORK_ERROR / TIMEOUT / RATE_LIMITED / SERVER_ERROR / SERVICE_OVERLOADED /
 *         空 content、JSON 解析失败等明显临时的 INVALID_RESPONSE（Provider 已标 retryable）。
 * 不可重试：400/422（INVALID_REQUEST）、401（API_KEY_INVALID）、402（INSUFFICIENT_BALANCE）、
 *           USER_CANCELLED、AbortError、PAGE_UNSUPPORTED、PAGE_HIGH_RISK。
 * OUTPUT_TRUNCATED 不在此列：截断的 batch 绝不原样重试（成本优先）——
 * 由 batch-translator 立即拆半，单块截断直接失败。
 * 若错误携带 retryAfterMs（来自 Retry-After），优先尊重。
 */
import { TranslationError, ERROR_CODES } from '../shared/errors.js';

const RETRYABLE_CODES = new Set([
  ERROR_CODES.NETWORK_ERROR,
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.SERVER_ERROR,
  ERROR_CODES.SERVICE_OVERLOADED,
  ERROR_CODES.INVALID_RESPONSE,
]);

export function shouldRetryError(err, attempt, maxRetries) {
  if (attempt >= maxRetries) return false;
  if (!err) return false;
  if (err.retryable === true) return true;
  return RETRYABLE_CODES.has(err.code);
}

/** 指数退避 + 少量 jitter；Retry-After 优先（封顶 15s）。 */
export function backoffDelayMs(attempt, err, baseMs = 500) {
  if (err && typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0) {
    return Math.min(err.retryAfterMs, 15000);
  }
  return Math.min(baseMs * 2 ** attempt, 8000) + Math.random() * 200;
}

/** 可被 AbortSignal 打断的 sleep：中止时抛出 AbortError。 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 带有限重试执行 fn。
 * 用户停止（signal abort）后立即中止，不再重试。
 * 注：fetch 本身的取消由 Provider 内部的 AbortController 完成；
 * 这里只负责“失败 → 退避 → 重试”与退避期间的中止。
 */
export async function withRetry(fn, { maxRetries = 2, signal = null, backoffBaseMs = 500 } = {}) {
  let lastError = null;
  for (let attempt = 0; ; attempt += 1) {
    if (signal && signal.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (signal && signal.aborted) {
        // 用户停止：把任意原始错误归一为 USER_CANCELLED（Scheduler 据此标记 cancelled，不算失败）
        throw new TranslationError(ERROR_CODES.USER_CANCELLED);
      }
      if (!shouldRetryError(err, attempt, maxRetries)) throw err;
      await abortableSleep(backoffDelayMs(attempt, err, backoffBaseMs), signal);
    }
  }
}
