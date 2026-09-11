# spec — 拾分钟知识卡技术设计

**产品形态**：本地优先的单页学习工具，把抽卡、研究、口述与反馈压缩为 15 分 分钟内  
**状态**：设计稿 v0.1（2026-09-10）

---

## 1. 概述

- React + TypeScript + Vinext/Vite 的纯前端响应 SPA。
- 以卡片堆为首屏核心，不，无营销落地页。
- 本地功能不依赖网络；百科发现与 AI 评价按能力降级。
- 录音保存在 IndexedDB，配置和当前会话保存在 localStorage。

## 2. 目标 / 非目标

### Goals
- 用明确状态机实现可恢复的 10 分钟研究与 3/5 分钟口述流程。
- 为 Chrome、Edge、Safari 提供录音；为语音识别提供自然降级。
- 抽象 OpenAI-compatible 与 Anthropic 两类评价接口。

### Non-Goals（明确不做）
- 不实现后端、登录、跨设备同步、服务端代理或自动语音转写 API。
- 不在 MVP 中上传音频、运行远程统计脚本或生成公开分享页。

## 3. 架构总览

页面状态机驱动 UI。词库服务从内置数据和 IndexedDB 在线收藏组成抽取池；计时服务只持久化阶段、截止时间和暂停剩余量；录音服务写入 IndexedDB 后再提交会话引用；AI 适配器只接收当前词条和用户确认后的文字稿。

## 4. 系统组件 / 模块

### 4.1 Card Deck
职责：领域过滤、防重复抽取、拖拽阈值、键盘操作、滑动合成音。

### 4.2 Session Engine
职责：维护 `draw → research → prepare → speak → transcript → evaluating → review → completed`，按绝对截止时间恢复。

### 4.3 Recorder & Transcript
职责：探测 MIME、分块录制、停止媒体轨道、生成回放 URL；能力探测 SpeechRecognition 并维护 interim/final 文本。

### 4.4 Local Repository
职责：localStorage 保存小型偏好/加密配置；IndexedDB 保存音频、历史和在线词条。

### 4.5 AI Adapters
职责：构造白名单请求、按模型注册表分流（思考参数、token 预算）、设置超时、标准化两类响应、校验评价 JSON、分类错误、在 thinking-only 时按中文比例决回退或报错。

## 5. 关键设计 / 核心机制

### 5.1 计时恢复
- 运行时保存 `deadlineAt`；展示 `Math.ceil((deadlineAt - Date.now()) / 1000)`。
- 暂停时固化 `pausedRemainingMs` 并清空 deadline，恢复时产生新 deadline。
- `remaining <= 0` 只推进一次；监听 `visibilitychange` 立即校准。

### 5.2 录音和识别解耦
- MIME 按 `audio/webm;codecs=opus`、`audio/mp4`、浏览器默认顺序探测。
- MediaRecorder 使用 timeslice 收集块；等待最终 `dataavailable` 后写 IndexedDB。
- SpeechRecognition 意外结束不停止录音；不可用时只显示手动稿件。
- 所有结束和异常路径停止 MediaStreamTrack，并回收 Object URL。

### 5.3 API Key 本地加密
- 用户口令经 PBKDF2-SHA-256（310,000 次）派生不可导出的 AES-GCM 256 位密钥。
- 每次保存生成 16 字节 salt 与 12 字节 IV；localStorage 仅保存版本、算法参数和密文。
- 解锁口令和明文 Key 只留内存；忘记口令只能重置 AI 配置。
- 该方案只保护静态存储，不能防御运行时 XSS、恶意扩展或不可信 Endpoint。

### 5.4 按模型分流

`lib/ai-models.ts` 维护一个 `(provider, model)` → `ModelBehavior` 的注册表，`createCompletionBody` 先查表再走默认逻辑：

- `deepseek-*`（OpenAI 协议）：注入 `thinking: { type: 'disabled' }`，最低 1024 token。
- `MiniMax-M2/M3*`（Anthropic 协议）：默认传 `thinking: { type: 'disabled' }` 关闭思考，避免思考块吃满预算后只剩空正文；`minMaxTokens` 4000 与 evaluation 路径对齐，预留 SSE 流式过程中文本增量的余量。`research` 超时 60s 预留网络抖动。当响应只含 thinking 块时，`requestText` 调用 `isMostlyChinese` 判断：中文为主（>40% 中文字符）的成品被当作正文返回，英文元推理仍走“可操作的错误”。
  - **实测已知问题（2026-09-11）**：`MiniMax-M2.7` 会忽略 `thinking: disabled`，生成整段英文元推理（含逐字符计数）并把 `minMaxTokens=4000` 预算全部吃光（`stop_reason: max_tokens`、`output_tokens_details.thinking_tokens: 4000`），从未发出 `text` block，导致 stream 结束后抛出“模型开启了深度思考但未输出正文”。`streamCompletion` 与非流式 `requestText` 收尾时识别 `^MiniMax-M[23]` + 有 thinking 但无 text 的组合，抛出专属提示明确指向 `-highspeed` 变体或 `M3` 模型；预设下拉默认推荐 `MiniMax-M2.7-highspeed`，国内预设同步补 `MiniMax-M3` 选项。
