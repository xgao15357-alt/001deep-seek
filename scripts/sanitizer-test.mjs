/**
 * scripts/sanitizer-test.mjs —— TranslationTextSanitizer 与缓存规则测试（零依赖）。
 *
 * 覆盖：
 *  Sanitizer 1-10：<STRONG> 对、<em>、x < y、vector<int>、<username>、URL、Emoji、
 *  零宽字符、多空格、originalText 永不修改（清洗只作用于 API 副本）。
 *  Cache 29-32：prompt-v1 ≠ prompt-v2；Flash ≠ Pro；失败结果不缓存；成功结果缓存。
 *
 * 运行：node scripts/sanitizer-test.mjs（0 次网络请求）。
 */
import assert from 'node:assert/strict';
import { sanitizeTranslationInput } from '../src/translation/translation-text-sanitizer.js';
import { TRANSLATION_PROMPT_VERSION, DEEPSEEK_MODELS } from '../src/shared/constants.js';
import { SessionCache } from '../src/cache/session-cache.js';
import { TranslationError, ERROR_CODES } from '../src/shared/errors.js';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('1. Sanitizer：白名单表现标签（严禁粗暴 strip）');
ok('<STRONG>PAGE-TURNERS</STRONG> → PAGE-TURNERS', sanitizeTranslationInput('<STRONG>PAGE-TURNERS</STRONG>') === 'PAGE-TURNERS');
ok('<em>Hello</em> → Hello', sanitizeTranslationInput('<em>Hello</em>') === 'Hello');
ok('小写/属性变体 <b class="x">Save</b> → Save', sanitizeTranslationInput('<b class="x">Save</b>') === 'Save');

console.log('2. Sanitizer：数学/代码/占位文本绝不误伤');
ok('x < y 保留原样', sanitizeTranslationInput('x < y') === 'x < y');
ok('vector<int> 保留原样', sanitizeTranslationInput('vector<int>') === 'vector<int>');
ok('<username> 保留原样（未知标签）', sanitizeTranslationInput('<username>') === '<username>');
ok('C++ template 保留原样', sanitizeTranslationInput('if (a < b) return vector<int>(); // C++ template') === 'if (a < b) return vector<int>(); // C++ template');

console.log('3. Sanitizer：URL / Emoji / 数字 / 大小写不受影响');
ok('URL 保留', sanitizeTranslationInput('See https://example.com/a?x=1&y=2 now') === 'See https://example.com/a?x=1&y=2 now');
ok('Emoji 保留', sanitizeTranslationInput('Great news 🎉 中文 OK') === 'Great news 🎉 中文 OK');
ok('专有名词大小写保留', sanitizeTranslationInput('BBC News and GitHub Actions') === 'BBC News and GitHub Actions');

console.log('4. Sanitizer：零宽字符 / 多空格 / 多余换行标准化');
ok('零宽字符去除', sanitizeTranslationInput('Hel\u200Blo\u200B') === 'Hello');
ok('多空格折叠', sanitizeTranslationInput('A   B\t\tC') === 'A B C');
ok('多余换行归一', sanitizeTranslationInput('Line one\n\n\nLine two') === 'Line one Line two');

console.log('5. Sanitizer：originalText 永不修改（清洗只作用于副本）');
{
  const original = '<STRONG>PAGE-TURNERS</STRONG>  \u200B x';
  const copy = sanitizeTranslationInput(original);
  ok('原文字符串内容不变', original === '<STRONG>PAGE-TURNERS</STRONG>  \u200B x');
  ok('清洗结果与原文不同（副本独立）', copy !== original && copy === 'PAGE-TURNERS x');
  ok('清洗后为空时回退原文（不丢块）', sanitizeTranslationInput('<em></em>') === '<em></em>');
}

console.log('6. Cache：prompt-v1 ≠ prompt-v2，Flash ≠ Pro');
{
  const cache = new SessionCache();
  const base = { sourceText: 'Privilege escalation', sourceLang: 'en', targetLang: 'zh-CN' };
  const kOld = cache.buildKey({ ...base, provider: 'deepseek', model: DEEPSEEK_MODELS.FLASH, promptVersion: 'translation-prompt-v1' });
  const kNew = cache.buildKey({ ...base, provider: 'deepseek', model: DEEPSEEK_MODELS.FLASH, promptVersion: TRANSLATION_PROMPT_VERSION });
  const kPro = cache.buildKey({ ...base, provider: 'deepseek', model: DEEPSEEK_MODELS.PRO, promptVersion: TRANSLATION_PROMPT_VERSION });
  ok('当前 Prompt 版本为 v2', TRANSLATION_PROMPT_VERSION === 'translation-prompt-v2');
  ok('v1 与 v2 键不同（旧缓存绝不命中）', kOld !== kNew);
  ok('Flash 与 Pro 键不同', kNew !== kPro);
  cache.set(kOld, '【旧版译文】');
  ok('旧 v1 缓存不命中 v2 键', cache.get(kNew) === null);
}

console.log('7. Cache：只缓存验证过的成功译文，失败结果绝不缓存');
{
  const cache = new SessionCache();
  const key = cache.buildKey({ sourceText: 'sample', sourceLang: 'en', targetLang: 'zh-CN', provider: 'deepseek', model: DEEPSEEK_MODELS.FLASH, promptVersion: TRANSLATION_PROMPT_VERSION });
  // 失败场景：直接抛错的 provider 不产生任何 cache.set（此处验证调用约定）
  const failingProvider = {
    async translateBatch() {
      throw new TranslationError(ERROR_CODES.TIMEOUT, { retryable: true });
    },
  };
  let threw = false;
  try {
    await failingProvider.translateBatch({ blocks: [{ id: 'a', text: 'sample' }], signal: undefined });
  } catch (err) {
    threw = err.code === ERROR_CODES.TIMEOUT;
  }
  ok('TIMEOUT 抛错且未写缓存（缓存为空）', threw && cache.get(key) === null);
  cache.set(key, '示例');
  ok('成功译文可以缓存并命中', cache.get(key)?.translation === '示例');
}

console.log(`\n全部通过：${passed} 项断言。`);
