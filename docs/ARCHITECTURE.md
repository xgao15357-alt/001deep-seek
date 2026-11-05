# AI Web Translator — 架构说明

## 1. 总览（Phase 3）

```
┌──────────────┐   chrome.runtime 消息   ┌──────────────────────────────┐
│   Popup UI   │ ──────────────────────▶ │        Service Worker         │
│  (popup/*)   │ ◀────────────────────── │  消息路由 · 注入编排 · 风控闸门 │
└──────┬───────┘   状态广播 STATE_UPDATED │  批量队列 · 调度 · 重试 · 用量   │
       │                                 └──────┬───────────┬───────────┘
┌──────▼───────┐   chrome.storage.local        │ fetch(仅  │ scripting
│  Options UI  │ ◀────────────────────────────▶ │ DeepSeek) │ 注入+CSS
│ (options/*)  │  设置 / API Key                ▼           ▼
└──────────────┘                       ┌──────────────┐  ┌────────────────┐
                                       │ DeepSeek API │  │ Content Scripts │
                                       │(官方域名限定) │  │ extractor/block │
                                       └──────────────┘  │ renderer/bootstrap│
                                                          └────────────────┘
```

## 2. Phase 3 翻译数据流

```
Content（页面侧）                          Service Worker（后台侧）
─────────────────                         ─────────────────────────
TextExtractor → 块登记（稳定 ID）
  → TRANSLATE_REQUEST {blocks:[{id,text}]}
                                           ① 逐块：SessionCache 命中 → 立即完成
                                           ② 未命中 → batchQueue（FIFO）
                                           ③ flushBatchQueue：
                                              buildBatches（≤12 块 / ≤12000 字符）
                                              → N 个 batch 任务（每个绑定
                                                tabId + pageSessionId + AbortController）
                                           ④ Scheduler 限流（同时 ≤ maxConcurrency 个 batch）
                                           ⑤ 每 batch execute：
                                              二次缓存检查 → DeepSeekProvider.translateBatch
                                              （withRetry：临时错误指数退避重试）
                                              → 结果写回 SessionCache
  ← TRANSLATE_RESULT {id, translation}   ←⑥ 结果经 pageSessionId 闸门校验后按 block.id 回传
DomRenderer 按 ID 落位（textContent）
  进度 / 状态 / Token 用量 → Popup
```

关键点：**译文按 block.id 关联，绝不依赖数组顺序**；缺失块只重试缺失项；
重复/未知/非法 id 严格分类处理；模型输出永远按不可信数据处理。

## 3. 运行时组件与职责

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| Popup | `popup/*` | 状态机（含 API Key 未配置 / API 错误 / 部分失败）、块级进度、Token 用量、模式切换、风险确认 |
| Service Worker | `src/background/service-worker.js` | 路由、注入、风控闸门、块队列→batch 编排、调度、重试、pageSessionId 闸门、用量聚合 |
| 页面状态模块 | `src/background/page-session-state.js` | tabId+pageSessionId 生命周期、批量状态、结果闸门（纯逻辑，可 Node 测试） |
| Content 脚本 ×4 | `src/content/*` | 提取 / 块登记 / 渲染 / 观察（Phase 2 架构原样保留，无 Key、无网络） |
| Options | `options/*` | API Key、模型选择（flash/pro）、Timeout、并发、重试、Thinking 只读锁定 |

