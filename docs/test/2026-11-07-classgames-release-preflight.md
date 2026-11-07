---
updated_at: 2026-11-07T16:28:36+08:00
git_commit: 885e3c2a5553b88d41d3366cdc346c238ceafe79
---

# classgames 人工发布：只读盘点与准备记录

## 授权范围与结论

用户于 2026-11-07 批准从 classgames 试点，当前仅执行只读盘点和实施准备；真正部署生产前另行确认。本文不是发布成功证明，不代表发布功能已实现或生产授权已获得。

关键链路事实已取得：Cloudflare、GitHub、飞书和 Hermes 源码。现有凭据完成只读查询；未创建/升级 token，未修改配置、DNS、路由、GitHub 规则或自动部署开关，未发送业务消息、dispatch、部署或重启服务。飞书 tenant token 仅经现有应用凭据正常换取，用于读取，不落盘、不输出。

尚待落实的启用条件：真实人工发布者授权名单、首次线上 Git SHA 对应关系、GitHub 私有仓库套餐/规则能力、独立 GitHub App/签名与 claim 通路、后续发布写凭据。以上不阻止离线开发，但阻止生产启用。

## 1. Cloudflare 线上基线

来源：现有云端只读凭据 GET 和已登录 Cloudflare 后台网络响应，交叉核验；后台检查使用标签页 `375373589`。没有点击 Create token、Connect、Save 或 Deploy。

| 项目 | 当前值 |
| --- | --- |
| account ID | `7daf69e93f12575570a679bb91cc1e76` |
| Worker / environment | `classgames` / `production` |
| script tag | `fb716a2b4dac422588d12a9c8af983f0` |
| zone ID | `3a05bbc484d36da05b864c2a509c6a0b` |
| 自定义域名 | `classgames.net`、`www.classgames.net`，均 enabled |
| 当前 deployment ID | `fce99234-160f-4715-ab0f-f5e7a5151e3d` |
| 当前 version ID | `ead4ab79-fcc2-4f5d-b6fd-bd36373778ae`，100% 流量 |
| 上次发布时间 | `2026-11-03T10:28:13.42034Z`，即北京时间 2026-11-03 18:28:13 |
| 发布来源 | `wrangler` |
| compatibility date | `2026-07-31`；flags 为空 |
| runtime bindings | 仅 `ASSETS`，类型 assets；本次 settings 未列出 KV/R2/D1/secret bindings |
| 静态资源行为 | `404-page`、`run_worker_first=true` |
| observability | enabled；日志采样 1；与仓库配置兼容 |

当前 version 元数据没有 Git commit SHA/tag。**不能据此把当前线上版本归因为当前 main，也不能准确生成“线上 SHA → main”的完整 PR 差异。**

上一个历史版本 `dda6b878-aaad-4aa4-88e6-51cf397464bb` 虽可见，但未验证历史健康，不把它自动指定为安全回滚点。当前线上 version 已有只读健康观测，可作为后续试点前的回滚候选，届时仍需新鲜校验和单独确认。

### 自动发布盘点

- 后台 Settings 显示 Git repository 为 Connect（未关联）。
- 后台 GET `/builds/workers/{script_tag}` 返回 404，错误 12040：没有关联 build configuration。
- `/builds/builds/latest?external_script_ids={script_tag}` 成功返回空 builds。
- `/builds/workers/{script_tag}/deploy_hooks` 成功返回空数组。
- Cron schedules 为空；传统 Worker Routes 为空，不代表 Custom Domains 为空；自定义域名已另行确认。
- 结论：当前未发现该 Worker 的 Cloudflare 原生 Git 自动构建或 deploy hook，**不需要为本次准备关闭任何 Cloudflare 自动生产开关**。这不排除其他机器持有 Wrangler 凭据；真实切换前仍需约定单一生产写入口。

云端已存在 `/root/.hermes/credentials/cloudflare-readonly.json`，权限 0600/root；文件声明 Scripts Read、Account Analytics Read、Pages Read，本轮 Scripts/Version 查询成功。Workers CI trigger 列表 GET 返回 403，故不把它当空列表；Git 构建结论来自上面的已登录后台响应，不升级该 token 权限。先前本机 OAuth 403 不再阻断 classgames 只读盘点，但也没有被修复或替换。

后台提供“仅部署此 Worker 的 account API token”入口。未创建或验证其策略；后续优先评估该入口，不先使用账户全量 Workers Edit。域名/Routes 修改权限是否必需，应结合锁定配置和部署实际行为核验。

## 2. 网站只读冒烟

本机真实 HTTP 请求结果，不代表所有地域或浏览器：

| 请求 | 结果 |
| --- | --- |
| `GET https://classgames.net/` | 200 HTML；canonical 自指；无 X-Robots-Tag noindex |
| `HEAD https://www.classgames.net/` | 301 → `https://classgames.net/` |
| `GET /robots.txt` | 200；Allow `/`；指向正确 sitemap-index |
| `GET /sitemap-index.xml` | 200 XML；包含 sitemap-0.xml；lastmod 为 2026-11-03 |
| `GET /__codex_nonexistent_readonly_probe__` | 404 HTML |
| `HEAD /`，Accept `text/markdown` | 200 `text/markdown; charset=utf-8`；Vary: Accept |

首页 `Cache-Control: public, max-age=300, must-revalidate`，本次多次响应为 HIT。后续版本证明须结合控制面与非缓存版本标记，不能仅用首页 200 或现有内容哈希判断更新。

## 3. GitHub / 构建基线

