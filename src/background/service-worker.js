/**
 * background/service-worker.js —— Manifest V3 Service Worker（Phase 3 中枢）。
 *
 * Phase 3：真实 DeepSeek API 翻译（批量 + 有限并发 + Abort + 结构化返回 + 重试）。
 * 完整链路：
 *   Content TRANSLATE_REQUEST（纯文本块）
 *     → 块级缓存检查（SessionCache 命中即完成）
 *     → TranslationBatcher（数量/字符双上限分批）
 *     → TranslationScheduler（同时 ≤ maxConcurrency 个 API batch）
 *     → DeepSeekProvider.translateBatch（fetch + 严格校验 + 按 block.id 匹配）
 *     → 缺失块有限重试 / 临时错误指数退避重试
 *     → pageSessionId 生命周期闸门 → 结果回传 Content → DOM Renderer
 *
 * 保留 Phase 2 全部已验收行为：DOM 安全策略、显示模式、Restore、动态内容、
 * 高风险确认、停止、会话缓存、最小权限、pageSessionId 生命周期。
 *
 * API Key 边界（Phase 3 最重要规则之一）：
 *   Options → chrome.storage.local → Service Worker（仅内存读取）→ DeepSeekProvider → API
 *   Content Script 永远拿不到 Key；Key 不进消息/快照/日志/Console/DOM/Git。
 *
 * 隐私：发送给 DeepSeek 的只有翻译规则 + 当前 batch 的纯文本块（id/text）；
 * 绝不发送 URL/标题/HTML/Cookie/表单/账号/设备信息。
 */
import { MESSAGE_TYPES, LIMITS, isKnownMessage } from '../shared/messages.js';
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  mergeSettings,
  PROVIDER_IDS,
  API_BATCH_LIMITS,
  TRANSLATION_PROMPT_VERSION,
} from '../shared/constants.js';
import { TranslationError, ERROR_CODES, toStructuredError } from '../shared/errors.js';
import { PageSafetyGuard, canInjectIntoUrl, RISK_LEVELS } from '../page/page-safety-guard.js';
import { AIWT_STYLES } from '../page/aiwt-styles.js';
import { TranslationScheduler } from '../translation/translation-scheduler.js';
import { ProviderRegistry } from '../translation/translation-provider.js';
import { DeepSeekProvider } from '../translation/deepseek-provider.js';
import { MockTranslationProvider } from '../translation/mock-provider.js';
import { buildBatches, sortBlockIdsByPriority } from '../translation/translation-batcher.js';
import { translateBatchWithSplitRetry } from '../translation/batch-translator.js';
import { sanitizeTranslationInput } from '../translation/translation-text-sanitizer.js';
import { SessionCache } from '../cache/session-cache.js';
import {
  createPageState,
  resetPageState,
  adoptPageSession,
  isCurrentPageSession,
  pageStateToStorable,
  hydratePageStateFromStored,
} from './page-session-state.js';
import { createApiKeyCache } from './api-key-cache.js';

// 注入顺序固定：消息常量 → 提取器 → 块登记表 → 渲染器 → 主控制器。
const CONTENT_FILES = [
  'src/shared/messages.core.js',
  'src/content/text-extractor.js',
  'src/content/text-block-manager.js',
  'src/content/dom-renderer.js',
  'src/content/content-bootstrap.js',
];

const READY_TIMEOUT_MS = 4000;

// Provider 注册表：正常路径 = deepseek；mock 仅 dev 开关 / 自动测试使用
const providerRegistry = new ProviderRegistry()
  .register(MockTranslationProvider)
  .register(DeepSeekProvider);

// 会话级缓存：仅内存、仅本次扩展会话；key 含 provider/model/promptVersion（Mock 与 DeepSeek 绝不互串）
const sessionCache = new SessionCache();

const VALID_MODES = new Set(['bilingual', 'targetOnly', 'original']);
const BLOCK_ID_RE = /^aiwt-block-\d{6}$/;

// ---- 标签页会话（页面翻译状态绑定 tabId + pageSessionId，绝不保存页面文字）----
const tabSessions = new Map();

// ---- API Key 内存缓存（SW 进程内单值）。绝不进入消息 / 快照 / 日志 / DOM ----
// 生命周期保证（见 ./api-key-cache.js）：
//  - 每次新翻译任务启动都直读 storage 最新 Key（场景 A/B 根本保证）；
//  - chrome.storage.onChanged 立即使内存副本失效；
//  - 会话中新建 batch 时缓存失效则自动重读。
const apiKeyCache = createApiKeyCache(readApiKey);

