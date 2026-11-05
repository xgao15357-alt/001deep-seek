/**
 * scripts/lifecycle-test.mjs —— 页面生命周期 stale-state 自动化测试（零依赖，Node 运行）。
 *
 * 复现 Phase 2 实机验收发现的 Bug 场景并断言修复行为：
 *   Document A 翻译完成 226/226
 *   → 模拟 F5 reload → Document B（新 pageSessionId）
 *   → Popup 查询状态必须得到「未开始 0/0」（停止/恢复不可用）
 *   → SessionCache 保留
 *   → Document B 重新翻译时命中缓存（相同文本不再调用 Provider）。
 *
 * 运行：node scripts/lifecycle-test.mjs
 */
import assert from 'node:assert/strict';

import {
  createPageState,
  resetPageState,
  adoptPageSession,
  isCurrentPageSession,
} from '../src/background/page-session-state.js';
import { TranslationScheduler } from '../src/translation/translation-scheduler.js';
import { MockTranslationProvider } from '../src/translation/mock-provider.js';
import { SessionCache } from '../src/cache/session-cache.js';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * 模拟 SW 侧 scheduleBlock 的核心逻辑（不含 chrome.*）：
 * 按块调度 → SessionCache 命中或 MockProvider → 回填 state.stats。
 */
async function runFullTranslation(state, blocks, cache) {
  const provider = new MockTranslationProvider({ minDelayMs: 1, maxDelayMs: 3, failRatio: 0 });
  state.scheduler = new TranslationScheduler({ maxConcurrency: 2 });
  state.active = true;
  state.status = 'translating';
  const results = [];
  for (const b of blocks) {
    state.stats.total += 1;
    const cacheKey = cache.buildKey({
      sourceText: b.text,
      sourceLang: 'en',
      targetLang: 'zh-CN',
      provider: 'mock',
      model: provider.model,
      promptVersion: 'translation-prompt-v1',
    });
    const promise = state.scheduler.schedule({
      taskId: b.id,
      execute: async () => {
        const hit = cache.get(cacheKey);
        if (hit) return hit.translation;
        const [translation] = await provider.translate([b.text]);
        cache.set(cacheKey, translation);
        return translation;
      },
      onResult: (translation) => {
        state.stats.completed += 1;
        results.push([b.id, translation]);
      },
      onError: () => {},
    });
    await promise; // 串行等待，保证确定性
  }
  state.status = 'completed';
  return results;
}

console.log('1. 场景复现：Document A 翻译完成 226/226');
const cache = new SessionCache(); // 全局会话缓存（reload 不得清除）
const state = createPageState();
adoptPageSession(state, 'doc-A');
const blocksA = Array.from({ length: 226 }, (_, i) => ({
  id: `aiwt-block-${String(i + 1).padStart(6, '0')}`,
  text: `Sample english text number ${i + 1}`,
}));
await runFullTranslation(state, blocksA, cache);
ok('Document A 完成：226/226，status=completed', state.stats.total === 226 && state.stats.completed === 226 && state.status === 'completed');
ok('恢复原文可用（total>0，等价 Popup 按钮启用条件）', state.stats.total > 0);
const providerMissesBefore = cache.stats.misses; // miss 数 = 真实 Provider 调用次数
const oldScheduler = state.scheduler;

console.log('2. 模拟 reload：Document B 上报新 pageSessionId → 旧状态必须失效');
adoptPageSession(state, 'doc-B');
ok('旧 Document 状态失效：status 回到 idle（未开始）', state.status === 'idle');
ok('进度归零：0 / 0', state.stats.total === 0 && state.stats.completed === 0);
ok('恢复原文不可用（total=0）', state.stats.total === 0);
ok('旧调度器已 stop（在途任务不再投递）', oldScheduler.stopped === true);
ok('新调度器引用已清空', state.scheduler === null);
ok('已采纳新 pageSessionId=doc-B', state.pageSessionId === 'doc-B');

console.log('3. Popup 查询状态（GET_STATE 握手等价逻辑）');
// 3a. Content 存活且 id 一致 → 同 Document，状态保持（重开 Popup 不误清）
state.status = 'completed';
adoptPageSession(state, 'doc-B');
ok('同 Document 握手：状态保持不误清', state.status === 'completed');
// 3b. Content 不存在（刷新后未再翻译）：GET_STATE 的 ping 失败路径等价逻辑
const stateC = createPageState();
adoptPageSession(stateC, 'doc-A');
stateC.status = 'completed';
stateC.stats = { total: 226, completed: 226, failed: 0, cancelled: 0 };
resetPageState(stateC); // 等价于 handshakeWithDocument 中 Content 不存在分支
stateC.pageSessionId = null;
ok('Content 不存在 → 未开始 0/0（不再显示旧“已完成”）', stateC.status === 'idle' && stateC.stats.total === 0 && stateC.pageSessionId === null);

console.log('4. SessionCache 保留 + Document B 重新翻译命中缓存');
ok('reload 后缓存条目保留', cache.size >= 226);
const stateB = createPageState();
adoptPageSession(stateB, 'doc-B');
const resultsB = await runFullTranslation(stateB, blocksA.slice(0, 50), cache); // B 重扫前 50 块
ok('Document B 翻译 50 块全部完成', resultsB.length === 50);
ok('全部命中 SessionCache（Provider 未再被调用）', cache.stats.misses === providerMissesBefore);
ok('每个 DOM 块仍有独立 ID', resultsB.every(([id]) => id.startsWith('aiwt-block-')));

console.log('5. Phase 3 生命周期闸门：旧 Document 的 API 结果必须被丢弃');
{
  const stateX = createPageState();
  adoptPageSession(stateX, 'doc-A');
  ok('doc-A 会话内：doc-A 的 API 结果有效', isCurrentPageSession(stateX, 'doc-A') === true);
  adoptPageSession(stateX, 'doc-B'); // 模拟 reload → 新 Document
  ok('reload 后：doc-A 的迟到 API 结果被丢弃', isCurrentPageSession(stateX, 'doc-A') === false);
  ok('doc-B 会话内：doc-B 的 API 结果有效', isCurrentPageSession(stateX, 'doc-B') === true);
}

console.log(`\n全部通过：${passed} 项断言。`);
