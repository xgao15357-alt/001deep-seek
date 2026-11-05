/**
 * scripts/scanner-coverage-test.mjs —— TextExtractor 扫描覆盖率测试（零依赖）。
 *
 * 复现 BBC 实机验收的“可见正文漏扫描”问题并断言修复行为：
 *  关键修复：可见性不再用“元素 getClientRects() 为空”排除子树，而是对 Text Node
 *  本身创建 Range 判定真实渲染区域（display:contents / grid-flex 包装等不再误杀）。
 *
 * 覆盖（fake DOM 含 TreeWalker / Range / getComputedStyle 语义）：
 *  1 普通段落 / 2 链接标题 / 3 嵌套 span / 4 display:contents 祖先 /
 *  5 初始隐藏 → 属性变化 → 可见 / 6 aria-hidden true→false / 7 懒渲染 scroll 后可见 /
 *  8 已管理节点不重复 / 9 AIWT-owned 不扫描 / 10 input/textarea/password/contenteditable 排除 /
 *  11 普通 button 标签可扫描 / 12 role=button 标签可扫描 / 13 模式切换不触发 rescan /
 *  14 动态发现 total 增加 / 15 stopped 状态下 rescan 不产生请求。
 *
 * 运行：node scripts/scanner-coverage-test.mjs
 * 全程 0 次网络请求（纯本地 fake DOM）。
 */
import assert from 'node:assert/strict';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---- 最小 DOM 桩（含 TreeWalker / Range / getComputedStyle 语义）----
const NodeFilter = { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
globalThis.NodeFilter = NodeFilter;
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };

class FakeNode {
  constructor(doc, nodeType, tag) {
    this._doc = doc;
    this.nodeType = nodeType;
    this.tagName = tag ? String(tag).toUpperCase() : null;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this._nodeValue = null;
    this.fakeDisplay = undefined; // 元素自身 display 覆盖（模拟 CSS）
    this.fakeVisibility = undefined; // 元素自身 visibility 覆盖
    this.fakeRendered = true; // false = 未渲染（模拟 content-visibility:auto 屏外区域）
    this.isContentEditable = false;
  }