function sessionFor(tabId) {
  if (!tabSessions.has(tabId)) {
    tabSessions.set(tabId, createPageState());
  }
  return tabSessions.get(tabId);
}

// ---- Page Translation State 持久化（chrome.storage.session）----
// MV3 Service Worker 会被浏览器空闲回收：tabSessions 只存于 SW 内存，
// SW 重启后状态丢失会导致“仅切换显示模式却变成 未开始 0/0”的 Bug。
// 因此把状态摘要持久化到 storage.session（随浏览器会话存活、浏览器关闭即清空），
// 冷启动时 hydrate + 握手二次校验：同 pageSessionId → 状态完整保留（模式切换
// 绝不清状态）；不同 pageSessionId（真正 reload）→ stale reset。
// 注意：只持久化摘要（状态/计数/usage），绝不含页面文字与 API Key。

const hasSessionStorage = Boolean(
  typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session
);

function pageStateKey(tabId) {
  return STORAGE_KEYS.PAGE_STATE_PREFIX + tabId;
}

function persistPageState(tabId) {
  if (!hasSessionStorage) return;
  const s = tabSessions.get(tabId);
  if (!s) return;
  chrome.storage.session
    .set({ [pageStateKey(tabId)]: pageStateToStorable(s) })
    .catch(() => {});
}

async function hydratePageState(tabId, s) {
  if (!hasSessionStorage) return;
  try {
    const got = await chrome.storage.session.get(pageStateKey(tabId));
    hydratePageStateFromStored(s, got[pageStateKey(tabId)]);
  } catch {
    /* storage.session 不可用等异常：退化为不恢复（保持旧行为） */
  }
}

function broadcastState(tabId, force = false) {
  const s = tabSessions.get(tabId);
  const now = Date.now();
  if (!force && s && now - s.lastBroadcastAt < LIMITS.PROGRESS_BROADCAST_MS) return;
  if (s) s.lastBroadcastAt = now;
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.STATE_UPDATED }).catch(() => {});
  // 状态摘要同步持久化：SW 被空闲回收后，下次唤醒仍能恢复（模式切换绝不丢状态）
  persistPageState(tabId);
}

function sendToTab(tabId, type, payload) {
  chrome.tabs.sendMessage(tabId, { type, payload }).catch(() => {});
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new TranslationError(ERROR_CODES.TAB_CLOSED);
  return tab;
}

/** 探测 Content Script 是否已在页面中；返回页面快照（未注入时为 null）。 */
async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.CONTENT_PING });
    return response && response.ok ? response.payload : null;
  } catch {
    return null;
  }
}

/**
 * 与当前 Document / Content Script 做会话握手（stale 状态失效核心）。
 * 纯显示模式切换（SET_DISPLAY_MODE）绝不经过本函数，也绝不触发 reset。
 */