- 仓库 `blackpill/classgames.net`，ID `1223017142`，private，默认分支 main。
- 本轮 main SHA `13fe3976db0a865c9884a69efeeb4440b38e7b4c`。
- main CI run `42168718106` completed/success，检查名 `verify`：[运行记录](https://github.com/blackpill/classgames.net/actions/runs/42168718106)。本轮没有重跑远端 Actions。
- 仅 `.github/workflows/issue-auto-ci.yml`，PR/main push 均触发，Node 22、pnpm 10.18.2、Ubuntu 24.04，超时 30 分钟。
- `pnpm verify = pnpm test:ci-contract && pnpm check && pnpm test:e2e`；test:e2e 会构建并运行 Playwright，Chrome channel，单 worker，本地预览端口 4322。
- lockfile 中 Wrangler 实际锁定 `4.116.0`，不是 package.json 范围下限 `4.28.1`。
- 仓库级 Secrets/Variables/Environments 均空；当前所有者为个人账号，不把“空仓库 secrets”泛化成该账号其他凭据也为空。
- main 未保护，rulesets 为空；Actions allowed_actions=all、sha_pinning_required=false；默认 GITHUB_TOKEN 为 read，不能批准 PR。
- 账户 `/user` 返回 plan=null，不能据此认定 Free/Pro 或宣称已支持私有环境审批。生产前需确认可用规则，或取得用户对明确替代边界的批准；没有试写设置来测试套餐。

### 本轮本地验证

从上述精确 SHA 下载 GitHub archive 到 `/tmp/classgames-release-preflight.2NRuif/source`，不修改用户 checkout、不安装依赖、不启动本地网站。

执行 `node --test scripts/ci-contract.test.mjs`：**4/4 通过**。没有在本轮重跑完整 build/check/E2E，完整 main 验证证据来自上述现有远端 CI。

关键文件 SHA-256：

```text
wrangler.jsonc                     d12d0ab84fdc2722c3fe6a3339c64776b815f7cc1e38be78c591cea32cf0c18b
pnpm-lock.yaml                     88269a34a66815424d5d773b47cc253f906e60201d0273431d91f948cefd91ba
.github/workflows/issue-auto-ci.yml 90518695201ebc5c4f4101ff57ed2c16e5f3ec655fe0adc743aa2147533fa972
```

## 4. 飞书与 Hermes 接线

- 管理群配置：`oc_0e8427180f15b964018e2f899dd66879`，API 实读群名 **Hermes｜classgames.net**，private group。
- CodexReach 开发群是另一群 `oc_cb909557b30b0a6eed0182e840a50762`，不能误作发布确认入口。
- 现有应用身份读取管理群、最近一条消息、按 message_id 读取同一消息均成功 code=0；没有读取/保存无关会话全文。
- 消息响应包含 body、chat_id、message_id、create_time、update_time、updated、deleted 和 sender.id/id_type/sender_type。样本为 app 消息，只证明接口能力，不冒充真人确认测试。
- 根配置 `FEISHU_ALLOW_ALL_USERS=true`，未得到有效的发布者白名单。**聊天可用性不是发布授权**；不修改全局聊天权限，发布服务默认空 allowlist，未注册的真人一律不得批准。
- Hermes 源码 HEAD `3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065`。`plugins/platforms/feishu/adapter.py` 将原始 message_id、sender、thread、raw_message 送入 MessageEvent；gateway/run_turn.py 保留 message_id。确认入口实际可否直接提供给 Skill 仍需无副作用联调，不能只凭这些源码宣称已端到端接通。
- 可避免改网关的接线：发布服务在固定管理群、固定 pending release 的时间窗口内只读定位含精确确认码的消息，返回候选 ID，再用消息 API 独立校验。不按“最后一条消息”授权，不信模型传入的 sender；多个候选按歧义拒绝。这样无需新增第二个 WebSocket 消费者。
- `/srv/hermes/release-control` 尚不存在，cloudflared 不在当前 PATH；本轮没有创建服务、Tunnel 或安装程序。HTTPS claim 通路是后续单独的基础设施步骤。

## 5. 首次启用的特殊门槛

1. **线上 SHA 未知**：先尝试从既有发布记录人工核对。仍无法核对时，首次确认必须显式展示“线上版本已知、线上 SHA 未知，无法保证完整差异”，由用户审阅整个目标 SHA 后另行批准；不猜测线上 SHA，也不把已知几个 PR 说成完整变化集。首次受控发布之后记录 SHA/version 关联。
2. **预发布域名重定向陷阱**：main 的 Worker 把非 `classgames.net` 请求 301 到正式站。原样部署临时 Worker 会测到旧生产站，而不是新产物。后续需要固定 staging 配置和专用 canonical-host 处理，或先用本地 Worker 绑定测试；不能把跳转后的生产 200 算预发布验收。新增 staging 行为不得放松生产 canonical/HTTPS/noindex 边界。
3. **身份注册**：须由用户指定唯一或明确的发布者 open_id；用一条不触发部署的真实人工消息完成验证。不得拿群主、最近发言者或模型猜测当授权。
4. **私有仓库保护能力**：核实套餐，落实可用的分支/环境限制；若不可用则明确替代方案并再次确认，不擅自付费升级。
5. **权限准备**：独立 GitHub App、签名密钥、HTTPS claim、发布 token 均未创建。它们不是只读盘点的授权延伸；后续安装/配置与生产发布分开记录。

## 6. 下一阶段边界

可继续：审核实施计划、同意隔离工作区后离线编码、fake API/TDD、安全打包 dry-run；不使用生产写凭据。

本阶段不执行：真实 preview/production 部署、GitHub App 安装、写 token 创建或 Secret 配置、生产开关打开、main 合并、DNS/域名修改、全局 Hermes 配置修改、服务重启。

参考：[已批准总体设计](../spec/2026-11-07-hermes-manual-release-design.md)、[实施计划](../implement/2026-11-07-classgames-manual-release-plan.md)。