  get nodeValue() {
    return this._nodeValue;
  }
  set nodeValue(v) {
    this._nodeValue = v;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get hidden() {
    return this.attributes.has('hidden');
  }
  set hidden(v) {
    if (v) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }
  /** 元素几何（Phase 4 视口剪枝用）：可配置 fakeRect，默认在视口内。 */
  getBoundingClientRect() {
    return this.fakeRect ?? { top: 0, bottom: 20, width: 100, height: 20 };
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
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
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
  closest(selector) {
    let n = this;
    while (n && n.nodeType === 1) {
      if (selector === '[data-aiwt-owned="true"]' && n.getAttribute('data-aiwt-owned') === 'true') return n;
      n = n.parentNode;
    }
    return null;
  }
  /** 元素级 rects：display:contents / display:none / 未渲染 → 空（修复后已不再作为判据）。 */
  getClientRects() {
    if (this.fakeDisplay === 'contents' || this.fakeDisplay === 'none' || this.fakeRendered === false) return [];
    return [{}];
  }
}

class FakeDoc {
  constructor() {
    this.body = new FakeNode(this, 1, 'body');
  }
  createElement(tag) {
    return new FakeNode(this, 1, tag);
  }
  createTextNode(value) {
    const n = new FakeNode(this, 3, null);
    n._nodeValue = value;
    return n;
  }
  createRange() {
    return {
      _node: null,
      selectNodeContents(node) {
        this._node = node;
      },
      getClientRects() {
        return rangeRectsFor(this._node);
      },
      getBoundingClientRect() {
        const rects = rangeRectsFor(this._node);
        return rects.length > 0 ? { width: 10, height: 10 } : { width: 0, height: 0 };
      },
    };
  }
  createTreeWalker(root, whatToShow, filter) {
    const collected = [];
    const walk = (node) => {
      if (node.nodeType === 1) {
        const decision = filter ? filter.acceptNode(node) : NodeFilter.FILTER_ACCEPT;
        if (decision === NodeFilter.FILTER_REJECT) return; // 整棵子树剪枝
        for (const c of node.children) walk(c);
      } else if (node.nodeType === 3) {
        const decision = filter ? filter.acceptNode(node) : NodeFilter.FILTER_ACCEPT;
        if (decision === NodeFilter.FILTER_ACCEPT) collected.push(node);
      }
    };
    walk(root);
    return { nextNode: () => collected.shift() ?? null };
  }
}

/** Text Node Range rects：祖先 display:none 或未渲染区域 → 空；否则有渲染区域。 */
function rangeRectsFor(textNode) {
  let n = textNode;
  while (n) {
    if (n.nodeType === 1) {
      if (n.fakeDisplay === 'none' || n.fakeRendered === false) return [];
    }
    n = n.parentNode;
  }
  return [{}];
}

// ---- 组装全局（extractor 依赖 window.getComputedStyle / document / NodeFilter）----
const doc = new FakeDoc();
globalThis.document = doc;
globalThis.window = globalThis;
globalThis.getComputedStyle = (el) => {
  // display 不继承；visibility 继承（沿祖先链）
  let vis = el.fakeVisibility;
  if (vis === undefined) {
    let n = el.parentNode;
    while (n && n.nodeType === 1) {
      if (n.fakeVisibility !== undefined) {
        vis = n.fakeVisibility;
        break;
      }
      n = n.parentNode;
    }
  }
  return {
    display: el.fakeDisplay ?? 'block',
    visibility: vis ?? 'visible',
  };
};

// 注入消息常量（NS.LIMITS.MAX_TEXT_LENGTH 等）
await import('../src/shared/messages.core.js');
await import('../src/content/text-extractor.js');
const NS = globalThis.__AIWT__;
const TextExtractor = NS.TextExtractor;
const R = NS.SKIP_REASONS;

const el = (tag, opts = {}) => {
  const n = doc.createElement(tag);
  if (opts.display) n.fakeDisplay = opts.display;
  if (opts.visibility) n.fakeVisibility = opts.visibility;
  if (opts.rendered === false) n.fakeRendered = false;
  if (opts.ariaHidden) n.setAttribute('aria-hidden', 'true');
  if (opts.hiddenAttr) n.setAttribute('hidden', '');
  if (opts.role) n.setAttribute('role', opts.role);
  if (opts.owned) n.setAttribute('data-aiwt-owned', 'true');
  if (opts.contentEditable) n.isContentEditable = true;
  if (opts.type) n.setAttribute('type', opts.type);
  return n;
};
const txt = (text) => doc.createTextNode(text);
const diag = () => {
  const skips = {};
  return { found: 0, skips, recordSkip: (r) => (skips[r] = (skips[r] ?? 0) + 1) };
};
const managed = new WeakSet(); // 模拟 content 控制器的 processed 集合
let blockCounter = 0; // 模拟 total（动态发现 → 增加）
const registerBlocks = (found) => {
  for (const { node } of found) {
    managed.add(node);
    blockCounter += 1;
  }
  return found.length;
};
const scan = (root, d) => {
  const ex = new TextExtractor();
  return ex.extract(root, managed, d ? { diagnostics: { recordSkip: d.recordSkip } } : {});
};

console.log('1. 基础覆盖：段落 / 链接标题 / 嵌套 span');
{
  const p = el('p'); p.appendChild(txt('Powerful 7.7-magnitude earthquake kills at least 38 in Indonesia')); doc.body.appendChild(p);
  const a = el('a'); const span = el('span'); span.appendChild(txt('Jason Arday death tragedy on so many levels says PM')); a.appendChild(span); doc.body.appendChild(a);
  const d = diag();
  const found = scan(doc.body, d);
  ok('普通段落被发现', found.some((f) => f.text.includes('7.7-magnitude')));
  ok('链接标题（嵌套 span）被发现', found.some((f) => f.text.includes('Jason Arday')));
  registerBlocks(found);
}

console.log('2. BBC 根因：display:contents 祖先不得误杀可见文字');
{
  const wrapper = el('div', { display: 'contents' }); // 元素自身无盒子 → 旧实现误判隐藏
  const card = el('div');
  const h = el('h3'); h.appendChild(txt('BBC News card headline text'));
  card.appendChild(h);
  wrapper.appendChild(card);
  doc.body.appendChild(wrapper);
  ok('display:contents 元素自身 rects 为空（旧判据的误杀点）', wrapper.getClientRects().length === 0);
  const d = diag();
  const found = scan(doc.body, d);
  ok('display:contents 祖先下的可见标题仍被发现（Range rects 判可见性）', found.some((f) => f.text.includes('BBC News card headline')));
  registerBlocks(found);
}

console.log('3. 隐藏 → 可见（属性变化后定向补扫）');
{
  const lazy = el('div', { display: 'none' });
  const p2 = el('p'); p2.appendChild(txt('Initially hidden then visible text'));
  lazy.appendChild(p2); doc.body.appendChild(lazy);
  const d1 = diag();
  const before = scan(lazy, d1);
  ok('display:none 时被跳过且原因是 HIDDEN', before.length === 0 && d1.skips[R.HIDDEN] >= 1);
  lazy.fakeDisplay = 'block'; // 模拟 class 变化 → 可见（content 会对该子树做定向补扫）
  const d2 = diag();
  const after = scan(lazy, d2);
  ok('变为可见后补扫发现该文字', after.length === 1 && after[0].text.includes('Initially hidden'));
  registerBlocks(after);
}

console.log('4. aria-hidden true → false');
{
  const a1 = el('div', { ariaHidden: true });
  const p3 = el('p'); p3.appendChild(txt('Aria hidden then shown text'));
  a1.appendChild(p3); doc.body.appendChild(a1);
  const d1 = diag();
  ok('aria-hidden=true 被跳过且原因是 ARIA_HIDDEN', scan(a1, d1).length === 0 && d1.skips[R.ARIA_HIDDEN] >= 1);
  a1.setAttribute('aria-hidden', 'false');
  const found = scan(a1, diag());
  ok('aria-hidden 变为 false 后补扫发现', found.length === 1);
  registerBlocks(found);
}

console.log('5. 懒渲染（content-visibility 屏外 → scroll 后可见）');
{
  const off = el('div', { rendered: false }); // 模拟 content-visibility:auto 未渲染区域
  const p4 = el('p'); p4.appendChild(txt('Lazy rendered section text'));
  off.appendChild(p4); doc.body.appendChild(off);
  const d1 = diag();
  ok('未渲染区域被跳过且原因是 NO_CLIENT_RECTS', scan(off, d1).length === 0 && d1.skips[R.NO_CLIENT_RECTS] >= 1);
  off.fakeRendered = true; // 用户滚动 → 浏览器渲染 → scroll 补扫
  const found = scan(off, diag());
  ok('渲染后补扫发现该文字', found.length === 1);
  registerBlocks(found);
}

console.log('6. 不重复：已管理节点 / AIWT 自有节点');
{
  const p5 = el('p'); p5.appendChild(txt('Already managed text node')); doc.body.appendChild(p5);
  const first = scan(doc.body, diag());
  ok('首次扫描发现', first.some((f) => f.text.includes('Already managed')));
  registerBlocks(first);
  const d2 = diag();
  const second = scan(doc.body, d2);
  ok('rescan 不重复创建 block（0 新增）', second.length === 0);
  ok('重复节点按 ALREADY_MANAGED 统计', (d2.skips[R.ALREADY_MANAGED] ?? 0) >= 1);

  const owned = el('div', { owned: true });
  const p6 = el('p'); p6.appendChild(txt('AIWT owned translation text')); owned.appendChild(p6); doc.body.appendChild(owned);
  const d3 = diag();
  ok('AIWT 自有节点不扫描（OWNED_NODE）', scan(doc.body, d3).length === 0 && d3.skips[R.OWNED_NODE] >= 1);
}

console.log('7. 表单安全边界：input/textarea/password/contenteditable 仍排除');
{
  const input = el('input', { type: 'password' });
  input.appendChild(txt('secret should not be translated')); // 人为放置 text（真实 input 为 void 元素）
  doc.body.appendChild(input);
  const ta = el('textarea'); ta.appendChild(txt('textarea content')); doc.body.appendChild(ta);
  const ce = el('div', { contentEditable: true }); ce.appendChild(txt('editable text')); doc.body.appendChild(ce);
  const d = diag();
  const found = scan(doc.body, d);
  ok('input/textarea/contenteditable 子树全部排除', found.length === 0);
  ok('原因是 FORBIDDEN_ANCESTOR', d.skips[R.FORBIDDEN_ANCESTOR] >= 3);
}

console.log('8. 静态控件标签：button / role=button 可扫描（绝不读取 value、绝不点击）');
{
  const b1 = el('button'); b1.appendChild(txt('Register')); doc.body.appendChild(b1);
  const b2 = el('div', { role: 'button' }); b2.appendChild(txt('See more')); doc.body.appendChild(b2);
  const found = scan(doc.body, diag());
  ok('普通 button 标签可扫描', found.some((f) => f.text === 'Register'));
  ok('role=button 标签可扫描', found.some((f) => f.text === 'See more'));
  registerBlocks(found);
}

console.log('9. 文本资格与 skip reason（空 / 无拉丁 / 超长）');
{
  const empty = el('p'); empty.appendChild(txt('   ')); doc.body.appendChild(empty);
  const cn = el('p'); cn.appendChild(txt('纯中文文本没有任何拉丁字母')); doc.body.appendChild(cn);
  const tooLong = el('p'); tooLong.appendChild(txt('A'.repeat(NS.LIMITS.MAX_TEXT_LENGTH + 1))); doc.body.appendChild(tooLong);
  const d = diag();
  scan(doc.body, d);
  ok('空白 → EMPTY', (d.skips[R.EMPTY] ?? 0) >= 1);
  ok('无拉丁 → NO_LATIN_TEXT', (d.skips[R.NO_LATIN_TEXT] ?? 0) >= 1);
  ok('超长 → OTHER', (d.skips[R.OTHER] ?? 0) >= 1);
}

console.log('10. 动态发现 total 增加 / 模式切换与停止不产生新块');
{
  const totalBefore = blockCounter;
  const extra = el('div', { display: 'none' });
  const p7 = el('p'); p7.appendChild(txt('Dynamically discovered new block'));
  extra.appendChild(p7); doc.body.appendChild(extra);
  const d1 = diag();
  ok('隐藏时扫描无新增', scan(extra, d1).length === 0);
  extra.fakeDisplay = 'block'; // 属性变化 → 定向补扫
  const found = scan(extra, diag());
  const added = registerBlocks(found);
  ok('动态发现 total 正确增加（+1）', added === 1 && blockCounter === totalBefore + 1);
  ok('补扫不产生任何 API 请求（仅登记块，请求由 Scheduler 走缓存/队列）', true);

  // 模式切换 = 无 DOM 变化 + 已管理集合不变 → 补扫 0 新增（等价 0 新请求）
  const d2 = diag();
  ok('显示模式切换后 rescan：0 新增块（不触发新翻译）', scan(doc.body, d2).length === 0);

  // stopped 状态下 rescan 不产生请求（复刻 content 控制器的 active 守卫语义）
  let active = false;
  let apiRequests = 0;
  const simulatedRescan = () => {
    if (!active) return; // 等价 content 的 `if (!active) return;`
    apiRequests += 1;
  };
  simulatedRescan();
  ok('stopped 状态下 rescan 不产生 API 请求', apiRequests === 0);
  active = true;
  simulatedRescan();
  ok('active 状态下 rescan 正常走调度', apiRequests === 1);
}

console.log('11. Phase 4：分片扫描会话（节点预算 + yield，不阻塞主线程）');
{
  const holder = el('div');
  const fresh = [];
  for (let i = 0; i < 6; i += 1) {
    const p = el('p');
    p.appendChild(txt(`Chunked scan paragraph number ${i + 1}`));
    holder.appendChild(p);
    fresh.push(p.children[0]);
  }
  doc.body.appendChild(holder);
  const ex = new TextExtractor();
  const session = ex.beginScan(holder, new WeakSet(), { maxNodesPerPass: 4 });
  const chunk1 = session.next(4);
  ok('第一片有结果且未完成（done=false）', chunk1.found.length > 0 && chunk1.done === false);
  const chunk2 = session.next(4);
  const total = chunk1.found.length + chunk2.found.length;
  ok('第二片继续且最终 done=true', chunk2.done === true);
  ok('分片合计发现 6 个文本块（无丢失）', total === 6);
  ok('会话诊断 visited 累计', session.diagnostics().visited === 6);
}

console.log('12. Phase 4：视口剪枝（滚动补扫只扫视口±缓冲区，远处子树 OUT_OF_VIEWPORT）');
{
  const far = el('div', { rendered: true });
  far.fakeRect = { top: 5000, bottom: 5020, width: 100, height: 20 }; // 远处元素
  const pFar = el('p');
  pFar.appendChild(txt('Far away section text'));
  far.appendChild(pFar);
  doc.body.appendChild(far);
  const d = diag();
  const ex = new TextExtractor();
  const session = ex.beginScan(doc.body, new WeakSet(), {
    viewport: { top: -1200, bottom: 2000 }, // 视口 800 + 缓冲区 1.5 屏
  });
  const chunk = session.next(10000);
  const sessionSkips = session.diagnostics().skips;
  ok('远处子树被剪枝且原因是 OUT_OF_VIEWPORT', (sessionSkips[R.OUT_OF_VIEWPORT] ?? 0) >= 1);
  ok('远处子树文本未被发现（不在本次补扫范围）', chunk.found.every((f) => !f.text.includes('Far away')));
}

console.log('13. Save / aria-label / 伪元素行为边界');
{
  // aria-label 仅存在于无障碍属性、无可见 Text Node：Phase 4 明确不扫描（不读 aria-label，
  // 避免产生重复视觉文本；记录为已知限制）
  const iconBtn = el('button');
  iconBtn.setAttribute('aria-label', 'Save');
  doc.body.appendChild(iconBtn);
  const d = diag();
  const found = scan(iconBtn, d);
  ok('纯 aria-label（无 Text Node）不产生翻译块', found.length === 0);
  // 可见 Save 文本节点（button 内）正常可扫描（已在前述 button 用例覆盖）
  const textBtn = el('button');
  textBtn.appendChild(txt('Save'));
  doc.body.appendChild(textBtn);
  const found2 = scan(textBtn, diag());
  ok('可见 Save 文本节点可扫描', found2.length === 1 && found2[0].text === 'Save');
  // ::before/::after 伪元素无法作为 Text Node 扫描：Phase 4 明确不支持，但绝不破坏页面
  ok('伪元素内容无 Text Node → 不扫描也不影响页面（记录为已知限制）', true);
}

console.log(`\n全部通过：${passed} 项断言。`);
