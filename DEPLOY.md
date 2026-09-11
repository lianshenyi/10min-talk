# 部署指南 — Cloudflare Pages

本文档覆盖把本地开发项目推到公网域名的全过程。目标托管：**Cloudflare Pages**（Functions 模式保留 `/api/ai` 服务端代理，绕开浏览器 CORS）。

部署后所有数据继续留在浏览器（localStorage + IndexedDB），**不存在用户账号、云同步或服务端业务状态**；`/api/ai` 只是把请求中继到 DeepSeek / MiniMax 两个白名单厂商，用户的 API Key 仍在浏览器本地加密。

---

## 1. 前置条件

| 项 | 说明 |
|---|---|
| Cloudflare 账号 | 免费注册即可，无需绑卡 |
| 域名（可选） | 在 Cloudflare Registrar 或别处注册；不带域名也能用 `<project>.pages.dev` 临时域名 |
| Node.js ≥ 22.13 | 与 `package.json` 的 `engines` 字段对齐 |
| Wrangler CLI | `npx wrangler --version` 验证；Cloudflare 控制台部署则不需要本地 CLI |

---

## 2. 在 Cloudflare Pages 创建项目

1. 打开 <https://dash.cloudflare.com/> → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选择 GitHub 账号与仓库 `lianshenyi/10min-talk`
3. 配置构建设置：

   | 字段 | 值 |
   |---|---|
   | Project name | `10min-talk`（可改名，会决定默认域名 `<name>.pages.dev`） |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | *（留空）* |
   | Environment variables | `NODE_VERSION` = `22` |

4. **先不要点 Save and Deploy** —— 还需要先建 KV（下一节）。

---

## 3. 创建 KV 命名空间

`/api/ai` 频控依赖一个 KV 命名空间，binding 名固定为 `RATE_LIMIT_KV`。

### 方式 A：通过 Cloudflare 控制台（推荐）

1. 进入项目的 **Settings** → **Functions** → **KV namespace bindings** → **Add binding**
2. Variable name: `RATE_LIMIT_KV`
3. KV namespace: **Create new namespace**，名字 `10min-talk-rate-limit`
4. 选 Production 和 Preview 两种环境都勾上

### 方式 B：通过 wrangler CLI

```bash
npx wrangler kv namespace create RATE_LIMIT_KV
# 输出形如：
# ⎡  Adding the following to your Project's KV Namespaces:
# ⎣  { binding = "RATE_LIMIT_KV", id = "abcd1234..." }
```

把拿到的 `id` 替换 `wrangler.jsonc` 里的 `REPLACE_WITH_KV_NAMESPACE_ID` 字符串，然后提交。

---

## 4. 配置消费上限（防滥用兜底）

频控是软的——防脚本小子；消费上限是硬的——防账号爆掉。

1. Cloudflare 控制台 → **Workers & Pages** → 你的项目 → **Settings** → **Usage model**
2. 把 **Daily request limit** 设为 **$1 USD**（个人项目绑死就够，任意异常流量到此为止）
3. 保存后一旦单日 Workers 计费逼近 $1，Cloudflare 自动停止服务；不会有意外账单

如果项目预期会有较多 AI 调用（> 10k 次/日），再把上限提到 $5 或 $10 即可。

---

## 5. 添加自定义域名（可选）

1. 项目 → **Custom domains** → **Set up a custom domain**
2. 输入你拥有的域名，例如 `10min.example.com`
3. 如果域名已在 Cloudflare 托管：自动签发证书 + 自动加 DNS 记录，1 分钟生效
4. 如果域名在别处：Cloudflare 显示需要添加的 CNAME 记录，去域名注册商处添加

---

## 6. 完成部署

回到第 2 步的项目列表页，点 **Save and Deploy**。

首次构建大约 1-2 分钟（含 npm install + vinext build）。完成后：

- 临时域名：`<project>.pages.dev`
- 自定义域名（若配置）：你注册的域名
- HTTPS：自动签发

---

## 7. 部署后验证清单

打开站点后按顺序检查：

- [ ] 首屏渲染出卡片堆
- [ ] 换卡 → 选中 → 进入研究阶段
- [ ] 在 AI 设置里填入 DeepSeek 或 MiniMax 的 Key，点 **测试连接**：返回成功（而不是 CORS 错误）
- [ ] 跑一次 AI 研究速览或 AI 评价：能看到流式输出
- [ ] 在浏览器开发者工具的 Network 面板观察 `/api/ai` 响应头里包含 `X-RateLimit-Remaining-Minute`
- [ ] 反复刷新 `/api/ai` 6 次以上，应看到第 6 次返回 `429 Too Many Requests`，body 含 `reason: "per-minute"`

---

## 8. 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| 部署后页面 404 | Build output 配错 | 改成 `dist`，不是 `dist/client` 或 `dist/server` |
| `/api/ai` 返回 `KV namespace not found` | 没绑 `RATE_LIMIT_KV` | 回第 3 步补 binding，重新部署 |
| `/api/ai` 一直返回 502 | KV 频控判断走了回退 | 检查 binding 名大小写必须 `RATE_LIMIT_KV` |
| 自定义域名报 525/526 | 域名不在 Cloudflare 托管时 CNAME 未生效 | 等 DNS 生效（最长 24h）或改用 Cloudflare Registrar |
| Functions 单日耗尽 | 达到 $1 消费上限 | 临时去 Usage model 调高；长期考虑加 Turnstile |
| 本地 `npm start` 起不来 | 没 build | 先 `npm run build`；`dist/server/wrangler.json` 是必需产物 |

---

## 9. 持续部署

Cloudflare Pages 默认监听 GitHub `main` 分支推送。每次 `git push origin main` 会触发自动构建与发布。

如果需要预发环境，在 Cloudflare 控制台创建 **Preview** 配置，绑定到任意非 main 分支（PR 自动部署）。

---

## 10. 回滚

控制台 → 项目 → **Deployments** → 找到上一个稳定版本 → **Rollback to this deploy**。KV 频控数据不回滚（它只影响瞬时计数）。
