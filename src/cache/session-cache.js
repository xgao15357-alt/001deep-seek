/**
 * cache/session-cache.js
 * SessionCache —— 会话级「原文 → 译文」内存缓存（Phase 2 真实接通）。
 * 目标：同一浏览会话中重复出现的文本块直接复用译文，减少 API 调用与费用。
 * 隐私与存储策略：
 *  - 仅存于 Service Worker 内存，SW 被回收后自动消失，不写 chrome.storage、不落盘；
 *  - 长期翻译缓存默认关闭（settings.longTermCacheEnabled），Phase 2 不落地任何译文；
 *  - 缓存键包含原文，因此键与值都视为隐私数据：禁止打印、禁止上报。
 */
const MAX_ENTRIES = 2000; // 内存防呆上限：超出后整体清空（会话缓存允许丢弃）

export class SessionCache {
  constructor() {
    this.store = new Map(); // key -> { translation, meta, savedAt }
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * 缓存键：provider + model + prompt/schema 版本 + 语言对 + 归一化原文。
   * 为什么必须包含 provider / model / promptVersion：
   *  - Mock 结果绝不能因为旧缓存命中而显示在真实 DeepSeek 模式；
   *  - 不同模型（flash / pro）的译文质量与风格不同，必须分开缓存；
   *  - prompt / 输出 schema 变化时旧缓存必须整体失效。
   */
  buildKey({ provider, model, sourceText, sourceLang, targetLang, promptVersion }) {
    return JSON.stringify([
      provider ?? 'unknown',
      model ?? 'unknown',
      promptVersion ?? 'v0',
      sourceLang,
      targetLang,
      sourceText,
    ]);
  }

  has(key) {
    return this.store.has(key);
  }

  get(key) {
    if (this.store.has(key)) {
      this.stats.hits += 1;
      return this.store.get(key);
    }
    this.stats.misses += 1;
    return null;
  }

  set(key, translation, meta = {}) {
    if (this.store.size >= MAX_ENTRIES) {
      this.clear(); // 会话缓存整体失效可接受：下一轮扫描会重新翻译
    }
    this.store.set(key, { translation, meta, savedAt: Date.now() });
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
  }

  get size() {
    return this.store.size;
  }
}
