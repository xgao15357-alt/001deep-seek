/**
 * popup/popup.js —— Popup 界面逻辑（ES Module，仅静态 import 扩展内文件）。
 *
 * Phase 3：
 *  - 展示 DeepSeek 引擎与模型、方向、显示模式（即时应用）、状态、块级进度、Token 用量；
 *  - 按钮随状态启用/禁用；高风险页面显示「取消 / 仍然翻译」确认面板；
 *  - API Key 未配置时显示提示 + [打开设置]（Key 本身绝不经过 Popup/Content Script）；
 *  - 不直接读取网页内容，不发起任何翻译请求（全部经 Service Worker）。
 */
import { MESSAGE_TYPES, sendRuntimeMessage } from '../src/shared/messages.js';
import { DISPLAY_MODES } from '../src/shared/constants.js';

const $ = (id) => document.getElementById(id);

const els = {
  provider: $('provider'),
  direction: $('direction'),
  status: $('status'),
  progressDone: $('progress-done'),
  progressTotal: $('progress-total'),
  progressFill: $('progress-fill'),
  progressPercent: $('progress-percent'),
  usageRow: $('usage-row'),
  usage: $('usage'),
  cacheHitRow: $('cache-hit-row'),
  cacheHit: $('cache-hit'),
  scanDiagPanel: $('scan-diag-panel'),
  scanDiag: $('scan-diag'),
  message: $('message'),
  actions: $('actions'),
  riskPanel: $('risk-panel'),
  riskReasons: $('risk-reasons'),
  btnTranslate: $('btn-translate'),
  btnStop: $('btn-stop'),
  btnRestore: $('btn-restore'),
  btnSettings: $('btn-settings'),
  btnConfirmRisk: $('btn-confirm-risk'),
  btnCancelRisk: $('btn-cancel-risk'),
  btnOpenOptions: $('btn-open-options'),
};

const STATUS_TEXT_ZH = {
  idle: '未开始',
  checking: '正在检查页面',
  awaiting_confirmation: '等待敏感页面确认',
  scanning: '正在扫描正文',
  translating: '正在翻译',
  stopped: '已停止',
  completed: '已完成',
  partial: '已完成（部分内容翻译失败）',
  restored: '已恢复',
  unsupported: '页面不支持',
  api_key_missing: 'API Key 未配置',
  api_error: 'API 错误',
  error: '发生错误',
};

const DIRECTION_LABELS = {
  'en->zh-CN': 'English → 简体中文',
};

function setMessage(text, kind = 'info') {
  els.message.textContent = text ?? '';
  els.message.dataset.kind = kind;
}

function renderProgress(progress) {
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const percent = progress?.percent ?? 0;
  els.progressDone.textContent = String(done);
  els.progressTotal.textContent = String(total);
  els.progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  els.progressPercent.textContent = `${percent}%`;
}

function renderUsage(usage) {
  if (
    usage &&
    (usage.prompt_tokens > 0 || usage.completion_tokens > 0 || usage.total_tokens > 0)
  ) {
    els.usageRow.hidden = false;
    els.usage.textContent = `输入 ${usage.prompt_tokens} / 输出 ${usage.completion_tokens} tokens`;
  } else {
    els.usageRow.hidden = true;
    els.usage.textContent = '';
  }
}

/** Phase 4：缓存命中统计（保持 UI 简洁，只在有命中时显示一行）。 */
function renderCacheHit(cacheHits) {
  if (typeof cacheHits === 'number' && cacheHits > 0) {
    els.cacheHitRow.hidden = false;
    els.cacheHit.textContent = `${cacheHits} 块`;
  } else {
    els.cacheHitRow.hidden = true;
    els.cacheHit.textContent = '';
  }
}

/** 扫描诊断（仅开发开关开启时存在）：本地跳过原因统计。 */
function renderScanDiagnostics(diag) {
  const skips = diag?.skips;
  const hasSkips = skips && typeof skips === 'object' && Object.keys(skips).length > 0;
  if (!hasSkips) {
    els.scanDiagPanel.hidden = true;
    els.scanDiag.textContent = '';
    return;
  }
  els.scanDiagPanel.hidden = false;
  const parts = Object.entries(skips).map(([reason, count]) => `${reason} ${count}`);
  if (typeof diag.found === 'number') parts.unshift(`本轮发现 ${diag.found}`);
  els.scanDiag.textContent = parts.join(' · ');
}

