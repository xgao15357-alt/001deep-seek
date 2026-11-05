/**
 * shared/errors.js
 * 统一错误模型（V1 错误码设计）。
 * 所有层级（Page / Scheduler / Provider / Service Worker）产生错误时，
 * 都必须使用 TranslationError + 这里的错误码；Popup 据此显示可理解的中文提示，
 * 而不是一句笼统的 "Translation failed"。
 * 隐私约束：错误信息（detail）里禁止出现 API Key、Authorization header、
 * 完整请求体、原文、URL、Cookie 等敏感数据。
 */

export const ERROR_CODES = Object.freeze({
  API_KEY_MISSING: 'API_KEY_MISSING',
  API_KEY_INVALID: 'API_KEY_INVALID',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  INVALID_REQUEST: 'INVALID_REQUEST',       // HTTP 400 / 422 等请求参数错误
  SERVER_ERROR: 'SERVER_ERROR',             // HTTP 500
  SERVICE_OVERLOADED: 'SERVICE_OVERLOADED', // HTTP 503 / finish_reason=insufficient_system_resource
  OUTPUT_TRUNCATED: 'OUTPUT_TRUNCATED',     // finish_reason=length：输出被截断（可有限重试）
  CONTENT_FILTERED: 'CONTENT_FILTERED',     // finish_reason=content_filter：内容被安全过滤
  UNEXPECTED_FINISH_REASON: 'UNEXPECTED_FINISH_REASON', // tool_calls 等异常结束原因
  PAGE_UNSUPPORTED: 'PAGE_UNSUPPORTED',
  PAGE_HIGH_RISK: 'PAGE_HIGH_RISK',
  USER_CANCELLED: 'USER_CANCELLED',
  TAB_CLOSED: 'TAB_CLOSED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  UNKNOWN: 'UNKNOWN',
});

export const ERROR_MESSAGES_ZH = Object.freeze({
  [ERROR_CODES.API_KEY_MISSING]: '尚未配置 DeepSeek API Key。',
  [ERROR_CODES.API_KEY_INVALID]: 'DeepSeek API Key 无效，请检查设置。',
  [ERROR_CODES.INSUFFICIENT_BALANCE]: 'DeepSeek API 余额不足，请检查账户余额。',
  [ERROR_CODES.RATE_LIMITED]: '请求过于频繁，正在稍后重试。',
  [ERROR_CODES.NETWORK_ERROR]: '网络连接失败，请检查网络后重试。',
  [ERROR_CODES.TIMEOUT]: 'DeepSeek 请求超时。',
  [ERROR_CODES.INVALID_RESPONSE]: 'DeepSeek 返回的数据格式异常。',
  [ERROR_CODES.INVALID_REQUEST]: '请求参数无效。',
  [ERROR_CODES.SERVER_ERROR]: 'DeepSeek 服务暂时异常，请稍后重试。',
  [ERROR_CODES.SERVICE_OVERLOADED]: 'DeepSeek 服务当前繁忙，请稍后重试。',
  [ERROR_CODES.OUTPUT_TRUNCATED]: '翻译输出被截断。',
  [ERROR_CODES.CONTENT_FILTERED]: '内容被安全过滤，未返回译文。',
  [ERROR_CODES.UNEXPECTED_FINISH_REASON]: '翻译服务返回了异常的结束状态。',
  [ERROR_CODES.PAGE_UNSUPPORTED]: '当前页面不支持翻译（浏览器内置页面等无法注入脚本）。',
  [ERROR_CODES.PAGE_HIGH_RISK]: '检测到疑似高风险页面，翻译已暂停。',
  [ERROR_CODES.USER_CANCELLED]: '操作已被取消。',
  [ERROR_CODES.TAB_CLOSED]: '目标标签页已关闭，无法继续。',
  [ERROR_CODES.NOT_IMPLEMENTED]: '该功能尚未实现。',
  [ERROR_CODES.UNKNOWN]: '发生未知错误。',
});

export class TranslationError extends Error {
  constructor(code, options = {}) {
    super(ERROR_MESSAGES_ZH[code] ?? code);
    this.name = 'TranslationError';
    this.code = code;
    // 技术细节（如“HTTP 429”）。禁止放入 API Key / Authorization / 请求体 / 原文。
    this.detail = options.detail ?? null;
    this.retryable = Boolean(options.retryable);
    // 服务端建议的重试等待（毫秒，来自 Retry-After），仅内部重试策略使用
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  /** 跨消息传递用的结构化序列化（不含 retryAfterMs 等内部字段）。 */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      retryable: this.retryable,
    };
  }
}

/** 任意异常 → 结构化错误对象（跨线程 / 消息边界的统一入口）。 */
export function toStructuredError(err) {
  if (err instanceof TranslationError) return err.toJSON();
  return {
    code: ERROR_CODES.UNKNOWN,
    message: ERROR_MESSAGES_ZH[ERROR_CODES.UNKNOWN],
    detail: String(err?.message ?? err),
    retryable: false,
  };
}
