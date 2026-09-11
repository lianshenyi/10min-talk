# TASKS — 拾分钟知识卡

> 任务按阶段排，每完成一条勾掉。同阶段任务可并行。  
> 估算单位：⏱ ~30min | ⏱⏱ ~2h | ⏱⏱⏱ ~半天  
> 环境：本地 Vinext/Vite，Node.js ≥ 22.13

---

## Phase 0 — 决策确认

- [x] 个人本地网页，无账号、云同步和服务端
- [x] 混合词库：内置精选为主，在线候选需确认
- [x] 10 分钟研究；输出开始前选择 3 或 5 分钟
- [x] 口述录音 + 可选实时转写 + 手动文字兜底
- [x] OpenAI-compatible 与 Anthropic Endpoint；API Key 加密后存 localStorage

---

## Phase 1 — 产品骨架与词库 ⏱⏱

- [x] **1.1** 完成深色玻璃卡片主题、响应式首屏和产品元数据
- [x] **1.2** 建立 12 领域专业词库、类型和研究问题
- [x] **1.3** 实现防重复随机抽取、领域过滤和 3/5 分钟选择
- [x] **1.4** 实现卡片拖拽、按钮/键盘操作和减少动态效果（合成音留待后续打磨）

**Phase 1 完成标志**：打开网页可立即选时长、换卡并确认研究主题。

---

## Phase 2 — 学习闭环 ⏱⏱⏱

- [x] **2.1** 实现可暂停/恢复、刷新校准的 10 分钟研究计时
- [x] **2.2** 添加百科、必应、Google Scholar 搜索入口
- [x] **2.3** 实现 MIME 探测、分块录音、回放、重录和媒体轨道清理
- [x] **2.4** 实现 SpeechRecognition 能力探测、实时稿件和手动兜底
- [x] **2.5** IndexedDB 保存音频/历史，localStorage 恢复当前会话

**Phase 2 完成标志**：断开 AI 后仍可完成抽卡、研究、口述、回放和保存。

---

## Phase 3 — AI、在线扩展与测试 ⏱⏱⏱

- [x] **3.1** Web Crypto 加密、解锁、清除配置与安全说明
- [x] **3.2** OpenAI-compatible/Anthropic 适配器、连接测试与结构校验
  - 后续补：按 `(provider, model)` 查 `lib/ai-models.ts` 注册表决定 max_tokens / thinking 参数（DeepSeek 关闭思考、MiniMax 默认禁用思考避免正文被吃空、Claude 3.7 启用扩展思考）
- [x] **3.3** 自动评价界面及鉴权、CORS、限流、超时、格式异常处理
  - 后续补：研究超时从 45s 提到 60s；研究速览上限从 180 字提到 350 字，要求包含“误解或边界”；thinking-only 响应按 `isMostlyChinese`（>40% 中文字符）判断是否当作成品返回，英文元推理走 actionable 错误
  - 后续补：评价路径改为 SSE 流式，`evaluation` budget 4000；UI 在 loading 阶段同时展示思考与生成中的正文，结果出来后只展示评价
  - 后续补：MiniMax `minMaxTokens` 从 1024 提到 4000；研究速览复用 SSE，`AiResearchBrief` 同时订阅 `onTextDelta` / `onThinkingDelta`，中文思考作为可见草稿以避免 MiniMax 独返 thinking 时 UI 卡在“AI 正在整理…”
  - 后续补：`timeoutFetch` 把 `TypeError: Failed to fetch` 翻成中文（相对路径 → 后端未启，绝对 URL → 网络或 CORS）；`verifyAiKey` 二次校验上游 HTTP 200 内的错误体（MiniMax `base_resp.status_code` / OpenAI `error.message` / 通用 `message`），避免静默“验证成功”
  - 后续补：`AiResearchBrief` 的 `key` 改为只跟 `term.id` 联动，避免 AI 设置中途保存导致草稿被卸载；进度状态加耗时与超 8s 重试入口；`EvaluationPanel` 同源例的“AI 思考中…”不加耗时提示即可（一次性 phase），不统一带重试按钮