function renderState(data) {
  const engineName = data.engine?.displayName ?? 'DeepSeek';
  const model = data.engine?.model ?? '';
  els.provider.textContent = model ? `${engineName} · ${model}` : engineName;
  els.direction.textContent =
    DIRECTION_LABELS[data.settings?.direction] ?? data.settings?.direction ?? 'English → 简体中文';

  // 显示模式单选回显（值来自受控枚举）
  const displayMode = data.settings?.displayMode ?? DISPLAY_MODES.BILINGUAL;
  const radio = document.querySelector(`input[name="displayMode"][value="${displayMode}"]`);
  if (radio) radio.checked = true;

  const session = data.session;
  const status = session?.status ?? 'idle';
  const injectable = data.tab ? data.tab.injectable : true;

  // 页面不支持：优先级最高
  if (data.tab && !injectable && (status === 'idle' || status === 'unsupported')) {
    els.status.textContent = '页面不支持';
    setMessage('当前页面不支持翻译。', 'error');
  } else if (data.tabError && !session) {
    els.status.textContent = '不可用';
    setMessage(data.tabError.message ?? '无法获取当前标签页状态', 'error');
  } else {
    els.status.textContent = STATUS_TEXT_ZH[status] ?? status;
    if (session?.note) {
      const isError = status === 'api_error' || status === 'error' || status === 'unsupported';
      setMessage(session.note, isError ? 'error' : 'info');
    }
  }

  renderProgress(session?.progress);
  renderUsage(session?.usage);
  renderCacheHit(session?.cacheHits);
  renderScanDiagnostics(session?.lastScanDiagnostics);

  // 高风险确认面板与按钮状态
  const awaiting = status === 'awaiting_confirmation';
  els.riskPanel.hidden = !awaiting;
  els.actions.hidden = awaiting;
  if (awaiting && session?.riskReasons?.length) {
    els.riskReasons.textContent = `判定依据：${session.riskReasons.join('；')}`;
  } else {
    els.riskReasons.textContent = '';
  }

  // API Key 未配置：提示 + [打开设置]（Popup 不知道也拿不到 Key 本身）
  els.btnOpenOptions.hidden = status !== 'api_key_missing';

  if (!awaiting) {
    const busy = status === 'scanning' || status === 'translating' || status === 'checking';
    const hasWork = Boolean(session && session.stats && session.stats.total > 0);
    els.btnTranslate.disabled = busy || (data.tab ? !injectable : false);
    els.btnStop.disabled = !(status === 'scanning' || status === 'translating');
    els.btnRestore.disabled = !hasWork;
    els.btnSettings.disabled = false;
  }
}

async function refreshState() {
  try {
    const response = await sendRuntimeMessage(MESSAGE_TYPES.GET_STATE);
    if (response?.ok) {
      renderState(response.data);
    } else {
      setMessage(response?.error?.message ?? '获取状态失败', 'error');
    }
  } catch (err) {
    setMessage(`与后台通信失败：${err?.message ?? err}`, 'error');
  }
}

/** 发送动作消息并展示结构化结果（后台统一返回 { ok, data?, error? }）。 */
async function sendAction(type, okMessage, payload = {}) {
  try {
    const response = await sendRuntimeMessage(type, payload);
    if (response?.ok) {
      setMessage(okMessage, 'success');
    } else {
      setMessage(response?.error?.message ?? '操作失败', 'error');
    }
  } catch (err) {
    setMessage(`与后台通信失败：${err?.message ?? err}`, 'error');
  }
  await refreshState();
}

els.btnTranslate.addEventListener('click', () => {
  sendAction(MESSAGE_TYPES.START_TRANSLATION, '已开始翻译。');
});
els.btnStop.addEventListener('click', () => {
  sendAction(MESSAGE_TYPES.STOP_TRANSLATION, '已停止（进行中的请求已取消）。');
});
els.btnRestore.addEventListener('click', () => {
  sendAction(MESSAGE_TYPES.RESTORE_ORIGINAL, '已恢复原文。');
});
els.btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
els.btnOpenOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
els.btnConfirmRisk.addEventListener('click', () => {
  sendAction(MESSAGE_TYPES.CONFIRM_HIGH_RISK, '已确认，开始扫描正文。');
});
els.btnCancelRisk.addEventListener('click', () => {
  sendAction(MESSAGE_TYPES.CANCEL_HIGH_RISK, '已取消翻译。');
});

// 显示模式：经 Service Worker 持久化并应用到当前页面（纯 CSS 可见性，不产生任何 API 请求）
for (const radio of document.querySelectorAll('input[name="displayMode"]')) {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    try {
      const response = await sendRuntimeMessage(MESSAGE_TYPES.SET_DISPLAY_MODE, { mode: radio.value });
      if (response?.ok) {
        if (response.data?.applied === false) {
          // Content Script 不存在（如页面已刷新）：只保存偏好，绝不为此重建翻译会话
          setMessage('显示模式已保存；当前页面未连接（可能已刷新），重新翻译后生效。', 'info');
        } else {
          setMessage('显示模式已应用。', 'success');
        }
      } else {
        setMessage(response?.error?.message ?? '切换显示模式失败', 'error');
      }
    } catch (err) {
      setMessage(`切换显示模式失败：${err?.message ?? err}`, 'error');
    }
    await refreshState();
  });
}

// Service Worker 广播状态变化时刷新（进度、状态迁移、确认面板等）
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE_TYPES.STATE_UPDATED) {
    refreshState();
  }
});

refreshState();
