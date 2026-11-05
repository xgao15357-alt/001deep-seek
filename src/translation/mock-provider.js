/**
 * translation/mock-provider.js
 * MockTranslationProvider —— Phase 2 本地模拟 Provider。
 * 目的不是翻译正确，而是端到端验证：
 *   Text Block → Scheduler → Provider → 结果 ID → DOM Renderer 全链路。
 * 安全约束：
 *  - 绝对不联网：无 fetch / XMLHttpRequest，无任何 host 权限依赖；
 *  - 所有结果带「【模拟译文】」前缀，防止被误认为真实 AI 翻译；
 *  - 通过 settings.mock.failRatio 可模拟失败（开发开关，默认 0）。
 */
import { TranslationProvider } from './translation-provider.js';
import { TranslationError, ERROR_CODES } from '../shared/errors.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockTranslationProvider extends TranslationProvider {
  constructor(config = {}) {
    super(config);
    this.minDelayMs = config.minDelayMs ?? 50;
    this.maxDelayMs = config.maxDelayMs ?? 150;
    this.failRatio = config.failRatio ?? 0; // 0–1，默认 0 = 从不失败
  }

  get id() {
    return 'mock';
  }

  get displayName() {
    return '本地模拟（Mock）';
  }

  get model() {
    return 'mock-v1';
  }

  validateConfig() {
    const issues = [];
    if (!(this.failRatio >= 0 && this.failRatio <= 1)) issues.push('failRatio 必须在 0–1 之间');
    if (!(this.minDelayMs >= 0 && this.minDelayMs <= this.maxDelayMs)) issues.push('模拟延迟区间无效');
    return { ok: issues.length === 0, issues };
  }

  /**
   * 模拟翻译：每块 50–150ms 随机延迟，返回带前缀的原文。
   * failRatio > 0 时按概率抛出 INVALID_RESPONSE，用于测试失败流程（默认关闭）。
   */
  async translate(textBlocks, options = {}) {
    const signal = options.signal ?? null;
    const results = [];
    for (const text of textBlocks) {
      if (signal && signal.aborted) {
        throw new TranslationError(ERROR_CODES.USER_CANCELLED);
      }
      await delay(this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs));
      if (signal && signal.aborted) {
        throw new TranslationError(ERROR_CODES.USER_CANCELLED);
      }
      if (this.failRatio > 0 && Math.random() < this.failRatio) {
        throw new TranslationError(ERROR_CODES.INVALID_RESPONSE, {
          detail: 'Mock 模拟失败（开发开关）。',
        });
      }
      results.push(`【模拟译文】${text}`);
    }
    return results;
  }

  /**
   * Phase 3 批量接口（与 DeepSeekProvider 对齐，供 dev 开关走同一条批量链路）。
   * 绝不联网；结果带【模拟译文】前缀；usage 恒为 null（不虚构 Token 用量）。
   */
  async translateBatch({ blocks, signal }) {
    const texts = blocks.map((b) => b.text);
    const results = await this.translate(texts, { signal });
    return {
      results: blocks.map((b, i) => ({ id: b.id, text: results[i] })),
      missingIds: [],
      unknownIds: [],
      usage: null,
    };
  }
}