- [x] **3.4** 在线百科候选搜索、确认入库和离线降级
- [x] **3.5** 历史记录、导出、删除及配额错误提示
- [ ] **3.6** lint、typecheck/build 与主流程浏览器验证（已完成新增代码 lint、typecheck、build；待含真实 Endpoint 的浏览器验证）

**Phase 3 完成标志**：完整功能可交付，失败分支不会丢失用户内容。

---

## 后续阶段（不在 MVP / 可选增强）

- [ ] 本地代理，避免长期 API Key 暴露在网页运行时
- [ ] 可安装 PWA 与跨设备加密导入导出
- [ ] 词库扩展到 500+，增加来源复核与证据边界标记

---

## Phase 4 — 公网部署与防滥用 ⏱⏱

- [x] **4.1** 在 `lib/rate-limit.ts` 抽离纯函数频控决策（10 req/min、100 req/日）
- [x] **4.2** `/api/ai` 接入频控；返回 429 + `X-RateLimit-*` 响应头；KV 缺绑时降级为“未限频”
- [x] **4.3** `vite.config.ts` 在构建时读取 Cloudflare 环境变量 `RATE_LIMIT_KV_NAMESPACE_ID` 并生成 `RATE_LIMIT_KV` binding；不再把环境特定 ID 提交到 `wrangler.jsonc`
- [x] **4.4** 写 `DEPLOY.md`：Cloudflare **Workers** 部署文档（KV 创建、消费上限、域名、验收清单）——踩坑教训：Vinext 是 Workers 项目不是 Pages，部署走 `wrangler deploy --config dist/server/wrangler.json`，不是 `wrangler pages deploy`；详见 §8
- [ ] **4.5** 实际部署到 Cloudflare Workers 并验证“真实调用场景”频控生效（需控制台创建 KV 绑定；token 须带 `Account → Workers 脚本 → Edit` 权限；项目须建在 Workers 板块而非 Pages 板块，详见 `DEPLOY.md §8`）
- [x] **4.6** 同步踩坑记录：`DEPLOY.md`（重写为 Workers 流程 + §8 补充 8000007、404、env 桥接等条目）、`CLAUDE.md`（部署行 + 模块速查 + `request.env` 警告）、`spec.md §5.6`（Workers 部署形态 + env 桥接说明）

**Phase 4 完成标志**：公网域名可访问，AI 调用走 `/api/ai` 代理且返回带限频头。

---

## 进度跟踪

| Phase | 状态 | 完成日期 |
|---|---|---|
| 0 决策 | ✅ | 2026-09-10 |
| 1 产品骨架与词库 | ✅ | 2026-09-10 |
| 2 学习闭环 | ✅ | 2026-09-10 |
| 3 AI、在线扩展与测试 | 🟡 | 2026-09-11 |
| 3.x 跟随调整（按模型分流、速览扩写、思考内容辨识） | ✅ | 2026-09-11 |
| 3.x 跟随调整（评价 SSE 流式化、4000 token 预算、UI 两阶段呈现） | ✅ | 2026-09-11 |
| 3.x 跟随调整（MiniMax 预算升至 4000、研究速览走 SSE 增量渲染） | ✅ | 2026-09-11 |
| 3.x 跟随调整（研究速览同时订阅 thinking 流，中文思考作为可见草稿） | ✅ | 2026-09-11 |
| 3.x 跟随调整（Failed to fetch 本地化、上游 200+错误体 二次校验） | ✅ | 2026-09-11 |
| 3.x 跟随调整（研究速览 key 解耦、耗时+重试） | ✅ | 2026-09-11 |
| 3.x 跟随调整（M2.7 thinking-only 专属提示 + 默认 -highspeed + 国内预设加 M3） | ✅ | 2026-09-11 |
| 3.x 跟随调整（M2.7/-highspeed 英文思考元推理路径下研究速览 stalled 判定拓宽 + 「AI 整理中…」泄露字符数与切模型提示） | ✅ | 2026-09-11 |
| 4 公网部署与防滥用 | 🟡 | 2026-09-11（4.1–4.4、4.6 完成；KV ID 改由 Production/Preview 构建环境注入，4.5 待验证真实频控） |

---

## 速查命令

```bash
npm run dev
npm run lint
npm run build
npm test
```
