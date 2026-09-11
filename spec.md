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
职责：构造白名单请求、设置超时、标准化两类响应、校验评价 JSON、分类错误。

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

