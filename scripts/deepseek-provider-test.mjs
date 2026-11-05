/**
 * scripts/deepseek-provider-test.mjs —— DeepSeekProvider / 重试策略 / 取消 自动化测试（零依赖）。
 *
 * 硬性要求：绝不做真实 DeepSeek API 请求（不产生费用、不读取用户真实 Key）。
 * 全部使用 fake fetch / mock HTTP response；测试中仅使用占位假 Key，
 * 且测试输出绝不打印任何 Key 值。
 *
 * 覆盖：
 *  1) 请求构造（model / thinking=disabled / response_format=json_object / temperature / stream / headers）
 *  2) JSON 结果严格校验（正常 / invalid JSON / 空 content / 缺 id / 未知 id / 重复 id / 缺 translations / 非字符串 text）
 *  3) HTTP 错误映射（400/401/402/422/429/500/503 + Retry-After）
 *  4) 网络失败 / 超时 / 用户中止 / Key 缺失
 *  5) 重试策略（401→0 重试、500→有限重试、Abort→0 重试、Retry-After 优先）
 *  6) Scheduler 取消（2 个 batch running → stop → 全部 abort → 迟到结果不投递）
 *
 * 运行：node scripts/deepseek-provider-test.mjs
 */
import assert from 'node:assert/strict';
import { TranslationError, ERROR_CODES } from '../src/shared/errors.js';
import { DeepSeekProvider } from '../src/translation/deepseek-provider.js';
import { translateBatchWithSplitRetry } from '../src/translation/batch-translator.js';
import { withRetry, shouldRetryError, backoffDelayMs } from '../src/translation/retry-policy.js';
import { TranslationScheduler } from '../src/translation/translation-scheduler.js';

const FAKE_KEY = 'sk-fake-for-test-only'; // 占位假 Key，测试输出永不打印
const ENDPOINT = 'https://api.deepseek.com/chat/completions';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake fetch 基础设施 ----
let lastRequest = null;
let fetchCalls = 0;
function installFetch(handler) {
  fetchCalls = 0;
  lastRequest = null;
  globalThis.fetch = async (url, init) => {
    fetchCalls += 1;
    lastRequest = { url, init, body: JSON.parse(init.body) };
    return handler(url, init);
  };
}
function jsonResponse(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (headers[n.toLowerCase()] ?? null) },
    json: async () => payload,
  };
}
function apiPayload(content, usage = null, finishReason = 'stop') {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}
const blocks = [
  { id: 'aiwt-block-000001', text: 'What is network security?' },
  { id: 'aiwt-block-000002', text: 'A firewall monitors incoming traffic.' },
];
const baseProvider = () => new DeepSeekProvider({ apiKey: FAKE_KEY, model: 'deepseek-v4-flash' });

console.log('1. 请求构造（OpenAI Chat Completions 格式）');
{
  installFetch(() =>
    jsonResponse(
      apiPayload(JSON.stringify({ translations: blocks.map((b) => ({ id: b.id, text: '译文' })) }), {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      })
    )
  );
  const provider = baseProvider();
  const result = await provider.translateBatch({ blocks, signal: undefined });

  ok('只调用一次 fetch，目标为官方端点', fetchCalls === 1 && lastRequest.url === ENDPOINT);
  ok('POST + Authorization 存在（不打印 Key 值）', lastRequest.init.method === 'POST' && lastRequest.init.headers.Authorization === `Bearer ${FAKE_KEY}`);
  ok('Content-Type 为 application/json', lastRequest.init.headers['Content-Type'] === 'application/json');
  const body = lastRequest.body;
  ok('model = deepseek-v4-flash（默认）', body.model === 'deepseek-v4-flash');
  ok('thinking.type = disabled（显式关闭 Thinking）', body.thinking && body.thinking.type === 'disabled');
  ok('response_format.type = json_object', body.response_format && body.response_format.type === 'json_object');
  ok('temperature = 0.2', body.temperature === 0.2);
  ok('stream = false', body.stream === false);
  ok('max_tokens = 16384（显式设置，内部常量）', body.max_tokens === 16384);
  ok(
    '请求体只含必要字段（无 URL/标题/Referer 等）',
    JSON.stringify(Object.keys(body).sort()) ===
      JSON.stringify(['max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature', 'thinking'])
  );
  ok('System Prompt 包含 JSON 与防注入声明', body.messages[0].role === 'system' && body.messages[0].content.includes('JSON') && body.messages[0].content.includes('untrusted'));
  const user = JSON.parse(body.messages[1].content);
  ok(
    '用户消息只含语言对与纯文本块（无页面上下文）',
    JSON.stringify(Object.keys(user).sort()) === JSON.stringify(['blocks', 'source_language', 'target_language']) &&
      user.blocks.length === 2 &&
      user.blocks[0].id === 'aiwt-block-000001' &&
      user.blocks[1].text === 'A firewall monitors incoming traffic.'
  );
  ok('结果按 block.id 返回 + usage 归一化', result.results.length === 2 && result.usage.prompt_tokens === 100 && result.usage.total_tokens === 150);

  installFetch(() => jsonResponse(apiPayload(JSON.stringify({ translations: [] }))));
  const pro = new DeepSeekProvider({ apiKey: FAKE_KEY, model: 'deepseek-v4-pro' });
  await pro.translateBatch({ blocks, signal: undefined });
  ok('可选用 deepseek-v4-pro', lastRequest.body.model === 'deepseek-v4-pro');
}

