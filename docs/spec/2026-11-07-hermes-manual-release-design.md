---
updated_at: 2026-11-07T16:32:16+08:00
git_commit: 885e3c2a5553b88d41d3366cdc346c238ceafe79
---

# 云 Hermes 人工确认网站发布方案

状态：用户已于 2026-11-07 批准总体方案并同意先从 classgames 试点；当前授权范围仅只读盘点与实施准备，真正部署生产前再次确认。其他网站尚未启用，不包括移动 App、Hermes 自身或 Mac Bot。

## 1. 目标、选择与边界

用户已选择 GitHub Actions。流程为：人工审核合并 PR → 云 Hermes 准备发布清单 → 人工明确确认 → 固定 Actions workflow 验证与构建 → Cloudflare 发布 → 验证与回报。不依赖 Mac 在线。

备选比较：Hermes 直接调用 Cloudflare 较轻量，但云端需承担构建或原生构建协调、凭据和审计；Mac 发布可以复用环境，但依赖 Mac 在线。选择 Actions 集中构建与部署日志，Hermes 不持有 Cloudflare 写权限。

不做自动合并、合并即生产部署、Issue 标签触发发布、任意 shell、自动回滚、R2 批量内容上传或数据库迁移。自然语言只能表达意图，不能充当授权证据。

## 2. 已核实事实（2026-11-07）

直接查询 GitHub 默认分支和 API，而非以本地 checkout 为准：

| 项目 / repo ID | main 中部署配置 | 已有 CI | 本轮发现 |
| --- | --- | --- | --- |
| `blackpill/usmapgames.com` / `1444221313` | `wrangler.jsonc` 名称为 `usmapgames-local-preview`；Worker + `dist` 静态资产；没有生产域名 routes | `.github/workflows/issue-auto-ci.yml`，只在 PR 触发，分拆构建/E2E 后聚合 `verify` | main 无 check-run、无 main Actions run；不能把 PR 检查当合并 SHA 检查；不能直接部署当前预览配置 |
| `blackpill/classgames.net` / `1223017142` | Worker `classgames`；入口 `src/worker.mjs`；根域和 www 自定义域名；`dist` + ASSETS | `.github/workflows/issue-auto-ci.yml`，PR + main push；Node 22、pnpm 10.18.2；`pnpm verify` | main 最新检查 `verify` 成功；适合作为首个试点 |
| `blackpill/colorearmundo.com` / `1316936114` | Worker `colorearmundo`；入口 `worker/index.ts`；根域和 www；`COLORING_ASSETS` 绑定 R2 `colorearmundo-assets` | `.github/workflows/verify.yml`，PR + main push；Node 22.16.0、npm；`npm test` | main 最新检查 `verify` 成功；应用回滚不等于 R2 内容回滚 |

三个仓库都是私有仓库；均仅有一条 CI workflow，没有发布 workflow；仓库级 Actions Secrets 和 Environments 返回空；`main.protected=false`，rulesets 为空。这里只证明仓库级查询结果，不推断组织级 secrets 或账户套餐。

云端 `/srv/hermes/integrations/projects.json` 已登记三网站，也含两个移动项目；新增发布白名单只能包含三个网站，不能直接复用整份登记表作为发布授权。原运营桥 `create/list/refresh/sync/base-read` 不提供 deploy。

本机网站 checkout 与远端 main 有差异（例如新增 verify/printables 检查），实施必须从远端已核实提交创建隔离分支，不覆盖本地未提交工作。

### 尚未核实，不得默认通过

以下为首次调查时的缺口。后续 classgames 已使用现有云端只读凭据和后台响应补齐线上版本、域名、bindings及无关联构建的事实；详见[只读盘点](../test/2026-11-07-classgames-release-preflight.md)。其他网站不据此推断已核实，未映射线上SHA及人工授权等缺口仍保留。

- Cloudflare 本地现有 OAuth 凭据调用 accounts 返回 403，原因未判定；不能声称账户为空或凭据已过期。
- 使用登录 Chrome 打开后台，页面停留 Loading，后续扩展调用超时；未取得有效的当前 Worker、版本、域名或 Builds 数据。
- 因此尚不知道各站当前线上 Worker 精确名称、部署版本、是否有 Git 自动生产发布、运行时 secrets/bindings 与仓库是否一致。
- usmapgames 历史本地文档出现 `usmapgames-preview` 公开 noindex 测试 Worker，不是本轮生产核实证据；其生产产物需要显式 `DEPLOY_ENV=production` 与匹配的 SEO 校验。
- 云 Hermes 飞书原始消息 ID 能否稳定传给工具、读取真实消息所需 scopes、人工操作者 open_id、最终确认群/话题，需只读联调核实。

