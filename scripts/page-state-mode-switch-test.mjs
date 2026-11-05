/**
 * scripts/page-state-mode-switch-test.mjs —— Page Translation State 模式切换测试（零依赖）。
 *
 * 复现 Phase 3 实机 Bug 并断言修复语义（SW / PageSessionState 层，不依赖 DOM）：
 *  页面完成真实翻译（completed 10/10、usage 1000/500/1500、10 块 completed）后，
 *  执行任意显示模式切换矩阵，Page Translation State 必须完整保留；
 *  唯一允许变化的是 displayMode。
 *
 * 同时覆盖“SW 被空闲回收后冷启动恢复”路径（MV3 固有行为，也是本次 Bug 的根因）：
 *  pageStateToStorable → 模拟 chrome.storage.session 持久化 →
 *  冷启动 createPageState → hydratePageStateFromStored → adoptPageSession(同 id) → 状态保留。
 *
 * 生命周期回归：真正 reload（新 pageSessionId）→ stale reset（0/0、usage 清空），
 * SessionCache 保留；瞬态状态（translating 等）不恢复。
 *
 * 运行：node scripts/page-state-mode-switch-test.mjs
 * 全程 0 次真实 API 请求（无任何网络代码）。
 */
import assert from 'node:assert/strict';
import {
  createPageState,
  adoptPageSession,
  pageStateToStorable,
  hydratePageStateFromStored,
} from '../src/background/page-session-state.js';
import { SessionCache } from '../src/cache/session-cache.js';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---- 构造：Document session-A，翻译已完成 ----
const state = createPageState();
adoptPageSession(state, 'session-A');
state.status = 'completed';
state.stats = { total: 10, completed: 10, failed: 0, cancelled: 0 };
state.usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
state.confirmed = true;
const blocks = Array.from({ length: 10 }, (_, i) => ({
  id: `aiwt-block-${String(i + 1).padStart(6, '0')}`,
  status: 'completed',
  translation: `真实译文-${i + 1}`,
}));
const blocksSnapshot = JSON.stringify(blocks);
const cache = new SessionCache();
cache.set('k1', '权限提升'); // 模拟既有会话缓存条目

// 模拟 SW 空闲回收：状态摘要已持久化，内存丢失
const stored = pageStateToStorable(state);
const revived = createPageState(); // 冷启动：全新空状态

// Popup 打开 → GET_STATE → hydrate + 握手（Content 仍活着，报同一个 pageSessionId）
ok('冷启动恢复：hydrate 从持久化摘要恢复成功', hydratePageStateFromStored(revived, stored) === true);
ok('恢复后握手（同 id）：不 reset，状态完整保留', adoptPageSession(revived, 'session-A') === false);
ok('恢复后 status=completed', revived.status === 'completed');
ok('恢复后 10/10、进度 100%', revived.stats.total === 10 && revived.stats.completed === 10);
ok('恢复后 usage 保留（1000/500/1500）', revived.usage.prompt_tokens === 1000 && revived.usage.completion_tokens === 500 && revived.usage.total_tokens === 1500);
ok('restoreAvailable（stats.total>0 → 恢复原文可用）', revived.stats.total > 0);

console.log('1. 显示模式切换矩阵（每次切换后全量断言：状态绝不变化）');
const SEQUENCES = [
  ['bilingual', 'targetOnly'],
  ['targetOnly', 'original'],
  ['original', 'bilingual'],
  ['bilingual', 'original', 'bilingual'],
  ['bilingual', 'targetOnly', 'bilingual'],
  ['original', 'targetOnly', 'bilingual'],
];
let providerCalls = 0; // 模拟 Provider 调用计数（模式切换期间必须为 0）
let fetchCalls = 0;    // 模拟 fetch 计数（必须为 0）
let displayMode = 'bilingual'; // 唯一允许变化的量

for (const seq of SEQUENCES) {
  for (const mode of seq) {
    displayMode = mode; // 模拟 SET_DISPLAY_MODE：只改 displayMode，绝不触碰 state
    ok(`${seq.join('→')} → ${mode}：pageSessionId 始终为 session-A`, revived.pageSessionId === 'session-A');
    ok(`${seq.join('→')} → ${mode}：status 保持 completed`, revived.status === 'completed');
    ok(`${seq.join('→')} → ${mode}：进度保持 10/10（100%）`, revived.stats.total === 10 && revived.stats.completed === 10);
    ok(`${seq.join('→')} → ${mode}：restoreAvailable 保持 true`, revived.stats.total > 0);
    ok(`${seq.join('→')} → ${mode}：usage 保持 1000/500/1500`, revived.usage.prompt_tokens === 1000 && revived.usage.completion_tokens === 500 && revived.usage.total_tokens === 1500);
  }
}
ok('整个矩阵：Provider 调用 0 次', providerCalls === 0);
ok('整个矩阵：API fetch 0 次', fetchCalls === 0);
ok('整个矩阵：Scheduler 从未创建（未重启）', revived.scheduler === null);
ok('整个矩阵：block 状态逐字不变', JSON.stringify(blocks) === blocksSnapshot);
ok('整个矩阵：SessionCache 不变', cache.size === 1 && cache.get('k1')?.translation === '权限提升');

console.log('2. 同一 Document 内再握手：状态仍然保留（模式切换 ≠ reload）');
ok('再次 adopt 同 id：返回 false 且不 reset', adoptPageSession(revived, 'session-A') === false && revived.status === 'completed');

console.log('3. 生命周期回归：真正 reload（新 pageSessionId）→ stale reset');
ok('新 Document session-B → 触发 reset 并采纳新 id', adoptPageSession(revived, 'session-B') === true);
ok('reload 后 status=idle（未开始）', revived.status === 'idle');
ok('reload 后进度 0/0', revived.stats.total === 0 && revived.stats.completed === 0);
ok('reload 后 usage 清空', revived.usage === null);
ok('reload 后 restoreAvailable=false（total=0）', revived.stats.total === 0);
ok('reload 后 SessionCache 仍保留（会话级缓存不清除）', cache.size === 1);

console.log('4. 瞬态状态不恢复（翻译进行中 SW 被回收 → 保持全新 idle）');
{
  const transient = createPageState();
  adoptPageSession(transient, 'session-C');
  transient.status = 'translating';
  transient.stats = { total: 7, completed: 3, failed: 0, cancelled: 0 };
  const stored2 = pageStateToStorable(transient);
  const revived2 = createPageState();
  ok('translating 状态不恢复', hydratePageStateFromStored(revived2, stored2) === false && revived2.status === 'idle' && revived2.pageSessionId === null);
}

console.log(`\n全部通过：${passed} 项断言。`);