async function handshakeWithDocument(tabId, s) {
  const snapshot = await pingContentScript(tabId);
  if (snapshot) {
    const reset = adoptPageSession(s, snapshot.pageSessionId);
    if (reset) persistPageState(tabId); // 真正的 Document 变化 → 失效并落盘
  } else {
    resetPageState(s);
    s.pageSessionId = null;
    persistPageState(tabId);
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return mergeSettings(stored[STORAGE_KEYS.SETTINGS]);
}

/** 读取 API Key（真实值只存在于 SW 内存与 Provider 请求头，绝不外发）。 */
async function readApiKey() {
  const got = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  const key = got[STORAGE_KEYS.API_KEY];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** 只返回「是否已配置」的布尔值，绝不返回 Key 本身。 */
async function isApiKeyConfigured() {
  return (await readApiKey()) !== null;
}

/** 创建翻译 Provider。正常路径 = DeepSeek；dev.forceMockProvider 仅供内部测试。 */
function createTranslationProvider(settings, apiKey) {
  if (settings.dev?.forceMockProvider === true) {
    return providerRegistry.create(PROVIDER_IDS.MOCK, {
      failRatio: settings.mock?.failRatio ?? 0,
      minDelayMs: 5,
      maxDelayMs: 15,
    });
  }
  return providerRegistry.create(PROVIDER_IDS.DEEPSEEK, {
    apiKey,
    endpoint: settings.deepseek.apiEndpoint,
    model: settings.deepseek.model,
    timeoutMs: settings.deepseek.timeoutMs,
  });
}

function cacheKeyFor(model, text) {
  return sessionCache.buildKey({
    provider: PROVIDER_IDS.DEEPSEEK,
    model,
    sourceText: text,
    sourceLang: 'en',
    targetLang: 'zh-CN',
    promptVersion: TRANSLATION_PROMPT_VERSION,
  });
}

/**
 * 清洗扫描诊断（仅开发开关开启时 Content 才会上报）：
 * { found: number, skips: { REASON: count } }，做键数与数值上限防呆。
 * 只含计数、不含任何正文/Key；仅本地使用，绝不上传。
 */
function sanitizeScanDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const skips = raw.skips;
  if (!skips || typeof skips !== 'object' || Array.isArray(skips)) return null;
  const out = {};
  for (const k of Object.keys(skips).slice(0, 20)) {
    const v = skips[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[String(k).slice(0, 40)] = Math.min(Math.floor(v), 1000000);
    }
  }
  const found =
    typeof raw.found === 'number' && Number.isFinite(raw.found) ? Math.min(Math.floor(raw.found), 1000000) : 0;
  return { found, skips: out };
}

// ---- 注入与风险闸门 ----

async function handleStartTranslation() {
  const tab = await getActiveTab();
  const s = sessionFor(tab.id);
  // SW 冷启动恢复：先 hydrate 持久化摘要，再由下方握手二次校验 pageSessionId
  await hydratePageState(tab.id, s);

  // 1) 页面可用性
  if (!canInjectIntoUrl(tab.url ?? '')) {
    resetPageState(s);
    s.pageSessionId = null;
    s.status = 'unsupported';
    s.note = '当前页面不支持翻译。';
    broadcastState(tab.id, true);
    return { ok: false, error: new TranslationError(ERROR_CODES.PAGE_UNSUPPORTED).toJSON() };
  }

  // 2) Phase 3：API Key 检查（未配置 → 不发任何请求，Popup 提示 + 打开设置）
  const settings = await loadSettings();
  const devMock = settings.dev?.forceMockProvider === true;
  if (!devMock) {
    // 每次新翻译任务启动都直读 storage 最新 Key：换 Key → 用新 Key；清除 → API_KEY_MISSING
    const key = await readApiKey();
    if (!key) {
      resetPageState(s);
      s.pageSessionId = null;
      s.status = 'api_key_missing';
      s.note = '尚未配置 DeepSeek API Key。请先打开“设置”填写 API Key。';
      broadcastState(tab.id, true);
      return { ok: false, error: new TranslationError(ERROR_CODES.API_KEY_MISSING).toJSON() };
    }
    apiKeyCache.set(key);
  } else {
    apiKeyCache.set(null); // dev mock 模式不使用 Key
  }

  s.tab = { url: tab.url, title: tab.title };
  s.status = 'checking';
  s.note = '正在检查页面并注入脚本…';
  broadcastState(tab.id, true);

  try {
    const snapshot = await pingContentScript(tab.id);
    if (!snapshot) {
      resetPageState(s);
      s.pageSessionId = null;
      s.status = 'checking';
      s.note = '正在检查页面并注入脚本…';
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css: AIWT_STYLES });
      clearTimeout(s.readyTimer);
      s.readyTimer = setTimeout(() => {
        if (s.status === 'checking') {
          s.status = 'error';
          s.note = '内容脚本就绪超时，请刷新页面后重试。';
          broadcastState(tab.id, true);
        }
      }, READY_TIMEOUT_MS);
    } else {
      adoptPageSession(s, snapshot.pageSessionId);
      processContentReady(tab.id, snapshot);
    }
  } catch (err) {
    resetPageState(s);
    s.pageSessionId = null;
    s.status = 'unsupported';
    s.note = '当前页面不支持翻译（注入失败）。';
    broadcastState(tab.id, true);
    return {
      ok: false,
      error: new TranslationError(ERROR_CODES.PAGE_UNSUPPORTED, {
        detail: String(err?.message ?? err),
      }).toJSON(),
    };
  }
  return { ok: true, data: { status: s.status } };
}

function handleContentReady(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) {
    return {
      ok: false,
      error: new TranslationError(ERROR_CODES.UNKNOWN, { detail: '缺少发送方标签页信息。' }).toJSON(),
    };
  }
  processContentReady(tabId, message.payload ?? {});
  return { ok: true, data: { status: sessionFor(tabId).status } };
}

