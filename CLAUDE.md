# 拾分钟知识卡 — Agent 协作约定

## 必读与同步

- 开新会话先读：`PRD.md`（产品需求）、`spec.md`（技术设计）、`TASKS.md`（任务与进度跟踪）。
- 任何代码 / 配置 / 文案改动，**这四个文件（CLAUDE.md / PRD.md / spec.md / TASKS.md）都要同步更新**——文档是单一信息源，遗漏会让后续 agent 失去上下文。
  - 行为变更 → `spec.md` 对应章节加一句或扩写实现说明
  - 任务状态 → `TASKS.md` 勾掉 checkbox，进度跟踪表新增一行
  - 范围/目标变化 → 改 `PRD.md`
  - 新的协作约定/禁区 → 改本文件

## 项目一句话

本地优先的 15 分钟学习闭环：抽卡 → 10 分钟研究（可选 AI 速览）→ 3/5 分钟口述 → AI 复盘。所有数据落浏览器，**无账号、无服务端业务逻辑**；后端仅 `/api/ai` 一条 SSE/Completion 代理，规避浏览器 CORS。

## 技术栈要点

- React 19 + TypeScript + Tailwind v4，运行在 **Vinext/Vite + Cloudflare 插件**（不是纯 Next.js，但保留 `app/` 目录约定）。
- 存储：`localStorage` 存轻量偏好与加密 AI 配置；`IndexedDB` 存音频 Blob / 历史 / 个人词条。
- 录音：`MediaRecorder` + MIME 探测；转写：`SpeechRecognition` 能力探测 + 手动兜底，不上传音频。
- 加密：`Web Crypto` PBKDF2-SHA-256 + AES-GCM；明文 API Key 只在内存中。
- 部署：本地 `npm run dev` (Vite 3000) 或 `npm start` (`wrangler dev` 读 `dist/server`)；公网部署走 Cloudflare Pages（Functions 保留 `/api/ai`），流程见 `DEPLOY.md`。
- 公网安全：`/api/ai` 默认上限 5 req/min + 100 req/IP/日，绑定 `RATE_LIMIT_KV`（生产需替换 `wrangler.jsonc` 里的 `REPLACE_WITH_KV_NAMESPACE_ID`）。决策逻辑在 `lib/rate-limit.ts`，纯函数被 `tests/rate-limit.test.ts` 覆盖。

## 模块速查

```
app/                    Vinext 路由 & layout
  api/ai/route.ts       唯一服务端入口：DeepSeek + MiniMax CN/Intl 的 Completion 代理
  page.tsx              <LearningApp />
components/
  learning-app.tsx      状态机 + 所有阶段 UI（draw/research/prepare/speak/transcript）
  phase-three.tsx       AI 设置 / 评价 / 维基搜索 / 历史 四个 modal
lib/
  ai.ts                 SSE 解析、按模型分流、超时、错误归类
  ai-models.ts          ModelBehavior 注册表（DeepSeek/MiniMax/Claude 3.7 规则）
  ai-proxy.ts           supportedEndpoints 白名单 + 旧路径映射
  rate-limit.ts         纯函数频控决策（5/min、100/日），route.ts 在 KV 上适配
  research-ai.ts        ResearchAiState 类型（unavailable/loading/ready/failed）
  secure-config.ts      Web Crypto 加密/解锁/清除
  local-repository.ts   IndexedDB 音频与历史
data/terms.ts           12 领域 144 词条（修改会带动 Phase 1 验收）
tests/                  node:test 跑单测；fixtures 不要 mock 真实 fetch
```

## AI 集成的关键约束

- 浏览器直连自定义 Endpoint 会撞 CORS，所以 **preset（`/api/ai` 白名单内）一律走代理**，自定义走浏览器直连并依赖对方 CORS 头。
- `verifyAiKey` 只对 preset Endpoint 生效，自定义直接 throw "自定义 Endpoint 暂不支持官方 API Key 验证"。
- 上游对鉴权失败常用 **HTTP 200 + JSON 错误体**（MiniMax `base_resp.status_code`、OpenAI `error.message`、通用 `message`），`verifyAiKey` 必须二次校验；仅看 `response.ok` 会"假成功"。
- 研究速览 / 评价都走 SSE；`parseSSE` 在 `lib/ai.ts`，增量回调分 `onTextDelta` / `onThinkingDelta`。
- 按模型分流在 `lib/ai-models.ts`：DeepSeek `thinking: disabled`、MiniMax M2/M3 默认禁用思考（即便回退仍可能只返 thinking）、Claude 3.7 启用扩展思考。修改前先翻 `spec.md` §5.4。
- 中文思考可作为可见草稿（`isMostlyChinese` >40%），英文独白隐藏——这条铁律改之前要确认 UI 影响面。

## 开发约定

- **新增/改动后必跑**：`npm run lint`、`npm test`、`npm run build`。`TASKS.md` 3.6 是浏览器端含真实 Endpoint 的最后一关。
- 单测用 `node --test`，不要装 Vitest；`package.json` 已固定。
- 浏览器 fetch 失败用 `lib/ai.ts` 的 `isNetworkFetchError` + `formatFetchError` 出友好提示，**别再让 `TypeError: Failed to fetch` 直接漏到 UI**。
- 改动 SSE 解析路径请在 PR 描述里附"先后/4"模型分流是否变化。
- 不要提交任何含明文 API Key、token、`dist/`、`node_modules/` 的文件。
- 不要在 `useEffect` 体内直接 `setState` 同步触发另一个 setState（oxlint `react-compiler` 规则）；需要延后用 `queueMicrotask` 或迁到事件回调。

## 禁区

- 不上传录音、不引入第三方分析/埋点脚本。
- 不在产品代码里写死真实 API Key 或 endpoint 例外到仓库。
- 不在 PR 中"顺手"重构不在本任务范围内的文件——CLAUDE.md 要求改动有据可查。
- 不绕过 `lib/ai.ts` 直接 fetch（会绕开超时、错误归类、模型分流）。