/**
 * scripts/mode-switch-test.mjs —— 显示模式切换矩阵测试（零依赖，Node 运行）。
 *
 * 复现 Phase 2 实机验收发现的模式切换 Bug 场景并断言修复行为：
 *  10 个 block 完成 Mock 翻译后，在 Bilingual / Translation Only / Original 之间
 *  任意切换都必须完全非破坏性：
 *   - 不修改原文 Text Node 内容（0 次 characterData 变更 → Observer 不会误判失效）；
 *   - 不删除译文节点 / 不清空 block.translation / 不改变任务状态（completed）；
 *   - 不重新调用 Provider、不重启 Scheduler、不清 SessionCache、不重新排队；
 *   - 进度保持 10/10；每个 DOM block 恰好一个 wrapper + 一个译文 span；
 *   - body 的 aiwt-mode-* 类 + 注入 CSS 规则共同保证“显示内容符合模式要求”。
 *
 * 运行：node scripts/mode-switch-test.mjs
 * 说明：测试内置一个仅覆盖 DomRenderer 所需 API 的最小 DOM 桩（无任何第三方依赖）。
 */
import assert from 'node:assert/strict';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 先动态 import 经典脚本模块（IIFE 挂到 globalThis.__AIWT__），再注入 fake document
await import('../src/content/dom-renderer.js');
await import('../src/content/text-block-manager.js');
const NS = globalThis.__AIWT__;
const DomRenderer = NS.DomRenderer;
const TextBlockManager = NS.TextBlockManager;
const BLOCK_STATUS = NS.BLOCK_STATUS;

// ---- 最小 DOM 桩（只覆盖渲染器用到的 API，并记录 mutation 事件）----
class FakeDoc {
  constructor() {
    this.attributeChanges = [];
    this.characterDataChanges = [];
    this.childListChanges = [];
  }
  createElement(tag) {
    return new FakeNode(this, 1, tag);
  }
  createTextNode(value) {
    const n = new FakeNode(this, 3, null);
    n._nodeValue = value; // 创建不视为“数据变更”
    return n;
  }
}

class FakeNode {
  constructor(doc, nodeType, tag) {
    this._doc = doc;
    this.nodeType = nodeType;
    this.tagName = tag ? String(tag).toUpperCase() : null;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this._nodeValue = null;
    this.classList = {
      add: (...xs) => {
        const cur = new Set((this.attributes.get('class') || '').split(/\s+/).filter(Boolean));
        xs.forEach((x) => cur.add(x));
        this.attributes.set('class', Array.from(cur).join(' '));
        this._doc.attributeChanges.push({ el: this });
      },
      remove: (...xs) => {
        const cur = new Set((this.attributes.get('class') || '').split(/\s+/).filter(Boolean));
        xs.forEach((x) => cur.delete(x));
        this.attributes.set('class', Array.from(cur).join(' '));
        this._doc.attributeChanges.push({ el: this });
      },
      contains: (x) => (this.attributes.get('class') || '').split(/\s+/).includes(x),
    };
  }

  get nodeValue() {
    return this._nodeValue;
  }

  set nodeValue(v) {
    if (this._nodeValue !== v) {
      this._nodeValue = v;
      this._doc.characterDataChanges.push({ node: this, value: v }); // 模拟 characterData mutation
    }
  }

  get textContent() {
    if (this.nodeType === 3) return this._nodeValue ?? '';
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(v) {
    if (this.nodeType === 3) {
      this.nodeValue = v;
      return;
    }
    this.children = [this._doc.createTextNode(String(v))];
    this._doc.childListChanges.push({ parent: this });
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i >= 0 ? (this.parentNode.children[i + 1] ?? null) : null;
  }

  get isConnected() {
    let n = this;
    while (n) {
      if (n === this._doc.body) return true;
      n = n.parentNode;
    }
    return false;
  }

  appendChild(c) {
    return this.insertBefore(c, null);
  }

  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, c);
    else this.children.push(c);
    this._doc.childListChanges.push({ parent: this, added: [c], removed: [] });
    return c;
  }

  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i < 0) return c;
    this.children.splice(i, 1);
    c.parentNode = null;
    this._doc.childListChanges.push({ parent: this, added: [], removed: [c] });
    return c;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChild(nc, oc) {
    if (nc.parentNode) nc.parentNode.removeChild(nc);
    const i = this.children.indexOf(oc);
    nc.parentNode = this;
    if (i >= 0) this.children[i] = nc;
    else this.children.push(nc);
    oc.parentNode = null;
    this._doc.childListChanges.push({ parent: this, added: [nc], removed: [oc] });
    return oc;
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }

  hasAttribute(k) {
    return this.attributes.has(k);
  }
}