/** 风险闸门：本地判定 → 高风险则等待用户确认，否则直接开始扫描。 */
function processContentReady(tabId, snapshot) {
  const s = sessionFor(tabId);
  clearTimeout(s.readyTimer);
  adoptPageSession(s, snapshot.pageSessionId);
  s.page = {
    readyState: snapshot.readyState ?? 'unknown',
    isTopFrame: Boolean(snapshot.isTopFrame),
    hasPasswordField: Boolean(snapshot.hasPasswordField),
    hasSensitiveForm: Boolean(snapshot.hasSensitiveForm),
  };

  if (s.status !== 'idle' && s.status !== 'checking') return;

  const guard = new PageSafetyGuard();
  const risk = guard.assess({
    url: s.tab?.url ?? '',
    title: s.tab?.title ?? '',
    hasPasswordField: s.page.hasPasswordField,
    hasSensitiveForm: s.page.hasSensitiveForm,
  });
  s.risk = risk.level;
  s.riskReasons = risk.reasons;

  if (risk.level === RISK_LEVELS.HIGH_RISK && !s.confirmed) {
    s.status = 'awaiting_confirmation';
    s.note = '当前页面可能包含敏感信息，为降低安全和风控风险，默认暂停翻译。';
    broadcastState(tabId, true);
    return;
  }
  beginScan(tabId);
}

async function beginScan(tabId) {
  const s = sessionFor(tabId);
  s.confirmed = true;
  s.active = true;
  s.status = 'scanning';
  s.note = '正在扫描正文…';
  // 注意：不清空 stats —— 同一页面会话内“重新翻译”只补未完成/失败块；
  // 新 Document 的 stats 已由 adoptPageSession → resetPageState 归零。
  const settings = await loadSettings();
  s.scheduler = new TranslationScheduler({
    maxConcurrency: settings.deepseek.maxConcurrency, // 同时进行的 API batch 数
  });
  sendToTab(tabId, MESSAGE_TYPES.BEGIN_SCAN, {
    mode: settings.displayMode,
    // 扫描诊断（跳过原因统计）仅开发开关开启时下发，生产默认关闭
    diagnostics: settings.dev?.scanDiagnostics === true,
  });
  broadcastState(tabId, true);
}

async function handleConfirmHighRisk() {
  const tab = await getActiveTab();
  const s = sessionFor(tab.id);
  if (s.status !== 'awaiting_confirmation') {
    return { ok: true, data: { status: s.status } };
  }
  await beginScan(tab.id);
  return { ok: true, data: { status: s.status } };
}

async function handleCancelHighRisk() {
  const tab = await getActiveTab();
  const s = sessionFor(tab.id);
  if (s.status === 'awaiting_confirmation') {
    s.status = 'idle';
    s.note = '已取消翻译。';
    s.confirmed = false;
    s.risk = null;
    s.riskReasons = [];
    broadcastState(tab.id, true);
  }
  return { ok: true, data: { status: s.status } };
}

// ---- 翻译请求 → 块登记 → 缓存 → 批量队列 ----

async function handleTranslateRequest(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) {
    return {
      ok: false,
      error: new TranslationError(ERROR_CODES.UNKNOWN, { detail: '缺少发送方标签页信息。' }).toJSON(),
    };
  }
  const s = sessionFor(tabId);
  // SW 冷启动恢复后（completed/partial 且调度器已随旧进程消失）：
  // 页面仍活跃，Observer 送来新内容 → 重建调度器继续增量翻译（不丢旧状态、不重复翻译旧块）
  if (!s.scheduler && (s.status === 'completed' || s.status === 'partial') && s.pageSessionId) {
    const resumeSettings = await loadSettings();
    s.scheduler = new TranslationScheduler({ maxConcurrency: resumeSettings.deepseek.maxConcurrency });
    s.active = true;
  }
  if (!s.active || !s.scheduler) {
    return {
      ok: false,
      error: new TranslationError(ERROR_CODES.USER_CANCELLED, { detail: '翻译会话未激活。' }).toJSON(),
    };
  }
  const blocks = message.payload?.blocks;
  if (!Array.isArray(blocks) || blocks.length > LIMITS.MAX_BLOCKS_PER_BATCH) {
    return {
      ok: false,
      error: new TranslationError(ERROR_CODES.UNKNOWN, { detail: '非法文本块批次。' }).toJSON(),
    };
  }

  const settings = await loadSettings();
  if (s.status === 'scanning' || s.status === 'completed' || s.status === 'partial') {
    s.status = 'translating';
    s.note = '正在翻译…';
  }

  if (blocks.length === 0) {
    // 空批次 = 当前没有可翻译文本
    if (s.stats.total === 0) {
      s.status = 'completed';
      s.note = '扫描完成：页面没有可翻译的英文文本。';
      broadcastState(tabId, true);
    } else {
      maybeCompleted(tabId, s);
    }
    return { ok: true, data: { status: s.status } };
  }

  // 扫描诊断（仅开发开关开启时 Content 上报）：本地跳过原因统计，清洗后保存
  s.lastScanDiagnostics = sanitizeScanDiagnostics(message.payload?.diagnostics);

  for (const b of blocks) {
    const id = typeof b?.id === 'string' && BLOCK_ID_RE.test(b.id) ? b.id : null;
    // Phase 4：文本清洗只作用于“发送给翻译 API 的副本”（originalText 在页面侧保持原样）
    const text = typeof b?.text === 'string' ? sanitizeTranslationInput(b.text) : '';
    const priority = ['high', 'medium', 'low'].includes(b?.priority) ? b.priority : 'low';
    if (!id || !text || text.length > LIMITS.MAX_TEXT_LENGTH) continue;
    enqueueBlock(tabId, s, id, text, priority, settings);
  }
  flushBatchQueue(tabId, s, settings);
  broadcastState(tabId);
  return { ok: true, data: { status: s.status } };
}