以上均是各项目启用前置条件。先补齐只读访问，不为调查创建宽权限 token；具体凭据授权需另行确认。

## 3. 人工操作约定（本方案建议）

首版采用纯文本精确确认，避免把飞书卡片回调公网接入作为首发依赖。后续卡片可复用同一授权逻辑。

1. 用户在该项目运营群向 Hermes 说“准备发布 classgames”。
2. 固定发布服务生成不可变 `release_id`，向同一会话直接发送发布清单：项目、生产域名、当前 deployment/version、目标完整 SHA、差异提交及关联 PR、CI 状态、存储/配置风险、有效期。
3. 提示用户发送 `确认发布 <release_id> <一次性确认码>`，确认窗口建议 10 分钟。不接受仅“好的”“继续”，也不解释粘贴/引用内容中的确认文字。
4. Hermes 仅传递确认消息的 `message_id`。服务通过飞书官方消息 API 独立读取原消息，验证真实人类 sender、允许的 open_id、chat/thread、原始文本、创建时间、未编辑/撤回状态和未消费消息 ID；不接受模型自报 sender 或原文。无法验证则拒绝。
5. 服务再次核实目标与 main、线上基线、CI，随后 dispatch。目标 main 或线上基线发生变化，一律使清单失效并要求重新确认，不静默改成新版本。
6. 只发送排队/开始、完成、失败/需人工处理等有意义的通知；用户可询问状态。合并本身不发送重复 PR 通知。

初始只有仓库 main 当前 HEAD 可常规发布，不支持普通命令任意发布历史 SHA；已知旧 Cloudflare version 的回滚走单独确认入口。确认文案明确显示本次所有提交，发布不是“仅部署某个 Issue”。

## 4. 组件与权限

### 4.1 云端发布控制器

在本仓库新增独立 `integrations/hermes/release/`：项目白名单配置、SQLite 台账、prepare/confirm/status/rollback CLI、GitHub/飞书/Cloudflare 只读适配器和后台 reconcile。

上线位置建议 `/srv/hermes/release-control`，独立无登录系统用户、systemd 服务和 0600 凭据，程序文件服务只读、状态目录可写；与现有桥、分析采集、YouTube 服务隔离。Hermes CLI 通过受限本地接口调用，不读取数据库或私钥。

Hermes Skill 只提供项目固定命令，并更新三个项目入口对“允许人工确认发布”的说明；不放开其他原有禁令。确认消息必须是飞书真实用户消息；发布服务用应用身份读取，不持有可冒充人类发送确认消息的 user token。

GitHub 使用单独 GitHub App，安装仅限三网站，权限按实现所需配置 Contents/Checks/PR 只读、Actions 写及必要的 Deployments 读写；不能把 Actions 写称为“单 workflow 权限”，API 并不提供这种粒度。控制器本地白名单进一步限制 workflow/ref/inputs，不复用现有宽权限 gh 登录。

Cloudflare 写 token 仅在 GitHub 发布 secret 中，限制目标账户及所需权限；Workers 自定义域名配置可能需要对应 zone 的 Routes 写权限，实施时实测最小授权，不承诺 token 天然隔离单个 Worker。独立的线上盘点只读凭据不应升级为写。

安全边界：当前 Hermes 以 root 运行。独立系统用户只能减少误用，不能阻止 root 读取私钥/修改程序；本方案不宣称对已攻陷 root 主机有硬隔离。若要求该威胁模型，签发器必须迁到独立安全边界，不能继续在同一 root 主机上加软限制。

### 4.2 授权回执与发布幂等

服务签发短时有效的 Ed25519 授权回执，绑定 `release_id/operation/repository_id/target_sha/target_version/environment/expected_previous_version/config_digest/approved_by/expires_at`，私钥仅服务可读，workflow 固定公钥验签；普通 GitHub Actions 手工输入不能绕过确认。人工确认窗口为 10 分钟；确认后的执行票据建议有效 90 分钟，以容纳完整构建/E2E，deploy 的 claim 时仍校验 main 和线上基线；rollback 使用下节独立规则，超过有效期停止并重新准备，不自动续期。