const doc = new FakeDoc();
const body = doc.createElement('body');
doc.body = body;
globalThis.document = doc;

// ---- 页面：10 个 <p>，各含一个英文 Text Node ----
const paragraphs = [];
for (let i = 1; i <= 10; i += 1) {
  const p = doc.createElement('p');
  const node = doc.createTextNode(`Privilege escalation example sentence ${i}`);
  p.appendChild(node);
  body.appendChild(p);
  paragraphs.push({ p, node });
}

// ---- 真实完成翻译（复用 SW 的调度 + 缓存逻辑，不含 chrome.*）----
const { MockTranslationProvider } = await import('../src/translation/mock-provider.js');
const { TranslationScheduler } = await import('../src/translation/translation-scheduler.js');
const { SessionCache } = await import('../src/cache/session-cache.js');

const cache = new SessionCache();
let providerCalls = 0;
const provider = new MockTranslationProvider({ minDelayMs: 1, maxDelayMs: 2, failRatio: 0 });
const scheduler = new TranslationScheduler({ maxConcurrency: 2 });
const store = new TextBlockManager();
const renderer = new DomRenderer();

for (let i = 0; i < paragraphs.length; i += 1) {
  const { node } = paragraphs[i];
  const id = `aiwt-block-${String(i + 1).padStart(6, '0')}`;
  const text = node.nodeValue.trim();
  const record = store.register({ id, node, text, normalizedText: text });
  const cacheKey = cache.buildKey({
    sourceText: text,
    sourceLang: 'en',
    targetLang: 'zh-CN',
    provider: 'mock',
    model: provider.model,
    promptVersion: 'translation-prompt-v1',
  });
  await scheduler.schedule({
    taskId: id,
    execute: async () => {
      const hit = cache.get(cacheKey);
      if (hit) return hit.translation;
      providerCalls += 1;
      const [translation] = await provider.translate([text]);
      cache.set(cacheKey, translation);
      return translation;
    },
    onResult: (translation) => {
      record.translation = translation;
      record.status = BLOCK_STATUS.COMPLETED;
      renderer.ensureSpan(record);
    },
    onError: () => {},
  });
}

ok('初始：10 块全部完成并渲染（Provider 调用 10 次）', store.size === 10 && providerCalls === 10);
ok('初始：进度 10/10，全部 completed', scheduler.stats().completed === 10 && store.records().every((r) => r.status === BLOCK_STATUS.COMPLETED));

const baseline = {
  providerCalls,
  cacheSize: cache.size,
  schedulerStats: scheduler.stats(),
  charData: doc.characterDataChanges.length,
  childList: doc.childListChanges.length,
};

/** 每个 block 的 AIWT 自有节点数（wrapper + span，防重复译文）。 */
function ownedNodesForBlock(record) {
  const parent = record.wrapper ? record.wrapper.parentElement : null;
  if (!parent) return [];
  return parent.children.filter(
    (c) =>
      c.hasAttribute('data-aiwt-block-id') &&
      c.getAttribute('data-aiwt-block-id') === record.id
  );
}