## 4. 模块分层（src/）

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 共享层 | `shared/constants.js` | 设置默认值、模型枚举、API 批量上限、Prompt 版本 |
| 共享层 | `shared/messages.core.js` + `messages.js` | 消息协议唯一事实来源（双模式） |
| 共享层 | `shared/errors.js` | 统一错误码（含 API 系列）、TranslationError（retryAfterMs） |
| 翻译层 | `translation/translation-provider.js` | Provider 接口 + 注册表 |
| 翻译层 | `translation/deepseek-provider.js` | **Phase 3 真实实现**：请求构造 / fetch / 三层校验 / HTTP 映射 / usage |
| 翻译层 | `translation/mock-provider.js` | 测试/内部 dev 开关用（translateBatch 对齐），绝不在生产路径出现 |
| 翻译层 | `translation/translation-batcher.js` | 分批（数量+字符双上限）+ 响应集合分类 + viewport pending 稳定排序（纯函数） |
| 翻译层 | `translation/translation-text-sanitizer.js` | 翻译输入副本清洗：白名单表现标签 + Unicode/空白标准化（纯函数，绝不改原文） |
| 翻译层 | `translation/retry-policy.js` | 有限重试 + 指数退避 + jitter + Retry-After + abort 感知（纯函数） |
| 翻译层 | `translation/batch-translator.js` | OUTPUT_TRUNCATED 第一次即拆半（成本优先，绝不原样重试）（纯函数） |
| 翻译层 | `translation/translation-scheduler.js` | 并发=API batch 数；AbortController 真实取消；停止语义 |
| 后台层 | `background/page-session-state.js` | tabId+pageSessionId 生命周期、批量状态、结果闸门、可持久化摘要（纯逻辑，可 Node 测试） |
| 后台层 | `background/api-key-cache.js` | API Key 单值内存缓存（启动直读 + onChanged 失效 + 自动重读） |
| 内容层 | `content/text-extractor.js` | 安全正文识别：Text Node Range 可见性（display:contents/grid-flex/content-visibility 不误杀）+ 跳过原因诊断（开发开关） |
| 内容层 | `content/content-bootstrap.js` | 控制器：Observer（childList/characterData/class/style/hidden/aria-hidden）、scroll/resize debounce 补扫、有限稳定化补扫 |
| 页面层 | `page/page-safety-guard.js` / `page/aiwt-styles.js` | 本地风控 / 注入样式 |
| 缓存层 | `cache/session-cache.js` | 键含 provider/model/promptVersion（Mock≠DeepSeek，Flash≠Pro） |

## 5. 关键设计决策（Phase 3 新增）

1. **Provider 与网页彻底解耦**：DeepSeekProvider 只做请求/解析/校验/映射，不碰 DOM、Popup、Observer。
2. **Batcher 独立职责**：分批与响应集合校验放在 `translation-batcher.js`（纯函数，可单测）。
3. **并发 = API batch 数**：Scheduler 的 maxConcurrency 语义调整为“同时进行的 API batch 数”（默认 2），
   由 Scheduler 统一限流，绝不 Promise.all 几百个 fetch。
4. **批量 + block.id 精确匹配**：批量请求携带 id，返回按 id 落账；缺失/重复/未知/非法分类处理，
   缺失只重试缺失项，已成功块绝不重复请求。
5. **API Key 单向流动**：Options → storage → SW（单值内存缓存）→ Provider → API；
   任何消息/快照/Content Script 只可能看到 `apiKeyConfigured` 布尔值。
   Key 缓存生命周期：每次翻译任务启动直读 storage 最新值；`storage.onChanged` 立即使缓存失效；
   会话中新建 batch 时缓存失效则自动重读——换 Key 用新 Key，清除 Key 得到 API_KEY_MISSING，
   绝不使用旧的内存 Key。
6. **pageSessionId 贯穿 API 结果**：batch 发起时绑定，投递前校验；reload 后旧结果直接丢弃（缓存保留）。
7. **缓存键含 promptVersion**：Prompt/schema 变更 = 旧缓存整体失效；Mock 与 DeepSeek 绝不互串。
8. **Token 统计只认真实 usage**：缓存命中不虚构 Token 数；不做价格计算。
9. **finish_reason 严格处理**：仅 `stop` 视为完整成功；缺失/null/undefined → UNEXPECTED_FINISH_REASON
   （不解析不投递不重试）；`length` → OUTPUT_TRUNCATED（**绝不原样重试同一 batch**：第一次即拆半
   12→6+6→3+3→1+2，单块有界失败）；`content_filter` → CONTENT_FILTERED；
   `insufficient_system_resource` → SERVICE_OVERLOADED（临时可重试）；`tool_calls` 等 →
   UNEXPECTED_FINISH_REASON。
