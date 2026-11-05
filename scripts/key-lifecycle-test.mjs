/**
 * scripts/key-lifecycle-test.mjs —— API Key 内存缓存生命周期测试（零依赖）。
 *
 * 覆盖 pre-flight 要求的两条场景：
 *  场景 A：Options 把 API Key 替换成新 Key → 旧 tab 再次翻译必须使用新 Key；
 *  场景 B：Options 清除 API Key → 旧 tab 再次翻译必须得到 API_KEY_MISSING（null），
 *          绝不能继续使用旧的内存 Key。
 *
 * 模拟 SW 的三条保证：
 *  1) 每次新翻译任务启动直读 storage 最新 Key；
 *  2) chrome.storage.onChanged → 内存副本立即失效（invalidate）；
 *  3) 会话中新建 batch 时缓存失效 → 自动重读 storage。
 *
 * 运行：node scripts/key-lifecycle-test.mjs
 * 说明：readFromStorage 由测试注入模拟 storage；全程 0 次真实 API 请求、0 次真实 Key。
 */
import assert from 'node:assert/strict';
import { createApiKeyCache } from '../src/background/api-key-cache.js';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 模拟 chrome.storage.local（仅内存）
const storage = { key: 'old-key-1' };
const readFromStorage = async () =>
  typeof storage.key === 'string' && storage.key.length > 0 ? storage.key : null;
const cache = createApiKeyCache(readFromStorage);

console.log('1. 场景 A：Options 替换新 Key → 旧 tab 必须用新 Key');
ok('首次读取得到旧 Key', (await cache.get()) === 'old-key-1');
storage.key = 'new-key-2'; // 用户在 Options 保存新 Key → SW 收到 storage.onChanged
cache.invalidate(); // 等价于 onChanged 处理器
ok('onChanged 失效后自动重读，得到新 Key', (await cache.get()) === 'new-key-2');

console.log('2. 场景 B：Options 清除 Key → 旧 tab 必须得到 API_KEY_MISSING');
storage.key = null; // 用户点击「清除 API Key」
cache.invalidate();
ok('清除后读取得到 null（上游转 API_KEY_MISSING，绝不使用旧 Key）', (await cache.get()) === null);

console.log('3. 旧内存副本绝不复活');
cache.set('new-key-2'); // 模拟某次旧任务曾写入缓存
storage.key = null; // 之后用户清除了 Key
cache.invalidate();
ok('失效后旧内存 Key 不复用（仍为 null）', (await cache.get()) === null);

console.log('4. 任务启动路径：每次 START 直读 storage 最新 Key（不依赖缓存）');
storage.key = 'key-after-restart';
const freshAtStart = await readFromStorage(); // 等价于 handleStartTranslation 的直读
cache.set(freshAtStart);
ok('START 直读得到最新 Key 并写入缓存', (await cache.get()) === 'key-after-restart');
storage.key = 'key-after-another-restart';
const freshAtStart2 = await readFromStorage();
cache.set(freshAtStart2);
ok('再次 START 仍直读最新 Key（缓存不拦截）', (await cache.get()) === 'key-after-another-restart');

console.log(`\n全部通过：${passed} 项断言。`);