console.log('2. JSON 结果严格校验（不可信外部数据）');
{
  const cases = [
    { name: '正常结果', content: JSON.stringify({ translations: [{ id: 'aiwt-block-000001', text: '一' }, { id: 'aiwt-block-000002', text: '二' }] }), ok: true, results: 2 },
    { name: 'invalid JSON', content: 'not-json{{', code: ERROR_CODES.INVALID_RESPONSE },
    { name: '空 content', content: '   ', code: ERROR_CODES.INVALID_RESPONSE },
    { name: '缺 translations 字段', content: JSON.stringify({ foo: 1 }), code: ERROR_CODES.INVALID_RESPONSE },
    { name: 'translations 非数组', content: JSON.stringify({ translations: 'x' }), code: ERROR_CODES.INVALID_RESPONSE },
    { name: '条目缺 id', content: JSON.stringify({ translations: [{ text: '一' }] }), code: ERROR_CODES.INVALID_RESPONSE },
    { name: 'text 非字符串', content: JSON.stringify({ translations: [{ id: 'aiwt-block-000001', text: 123 }] }), code: ERROR_CODES.INVALID_RESPONSE },
    { name: 'text 为空字符串', content: JSON.stringify({ translations: [{ id: 'aiwt-block-000001', text: '  ' }] }), code: ERROR_CODES.INVALID_RESPONSE },
    { name: '重复 id（视为响应非法）', content: JSON.stringify({ translations: [{ id: 'aiwt-block-000001', text: '一' }, { id: 'aiwt-block-000001', text: '二' }] }), code: ERROR_CODES.INVALID_RESPONSE },
    { name: '未知 id（忽略，不抛错）', content: JSON.stringify({ translations: [{ id: 'aiwt-block-000001', text: '一' }, { id: 'unknown-999', text: '?' }] }), ok: true, results: 1, unknown: 1, missing: 1 },
    { name: '缺失 id（缺 000002）', content: JSON.stringify({ translations: [{ id: 'aiwt-block-000001', text: '一' }] }), ok: true, results: 1, missing: 1 },
    { name: '返回顺序颠倒（仍按 id 匹配）', content: JSON.stringify({ translations: [{ id: 'aiwt-block-000002', text: '二' }, { id: 'aiwt-block-000001', text: '一' }] }), ok: true, results: 2, orderOk: true },
  ];
  for (const c of cases) {
    installFetch(() => jsonResponse(apiPayload(c.content)));
    const provider = baseProvider();
    try {
      const r = await provider.translateBatch({ blocks, signal: undefined });
      if (c.ok) {
        ok(`正常路径：${c.name}`, r.results.length === c.results && (c.missing ? r.missingIds.length === c.missing : r.missingIds.length === 0) && (c.unknown ? r.unknownIds.length === c.unknown : true));
        if (c.orderOk) ok('乱序返回不导致串块', r.results[0].id === 'aiwt-block-000002');
        ok(`无 usage 时返回 null：${c.name}`, r.usage === null);
      } else {
        ok(`应失败：${c.name}`, false);
      }
    } catch (err) {
      if (c.ok) {
        ok(`不应失败：${c.name}`, false);
      } else {
        ok(`错误码正确：${c.name} → ${c.code}`, err instanceof TranslationError && err.code === c.code);
      }
    }
  }
}

