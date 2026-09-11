# 部署指南 — Cloudflare Workers（Vinext 项目）

本文档覆盖把本地开发项目推到公网域名的全过程。目标托管：**Cloudflare Workers**（带 static assets binding），保留 `/api/ai` 服务端入口，绕开浏览器 CORS。

部署后所有数据继续留在浏览器（localStorage + IndexedDB），**不存在用户账号、云同步或服务端业务状态**；`/api/ai` 只是把请求中继到 DeepSeek / MiniMax 两个白名单厂商，用户的 API Key 仍在浏览器本地加密。

> ⚠️ **项目类型是 Workers，不是 Pages**。Vinext 编译产物（`dist/server/wrangler.json`）走 Workers 部署模式（带 `main` 入口 + `assets` binding），不能用 `wrangler pages deploy` 部署；Pages 部署会找不到 `_worker.js` 导致所有请求 404。详见 §8。

---

## 1. 前置条件

| 项 | 说明 |
|---|---|
| Cloudflare 账号 | 免费注册即可，无需绑卡 |
| 域名（可选） | 在 Cloudflare Registrar 或别处注册；不带域名也能用 `<project>.workers.dev` 临时域名 |
| Node.js ≥ 22.13 | 与 `package.json` 的 `engines` 字段对齐 |
| Wrangler CLI | `npx wrangler --version` 验证；Cloudflare 控制台部署则不需要本地 CLI |

---

## 2. 在 Cloudflare Workers 创建项目

1. 打开 <https://dash.cloudflare.com/> → **Workers & Pages** → **Create** → **Create Worker**（**不要选 Pages**，详见 §8）
2. 选择 **Connect to Git** → 选 GitHub 账号与仓库 `lianshenyi/10min-talk`
3. 配置构建设置：

   | 字段 | 值 |
   |---|---|
   | Project name | `10min-talk`（可改名，会决定默认域名 `<name>.workers.dev`） |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Build output directory | `dist/server`（**关键**：Vinext 的 worker entry + 配置都在这里） |
   | Root directory | *（留空）* |
   | Environment variables | `NODE_VERSION` = `22` |
   | Deploy command | `npx wrangler deploy --config dist/server/wrangler.json` |

4. **先不要点 Save and Deploy** —— 还需要先建 KV 并配置构建变量（下一节）。

---

## 3. 创建 KV 命名空间

`/api/ai` 频控依赖一个 KV 命名空间，binding 名固定为 `RATE_LIMIT_KV`。Vinext 会在构建时读取 `RATE_LIMIT_KV_NAMESPACE_ID` 并写入生成的 `dist/server/wrangler.json`；仓库不保存任何环境特定的 namespace ID。

### 方式 A：通过 Cloudflare 控制台（推荐）

1. 进入项目的 **Storage & Databases** → **KV**，创建命名空间 `10min-talk-rate-limit`，复制其 ID。
2. 回到项目的 **Settings** → **Build** → **Build Variables and Secrets**，添加普通构建环境变量：名称 `RATE_LIMIT_KV_NAMESPACE_ID`，值为刚复制的 ID。不要填到 Runtime Variables and Secrets；后者不会提供给构建命令。
3. 对 **Production** 和 **Preview** 都填写同一个值。
4. 不要把该 ID 写入 `wrangler.jsonc`，也不要把 `RATE_LIMIT_KV_NAMESPACE_ID` 作为应用代码读取的运行时变量；它只用于生成真正的 KV binding。

### 方式 B：通过 wrangler CLI

```bash
npx wrangler kv namespace create RATE_LIMIT_KV
# 输出形如：
# ⎡  Adding the following to your Project's KV Namespaces:
# ⎣  { binding = "RATE_LIMIT_KV", id = "abcd1234..." }
```

把输出的 `id` 填入 Cloudflare 的 `RATE_LIMIT_KV_NAMESPACE_ID` 构建环境变量，不提交到仓库。本地如需模拟生产 binding，可临时在 shell 中设置该变量后运行 `npm run build`；未设置时本地继续使用频控回退路径。

---

## 4. 配置消费上限（防滥用兜底）

频控是软的——防脚本小子；消费上限是硬的——防账号爆掉。

1. Cloudflare 控制台 → **Workers & Pages** → 你的项目 → **Settings** → **Usage model**
2. 把 **Daily request limit** 设为 **$1 USD**（个人项目绑死就够，任意异常流量到此为止）
3. 保存后一旦单日 Workers 计费逼近 $1，Cloudflare 自动停止服务；不会有意外账单

如果项目预期会有较多 AI 调用（> 10k 次/日），再把上限提到 $5 或 $10 即可。

---

## 5. 添加自定义域名（可选）

1. 项目 → **Settings** → **Triggers** → **Custom Domains** → **Add Custom Domain**
2. 输入你拥有的域名，例如 `10min.example.com`
3. 如果域名已在 Cloudflare 托管：自动签发证书 + 自动加 DNS 记录，1 分钟生效
4. 如果域名在别处：Cloudflare 显示需要添加的 CNAME 记录，去域名注册商处添加

---

## 6. 完成部署

回到第 2 步的项目列表页，点 **Save and Deploy**。

首次构建大约 1-2 分钟（含 npm install + vinext build）。完成后：

- 临时域名：`<project>.workers.dev`
- 自定义域名（若配置）：你注册的域名
- HTTPS：自动签发

部署命令的详细路径：

```bash
# 本地部署等价命令（控制台 Save and Deploy 触发的就是这个）
npx wrangler deploy --config dist/server/wrangler.json
```

