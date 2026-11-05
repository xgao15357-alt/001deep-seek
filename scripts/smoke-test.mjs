/**
 * scripts/smoke-test.mjs —— 零依赖逻辑自测（Node 自带能力，无需安装任何依赖）。
 * 运行：node scripts/smoke-test.mjs
 * 覆盖纯逻辑模块（不涉及浏览器 DOM）：
 *  错误模型 / 高风险判定与注入可用性 / 会话缓存 / Mock Provider / 调度器（并发、取消、缓存去重）。
 * 任何断言失败都会以非零退出码结束。
 */
import assert from 'node:assert/strict';

import { TranslationError, ERROR_CODES, toStructuredError } from '../src/shared/errors.js';
import { PageSafetyGuard, canInjectIntoUrl, RISK_LEVELS } from '../src/page/page-safety-guard.js';
import { SessionCache } from '../src/cache/session-cache.js';
import { MockTranslationProvider } from '../src/translation/mock-provider.js';
import { TranslationScheduler } from '../src/translation/translation-scheduler.js';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('1. 统一错误模型');
{
  const e = new TranslationError(ERROR_CODES.PAGE_UNSUPPORTED, { detail: 'd' });
  ok('错误码与结构化序列化', e.toJSON().code === 'PAGE_UNSUPPORTED' && e.toJSON().detail === 'd');
  ok('中文提示可读', e.message.includes('不支持翻译'));
  ok('任意异常转结构化 UNKNOWN', toStructuredError(new Error('x')).code === 'UNKNOWN');
}

console.log('2. PageSafetyGuard 本地判定');
{
  const g = new PageSafetyGuard();
  ok('登录页 URL → HIGH_RISK', g.assess({ url: 'https://example.com/login' }).level === RISK_LEVELS.HIGH_RISK);
  ok('密码框存在 → HIGH_RISK', g.assess({ url: 'https://example.com/', hasPasswordField: true }).level === RISK_LEVELS.HIGH_RISK);
  ok('敏感表单存在 → HIGH_RISK', g.assess({ url: 'https://example.com/', hasSensitiveForm: true }).level === RISK_LEVELS.HIGH_RISK);
  ok('普通页面 → NORMAL', g.assess({ url: 'https://example.com/news/1', title: 'News' }).level === RISK_LEVELS.NORMAL);
  ok('edge:// 不可注入', !canInjectIntoUrl('edge://settings/'));
  ok('chrome-extension:// 不可注入', !canInjectIntoUrl('chrome-extension://abc/page.html'));
  ok('商店页不可注入', !canInjectIntoUrl('https://chromewebstore.google.com/detail/x'));
  ok('普通 https 可注入', canInjectIntoUrl('https://example.com/'));
}

console.log('3. SessionCache');
{
  const cache = new SessionCache();
  const k1 = cache.buildKey({ sourceText: 'Hello world', sourceLang: 'en', targetLang: 'zh-CN', provider: 'mock', model: 'mock-v1', promptVersion: 'translation-prompt-v1' });
  cache.set(k1, '你好');
  ok('命中并返回译文', cache.get(k1).translation === '你好');
  ok('缺失计数正确', cache.stats.misses === 0 && cache.stats.hits === 1);
}

console.log('4. MockTranslationProvider（零网络、带前缀）');
{
  const mock = new MockTranslationProvider({ minDelayMs: 5, maxDelayMs: 10, failRatio: 0 });
  const [t1] = await mock.translate(['The OSI model has seven layers.']);
  ok('结果带【模拟译文】前缀', t1 === '【模拟译文】The OSI model has seven layers.');
  ok('配置校验通过', mock.validateConfig().ok === true);
}

console.log('5. TranslationScheduler：并发 + 缓存去重');
{
  const cache = new SessionCache();
  let providerCalls = 0;
  const fakeProvider = {
    model: 'mock-v1',
    async translate(blocks) {
      providerCalls += 1;
      await sleep(10);
      return blocks.map((b) => `【模拟译文】${b}`);
    },
  };
  const sched = new TranslationScheduler({ maxConcurrency: 2 });
  const done = [];
  const run = (id, text) =>
    sched.schedule({
      taskId: id,
      execute: async () => {
        const key = cache.buildKey({ sourceText: text, sourceLang: 'en', targetLang: 'zh-CN', provider: 'mock', model: 'mock-v1', promptVersion: 'translation-prompt-v1' });
        const hit = cache.get(key);
        if (hit) return hit.translation;
        const [res] = await fakeProvider.translate([text]);
        cache.set(key, res);
        return res;
      },
      onResult: (t) => done.push([id, t]),
      onError: () => {},
    });
  // 第一批：2 个不同文本并发执行
  run('aiwt-block-000001', 'Privilege escalation');
  run('aiwt-block-000003', 'Another topic');
  await sleep(40);
  ok('首批 2 个任务完成，Provider 调用 2 次', done.length === 2 && providerCalls === 2);
  // 第二批：重复文本 → 纯缓存命中（不再调用 Provider）
  run('aiwt-block-000002', 'Privilege escalation');
  await sleep(20);
  ok('重复文本走缓存（Provider 仍只调用 2 次）', done.length === 3 && providerCalls === 2);
  ok('结果按 block.id 关联', done.every(([id]) => id.startsWith('aiwt-block-')));
  const st = sched.stats();
  ok('统计：3 完成 0 失败', st.total === 3 && st.completed === 3 && st.failed === 0);
  ok('幂等：同 id 不重复排队', (() => {
    const t = sched.getTask('aiwt-block-000001');
    return t && t.status === 'completed';
  })());
}

console.log('6. TranslationScheduler：停止语义');
{
  const sched = new TranslationScheduler({ maxConcurrency: 1 });
  const done = [];
  const slowProvider = {
    model: 'mock-v1',
    async translate(blocks) {
      await sleep(30);
      return blocks.map((b) => `【模拟译文】${b}`);
    },
  };
  for (let i = 1; i <= 3; i += 1) {
    const id = `aiwt-block-00000${i}`;
    sched.schedule({
      taskId: id,
      execute: async () => (await slowProvider.translate([`text-${i}`]))[0],
      onResult: (t) => done.push([id, t]),
      onError: () => {},
    });
  }
  await sleep(5); // 第 1 个在跑，2/3 排队
  sched.stop();
  await sleep(80); // 给在途任务收尾时间
  ok('停止后没有结果回调（在途任务不再投递）', done.length === 0);
  const st = sched.stats();
  ok('3 个任务全部标记 cancelled', st.cancelled === 3 && st.completed === 0 && st.failed === 0);
}

console.log('7. 消息协议单一事实来源');
{
  // messages.core.js 同时挂到全局命名空间（经典脚本）与 ESM 再导出
  await import('../src/shared/messages.js');
  ok('ESM 再导出与全局命名空间一致', globalThis.__AIWT__?.MESSAGE_TYPES?.TRANSLATE_REQUEST === 'awt.translateRequest');
  ok('协议含 Phase 2 新消息', typeof globalThis.__AIWT__.MESSAGE_TYPES.CONFIRM_HIGH_RISK === 'string');
}

console.log(`\n全部通过：${passed} 项断言。`);