console.log('3. finish_reason 严格处理（缺失/截断/过滤/异常结束绝不投递）');
{
  const good = JSON.stringify({ translations: blocks.map((b) => ({ id: b.id, text: '译文' })) });
  const cases = [
    { name: 'stop → 正常投递', fr: 'stop', code: null },
    { name: 'finish_reason=null → UNEXPECTED_FINISH_REASON（不解析不投递）', fr: null, code: ERROR_CODES.UNEXPECTED_FINISH_REASON, retryable: false },
    { name: 'finish_reason 字段缺失 → UNEXPECTED_FINISH_REASON（不解析不投递）', fr: 'ABSENT', code: ERROR_CODES.UNEXPECTED_FINISH_REASON, retryable: false },
    { name: 'length → OUTPUT_TRUNCATED（不原样重试，截断 JSON 不投递）', fr: 'length', code: ERROR_CODES.OUTPUT_TRUNCATED, retryable: false },
    { name: 'content_filter → CONTENT_FILTERED（不作为成功）', fr: 'content_filter', code: ERROR_CODES.CONTENT_FILTERED, retryable: false },
    { name: 'insufficient_system_resource → SERVICE_OVERLOADED（临时失败可重试）', fr: 'insufficient_system_resource', code: ERROR_CODES.SERVICE_OVERLOADED, retryable: true },
    { name: 'tool_calls → UNEXPECTED_FINISH_REASON', fr: 'tool_calls', code: ERROR_CODES.UNEXPECTED_FINISH_REASON, retryable: false },
    { name: '未知结束原因 → UNEXPECTED_FINISH_REASON', fr: 'weird_reason', code: ERROR_CODES.UNEXPECTED_FINISH_REASON, retryable: false },
  ];
  for (const c of cases) {
    // ABSENT：构造完全没有 finish_reason 字段的原始 payload（fake response）
    const payload = c.fr === 'ABSENT' ? { choices: [{ message: { content: good } }] } : apiPayload(good, null, c.fr);
    installFetch(() => jsonResponse(payload));
    try {
      const r = await baseProvider().translateBatch({ blocks, signal: undefined });
      if (c.code) {
        ok(`应失败：${c.name}`, false);
      } else {
        ok(`正常：${c.name}（2 个结果）`, r.results.length === 2);
      }
    } catch (err) {
      if (c.code) {
        ok(`${c.name} → ${c.code}`, err.code === c.code && err.retryable === c.retryable);
      } else {
        ok(`不应失败：${c.name}`, false);
      }
    }
  }
}

console.log('4. HTTP 错误映射');
{
  const httpCases = [
    [400, ERROR_CODES.INVALID_REQUEST],
    [401, ERROR_CODES.API_KEY_INVALID],
    [402, ERROR_CODES.INSUFFICIENT_BALANCE],
    [422, ERROR_CODES.INVALID_REQUEST],
    [429, ERROR_CODES.RATE_LIMITED],
    [500, ERROR_CODES.SERVER_ERROR],
    [503, ERROR_CODES.SERVICE_OVERLOADED],
  ];
  for (const [status, code] of httpCases) {
    installFetch(() => jsonResponse({}, status));
    const provider = baseProvider();
    try {
      await provider.translateBatch({ blocks, signal: undefined });
      ok(`HTTP ${status} 应抛错`, false);
    } catch (err) {
      ok(`HTTP ${status} → ${code}`, err instanceof TranslationError && err.code === code);
    }
  }
  installFetch(() => jsonResponse({}, 429, { 'retry-after': '2' }));
  try {
    await baseProvider().translateBatch({ blocks, signal: undefined });
    ok('429 应抛错', false);
  } catch (err) {
    ok('429 尊重 Retry-After（2s → 2000ms）', err.retryAfterMs === 2000 && err.retryable === true);
  }
}