`dist/server/wrangler.json` 是 Vinext 构建产物（含 `main: "index.js"` + `assets.directory: "../client"` + 合并的 KV bindings），不是项目根的 `wrangler.jsonc`——后者只用于本地 `wrangler dev`，生产部署必须用 Vinext 生成的配置。

---

## 7. 部署后验证清单

打开站点后按顺序检查：

- [ ] 首屏渲染出卡片堆
- [ ] 换卡 → 选中 → 进入研究阶段
- [ ] 在 AI 设置里填入 DeepSeek 或 MiniMax 的 Key，点 **测试连接**：返回成功（而不是 CORS 错误）
- [ ] 跑一次 AI 研究速览或 AI 评价：能看到流式输出
- [ ] 在浏览器开发者工具的 Network 面板观察 `/api/ai` 响应头里包含 `X-RateLimit-Remaining-Minute`
- [ ] 反复刷新 `/api/ai` 11 次以上，应看到第 11 次返回 `429 Too Many Requests`，body 含 `reason: "per-minute"`

---

## 8. 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| 部署后页面 404 | Build output 配错 | 改成 `dist/server`，不是 `dist`、`dist/client` 或 `dist/server/_next` |
| wrangler 部署报 `Authentication error [code: 10000]` | `CLOUDFLARE_API_TOKEN` 缺对应产品的 Edit 权限（Workers 板块需 `Workers 脚本: 编辑`，Pages 板块需 `Cloudflare Pages: 编辑`） | 去 [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) 给 token 加对应的 Edit 权限 |
| wrangler 部署报 `Project not found [code: 8000007]` on `/pages/projects/...` | 项目实际在 **Workers 板块**（`workers/services/view/...`），但部署命令用了 `wrangler pages deploy` | 两种产品 API 路径不同、互相看不见。Vinext 项目应在 Workers 板块 + 用 `wrangler deploy`；如果误建在 Pages 板块，删掉重建到 Workers 板块 |
| wrangler 部署报 `Project not found [code: 8000007]` on `/workers/services/...` | 项目实际在 **Pages 板块**（`pages/view/...`），但用了 `wrangler deploy` | 同上——把项目挪到对应板块 |
| 部署日志显示 `Success: Your site was deployed!`，但访问 `<id>.<project>.pages.dev` 返回 404 | **项目建错板块**（Pages 部署了 Vinext worker 产物）：Pages 找不到 `dist/_worker.js`，所有请求走 static fallback → `/` 没匹配的 HTML → 404。Vinext 项目本质是 Workers 项目，编译产物走 `main` 入口而不是 `_worker.js` | 删 Pages 项目，在 Workers 板块重建 + 改用 `wrangler deploy --config dist/server/wrangler.json`（详见 §2 §6）|
| `/api/ai` 返回 `KV namespace not found` | 没绑 `RATE_LIMIT_KV` 或 variable name 拼错（必须是 `RATE_LIMIT_KV`，不能写成 namespace 名） | 回 §3 补 binding，Variable name 严格等于 `RATE_LIMIT_KV`，KV namespace 选 `10min-talk-rate-limit` |
| `/api/ai` 一直返回 502 | KV 频控判断走了回退 | 检查 binding 名大小写必须 `RATE_LIMIT_KV` |
| 自定义域名报 525/526 | 域名不在 Cloudflare 托管时 CNAME 未生效 | 等 DNS 生效（最长 24h）或改用 Cloudflare Registrar |
| Workers 单日耗尽 | 达到 $1 消费上限 | 临时去 Usage model 调高；长期考虑加 Turnstile |
| 本地 `npm start` 起不来 | 没 build | 先 `npm run build`；`dist/server/wrangler.json` 是必需产物 |
| 部署日志里 wrangler 报 `custom API token set in an environment variable` | `CLOUDFLARE_API_TOKEN` 被注入到 Workers CI 环境（Cloudflare Workers 自身、GitHub repo secrets 或 Account 级别设置都可能） | 项目级删不掉时，去 GitHub repo Settings → Secrets 删；Account 角色（Super Administrator）与 token 权限是两套，账号角色不影响 token scope |
| wrangler 告警 `Pages now has wrangler.json support` / `dist/server/wrangler.json missing pages_build_output_dir` | Vinext 构建时输出 `dist/server/wrangler.json`（Workers 配置，带 `main` + `assets`），被新版 Pages 误读为 Pages 配置 | **可忽略**——wrangler 会忽略该配置、走 CLI flag；正确部署走 Workers 板块，不触发这条 warning |
| `request.env` 在代码里被使用，担心升级 Vinext 时翻车 | `request.env` 是 Vinext 内部封装，**不是 Cloudflare 官方 API**（标准 Pages Functions 用 `context.env`，advanced mode / Workers 用 `env` 参数） | 当前 Vinext 1.0.0-beta.5 在 worker fetch handler 里把 env 挂到 Request 上能跑通；升级 Vinext 时需要回归 `/api/ai` 的 KV 频控路径 |
| 想"零 token"部署被 UI 阻断 | 新版 Cloudflare 控制台 UI 强制要求"部署命令"字段，任何真实 deploy 命令最终都要打 Cloudflare API、都需 token | 当前 Cloudflare 架构下"零 token"不可达，给 token 加对应产品 Edit 权限是唯一稳定解 |

---

## 9. 持续部署

Cloudflare Workers 默认监听 GitHub `main` 分支推送。每次 `git push origin main` 会触发自动构建与发布。

如果需要预发环境，在 Cloudflare 控制台配置 Preview branches，绑定到任意非 main 分支（PR 自动部署）。

---

## 10. 回滚

控制台 → 项目 → **Deployments** → 找到上一个稳定版本 → **Rollback to this deploy**。KV 频控数据不回滚（它只影响瞬时计数）。
