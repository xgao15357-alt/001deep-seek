/**
 * translation/translation-provider.js
 * Translation Provider 抽象层（统一接口 + 注册表）。
 * 为什么需要这一层：
 *  - 页面处理核心（DOM / 调度 / 缓存）只依赖本接口，不感知具体厂商；
 *  - 未来新增 OpenAI / Gemini / Claude / DeepL / 自建兼容端点 Provider 时，
 *    只需注册新类，无需改动页面层与调度层代码。
 * Phase 1：只定义契约；任何真实网络调用都禁止。
 */
import { TranslationError, ERROR_CODES } from '../shared/errors.js';

export class TranslationProvider {
  constructor(config = {}) {
    this.config = config;
  }

  get id() {
    throw new Error('TranslationProvider 子类必须实现 id getter');
  }

  get displayName() {
    throw new Error('TranslationProvider 子类必须实现 displayName getter');
  }

  /** 校验配置，返回 { ok, issues[] }。API Key 不在此校验（运行时缺失 → API_KEY_MISSING）。 */
  validateConfig() {
    return { ok: true, issues: [] };
  }

  /**
   * 核心接口：输入纯文本块数组 → 输出同序译文数组。
   * 约定：textBlocks 只允许纯文本，禁止携带 URL / 标题 / HTML / Cookie 等任何元数据。
   * Phase 1：基类一律返回 NOT_IMPLEMENTED，防止任何意外调用。
   */
  async translate(textBlocks, options = {}) {
    void textBlocks;
    void options;
    throw new TranslationError(ERROR_CODES.NOT_IMPLEMENTED, {
      detail: `${this.displayName} Provider 尚未实现（Phase 2 提供）。`,
    });
  }
}

/**
 * Provider 注册表：创建 Provider 实例的唯一入口。
 * 未来在 Service Worker 初始化时逐个 register 即可完成扩展。
 */
export class ProviderRegistry {
  constructor() {
    this.constructors = new Map();
  }

  register(providerClass) {
    // 用空配置实例化一次以读取 id，同时起到“注册的类必须合法”的注册期校验作用
    const probe = new providerClass({});
    this.constructors.set(probe.id, providerClass);
    return this;
  }

  create(id, config) {
    const Ctor = this.constructors.get(id);
    if (!Ctor) {
      throw new TranslationError(ERROR_CODES.UNKNOWN, {
        detail: `未知的 Translation Provider：${id}`,
      });
    }
    return new Ctor(config);
  }

  has(id) {
    return this.constructors.has(id);
  }

  list() {
    return Array.from(this.constructors.keys());
  }
}