/** 模式切换后全量不变量断言（每个 block 的细项聚合成一行，避免日志刷屏）。 */
function assertInvariants(stepName, mode) {
  ok(`${stepName}：Provider 调用次数不增加（${providerCalls}）`, providerCalls === baseline.providerCalls);
  const st = scheduler.stats();
  ok(`${stepName}：Scheduler 不重启（10 完成 0 失败 0 取消）`, st.total === 10 && st.completed === 10 && st.failed === 0 && st.cancelled === 0 && scheduler.stopped === false);
  ok(`${stepName}：block 数量不减少（10）`, store.size === 10);
  ok(`${stepName}：SessionCache 不变化（${cache.size}）`, cache.size === baseline.cacheSize);
  ok(`${stepName}：进度保持 10/10`, st.completed === 10 && st.total === 10);
  const allBlocksOk = store.records().every(
    (r) =>
      typeof r.translation === 'string' &&
      r.translation.length > 0 &&
      r.status === BLOCK_STATUS.COMPLETED &&
      r.node.isConnected &&
      r.node.nodeValue.trim() === r.text &&
      r.wrapper &&
      r.wrapper.isConnected &&
      r.span &&
      r.span.isConnected &&
      ownedNodesForBlock(r).length === 2
  );
  ok(`${stepName}：10 个 block 的 translation/状态/原文内容/节点/无重复全部保持`, allBlocksOk);
  ok(`${stepName}：切换未产生任何 characterData 变更（Observer 不会误判原文被改）`, doc.characterDataChanges.length === baseline.charData);
  ok(`${stepName}：切换未产生任何 childList 变更（无节点增删）`, doc.childListChanges.length === baseline.childList);
  ok(`${stepName}：没有任务被重新排队（pendingCandidates=0）`, store.pendingCandidates().length === 0);
  ok(`${stepName}：body 模式类 = ${mode}`, body.classList.contains(`aiwt-mode-${mode}`));
}

console.log('1. 显示模式切换矩阵（7 条路径，每条切换后全量断言）');
const SEQUENCES = [
  { name: 'Bilingual → Translation Only', steps: ['bilingual', 'targetOnly'] },
  { name: 'Translation Only → Original', steps: ['targetOnly', 'original'] },
  { name: 'Original → Bilingual', steps: ['original', 'bilingual'] },
  { name: 'Bilingual → Original → Bilingual', steps: ['bilingual', 'original', 'bilingual'] },
  { name: 'Bilingual → Translation Only → Bilingual', steps: ['bilingual', 'targetOnly', 'bilingual'] },
  { name: 'Original → Translation Only', steps: ['original', 'targetOnly'] },
  { name: 'Translation Only → Original → Translation Only', steps: ['targetOnly', 'original', 'targetOnly'] },
];
for (const seq of SEQUENCES) {
  for (const m of seq.steps) {
    renderer.applyMode(m);
    assertInvariants(`${seq.name} → ${m}`, m);
  }
}

console.log('2. CSS 可见性契约（模式 → 显示内容的最终依据）');
const { AIWT_STYLES } = await import('../src/page/aiwt-styles.js');
const css = AIWT_STYLES.replace(/\s+/g, ' ');
ok('targetOnly：隐藏原文 wrapper（译文可见）', css.includes('body.aiwt-mode-targetOnly .aiwt-original { display: none !important; }'));
ok('original：隐藏全部译文（原文可见）', css.includes('body.aiwt-mode-original .aiwt-translation { display: none !important; }'));

console.log('3. 网站修改原文 → 旧译文失效后的重渲染保持布局（不丢 wrapper/布局）');
const rec0 = store.records()[0];
renderer.removeTranslation(rec0);
ok('失效时只移除译文 span', rec0.span === null && rec0.wrapper && rec0.wrapper.isConnected);
rec0.translation = '【模拟译文】updated text';
renderer.ensureSpan(rec0);
ok('重渲染复用 wrapper 且保持 block 布局', rec0.wrapper.isConnected && rec0.span.classList.contains('aiwt-block'));
ok('重渲染后仍无重复节点', ownedNodesForBlock(rec0).length === 2);

console.log('4. 恢复原文（与显示模式彻底分离的独立动作）');
renderer.restoreAll(store.records());
for (let i = 0; i < store.records().length; i += 1) {
  const r = store.records()[i];
  ok(`块 ${i + 1}：原文节点回到原 <p> 直属`, r.node.isConnected && r.node.parentElement === paragraphs[i].p);
  ok(`块 ${i + 1}：原文内容完整`, r.node.nodeValue.trim() === r.text);
  ok(`块 ${i + 1}：AIWT 节点引用清空`, r.wrapper === null && r.span === null);
}
ok('恢复后 body 模式类清除', !body.classList.contains('aiwt-mode-targetOnly') && !body.classList.contains('aiwt-mode-original'));
ok('恢复过程同样未修改原文内容（0 characterData）', doc.characterDataChanges.length === baseline.charData);

console.log(`\n全部通过：${passed} 项断言。`);