/**
 * 单块登记（Phase 4 视口优先级）：
 *  - completed / running：绝不重新请求、绝不 abort 在途；
 *  - queued：滚动后仅更新优先级（pending 重排由 flushBatchQueue 排序）；
 *  - 缓存命中 → 立即完成并计入 cacheHits；未命中 → 进入优先级队列。
 */
function enqueueBlock(tabId, s, blockId, text, priority, settings) {
  if (s.stats.total >= LIMITS.MAX_BLOCKS_PER_TAB) return;
  const existing = s.blocks.get(blockId);
  if (existing && existing.status === 'completed') return; // 已完成：绝不重新请求
  if (existing && existing.status === 'running') return;    // 在途：不 abort、不重排
  if (existing && existing.status === 'queued') {
    existing.priority = priority; // 滚动后 pending 优先级更新（只影响后续排序）
    return;
  }

  const cacheKey = cacheKeyFor(settings.deepseek.model, text);
  const hit = sessionCache.get(cacheKey);
  if (hit) {
    if (!existing) s.stats.total += 1;
    s.blocks.set(blockId, { status: 'completed', text, retries: 0, priority });
    s.stats.completed += 1;
    s.cacheHits += 1;
    sendToTab(tabId, MESSAGE_TYPES.TRANSLATE_RESULT, { id: blockId, ok: true, translation: hit.translation });
    maybeCompleted(tabId, s);
    broadcastState(tabId);
    return;
  }

  if (!existing) s.stats.total += 1;
  s.blocks.set(blockId, { status: 'queued', text, retries: existing?.retries ?? 0, priority });
  s.batchQueue.push(blockId);
}

/** 把队列中的块按「数量 + 字符」双上限切成 API batch 并交给 Scheduler。 */
async function flushBatchQueue(tabId, s, settings) {
  if (s.draining || !s.active || s.batchQueue.length === 0) return;
  s.draining = true;
  try {
    const ids = s.batchQueue.splice(0, s.batchQueue.length);
    // Phase 4 视口优先级：HIGH → MEDIUM → LOW（稳定排序，同优先级保持 DOM 阅读顺序；
    // 只重排 pending——在途 batch 绝不被 abort/重排）
    const sortedIds = sortBlockIdsByPriority(ids, (id) => s.blocks.get(id)?.priority ?? 'low');
    const blocks = [];
    for (const id of sortedIds) {
      const blk = s.blocks.get(id);
      if (!blk || blk.status !== 'queued') continue;
      blocks.push({ id, text: blk.text });
    }
    if (blocks.length === 0) return;
    // 缓存失效（Options 改/清 Key）时自动重读 storage；绝不使用旧的内存 Key
    const apiKey = await apiKeyCache.get();
    const provider = createTranslationProvider(settings, apiKey);
    const batches = buildBatches(blocks, API_BATCH_LIMITS);
    for (const batch of batches) {
      for (const b of batch) {
        const blk = s.blocks.get(b.id);
        if (blk) blk.status = 'running';
      }
      s.batchCounter += 1;
      scheduleBatchTask(tabId, s, provider, settings, `awt-batch-${String(s.batchCounter).padStart(6, '0')}`, batch);
    }
  } catch (err) {
    // flush 阶段异常（如 storage 读取失败）：排队块标记失败并上报，绝不静默丢块
    const structured = toStructuredError(err);
    s.lastError = structured;
    for (const [id, blk] of s.blocks) {
      if (blk.status === 'queued') {
        blk.status = 'failed';
        s.stats.failed += 1;
        sendToTab(tabId, MESSAGE_TYPES.TRANSLATE_RESULT, { id, ok: false, error: structured });
      }
    }
    maybeCompleted(tabId, s);
    broadcastState(tabId);
  } finally {
    s.draining = false;
  }
}