- `claude-3-7-*`（Anthropic 协议）：启用扩展思考 `budget_tokens: 1024`，最低 2048 token。
- 其它模型：保持原行为。

速览区域只展示成品正文；思考过程与英文元推理都不应泄漏给用户。

复盘评价路径走不同策略：`AI_RESPONSE_TOKEN_BUDGETS.evaluation = 4000`，超时 60s。`requestEvaluation` 调用 `requestText(..., { includeThinking: true, callbacks })`，底层启用 SSE 流式：`onThinkingDelta` 透出思考增量，`onTextDelta` 透出正文增量；评价 JSON 仅从最终 text 抽取，`EvaluationResult.thinking` 随会话存储但不在评价完成后的 UI 中呈现。UI 分为两阶段：评价过程中（loading）在 `evaluation-thinking` / `evaluation-text-draft` 中实时展示思考与生成中的文本，并随增量自动滚动；评价完成后仅展示评分与点评。

研究速览路径同样走 SSE：`requestResearchBrief(config, term, callbacks?)` 转发 `onTextDelta` 与 `onThinkingDelta`。`AiResearchBrief` 本地跟踪 `textDraft` / `thinkingDraft`：仅正文可见时直接展示；正文为空但思考是中文（`isMostlyChinese`）时将思考作为可见草稿；英文思考独白隐藏，仅显示 “AI 整理中…”，避免元推理污染速览区。完成时 `requestText` 仍走 `isMostlyChinese` 回退，保证响应只剩中文思考块时也能交付成品。

**流式体感问题（M2.7 / M2.7-highspeed 已知）**：这两类模型默认会发英文思考元推理（“The user is speaking Chinese. We need to produce…”），使 `isMostlyChinese` 快速翻为 false，原「AI 思考中…+Ns」仅展示秒数累加，体感上流式被隐藏。修复后：
- 「AI 整理中…」分支同时输出 `{elapsedSeconds}s · 思考字符 {thinkingDraft.length}`，让用户在思考独白路径下也能看到状态推进。
- `isResearchStalled` （位于 `lib/research-ai.ts`）覆盖三条路径：思考字符 <50 且 ≥8s（早期重试）、思考字符 ≥500 且 ≥6s（M2.7/-highspeed 深度思考路径）、≥25s 兑底；任一为真即在 thinking 分支露出「重试」或「深度思考中，切 -highspeed / M3」按钮，原 `!thinkingDraft && ≥8s` 条件在思考路径下永远不成立，导致重试按钮 / 切模型提示不会露出。
- `isHeavyThinkingStuck` 独立控制 actionable 提示文案（仅在思考字符 ≥500 且 ≥6s 时显示「切 -highspeed / M3」），避免 25s 兑底路径下文案误导用户。

`AiResearchBrief` 仅以 `term.id` 作为 React `key`，中途改动 AI 设置只重跑 effect、不重挂组件；新 chunks 会覆盖草稿，UI 不会闪回“AI 正在整理…”。loading 期间每秒刷新 `elapsedSeconds`，无任何增量超 8s 时把提示切成“AI 响应较慢（N s）…”并露出“重试”按钮，避免上游沉默时给人“完成”的假象。

### 5.6 公网频控与防滥用

`/api/ai` 是唯一会被公网访问的服务端入口；为了避免脚本被攻击者滥用，导致每个 IP 不限量调用转走 DeepSeek / MiniMax，必须加限频。决策逻辑与平台适配拆开：

- 策略：每 IP 5 req/min + 100 req/日（UTC）·跨实例共享。
- 决策：纯函数 `evaluateRateLimit(counters, config)` 在 `lib/rate-limit.ts`，与 Cloudflare 解耦；KV 读写是 `readCounters` / `writeCounters` 两个薄适配器，可换成其他 KV。
- KV key：`rl:<ip>:m:<分钟桶>`（TTL 2 分钟）与 `rl:<ip>:d:<UTC 日期>`（TTL 26 小时）。两者分开是为了分钟桶快速过期、日桶隔夜重置，避免单 key 里的字符串 split。
- 状态机：`route.ts` 先 `readCounters` → `evaluateRateLimit({ ...counters, window: counters.window + 1, daily: counters.daily + 1 })` 决定是否准入 → 仅在 `allow = true` 时 `writeCounters`。返回 429 时携带 `Retry-After` 和 `X-RateLimit-*` 响应头，调用方能直接看到剩余配额。
- 客户端：禁止绕过。未来加 Turnstile 时需补齐 siteverify 中间件位置（参 `turnstile-spin` skill）。
- 兜底：控制台为 Workers 每日计费设上限 1 USD；一旦异常流量逼近阈值，Cloudflare 会自动停服。

