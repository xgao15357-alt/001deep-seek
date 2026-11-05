/**
 * background/api-key-cache.js
 * API Key 内存缓存（Service Worker 进程内单值，无 chrome.* 依赖，可 Node 单测）。
 *
 * 为什么不需要按 tab 保存：所有标签页共用同一个 Key，按 tabId 缓存同一份 Key
 * 只会增加陈旧风险而无任何收益——因此简化为「单值缓存 + 失效重读」。
 *
 * 陈旧性保证（场景 A / B）：
 *  - 每次新的翻译任务启动（handleStartTranslation）都直接从 storage 读取最新 Key
 *    （这是“必须用新 Key / 必须 API_KEY_MISSING”的根本保证）；
 *  - chrome.storage.onChanged（API_KEY 变化）→ invalidate() 立即使内存副本失效；
 *  - 会话进行中新建 batch 时若缓存已失效 → get() 自动重新读取 storage。
 *  因此：换 Key → 新任务用新 Key；清除 Key → 新任务得到 null（上游转 API_KEY_MISSING），
 *  绝不继续使用旧的内存 Key。
 *
 * 安全：缓存值只存在于 SW 内存；本模块不打印、不序列化、不进入任何消息。
 */
export function createApiKeyCache(readFromStorage) {
  let cached = null; // null = 未缓存/已失效；保存的值只能是 string 或 null
  return {
    /** 读取当前 Key：缓存有效直接用；失效则重新从 storage 读取。 */
    async get() {
      if (cached === null) {
        cached = await readFromStorage();
      }
      return cached;
    },
    /** 翻译任务启动时写入刚从 storage 直读的新鲜 Key。 */
    set(key) {
      cached = key;
    },
    /** storage 变化时立即失效（由 chrome.storage.onChanged 调用）。 */
    invalidate() {
      cached = null;
    },
  };
}