function scheduleBatchTask(tabId, s, provider, settings, taskId, batch) {
  const batchPageSessionId = s.pageSessionId; // 发起时绑定 tabId + pageSessionId
  const model = settings.deepseek.model;
  s.scheduler.schedule({
    taskId,
    execute: async (signal) => {
      // 发送前二次缓存检查：并发窗口内已被其它 batch 完成的重复文本直接复用
      const needApi = [];
      const fromCache = [];
      for (const b of batch) {
        const key = cacheKeyFor(model, b.text);
        const hit = sessionCache.get(key);
        if (hit) fromCache.push({ id: b.id, text: hit.translation });
        else needApi.push(b);
      }
      let apiResult = { results: [], missingIds: [], unknownIds: [], usage: null };
      if (needApi.length > 0) {
        // 有限重试 + OUTPUT_TRUNCATED 拆半兜底（截断 JSON 绝不投递）
        apiResult = await translateBatchWithSplitRetry(provider, needApi, {
          maxRetries: settings.deepseek.maxRetries,
          signal,
        });
        // 只把真实 API 结果写回会话缓存
        const textById = new Map(batch.map((b) => [b.id, b.text]));
        for (const r of apiResult.results) {
          const src = textById.get(r.id);
          if (src != null) sessionCache.set(cacheKeyFor(model, src), r.text);
        }
      }
      return {
        results: [...fromCache, ...apiResult.results],
        missingIds: apiResult.missingIds ?? [],
        usage: apiResult.usage,
        fromCacheCount: fromCache.length,       // Phase 4 统计：缓存命中块数
        apiCount: apiResult.results.length,     // Phase 4 统计：真实 API 翻译块数
      };
    },
    onResult: (result) => deliverBatchResult(tabId, s, batch, result, batchPageSessionId, settings),
    onError: (err) => handleBatchError(tabId, s, batch, err, batchPageSessionId),
  });
}

/** 批量成功：按 block.id 精确落账；缺失块只重试缺失项（有限次数）。 */
function deliverBatchResult(tabId, s, batch, result, batchPageSessionId, settings) {
  // 生命周期闸门：只把结果写回发起请求时的那个 Document
  if (!isCurrentPageSession(s, batchPageSessionId)) return;

  const returned = new Map((result.results ?? []).map((r) => [r.id, r.text]));
  for (const b of batch) {
    const blk = s.blocks.get(b.id);
    if (!blk || blk.status !== 'running') continue;
    const translation = returned.get(b.id);
    if (typeof translation === 'string' && translation.length > 0) {
      blk.status = 'completed';
      s.stats.completed += 1;
      sendToTab(tabId, MESSAGE_TYPES.TRANSLATE_RESULT, { id: b.id, ok: true, translation });
    } else if (blk.retries < settings.deepseek.maxRetries) {
      // 缺失块：有限重试，只重发缺失项，已成功块绝不重复请求
      blk.retries += 1;
      blk.status = 'queued';
      s.batchQueue.push(b.id);
    } else {
      blk.status = 'failed';
      s.stats.failed += 1;
      s.lastError = {
        code: ERROR_CODES.INVALID_RESPONSE,
        message: 'DeepSeek 未返回部分文本块的译文。',
        detail: null,
        retryable: false,
      };
      sendToTab(tabId, MESSAGE_TYPES.TRANSLATE_RESULT, { id: b.id, ok: false, error: s.lastError });
    }
  }
  addUsage(s, result.usage);
  // Phase 4 统计（仅成功路径；失败结果绝不写缓存、绝不计数）
  s.cacheHits += result.fromCacheCount ?? 0;
  s.apiTranslatedBlocks += result.apiCount ?? 0;
  if (s.batchQueue.length > 0) flushBatchQueue(tabId, s, settings);
  maybeCompleted(tabId, s);
  broadcastState(tabId);
}