10. **max_tokens 显式固定**：内部常量 16384（batch 输入 ≤12000 字符、中文输出约 1 token/字，
    8192 可能截断；16384 留裕量且不扩大 batch/上下文）；用户不可配置。
11. **Page Translation State 持久化（MV3 SW 冷启动存活）**：MV3 Service Worker 会被浏览器
    空闲回收，页面翻译状态摘要（status / stats / usage / pageSessionId，**绝不含页面文字与 Key**）
    持久化到 `chrome.storage.session`（随浏览器会话存活、关闭即清）。冷启动时 hydrate + 握手二次校验：
    同 pageSessionId → 完整保留（**纯显示模式切换绝不清状态**）；不同 pageSessionId（真正 reload）→
    stale reset；瞬态状态（translating 等）不恢复。SessionCache 仍是 SW 内存级（缓存允许随进程消失）。
12. **显示模式与翻译任务状态彻底独立**：SET_DISPLAY_MODE 是纯模式命令（持久化偏好 + 转发
    APPLY_MODE），不 reset、不 hydrate、不重建 session、不重新注入、不产生任何翻译任务/API 请求；
    Content Script 不存在时只保存偏好并返回 applied=false。
13. **Phase 4 可见区域优先**：Content 用 Range 几何 + innerHeight 算 HIGH/MEDIUM/LOW
    （只读几何，绝不滚动/改布局）；SW 用稳定排序重排 pending（同优先级保持 DOM 阅读顺序）；
    在途 batch 绝不 abort、completed 绝不重翻；滚动 debounce 只更新未翻译块优先级。
14. **Phase 4 长网页扫描性能**：TextExtractor.beginScan 分片会话（800 节点/pass + yield 续跑）；
    滚动补扫只走视口±1.5 屏（远处子树 OUT_OF_VIEWPORT 剪枝）；Mutation 定向子树扫描；
    AIWT 节点永远跳过。
15. **Phase 4 Prompt v2 + 文本清洗**：translation-prompt-v2（自然中文/标题/UI 文本/人名品牌/术语）；
    TranslationTextSanitizer 只清洗发送给 API 的副本（originalText 永不修改），
    白名单表现标签 + 安全 Unicode 标准化，绝不通用 HTML strip。

## 6. 已知限制（Phase 4）

- 单块文本上限 4000 字符（超长文本分块延后）；
- 仅翻译含连续拉丁字母的文本（英文启发式）；
- SPA 路由切换不感知（大范围替换时旧块剪除、新块正常翻译）；
- 页面存在密码输入框（含隐藏登录下拉表单）即触发风险确认，属预期行为；
- Token 统计以 DeepSeek 返回的 usage 为准，若服务端未返回则不显示；
- **Save 类 UI 标签诊断结论**：可见 Text Node（含 button / role=button / 嵌套 span）→ 正常翻译；
  纯 aria-label（无可见文本）→ 不翻译（不读无障碍属性，避免产生重复视觉文本）；
  CSS ::before/::after 伪元素内容 → 明确不支持；Shadow DOM → 默认延期（需证明权限/性能/
  Restore/状态可靠后才考虑）。
- Phase 3 已保存的 Timeout=30000 设置保持原值；Phase 4 新默认 25000ms 仅对新默认生效。

## 7. 目录结构

```
AI-Web-Translator/
├── manifest.json                     # MV3 清单（0.3.0；host 权限仅 https://api.deepseek.com/*）
├── README.md · package.json
├── docs/                             # REQUIREMENTS / ARCHITECTURE / SECURITY
├── scripts/                          # 零依赖测试 ×5（全部 fake fetch，0 真实请求）
├── popup/ · options/
└── src/
    ├── background/                   # service-worker · page-session-state
    ├── content/                      # extractor · text-block-manager · dom-renderer · bootstrap
    ├── shared/                       # constants · errors · messages(.core)
    ├── translation/                  # provider · deepseek · mock · batcher · retry-policy · scheduler
    ├── page/                         # page-safety-guard · aiwt-styles
    └── cache/                        # session-cache
```
