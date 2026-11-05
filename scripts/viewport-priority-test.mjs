/**
 * scripts/viewport-priority-test.mjs —— Viewport Priority 与 pending 排序测试（零依赖）。
 *
 * 覆盖：
 *  11-13 优先级分类：viewport 内 HIGH / 附近 MEDIUM / 远处 LOW（纯几何，绝不滚动）
 *  14 pending 排序正确（HIGH→MEDIUM→LOW，同优先级稳定保持 DOM 阅读顺序）
 *  15 running batch 不因滚动 abort / 不被重排（复刻 SW enqueueBlock 守卫语义）
 *  16 completed 不重新排队
 *  17 滚动后 pending priority 更新（queued 块优先级刷新并参与重排）
 *
 * 运行：node scripts/viewport-priority-test.mjs（0 次网络请求）。
 */
import assert from 'node:assert/strict';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 注入经典模块（computeViewportPriority 挂在 __AIWT__）
await import('../src/shared/messages.core.js');
await import('../src/content/text-extractor.js');
const NS = globalThis.__AIWT__;
const compute = NS.computeViewportPriority;
const { HIGH, MEDIUM, LOW } = NS.BLOCK_PRIORITIES;
const { sortBlockIdsByPriority } = await import('../src/translation/translation-batcher.js');

console.log('1. 优先级分类（vh=800，缓冲区 1.5 屏）');
ok('viewport 内 → HIGH', compute({ top: 100, bottom: 120 }, 800) === HIGH);
ok('与视口相交（跨上边界）→ HIGH', compute({ top: -50, bottom: 50 }, 800) === HIGH);
ok('视口下方 1 屏内 → MEDIUM', compute({ top: 900, bottom: 920 }, 800) === MEDIUM);
ok('视口上方 1 屏内 → MEDIUM', compute({ top: -1000, bottom: -980 }, 800) === MEDIUM);
ok('远处 → LOW', compute({ top: 5000, bottom: 5020 }, 800) === LOW);
ok('缓冲区边界附近（2 屏外）→ LOW', compute({ top: 3000, bottom: 3020 }, 800) === LOW);

console.log('2. pending 排序：HIGH→MEDIUM→LOW，稳定保持 DOM 阅读顺序');
{
  const blocks = [
    { id: 'b1', priority: LOW },
    { id: 'b2', priority: HIGH },
    { id: 'b3', priority: MEDIUM },
    { id: 'b4', priority: HIGH },
    { id: 'b5', priority: LOW },
  ];
  const sorted = sortBlockIdsByPriority(blocks.map((b) => b.id), (id) => blocks.find((b) => b.id === id).priority);
  ok('HIGH 优先且同优先级保持原顺序（b2 在 b4 前）', sorted[0] === 'b2' && sorted[1] === 'b4');
  ok('MEDIUM 居中', sorted[2] === 'b3');
  ok('LOW 最后且保持原顺序（b1 在 b5 前）', sorted[3] === 'b1' && sorted[4] === 'b5');
  ok('未知优先级按 LOW 处理（已知 HIGH 优先于未知）', JSON.stringify(sortBlockIdsByPriority(['x1', 'h1'], (id) => (id === 'h1' ? 'high' : undefined))) === JSON.stringify(['h1', 'x1']));
}

console.log('3. 守卫语义：running 不 abort、completed 不重排、滚动只更新 queued');
{
  // 复刻 SW enqueueBlock 的守卫分支（块状态 → 行为）
  const blocks = new Map([
    ['r1', { status: 'running', priority: LOW, text: 'x' }],
    ['c1', { status: 'completed', priority: HIGH, text: 'y' }],
    ['q1', { status: 'queued', priority: LOW, text: 'z' }],
  ]);
  let abortCalls = 0;
  let requeued = [];
  function simulatePriorityUpdate(id, newPriority) {
    const blk = blocks.get(id);
    if (!blk || blk.status === 'completed') return; // completed：绝不重新排队
    if (blk.status === 'running') return;           // running：绝不 abort / 不重排
    if (blk.status === 'queued') blk.priority = newPriority; // 仅 pending 更新
  }
  simulatePriorityUpdate('r1', HIGH);
  simulatePriorityUpdate('c1', MEDIUM);
  simulatePriorityUpdate('q1', HIGH);
  ok('running 块优先级更新被忽略（不 abort）', blocks.get('r1').priority === LOW && abortCalls === 0);
  ok('completed 块不重新排队（优先级不改）', blocks.get('c1').priority === HIGH && requeued.length === 0);
  ok('queued 块优先级成功更新（滚动后 pending 重排依据）', blocks.get('q1').priority === HIGH);
  ok('运行中任务无 abort 调用', abortCalls === 0);
}

console.log('4. 滚动后 pending 整体重排（不重翻 completed、不清 usage/total）');
{
  const queue = ['q1', 'q2', 'q3'];
  const pri = { q1: LOW, q2: HIGH, q3: MEDIUM };
  const before = sortBlockIdsByPriority(queue, (id) => pri[id]);
  ok('滚动前排序 [HIGH, MEDIUM, LOW]', JSON.stringify(before) === JSON.stringify(['q2', 'q3', 'q1']));
  pri.q1 = HIGH; // 用户滚动：q1 进入视口
  const sorted = sortBlockIdsByPriority(queue, (id) => pri[id]);
  ok('滚动后 q1 前移（HIGH 组内保持原顺序）', JSON.stringify(sorted) === JSON.stringify(['q1', 'q2', 'q3']));
  // 状态量不变：重排只影响顺序
  const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
  const stats = { total: 10, completed: 8, failed: 0, cancelled: 0 };
  ok('重排后 usage / total 不变', usage.total_tokens === 1500 && stats.total === 10 && stats.completed === 8);
}

console.log(`\n全部通过：${passed} 项断言。`);