/** 批量失败（重试耗尽或不可重试错误）：整批块标记失败，保留已成功译文。 */
function handleBatchError(tabId, s, batch, err, batchPageSessionId) {
  if (!isCurrentPageSession(s, batchPageSessionId)) return;
  const structured = toStructuredError(err);
  s.lastError = structured;
  for (const b of batch) {
    const blk = s.blocks.get(b.id);
    if (!blk || blk.status !== 'running') continue;
    blk.status = 'failed';
    s.stats.failed += 1;
    sendToTab(tabId, MESSAGE_TYPES.TRANSLATE_RESULT, { id: b.id, ok: false, error: structured });
  }
  maybeCompleted(tabId, s);
  broadcastState(tabId);
}

function addUsage(s, usage) {
  if (!usage) return;
  s.usage = {
    prompt_tokens: (s.usage?.prompt_tokens ?? 0) + (usage.prompt_tokens ?? 0),
    completion_tokens: (s.usage?.completion_tokens ?? 0) + (usage.completion_tokens ?? 0),
    total_tokens: (s.usage?.total_tokens ?? 0) + (usage.total_tokens ?? 0),
  };
}

function maybeCompleted(tabId, s) {
  if (!s.active || s.status !== 'translating') return;
  if (s.batchQueue.length > 0) return;
  const st = s.scheduler ? s.scheduler.stats() : null;
  if (st && (st.pending > 0 || st.running > 0)) return;
  if (s.stats.total === 0) return;

  if (s.stats.failed > 0) {
    if (s.stats.completed === 0) {
      s.status = 'api_error';
      s.note = s.lastError?.message ?? 'DeepSeek API 调用失败。';
    } else {
      s.status = 'partial'; // 部分成功：已成功的译文全部保留
      s.note = `已完成 ${s.stats.completed} / ${s.stats.total}，${s.stats.failed} 个翻译失败。`;
    }
  } else {
    s.status = 'completed';
    s.note = '翻译完成。';
  }
  broadcastState(tabId, true);
}

// ---- 停止 / 恢复 / 显示模式 ----

async function handleStopTranslation() {
  const tab = await getActiveTab();
  const s = sessionFor(tab.id);
  s.active = false; // 拒绝新请求；MutationObserver 侧由 CONTENT_STOP 断开
  s.scheduler?.stop(); // 排队任务取消 + 在途 API batch 全部 abort
  for (const blk of s.blocks.values()) {
    if (blk.status === 'queued' || blk.status === 'running') {
      blk.status = 'cancelled';
      s.stats.cancelled += 1;
    }
  }
  s.batchQueue = [];
  s.status = 'stopped';
  s.note = '已停止。进行中的请求已取消；已完成译文保留。';
  sendToTab(tab.id, MESSAGE_TYPES.CONTENT_STOP, {});
  broadcastState(tab.id, true);
  return { ok: true, data: { status: s.status } };
}

async function handleRestoreOriginal() {
  const tab = await getActiveTab();
  const s = sessionFor(tab.id);
  resetPageState(s); // abort 所有在途请求 + 清批量队列/块状态/usage/error（SessionCache 保留）
  s.status = 'restored';
  s.note = '已恢复原文（已清除本页所有译文与状态）。';
  sendToTab(tab.id, MESSAGE_TYPES.CONTENT_RESTORE, {});
  broadcastState(tab.id, true);
  return { ok: true, data: { status: s.status } };
}

async function handleSetDisplayMode(message) {
  const tab = await getActiveTab();
  const mode = message.payload?.mode;
  if (!VALID_MODES.has(mode)) {
    return { ok: false, error: new TranslationError(ERROR_CODES.UNKNOWN, { detail: '非法显示模式。' }).toJSON() };
  }
  // 纯模式命令：只持久化 displayMode 并转发给当前 Content Script。
  // 绝不触碰 Page Translation State（不 reset、不 hydrate、不重建 session、不重新注入），
  // 绝不产生新的翻译任务 / API 请求。
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = stored[STORAGE_KEYS.SETTINGS] ?? {};
  settings.displayMode = mode;
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  let applied = false;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: MESSAGE_TYPES.APPLY_MODE,
      payload: { mode },
    });
    applied = Boolean(response && response.ok);
  } catch {
    applied = false; // Content Script 不存在：只保存偏好，绝不因此创建新翻译 Session
  }
  return { ok: true, data: { mode, applied } };
}

function handleContentError(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) {
    return { ok: false, error: new TranslationError(ERROR_CODES.UNKNOWN).toJSON() };
  }
  const s = sessionFor(tabId);
  s.status = 'error';
  s.note = `发生错误：${String(message.payload?.message ?? '未知')}`;
  broadcastState(tabId, true);
  return { ok: true };
}