### 5.5 研究速览输出格式

- 字数上限 350 中文字，超出会被模型截断但不会报错。
- 必含要素：核心含义 / 一个例子或应用 / 与研究问题的关联 / 可能存在的误解或边界。
- 事实不确定时模型应写入“需查证”，不编造来源。
- 响应 JSON 解析失败或不含 text 块时，按 5.4 中的中文思考判断或 actionable 错误处理。

## 6. 数据模型

```ts
type Phase = 'draw' | 'research' | 'prepare' | 'speak' | 'transcript' | 'evaluating' | 'review' | 'completed';

interface TermCard {
  id: string;
  title: string;
  english?: string;
  domain: string;
  kind: '定律' | '效应' | '悖论' | '理论' | '模型' | '原则' | '方法';
  prompt: string;
  sources: { label: string; url: string }[];
  origin: 'builtin' | 'wikipedia';
  reviewStatus: 'reviewed' | 'candidate';
}

interface LearningSession {
  id: string;
  termId: string;
  phase: Phase;
  outputSeconds: 180 | 300;
  deadlineAt?: number;
  pausedRemainingMs?: number;
  audioId?: string;
  transcript?: string;
  evaluation?: EvaluationResult;
}

interface EvaluationResult {
  understanding: number;
  expression: number;
  application: number;
  summary: string;
  strengths: string[];
  corrections: string[];
  improvements: string[];
  nextQuestion: string;
}
```

## 7. 接口 / API 设计

| 类型 | 请求 |
|---|---|
| OpenAI-compatible | 用户填写完整 Endpoint；`Authorization: Bearer`；Chat Completions messages |
| Anthropic | 用户填写完整 Endpoint；`x-api-key`、`anthropic-version`、`anthropic-dangerous-direct-browser-access`；Messages body |
| Wikipedia | `action=query&generator=search&origin=*`，只用于用户主动发现候选词条 |

AI 返回固定评价 JSON。运行时校验三项评分为 0–5、文本/数组类型；围栏 JSON 可容错剥离，验证失败展示原始文本但不写入正式评价。

测试连接经本站 `/api/ai` 代理完成，避免自定义 Endpoint 的 CORS 问题。`timeoutFetch` 把网络层 `TypeError: Failed to fetch` 翻成可执行建议：相对路径提示 dev server 未启动，绝对 URL 提示网络/CORS；`verifyAiKey` 二次校验上游响应——HTTP 200 但体内 `status_code !== 0`（MiniMax `base_resp`）、`error.message`（OpenAI）、`message`（通用）均视为鉴权失败，避免静默"验证成功"。

## 8. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| UI | React 19 + TypeScript + 原生 CSS/Tailwind | 现有 Sites 脚手架，适合复杂浏览器状态 |
| 存储 | localStorage + IndexedDB | 配置轻量；音频 Blob 需要结构化大对象存储 |
| 媒体 | MediaRecorder + SpeechRecognition 能力探测 | 无需额外上传，支持自然降级 |
| 密钥 | Web Crypto PBKDF2 + AES-GCM | 浏览器原生、可验证且不引入加密依赖 |
| 部署 | 本地 Vinext/Vite | 用户明确要求个人本地工具 |

## 9. 关键权衡

1. 选择浏览器直连自定义 AI Endpoint，换取本地零后端；代价是运行时密钥暴露风险和 CORS 限制。
2. 选择内置精选词库作为随机主池，在线内容需确认；代价是词库维护工作量，但避免百科随机噪声。
3. 选择浏览器语音识别加手动兜底，不上传音频转写；代价是部分浏览器需手动整理文字。

## 10. 里程碑（分阶段路线图）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| M0 骨架 | 文档、主题、主卡片 | 首屏可识别并能抽卡 |
| M1 学习闭环 | 计时、录音、转写、本地保存 | 无 AI 也能完成一次练习 |
| M2 AI 评价 | 加密配置、双协议适配 | 两类接口均可测试、评价和失败恢复 |
| M3 打磨 | 在线候选、历史、响应式、无障碍 | 手机和桌面可交付 |

## 11. 风险与待验证

- [ ] Safari 的录音 MIME 探测和移动端中断恢复。
- [ ] Anthropic 浏览器请求头与用户 Endpoint 的 CORS 配置。
- [ ] IndexedDB 配额/隐私模式失败提示。
- [ ] React Strict Mode 下倒计时只推进一次。