workflow 在触碰 Cloudflare 写操作前向发布控制器原子 claim。claim 绑定 `run_id/run_attempt/release_id`，只允许一个运行启动一次受控部署尝试；重复 dispatch、GitHub rerun 或并发运行都拒绝。Wrangler 内部涉及多次 API 写入及可能的客户端重试，不能据此宣称 Cloudflare 严格 exactly-once；实施需核实固定工具的重试行为，发生未知结果必须先对账，不能由控制器自动发起第二次部署尝试。控制器接口以受限 HTTPS 暴露，仅用于 claim/status，使用 GitHub OIDC 校验仓库 ID、workflow/ref 和 audience；可通过 Cloudflare Tunnel 接入云端服务，不暴露 Mac 或整套 Hermes 控制台。OIDC 访问与本地 Unix 接口分离，拒绝请求体自报身份。

服务重启从 SQLite 恢复。dispatch 响应丢失标 `DISPATCH_UNCERTAIN`，先按 release_id/run-name 对账，不能自动再次 POST。当前 GitHub REST 版本支持返回 run ID，客户端仍须覆盖未知响应和超时情况。

首版同项目只允许一个未终结发布，额外请求返回“已有发布”；不积压多个过时待发布版本。Actions 另设固定 production concurrency，`cancel-in-progress: false`，不能取消正在切流的发布。平台并发组不是完整幂等或可靠 FIFO，最终以台账 claim 为准。

## 5. 每个网站的 Actions

新增 `.github/workflows/deploy-production.yml`，只有 `workflow_dispatch`，没有 push/schedule/Issue 标签自动发布事件。dispatch 固定 `ref=main`，输入只含 release_id、完整 SHA 和授权回执，不接收命令、Worker 名、域名、bucket 或路径。

执行顺序：

1. 验签与来源校验，固定 repository ID、workflow、production；checkout 精确 SHA，`persist-credentials:false`。不使用仓库输入拼 shell。
2. 对该 SHA 重新验证和构建，而非只依赖 PR CI。安装锁定依赖；Action 固定 commit SHA，Wrangler 取锁文件版本，不执行 `npx ...@latest`。
3. `usmapgames` 复用现有 lint/check/data/unit/printables/E2E/预算验证；生产构建必须显式 `DEPLOY_ENV=production`，SEO、预算和浏览器测试验证同一份最终生产产物，不能用预览 E2E 报告替代。现有环境断言需要参数化时保留预览测试并新增生产覆盖，禁止为了通过删除 noindex 测试；拒绝生产内容页 noindex（404 页保留合理 noindex）。新增独立生产 Wrangler 配置，不能覆盖本地预览配置，也不能发布到带 local-preview 名称的服务。
4. `classgames` 用 pnpm frozen lockfile 与现有 `pnpm verify`，构建结果不再在持有发布凭据的步骤重新生成。
5. `colorearmundo` 用 npm ci + npm test（包括构建）；验证 R2 binding 存在，不执行 `upload:r2` 或修改/删除 R2 对象。包声明虽有 latest，CI 必须使用已提交 lockfile；缺失或不一致直接失败。
6. 无 Cloudflare 写 secret 的验证/构建 job 输出受信 artifact 与校验摘要；独立 deploy job 不执行 npm install、网站构建或网站自定义脚本，仅使用固定发布工具和验证过的部署包。打包须包含 Worker bundle、静态资产及审核过的生产配置；平台部署工具与依赖同样锁定。
7. deploy job 验证产物 SHA/摘要，原子 claim，重新检查 main 与线上基线；不匹配停止并重新确认。通过后执行固定 Wrangler 部署，记录 version/deployment ID。当前平台没有完整端到端 CAS，因此本方案要求停用其他自动生产写入入口，并保留管理员越权导致竞态的风险说明。
8. 查询 Cloudflare 实际服务版本；访问版本标记、首页、robots、sitemap 及项目关键 URL。发布清单可带只读 smoke paths，但只能来自受信配置。
9. 上传结构化结果 `release-result.json`，至少包括 SHA、artifact digest、前后 version/deployment ID、run ID、部署与验证状态、时间；控制器轮询取回，检查来源后更新台账与通知。

生产构建需注入精确 SHA 的非敏感版本标记；对缓存使用绕过缓存/唯一查询并结合 Cloudflare 控制面验证，不能仅凭 HTTP 200 声称发布成功。HTTP 验证不做写业务请求。

三个仓库当前未保护 main。优先配置可用的 branch rules/保护和 workflow/生产配置审阅；是否能启用取决于私有仓库套餐。若账户不支持，不能宣称“受保护主分支”，必须由用户明确接受替代的权限与人工审阅边界后再启用。Environment `production` 可用性也需核实，不依赖私有仓库一定支持 required reviewers；主审批是上面的真实消息与一次性 claim。

## 6. 状态、异常与回滚

