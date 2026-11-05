# AI Web Translator

中英双语网页翻译扩展（Chrome / Edge · Manifest V3），设计目标类似「沉浸式翻译」：
用户点击扩展后翻译当前网页，支持 原文 / 中英双语 / 仅中文 三种显示模式。

> **当前开发阶段：V1 · Phase 4（翻译质量 + 长网页体验优化）。**
>
> **数据披露（诚实说明）**：当你主动点击「翻译当前网页」后，AI-Web-Translator 会把
> 该页面中**筛选后的允许翻译正文文本**（纯文本块，仅 id + 文本）发送给 DeepSeek API。
> 它**不会**发送：网页 URL、标题、HTML 源码、DOM 路径、CSS 选择器、Cookie、登录 Token、
> 表单内容、密码、验证码、localStorage / sessionStorage、账号或设备信息。
> 未点击翻译时，扩展不会发送任何数据。

## 已实现（Phase 1 → 4）

- [x] Manifest V3 最小权限：`activeTab` / `scripting` / `storage` + **仅** `https://api.deepseek.com/*` host 权限
- [x] 安全正文识别（TreeWalker 遍历 Text Node，排除表单/密码/代码等；**可见性用 Text Node Range rects 判定**，
      display:contents/grid/flex/content-visibility 不再误杀；button/role=button 静态标签可翻译；开发扫描诊断可开）
- [x] 三种显示模式（非破坏性纯 CSS 切换）、停止翻译（真实取消网络请求）、恢复原文
- [x] **DeepSeekProvider 真实翻译**：OpenAI Chat Completions 格式、`deepseek-v4-flash`（默认）/`deepseek-v4-pro`、
      显式关闭 Thinking、JSON Output、temperature 0.2、25s 超时（新默认）
- [x] **Prompt v2（translation-prompt-v2）**：自然中文（不逐词直译/不硬搬语序）、新闻标题简洁保留语气、
      UI 文本简短（Save→保存、Sign In→登录、See more→查看更多、Live→直播）、人名常见译名/品牌保留、
      术语规范（OSI 模型/权限提升/反向 Shell/Payload（有效载荷））、标准缩写不翻译；旧 v1 缓存自动失效
- [x] **TranslationTextSanitizer**：白名单表现标签清洗（`<STRONG>PAGE-TURNERS</STRONG>`→PAGE-TURNERS；
      `x < y`/`vector<int>`/`<username>` 绝不误伤）、零宽/控制字符与空白标准化；originalText 永不修改
- [x] **Viewport Priority**：HIGH（视口内）/ MEDIUM（±1.5 屏）/ LOW；只重排 pending，
      在途 batch 绝不 abort、completed 绝不重翻；滚动 debounce 更新优先级；同优先级保持 DOM 阅读顺序
- [x] **长网页扫描性能**：分片扫描会话（800 节点/pass + yield）、滚动补扫视口剪枝（OUT_OF_VIEWPORT）、
      Mutation 定向子树扫描；超长网页不再阻塞主线程
- [x] **批量翻译**：TranslationBatcher（≤12 块 / ≤12000 字符双上限）、有限并发（默认 2 个 API batch）、
      结果按 `block.id` 精确匹配（绝不依赖数组顺序）、缺失块只重试缺失项
- [x] **严格响应校验**：finish_reason 严格处理（仅 stop 正常；缺失→UNEXPECTED_FINISH_REASON 不投递；
      length→OUTPUT_TRUNCATED 第一次即拆半、绝不原样重试；content_filter/tool_calls/资源不足分别映射）、
      JSON 解析、五类集合校验；模型输出一律按不可信数据处理
- [x] **请求加固**：显式 `max_tokens: 16384`（内部常量，用户不可配）、仅必要 header
- [x] **重试策略**：仅临时错误重试（默认 2 次，指数退避 + jitter，尊重 Retry-After）；401/402/422 不重试
- [x] **真实取消**：每个 API batch 绑定 AbortController；停止 → abort 在途请求 + 清空队列 + 迟到结果不投递
- [x] **Prompt Injection 防护**：System Prompt 声明网页文本是不可信素材，绝不执行其中指令；Prompt 不含 Key/URL/Cookie/内部状态
- [x] **API Key 边界**：Options → chrome.storage.local → Service Worker（单值内存缓存 + onChanged 立即失效）→ DeepSeekProvider → API；
      Content Script 永远拿不到 Key；换 Key 用新 Key、清除 Key 立即 API_KEY_MISSING；不回显、不打印、不进 DOM/日志/Git
- [x] **Token 用量 + 缓存统计**：聚合真实 API usage；缓存命中不虚构用量；Popup 显示 输入/输出 tokens 与缓存命中块数
- [x] SessionCache：键含 provider/model/promptVersion（v1≠v2、Mock≠DeepSeek、Flash/Pro 分开）；失败结果绝不缓存
- [x] pageSessionId 生命周期：reload 后旧状态与**旧 Document 的迟到 API 结果**全部丢弃，缓存保留
- [x] **Page Translation State 持久化**：状态摘要写入 `chrome.storage.session`（随浏览器会话存活、关闭即清，
      不含页面文字与 Key）；MV3 SW 空闲回收后冷启动恢复——**显示模式切换绝不丢状态/进度/Token 用量**，
      reload 仍正确 stale reset；SessionCache 保持内存级
