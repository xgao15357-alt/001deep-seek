/**
 * shared/constants.js
 * 全局共享常量：应用信息、存储键、显示模式、Provider 标识、默认设置、API 批量上限。
 * 设计说明：
 *  - 存储键与枚举集中定义，避免魔法字符串散落导致拼写不一致；
 *  - DEFAULT_SETTINGS 是「单一事实来源」，Service Worker 与 Options 页共用；
 *  - API Key 使用独立存储键：便于单独清除，也避免被其他“导出设置”类功能顺带带走。
 */

export const APP_INFO = Object.freeze({
  NAME: 'AI Web Translator',
  VERSION: '0.4.0',
  PHASE: 4,
});

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'awt.settings',
  API_KEY: 'awt.deepseek.apiKey',
  // Page Translation State 摘要（chrome.storage.session，键 = 前缀 + tabId）：
  // 只含状态/计数/Token 用量等摘要，绝不含页面文字、API Key。
  PAGE_STATE_PREFIX: 'awt.pageState.',
});

export const DISPLAY_MODES = Object.freeze({
  BILINGUAL: 'bilingual',   // 中英双语
  TARGET_ONLY: 'targetOnly', // 仅中文
  ORIGINAL: 'original',      // 原文
});

export const PROVIDER_IDS = Object.freeze({
  DEEPSEEK: 'deepseek',
  MOCK: 'mock', // 仅内部测试 / dev 开关使用，正常用户路径不可见
  // 未来扩展：OPENAI / GEMINI / CLAUDE / DEEPL / CUSTOM_OPENAI_COMPATIBLE
});

/** V1 允许的 DeepSeek 模型。默认 Flash（速度/成本/翻译质量平衡），可选 Pro。 */
export const DEEPSEEK_MODELS = Object.freeze({
  FLASH: 'deepseek-v4-flash',
  PRO: 'deepseek-v4-pro',
});

/**
 * 翻译 Prompt / 输出 schema 版本。
 * 缓存键必须包含它：prompt/schema 变化时旧缓存必须全部失效。
 * Phase 4 升级到 v2（自然中文风格 / 标题 / UI 文本规则）：v1 旧缓存自动 miss，绝不复用。
 */
export const TRANSLATION_PROMPT_VERSION = 'translation-prompt-v2';

/**
 * DeepSeek API 批量上限（内部常量，可随实测调整）。
 * 绝不把整页文本塞进一个巨大请求：数量或字符任一达到上限即结束当前 batch。
 */
export const API_BATCH_LIMITS = Object.freeze({
  MAX_BLOCKS: 12,
  MAX_CHARS: 12000,
});

/**
 * DeepSeek 输出 token 上限（内部常量，用户不可配置，Options 不暴露）。
 * 选择 16384 的理由：batch 输入上限 12000 字符，中文输出约 1 token/字符，
 * 最坏情况下输出可接近 12000+ token，8192 可能触发 finish_reason=length 截断；
 * 16384 为输出留足裕量，同时不扩大 batch 上限、不修改模型上下文配置。
 * 注意：即使显式设置了 max_tokens，finish_reason=length 仍必须按截断处理（防御性）。
 */
export const MAX_OUTPUT_TOKENS = 16384;

/**
 * Phase 4 长网页扫描性能预算（内部常量，可随实测调整）：
 * 单次扫描 pass 最多访问的节点数，超过即 yield 到下一事件循环继续，
 * 避免超长网页让主线程长时间阻塞。
 */
export const SCAN_BUDGET = Object.freeze({
  MAX_NODES_PER_PASS: 800,
  VIEWPORT_BUFFER_RATIO: 1.5, // 视口上下各 1.5 屏作为 MEDIUM 缓冲区 / 滚动补扫范围
});

/** Phase 4 视口优先级（只影响 pending 排序；在途 batch 绝不被 abort/重排）。 */
export const BLOCK_PRIORITIES = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

/**
 * 默认设置。
 * Phase 4：正常翻译链路使用 DeepSeekProvider；host_permissions 仅
 * https://api.deepseek.com/*（真实请求只发生在用户主动点击“翻译当前网页”之后）。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  provider: PROVIDER_IDS.DEEPSEEK,
  direction: 'en->zh-CN',
  displayMode: DISPLAY_MODES.BILINGUAL,
  // 隐私基线：长期翻译缓存默认关闭（当前仅内存会话缓存，不落地任何译文）
  longTermCacheEnabled: false,
  deepseek: Object.freeze({
    apiEndpoint: 'https://api.deepseek.com/chat/completions', // V1 锁定官方端点，Options 只读
    model: DEEPSEEK_MODELS.FLASH,
    // Phase 4 默认 25000ms：让插件自己的 AbortController 优先产生 TIMEOUT，
    // 避免贴近浏览器 fetch / MV3 SW 生命周期边界（用户可在 Options 调整）。
    // 注意：Phase 3 已保存的 30000 设置保持不变，仅新默认生效。
    timeoutMs: 25000,
    maxConcurrency: 2, // 同时进行的 API batch 数（1–8）
    maxRetries: 2,
    disableThinking: true, // 网页翻译固定关闭 Thinking，Options 只读不可改
  }),
  mock: Object.freeze({
    failRatio: 0,      // 0–1，仅 dev 开关/自动测试用
    minDelayMs: 50,
    maxDelayMs: 150,
  }),
  dev: Object.freeze({
    // 内部开发开关：true 时翻译链路使用 MockTranslationProvider（不联网）。
    // 故意不在 Options UI 暴露，正常用户路径永远是 DeepSeek。
    forceMockProvider: false,
    // 扫描诊断（TextExtractor 跳过原因统计，仅本地、生产默认关闭）。
    scanDiagnostics: false,
  }),
});

/**
 * 把 chrome.storage.local 中的设置与默认值合并（补齐缺失字段，嵌套对象同样处理）。
 * 纯函数，不产生副作用。
 */
export function mergeSettings(stored = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    deepseek: { ...DEFAULT_SETTINGS.deepseek, ...(stored.deepseek ?? {}) },
    mock: { ...DEFAULT_SETTINGS.mock, ...(stored.mock ?? {}) },
    dev: { ...DEFAULT_SETTINGS.dev, ...(stored.dev ?? {}) },
  };
}