// ---- 状态快照与消息入口 ----

async function buildStateSnapshot() {
  let tab = null;
  let tabError = null;
  try {
    tab = await getActiveTab();
  } catch (err) {
    tabError = toStructuredError(err);
  }

  const settings = await loadSettings();
  const s = tab?.id != null ? sessionFor(tab.id) : null;

  // Popup 打开即握手：reload/导航后旧状态立即失效；同一 Document（含纯模式切换）绝不失效
  if (s && tab) {
    await hydratePageState(tab.id, s); // SW 冷启动：先恢复持久化摘要
    await handshakeWithDocument(tab.id, s);
  }

  const stats = s?.stats ?? { total: 0, completed: 0, failed: 0, cancelled: 0 };
  const done = stats.completed;
  const total = stats.total;

  return {
    ok: true,
    data: {
      phase: 3,
      tab: tab
        ? {
            id: tab.id,
            url: tab.url ?? null,
            title: tab.title ?? null,
            injectable: canInjectIntoUrl(tab.url ?? ''),
          }
        : null,
      tabError,
      engine: { id: PROVIDER_IDS.DEEPSEEK, displayName: 'DeepSeek', model: settings.deepseek.model },
      settings: {
        provider: settings.provider,
        direction: settings.direction,
        displayMode: settings.displayMode,
        model: settings.deepseek.model,
        apiKeyConfigured: await isApiKeyConfigured(),
        longTermCacheEnabled: Boolean(settings.longTermCacheEnabled),
      },
      session: s
        ? {
            status: s.status,
            note: s.note,
            risk: s.risk,
            riskReasons: s.riskReasons,
            confirmed: s.confirmed,
            stats,
            usage: s.usage ?? null,
            cacheHits: s.cacheHits ?? 0,
            apiTranslatedBlocks: s.apiTranslatedBlocks ?? 0,
            lastScanDiagnostics: s.lastScanDiagnostics ?? null,
            progress: {
              done,
              total,
              percent: total > 0 ? Math.round((done / total) * 100) : 0,
            },
          }
        : null,
    },
  };
}

async function dispatch(message, sender) {
  if (!isKnownMessage(message)) {
    return {
      ok: false,
      error: new TranslationError(ERROR_CODES.UNKNOWN, { detail: '未知消息类型。' }).toJSON(),
    };
  }
  switch (message.type) {
    case MESSAGE_TYPES.GET_STATE:
      return buildStateSnapshot();
    case MESSAGE_TYPES.START_TRANSLATION:
      return handleStartTranslation();
    case MESSAGE_TYPES.STOP_TRANSLATION:
      return handleStopTranslation();
    case MESSAGE_TYPES.RESTORE_ORIGINAL:
      return handleRestoreOriginal();
    case MESSAGE_TYPES.SET_DISPLAY_MODE:
      return handleSetDisplayMode(message);
    case MESSAGE_TYPES.CONFIRM_HIGH_RISK:
      return handleConfirmHighRisk();
    case MESSAGE_TYPES.CANCEL_HIGH_RISK:
      return handleCancelHighRisk();
    case MESSAGE_TYPES.CONTENT_READY:
      return handleContentReady(message, sender);
    case MESSAGE_TYPES.TRANSLATE_REQUEST:
      return handleTranslateRequest(message, sender);
    case MESSAGE_TYPES.CONTENT_ERROR:
      return handleContentError(message, sender);
    default:
      return {
        ok: false,
        error: new TranslationError(ERROR_CODES.UNKNOWN, {
          detail: `未处理的消息类型：${message.type}`,
        }).toJSON(),
      };
  }
}

// 统一消息入口：所有响应都是 { ok, data?, error? } 结构化结果
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dispatch(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: toStructuredError(err) }));
  return true;
});

// 标签页关闭：清理会话状态与持久化摘要（防泄漏）
chrome.tabs.onRemoved.addListener((tabId) => {
  const s = tabSessions.get(tabId);
  if (s) {
    clearTimeout(s.readyTimer);
    s.scheduler?.stop();
  }
  tabSessions.delete(tabId);
  if (hasSessionStorage) {
    chrome.storage.session.remove(pageStateKey(tabId)).catch(() => {});
  }
});

// API Key 变化 → 立即使内存副本失效（场景 A：换新 Key；场景 B：清除 Key）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.API_KEY]) {
    apiKeyCache.invalidate();
  }
});

// 首次安装时写入默认设置（不含 API Key）
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!stored[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
});