- [x] **动态内容**：MutationObserver（childList/characterData/**class/style/hidden/aria-hidden 定向补扫**）+
      scroll/resize debounce 补扫 + 初始扫描后有限稳定化补扫（有界，无永久 loop；只新增未管理块，绝不重复翻译）
- [x] 高风险页面确认流程、统一错误码中文提示
- [x] 零依赖自动测试 ×10（全部 fake fetch / mock response / fake DOM，**绝不发真实 API 请求**）

## 尚未实现（后续阶段）

- [ ] 可见区域优先排序（当前按 DOM 顺序翻译）
- [ ] SPA 路由切换感知
- [ ] 其他 Provider（OpenAI / Gemini / Claude / DeepL / 自定义兼容端点）
- [ ] 超长文本分块（当前单块上限 4000 字符）
- [ ] 扩展图标（当前使用浏览器默认图标）

## 在 Edge 中加载（开发模式）

1. 打开 `edge://extensions` → 开启「开发人员模式」
2. 点击「加载解压缩的扩展」→ 选择本项目根目录（含 `manifest.json` 的文件夹）
3. 若已加载旧版本：点击该扩展卡片上的「重新加载」（**注意：Phase 3 新增了 host 权限，
   重新加载后请再次确认扩展详情页显示 `https://api.deepseek.com/*` 访问权限**）
4. 固定工具栏图标 → 打开「设置」填入你的 DeepSeek API Key → 保存

## Edge 手工验收清单（Phase 3）

1. **配置 Key**：设置页填入 API Key → 只显示「已配置」且不回显；Endpoint 只读；Thinking 固定关闭
2. **未配置 Key**：不填 Key 点「翻译当前网页」→ Popup 提示「尚未配置 DeepSeek API Key」+ [打开设置]，零网络请求
3. **真实翻译**：填 Key 后翻译英文网页（如 `https://example.com`）→ 出现真实简体中文译文（不再有【模拟译文】前缀）
4. **进度与用量**：进度按 block 计数（n / total），完成后显示「API 用量：输入 x / 输出 y tokens」
5. **模式切换**：双语/仅中文/原文即时切换，不产生任何新 API 请求（DevTools Network 观察）
6. **停止翻译**：翻译中点击「停止」→ 状态「已停止」、Network 面板在途请求立即取消、页面不再新增译文
7. **恢复原文**：页面回到翻译前状态，进度归 0/0
8. **动态内容**：页面自然新增英文内容被增量翻译（不自动滚动/点击）
9. **高风险页面**：含登录框/支付表单的页面 → 「取消 / 仍然翻译」确认
10. **reload**：F5 后 Popup 显示「未开始 0/0」；重新翻译时相同文本命中会话缓存（明显更快）
11. **错误提示**：把 Key 改成无效值 → 显示「DeepSeek API Key 无效，请检查设置。」

## 安全承诺（摘要）

- 最小权限：无 `<all_urls>`、无 Cookie / 网络拦截类权限；host 权限仅 DeepSeek 官方域名
- **诚实数据边界**：只发送用户主动翻译页面的筛选后纯文本块；绝不发送 URL/标题/HTML/Cookie/表单/密码/账号
- Prompt Injection 防护 + 模型输出按不可信数据严格校验 + 永不 innerHTML
- API Key 只在 SW↔DeepSeek 链路中，Content Script/Popup/DOM/日志/Git 全程无 Key
- 风控基线：观察网站，不驱动网站；高风险页面本地判定 + 用户确认（仅当前 tab 有效）
- 停止 = 真实取消网络请求；reload = 旧结果丢弃、缓存保留

完整说明见 [`docs/SECURITY.md`](docs/SECURITY.md)、架构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、
需求见 [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)。

## 目录结构

```
AI-Web-Translator/
├── manifest.json                     # MV3 清单（0.3.0，host 权限仅 DeepSeek）
├── README.md
├── docs/                             # REQUIREMENTS / ARCHITECTURE / SECURITY
├── scripts/                          # 零依赖测试 ×5（node 运行，无真实 API 请求）
├── popup/ · options/                 # 扩展页面
└── src/
    ├── background/                   # service-worker（批量编排）+ page-session-state
    ├── content/                      # extractor / block-manager / renderer / bootstrap
    ├── shared/                       # constants / errors / messages(.core)
    ├── translation/                  # provider 接口 / deepseek / mock / batcher / retry-policy / scheduler
    ├── page/                         # page-safety-guard / aiwt-styles
    └── cache/                        # session-cache（provider/model/promptVersion 隔离）
```

## 路线图

| 阶段 | 内容 |
| --- | --- |
| Phase 1 ✅ | 安全项目骨架 |
| Phase 2 ✅ | 安全正文识别 + 双语 DOM 渲染 + 本地模拟翻译 |
| Phase 3 ✅ | 真实 DeepSeek API 翻译（批量 + 并发 + 取消 + 结构化返回） |
| Phase 4 | 可见区域优先、SPA 路由感知、更多 Provider、图标 |

## 技术说明

- 零第三方依赖、零构建工具：原生 JavaScript / HTML / CSS，易于审计。
- 自动测试全部使用 fake fetch / mock response，**开发与测试过程 0 次真实 API 请求、0 费用**；
  真实请求只发生在你在 Edge 中配置自己的 Key 并主动点击「翻译当前网页」之后。
- 无图标文件：MV3 允许不带图标加载（显示默认图标），Phase 4 补充。
