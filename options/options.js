/**
 * options/options.js —— 设置页逻辑（ES Module，仅静态 import 扩展内文件）。
 *
 * Phase 3 安全要点：
 *  - API Key 只写入 / 移除 chrome.storage.local；绝不在页面回显、绝不 console / 日志输出；
 *  - 未配置时输入框真实为空（placeholder「请输入 DeepSeek API Key」）；
 *  - 已配置时只显示「已配置」，输入框保持为空并提示“输入新的 API Key 可覆盖当前配置”；
 *  - API Endpoint 锁定只读（V1 固定官方端点）；
 *  - Thinking 固定关闭（控件 disabled，保存时强制 true）；
 *  - Model 仅允许 deepseek-v4-flash（默认）/ deepseek-v4-pro；
 *  - 保存设置本身不触发任何网络请求。
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS, DEEPSEEK_MODELS } from '../src/shared/constants.js';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('settings-form'),
  provider: $('provider'),
  apiKey: $('api-key'),
  apiKeyStatus: $('api-key-status'),
  apiKeyHint: $('api-key-hint'),
  btnSaveKey: $('btn-save-key'),
  btnClearKey: $('btn-clear-key'),
  model: $('model'),
  endpoint: $('endpoint'),
  timeout: $('timeout'),
  concurrency: $('concurrency'),
  retries: $('retries'),
  disableThinking: $('disable-thinking'),
  cacheToggle: $('cache-toggle'),
  saveStatus: $('save-status'),
};

const KEY_HINT_DEFAULT =
  'Key 只保存在本机扩展存储中，保存后不再回显，也不会打印到 Console 或日志。' +
  '注意：chrome.storage.local 对个人自用方便，但它不是强加密保险箱，请勿在共享设备上保存。';
const KEY_HINT_CONFIGURED =
  '输入新的 API Key 可覆盖当前配置（Key 保存后不再回显、不打印、不进日志）。';

let flashTimer = null;
function flash(text, kind = 'success') {
  els.saveStatus.textContent = text;
  els.saveStatus.dataset.kind = kind;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    els.saveStatus.textContent = '';
  }, 4000);
}

/**
 * 只读取「是否已配置」的布尔事实，绝不读取 / 回显 Key 本身。
 * 输入框始终为空；根据配置状态切换状态文案与提示文案。
 */
async function refreshApiKeyStatus() {
  const got = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  const configured =
    typeof got[STORAGE_KEYS.API_KEY] === 'string' && got[STORAGE_KEYS.API_KEY].length > 0;
  els.apiKey.value = ''; // 无论是否已配置，都不回填
  els.apiKeyStatus.textContent = configured ? '已配置' : '未配置';
  els.apiKeyStatus.dataset.kind = configured ? 'ok' : 'warn';
  els.apiKeyHint.textContent = configured ? KEY_HINT_CONFIGURED : KEY_HINT_DEFAULT;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const s = stored[STORAGE_KEYS.SETTINGS] ?? {};
  const d = s.deepseek ?? {};
  els.model.value = [DEEPSEEK_MODELS.FLASH, DEEPSEEK_MODELS.PRO].includes(d.model)
    ? d.model
    : DEFAULT_SETTINGS.deepseek.model;
  // Endpoint 只读展示（V1 锁定官方端点）
  els.endpoint.value = d.apiEndpoint ?? DEFAULT_SETTINGS.deepseek.apiEndpoint;
  els.timeout.value = String(d.timeoutMs ?? DEFAULT_SETTINGS.deepseek.timeoutMs);
  els.concurrency.value = String(d.maxConcurrency ?? DEFAULT_SETTINGS.deepseek.maxConcurrency);
  els.retries.value = String(d.maxRetries ?? DEFAULT_SETTINGS.deepseek.maxRetries);
  // Thinking：网页翻译固定关闭（控件 disabled，这里仅回显）
  els.disableThinking.checked = true;
  els.cacheToggle.checked = Boolean(s.longTermCacheEnabled);
  await refreshApiKeyStatus();
}

els.btnSaveKey.addEventListener('click', async () => {
  const value = els.apiKey.value.trim();
  if (!value) {
    flash('请输入 API Key。', 'error');
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: value });
  els.apiKey.value = ''; // 保存后立即清空输入框，避免任何回显
  await refreshApiKeyStatus();
  flash('API Key 已保存（仅存储在本机扩展存储中）。');
});

els.btnClearKey.addEventListener('click', async () => {
  await chrome.storage.local.remove(STORAGE_KEYS.API_KEY);
  els.apiKey.value = '';
  await refreshApiKeyStatus();
  flash('API Key 已清除。');
});

function validateInputs() {
  const issues = [];
  const model = els.model.value;
  const timeout = Number(els.timeout.value);
  const concurrency = Number(els.concurrency.value);
  const retries = Number(els.retries.value);

  if (![DEEPSEEK_MODELS.FLASH, DEEPSEEK_MODELS.PRO].includes(model)) issues.push('Model 不合法');
  if (!Number.isInteger(timeout) || timeout < 1000) issues.push('Timeout 必须是 ≥1000 的整数（毫秒）');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) issues.push('并发 batch 数必须是 1–8 的整数');
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) issues.push('重试次数必须是 0–5 的整数');
  return issues;
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const issues = validateInputs();
  if (issues.length > 0) {
    flash(`无法保存：${issues.join('；')}`, 'error');
    return;
  }

  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const current = stored[STORAGE_KEYS.SETTINGS] ?? {};
  const next = {
    ...current, // 保留 provider / direction / displayMode / dev / mock 等已有字段
    longTermCacheEnabled: els.cacheToggle.checked,
    deepseek: {
      ...(current.deepseek ?? {}),
      apiEndpoint: DEFAULT_SETTINGS.deepseek.apiEndpoint, // V1 强制锁定官方端点
      model: els.model.value,
      timeoutMs: Number(els.timeout.value),
      maxConcurrency: Number(els.concurrency.value),
      maxRetries: Number(els.retries.value),
      disableThinking: true, // 网页翻译固定关闭 Thinking，不受 UI 影响
    },
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  flash('设置已保存');
});

loadSettings();