console.log('5. 网络失败 / 超时 / 用户中止 / Key 缺失');
{
  installFetch(async () => {
    throw new TypeError('network down');
  });
  try {
    await baseProvider().translateBatch({ blocks, signal: undefined });
    ok('网络失败应抛错', false);
  } catch (err) {
    ok('网络失败 → NETWORK_ERROR（可重试）', err.code === ERROR_CODES.NETWORK_ERROR && err.retryable === true);
  }

  const slowProvider = new DeepSeekProvider({ apiKey: FAKE_KEY, timeoutMs: 20 });
  installFetch(
    (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
  );
  try {
    await slowProvider.translateBatch({ blocks, signal: undefined });
    ok('超时应抛错', false);
  } catch (err) {
    ok('超时 abort → TIMEOUT（可重试）', err.code === ERROR_CODES.TIMEOUT && err.retryable === true);
  }

  const controller = new AbortController();
  controller.abort();
  installFetch((url, init) => {
    if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return jsonResponse(apiPayload('{}'));
  });
  try {
    await baseProvider().translateBatch({ blocks, signal: controller.signal });
    ok('已中止时应抛错', false);
  } catch (err) {
    ok('用户中止（开始前）→ USER_CANCELLED 且零 fetch', err.code === ERROR_CODES.USER_CANCELLED && fetchCalls === 0);
  }

  const controller2 = new AbortController();
  installFetch(
    (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
  );
  const pending = baseProvider().translateBatch({ blocks, signal: controller2.signal }).then(
    () => ({ code: 'NO_ERROR' }),
    (err) => ({ code: err.code })
  );
  await sleep(10);
  controller2.abort();
  const abortCode = await pending;
  ok('用户中止（进行中）→ USER_CANCELLED 而非 TIMEOUT', abortCode.code === ERROR_CODES.USER_CANCELLED);

  installFetch(() => jsonResponse(apiPayload('{}')));
  const noKey = new DeepSeekProvider({ apiKey: null });
  try {
    await noKey.translateBatch({ blocks, signal: undefined });
    ok('无 Key 应抛错', false);
  } catch (err) {
    ok('Key 缺失 → API_KEY_MISSING 且零 fetch', err.code === ERROR_CODES.API_KEY_MISSING && fetchCalls === 0);
  }
}

console.log('6. 重试策略');
{
  let calls = 0;
  const fn401 = async () => {
    calls += 1;
    throw new TranslationError(ERROR_CODES.API_KEY_INVALID);
  };
  await withRetry(fn401, { maxRetries: 2, backoffBaseMs: 1 }).catch(() => {});
  ok('401 → 0 次重试（共 1 次调用）', calls === 1);

  calls = 0;
  const fn500 = async () => {
    calls += 1;
    throw new TranslationError(ERROR_CODES.SERVER_ERROR, { retryable: true });
  };
  await withRetry(fn500, { maxRetries: 2, backoffBaseMs: 1 }).catch(() => {});
  ok('500 → 有限重试（共 3 次调用）', calls === 3);

  calls = 0;
  const fn402 = async () => {
    calls += 1;
    throw new TranslationError(ERROR_CODES.INSUFFICIENT_BALANCE);
  };
  await withRetry(fn402, { maxRetries: 2, backoffBaseMs: 1 }).catch(() => {});
  ok('402 → 0 次重试', calls === 1);

  ok('shouldRetryError：USER_CANCELLED 不重试', shouldRetryError(new TranslationError(ERROR_CODES.USER_CANCELLED), 0, 2) === false);
  ok('shouldRetryError：RETRYABLE 集合重试', shouldRetryError(new TranslationError(ERROR_CODES.TIMEOUT), 0, 2) === true);
  ok('shouldRetryError：OUTPUT_TRUNCATED 不原样重试（不在可重试集合）', shouldRetryError(new TranslationError(ERROR_CODES.OUTPUT_TRUNCATED), 0, 2) === false);
  ok('attempt 达到上限不重试', shouldRetryError(new TranslationError(ERROR_CODES.TIMEOUT), 2, 2) === false);
  ok(
    'Retry-After 优先于退避',
    backoffDelayMs(0, new TranslationError(ERROR_CODES.RATE_LIMITED, { retryAfterMs: 5000 }), 500) === 5000
  );

  calls = 0;
  const controller = new AbortController();
  const fnAbort = async () => {
    calls += 1;
    controller.abort();
    throw new TranslationError(ERROR_CODES.NETWORK_ERROR, { retryable: true });
  };
  let abortErr = null;
  await withRetry(fnAbort, { maxRetries: 2, signal: controller.signal, backoffBaseMs: 1 }).catch((e) => {
    abortErr = e;
  });
  ok('用户中止 → 立即停止，0 次重试，错误归一为 USER_CANCELLED', calls === 1 && abortErr && abortErr.code === ERROR_CODES.USER_CANCELLED);
}

console.log('7. Scheduler 取消：2 个 batch running → STOP → 全部 abort → 迟到结果不投递');
{
  const sched = new TranslationScheduler({ maxConcurrency: 2 });
  let aborted = 0;
  let delivered = 0;
  let failed = 0;
  for (let i = 0; i < 2; i += 1) {
    sched.schedule({
      taskId: `awt-batch-00000${i + 1}`,
      execute: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted += 1;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      onResult: () => {
        delivered += 1;
      },
      onError: () => {
        failed += 1;
      },
    });
  }
  await sleep(10); // 两个 batch 都进入 running
  sched.stop();
  await sleep(20);
  ok('两个 batch 的 AbortController 都收到 abort', aborted === 2);
  ok('停止后没有结果投递（onResult/onError 均为 0）', delivered === 0 && failed === 0);
  const st = sched.stats();
  ok('任务全部标记 cancelled（不算失败）', st.cancelled === 2 && st.failed === 0);
}

console.log('8. OUTPUT_TRUNCATED 第一次即拆半（成本优先，绝不原样重试同一 batch）');
{
  const calls = [];
  const stubProvider = {
    async translateBatch({ blocks }) {
      calls.push(blocks.length);
      if (blocks.length > 1) {
        // 模拟大于 1 块的 batch 总是被截断
        throw new TranslationError(ERROR_CODES.OUTPUT_TRUNCATED);
      }
      return {
        results: blocks.map((b) => ({ id: b.id, text: `译-${b.id}` })),
        missingIds: [],
        unknownIds: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const four = [
    { id: 'a', text: 'aa' },
    { id: 'b', text: 'bb' },
    { id: 'c', text: 'cc' },
    { id: 'd', text: 'dd' },
  ];
  // maxRetries=2：证明即使配置了重试，截断也绝不原样重发同一个多 block batch
  const res = await translateBatchWithSplitRetry(stubProvider, four, { maxRetries: 2, signal: undefined });
  ok('4 块 batch 截断 → 直接拆半后全部成功（4 个结果）', res.results.length === 4);
  ok('调用序列 [4, 2, 1, 1, 2, 1, 1]：多 block batch 从未被重复发送', JSON.stringify(calls) === JSON.stringify([4, 2, 1, 1, 2, 1, 1]));
  ok('usage 聚合正确', res.usage.total_tokens === 8);

  calls.length = 0;
  const alwaysTruncated = {
    async translateBatch({ blocks }) {
      calls.push(blocks.length);
      throw new TranslationError(ERROR_CODES.OUTPUT_TRUNCATED);
    },
  };
  const single = await translateBatchWithSplitRetry(alwaysTruncated, [{ id: 'x', text: 'xx' }], { maxRetries: 2, signal: undefined }).then(
    () => null,
    (e) => e
  );
  ok('单块截断 → 有界失败（仅 1 次调用，绝不无限重试同一请求）', single && single.code === ERROR_CODES.OUTPUT_TRUNCATED && calls.length === 1);

  calls.length = 0;
  const flaky = {
    async translateBatch({ blocks }) {
      calls.push(blocks.length);
      throw new TranslationError(ERROR_CODES.NETWORK_ERROR, { retryable: true });
    },
  };
  const netErr = await translateBatchWithSplitRetry(flaky, [{ id: 'y', text: 'yy' }], { maxRetries: 2, signal: undefined, backoffBaseMs: 1 }).then(
    () => null,
    (e) => e
  );
  ok('其他临时错误（NETWORK）仍按有限重试：3 次调用后失败', calls.length === 3 && netErr && netErr.code === ERROR_CODES.NETWORK_ERROR);
}

console.log(`\n全部通过：${passed} 项断言。`);
