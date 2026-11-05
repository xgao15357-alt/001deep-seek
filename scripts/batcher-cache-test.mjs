/**
 * scripts/batcher-cache-test.mjs —— TranslationBatcher 分批 + 响应完整性分类 + 缓存键隔离（零依赖）。
 *
 * 运行：node scripts/batcher-cache-test.mjs
 */
import assert from 'node:assert/strict';
import { buildBatches, classifyBatchResponse } from '../src/translation/translation-batcher.js';
import { SessionCache } from '../src/cache/session-cache.js';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const block = (i, len = 10) => ({ id: `aiwt-block-${String(i).padStart(6, '0')}`, text: 'x'.repeat(len) });

console.log('1. buildBatches：数量 / 字符双上限');
{
  const many = Array.from({ length: 25 }, (_, i) => block(i + 1, 10));
  const byCount = buildBatches(many, { maxBlocks: 12, maxChars: 12000 });
  ok('25 块 → [12, 12, 1]', byCount.length === 3 && byCount[0].length === 12 && byCount[1].length === 12 && byCount[2].length === 1);

  const byChars = buildBatches([block(1, 5000), block(2, 5000), block(3, 5000)], { maxBlocks: 12, maxChars: 12000 });
  ok('字符上限 12000 → [[b1,b2],[b3]]', byChars.length === 2 && byChars[0].length === 2 && byChars[1].length === 1);

  const bySmallMaxBlocks = buildBatches([block(1), block(2), block(3), block(4), block(5)], { maxBlocks: 2, maxChars: 12000 });
  ok('maxBlocks=2 → [2,2,1]', bySmallMaxBlocks.length === 3 && bySmallMaxBlocks[2].length === 1);

  const oversized = buildBatches([block(1, 15000)], { maxBlocks: 12, maxChars: 12000 });
  ok('超长单块独占一个 batch', oversized.length === 1 && oversized[0].length === 1);

  const ids = byCount.flat().map((b) => b.id);
  ok('分批不丢 id、不改变块内容绑定', new Set(ids).size === 25 && byCount.flat().every((b, i) => b.text.length === 10));
}

console.log('2. classifyBatchResponse：成功 / 缺失 / 重复 / 未知 / 非法');
{
  const requested = ['a', 'b', 'c'];
  const ok2 = classifyBatchResponse(requested, [
    { id: 'a', text: '一' },
    { id: 'b', text: '二' },
    { id: 'c', text: '三' },
  ]);
  ok('完整返回：全部成功', ok2.successful.length === 3 && ok2.missing.length === 0);

  const missing = classifyBatchResponse(requested, [{ id: 'a', text: '一' }, { id: 'b', text: '二' }]);
  ok('缺失 id 被单独列出（绝不顺延错位）', missing.successful.length === 2 && JSON.stringify(missing.missing) === JSON.stringify(['c']));

  const unknown = classifyBatchResponse(['a'], [{ id: 'a', text: '一' }, { id: 'zzz', text: '?' }]);
  ok('未知 id 单独列出且不混入成功结果', unknown.successful.length === 1 && JSON.stringify(unknown.unknown) === JSON.stringify(['zzz']));

  const dup = classifyBatchResponse(['a', 'b'], [{ id: 'a', text: '一' }, { id: 'a', text: '二' }]);
  ok('重复 id 单独列出', JSON.stringify(dup.duplicate) === JSON.stringify(['a']));

  const invalid = classifyBatchResponse(['a'], [{ text: '缺 id' }, { id: 'a', text: 123 }, { id: 'a', text: '   ' }, null]);
  ok('非法条目（缺 id/非字符串/空文本/null）全部归入 invalid', invalid.invalid.length === 4);

  const reversed = classifyBatchResponse(['a', 'b'], [{ id: 'b', text: '二' }, { id: 'a', text: '一' }]);
  ok('乱序返回仍按 id 精确匹配（绝不依赖数组顺序）', reversed.successful[0].id === 'b' && reversed.successful[1].id === 'a');
}

console.log('3. SessionCache key 隔离（Mock ≠ DeepSeek；Flash ≠ Pro；prompt 版本失效）');
{
  const cache = new SessionCache();
  const base = { sourceText: 'Privilege escalation', sourceLang: 'en', targetLang: 'zh-CN' };
  const kMock = cache.buildKey({ ...base, provider: 'mock', model: 'mock-v1', promptVersion: 'translation-prompt-v1' });
  const kFlash = cache.buildKey({ ...base, provider: 'deepseek', model: 'deepseek-v4-flash', promptVersion: 'translation-prompt-v1' });
  const kFlash2 = cache.buildKey({ ...base, provider: 'deepseek', model: 'deepseek-v4-flash', promptVersion: 'translation-prompt-v1' });
  const kPro = cache.buildKey({ ...base, provider: 'deepseek', model: 'deepseek-v4-pro', promptVersion: 'translation-prompt-v1' });
  const kPromptV2 = cache.buildKey({ ...base, provider: 'deepseek', model: 'deepseek-v4-flash', promptVersion: 'translation-prompt-v2' });
  ok('四种键互不相同', new Set([kMock, kFlash, kPro, kPromptV2]).size === 4);
  ok('相同输入产生相同键', kFlash === kFlash2);

  cache.set(kMock, '【模拟译文】Privilege escalation');
  ok('Mock 缓存绝不命中 DeepSeek 键', cache.get(kFlash) === null);
  cache.set(kFlash, '权限提升');
  ok('DeepSeek Flash 键命中', cache.get(kFlash)?.translation === '权限提升');
  ok('Flash 缓存绝不命中 Pro 键', cache.get(kPro) === null);
  ok('prompt/schema 版本变化 → cache miss', cache.get(kPromptV2) === null);
}

console.log(`\n全部通过：${passed} 项断言。`);