状态：`PREPARED → APPROVED → DISPATCHED → VERIFYING → DEPLOYING → DEPLOYED → HEALTHY`。其他状态：`EXPIRED/CANCELLED/VALIDATION_FAILED/DISPATCH_UNCERTAIN/DEPLOY_UNCERTAIN/DEPLOYED_UNHEALTHY`。

- 超时或网络断开不等于发布失败：已经 claim 或已发出部署请求后不自动重试写操作；先查 Cloudflare 与版本标记。无法确定则要求人工对账。
- 生产已更新但健康检查失败，报告“已发布，验证失败”，不谎报“未上线”。通知失败单独重试，不能重新部署。
- 回滚建议展示之前确实健康的 Cloudflare version，经同样的独立人工确认与 claim 执行。签名 `operation=rollback`，固定目标 version、关联历史 SHA、当前线上基线和配置摘要；只豁免常规发布的 main HEAD 相等规则，仍核实目标确属该 Worker、历史健康及基线未变。deploy/rollback 回执不可互换，版本选择来自受信记录，不能任意输入。回滚不重新构建当前 main，而是启用指定历史 version。
- Cloudflare Worker version 不回滚 R2/KV/D1 内容；colorearmundo 首版不变更存储数据，不承诺代码回滚可恢复外部内容。

## 7. 实施批次与交付物

本节为待批准设计的实施分解，不代表已获准修改生产。正式编码前再出可执行任务计划。

1. **P0 只读盘点**：恢复 Cloudflare 只读查询，逐站登记 account/Worker/domain/current-version/bindings/Build triggers；核验用户身份、飞书消息读取和 Hermes message_id 接线；核实 GitHub 套餐、规则、组织 secret 继承及 Actions 额度。产出盘点与差异清单。任何项目身份有歧义不启用。
2. **P1 发布基础**：隔离分支开发控制器、SQLite 状态机、签名/claim/OIDC、Hermes CLI/Skill 与假 API 测试；三个仓库提交独立发布 workflow PR；先全程 dry-run，不能使用生产写 token 验证业务脚本。
3. **P2 classgames 试点**：人工审阅 PR 和权限；准备临时预发布 Worker，以不绑定生产域名、不接生产写存储的配置验证部署链路。记录当前生产版本与回滚目标；用户另行授权后关闭该站原有自动生产发布（如果有），配置生产 secret、启用控制器，完成一次真实人工确认发布和独立确认回滚演练。
4. **P3 扩展**：colorearmundo 核实 R2 与资源健康；usmapgames 先明确正式服务/域名及 production/noindex 策略，再接入。每站独立启用，不因登记项目就自动开放。
5. **P4 运维**：发布记录进飞书专用发布台账，原有 Issue/Base 表不改字段语义；本地 SQLite 为控制器执行状态源，GitHub/Cloudflare 为外部事实源，飞书只作展示。具体是否复用运营 Base 新增表由用户批准，不因本方案擅自写表。

迁移原则：先准备并验证新通路，再于单站切换窗口停旧自动发布，不删除旧服务、不改 DNS、不影响其他项目。云发布控制器独立启动，不为本功能重启 Mac Bot；如必须改 Hermes 网关传 message_id，另安排维护窗口并确保无活跃任务。

## 8. 验收标准

- 合并 main、加 Auto、模型单独输出确认文本均不会发布。
- 非授权用户、其他项目群、过期/编辑/重放/机器人确认消息被拒绝；未知消息读取失败不得降级为相信模型。
- 确认后 main/线上基线变更会阻止发布；目标 SHA 不变且全套验证成功才可继续。
- 重复消息、重复 dispatch、workflow rerun、控制器重启、响应丢失不启动第二次受控部署尝试；不确定状态能对账，不承诺外部 API 严格 exactly-once。
- 构建 job 没有生产写 secret；deploy job 不执行网站依赖安装/自定义脚本；凭据、确认私钥不进日志和 artifact。
- 失败准确区分验证未过、部署结果未知、已部署但不健康、通知失败。
- 发布记录包含精确 SHA 与真实 Cloudflare version/deployment；关闭 Mac 后全链路仍可完成。
- R2 内容没有因发布或回滚被改动；实测一站发布和独立人工确认回滚后再扩展。

## 9. 官方能力参考

- [GitHub workflow dispatch API（权限与 run ID）](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10)
- [GitHub 部署环境与私有仓库套餐约束](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [Cloudflare Workers 角色与部署权限](https://developers.cloudflare.com/workers/authorization/workers/)
- [Workers Builds trigger 盘点接口](https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/methods/list/)
- [Worker versions、deployments 与外部存储边界](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [飞书消息读取 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1)
