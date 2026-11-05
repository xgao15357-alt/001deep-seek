/**
 * page/page-safety-guard.js
 * PageSafetyGuard —— 高风险页面本地防护模块（Phase 2 正式接通确认闸门）。
 * 设计原则：
 *  - 判定完全在本地完成，绝不把 URL / 标题 / 页面文字发送到任何服务器；
 *  - 只用「URL、标题、是否存在密码输入框、是否存在明显敏感表单（cc-* 自动填充字段）」
 *    做启发式预判：允许误报（误报走用户确认流程），力求不放过敏感页面；
 *  - 高风险页面默认：暂停翻译 → Popup 提示 → 用户主动点「仍然翻译」才继续；
 *    确认只对当前 tab 会话有效，绝不持久化“以后都允许”；
 *  - 即使确认继续，密码框 / 输入框 / 验证码 / 支付区域等内容在任何阶段都禁止读取。
 */

export const RISK_LEVELS = Object.freeze({
  NORMAL: 'normal',
  SENSITIVE: 'sensitive',
  HIGH_RISK: 'high',
});

// 关键词仅用于本地启发式判断；列表随版本演进，判定逻辑不变。
const HIGH_RISK_HINTS = Object.freeze({
  hostname: ['bank', 'pay', 'payment'],
  pathname: [
    'login', 'signin', 'logon', 'register', 'signup',
    'bank', 'banking', 'payment', 'checkout', 'billing',
    'transfer', 'remittance',
    'securit', 'stock', 'trade', 'broker', 'invest',
    'exam', 'quiz', 'assessment',
    'captcha', 'verify',
    'admin', 'console', 'manage',
  ],
  title: ['登录', '注册', '银行', '支付', '转账', '证券', '交易', '考试', '验证码', '后台管理'],
});

const SENSITIVE_HINTS = Object.freeze({
  pathname: ['account', 'profile', 'wallet', 'password', 'security', 'orders'],
  title: ['账户', '账号', '钱包', '个人信息', '会员中心', '订单'],
});

export class PageSafetyGuard {
  /**
   * 输入：最小可用页面元信息（不含任何页面正文与表单值）；
   * 输出：{ level, reasons[] }。reasons 仅用于本地提示，禁止上传。
   */
  assess({ url = '', title = '', hasPasswordField = false, hasSensitiveForm = false } = {}) {
    const highReasons = [];
    const sensitiveNotes = [];

    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null; // 非法 URL：按“无信息”处理，交给注入可用性检查兜底
    }
    const hostname = parsed?.hostname ?? '';
    const pathname = parsed?.pathname.toLowerCase() ?? '';
    const normalizedTitle = (title ?? '').toLowerCase();

    for (const hint of HIGH_RISK_HINTS.hostname) {
      if (hostname.split('.').some((segment) => segment === hint)) {
        highReasons.push(`主机名包含敏感词："${hint}"`);
        break;
      }
    }
    for (const hint of HIGH_RISK_HINTS.pathname) {
      if (pathname.includes(hint)) {
        highReasons.push(`路径包含敏感词："${hint}"`);
        break;
      }
    }
    for (const hint of HIGH_RISK_HINTS.title) {
      if (normalizedTitle.includes(hint)) {
        highReasons.push(`标题包含敏感词："${hint}"`);
        break;
      }
    }

    for (const hint of SENSITIVE_HINTS.pathname) {
      if (pathname.includes(hint)) {
        sensitiveNotes.push(`路径包含敏感词："${hint}"`);
        break;
      }
    }
    if (sensitiveNotes.length === 0) {
      for (const hint of SENSITIVE_HINTS.title) {
        if (normalizedTitle.includes(hint)) {
          sensitiveNotes.push(`标题包含敏感词："${hint}"`);
          break;
        }
      }
    }
    if (hasPasswordField) {
      // 只记录「存在」这一布尔事实；密码框的值在任何阶段都禁止读取。
      // 出现密码输入框通常意味着登录/账户区域，按高风险处理（Phase 2 走确认流程）。
      highReasons.push('页面存在密码输入框（其内容永不读取）');
    }
    if (hasSensitiveForm) {
      // 只记录「存在」这一布尔事实；cc-*（信用卡号/有效期/安全码）自动填充字段
      // 是支付表单的强信号，按高风险处理，且支付区域在任何阶段都禁止读取。
      highReasons.push('页面存在支付/卡片类表单字段（其内容永不读取）');
    }

    if (highReasons.length > 0) {
      return { level: RISK_LEVELS.HIGH_RISK, reasons: [...highReasons, ...sensitiveNotes] };
    }
    if (sensitiveNotes.length > 0) {
      return { level: RISK_LEVELS.SENSITIVE, reasons: sensitiveNotes };
    }
    return { level: RISK_LEVELS.NORMAL, reasons: [] };
  }
}

/** 浏览器禁止注入脚本的站点（商店页等，即使它们是 https 页面）。 */
const RESTRICTED_HOSTS = Object.freeze([
  'chromewebstore.google.com',
  'chrome.google.com',
  'microsoftedge.microsoft.com',
  'addons.mozilla.org',
]);

/**
 * 注入可用性判断：只允许 http/https 普通网页。
 * file:、chrome:、edge:、about: 等一律不支持；
 * 不可注入页面应优雅提示 PAGE_UNSUPPORTED，绝不反复重试。
 */
export function canInjectIntoUrl(url = '') {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (RESTRICTED_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
    return false;
  }
  return true;
}
