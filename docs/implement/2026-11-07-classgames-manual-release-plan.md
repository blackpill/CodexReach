---
updated_at: 2026-11-07T16:28:36+08:00
git_commit: 885e3c2a5553b88d41d3366cdc346c238ceafe79
---

# ClassGames Manual Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已选择 Native；Tasks1–7已离线实现和测试，Task8仍待单独授权。后续基础设施和生产写操作必须遵守分阶段授权。

**Goal:** 为 classgames 建立不依赖 Mac、由真实人工确认控制的 Cloudflare 发布链路，生产启用前保持关闭。

**Architecture:** 云端独立发布控制器管理白名单、SQLite 台账、真实飞书消息验证、签名回执与一次性 claim。GitHub Actions 将无生产凭据的验证/打包与固定工具部署分开；Cloudflare version + 精确 SHA 标记共同证明结果。Hermes 只提供受限 CLI，不持有生产写 token。

**Tech Stack:** Python 3.10+、SQLite、受维护的 Ed25519/JWT 库（实现前选定并锁版本）、GitHub App/Actions/OIDC、Node 22、pnpm 10.18.2、Wrangler 4.116.0、飞书应用身份消息读取。不要自写密码算法或 JWT/JWKS 验证。

**Spec:** [已批准总体设计](../spec/2026-11-07-hermes-manual-release-design.md)。事实基线和当前缺口见[只读盘点](../test/2026-11-07-classgames-release-preflight.md)。本计划仅 classgames，不把另外两站同时开放。

## Global Constraints

- 固定 repo `blackpill/classgames.net` / `1223017142`、Worker `classgames`、account `7daf69e93f12575570a679bb91cc1e76`、environment `production`；目标 SHA 使用运行时新鲜 main，不能硬编码盘点 SHA 当永远最新。
- 确认群固定 `oc_0e8427180f15b964018e2f899dd66879`，不是 CodexReach 开发群；允许用户列表默认空。
- 首版常规发布只接受当前 main HEAD，回滚绑定历史 Cloudflare version；operation 不可混用。
- 确认窗口 10 分钟，确认后执行票据 90 分钟；main、线上基线或配置摘要变化必须重新确认。
- `production_enabled=false` 为控制器默认；Actions 变量 `CLASSGAMES_PRODUCTION_RELEASE_ENABLED` 缺失/非精确 `true` 均不得进入生产部署 job。不开启、不配置生产 secret来完成本轮准备。
- 一份验证过的最终 artifact，不在 deploy job 执行网站构建、安装网站依赖或仓库自定义脚本；不得给验证/构建 job 生产写凭据。
- 最多一次受控部署尝试，未知结果先对账；不承诺 Cloudflare API 严格 exactly-once，不自动生产回滚。
- 盘点/文档阶段结束后，用户已同意 Native 隔离实现并建立了 `codex/` 分支，保留两个用户 checkout 的未提交文件。不为计划自动 git commit/push。
- 不新增第二个飞书 WebSocket 消费者，不动全局聊天权限、现有 Issue bridge、Mac Bot、分析或 YouTube 服务。

## Review Focus

1. 机器人发送的正确确认文本、转发/引用文本、编辑/撤回消息不能替代真人授权：Task 2 拒绝测试。
2. 两个并发 confirm/claim、进程重启、HTTP 响应丢失不能二次启动发布：Task 1/4/6 故障注入。
3. 线上 Git SHA 未知时不能捏造完整 PR 差异：Task 3 首次基线确认测试。
4. Preview canonical 重定向到生产不能被算成新版本验证：Task 5/7 Worker 绑定和重定向测试。
5. 产物包含路径穿越、符号链接、额外构建命令或被替换的包时不能接触生产凭据：Task 5/6 artifact 合同测试。

## 文件与仓库边界

本 Bot 仓库新增 `integrations/hermes/release/`，文件按下面任务分解；不改变原 Python unittest discover 路径，必要时只增加独立 release 测试命令。ClassGames 仓库另建发布 PR，保持现有 `.github/workflows/issue-auto-ci.yml` 和 `verify` 合同不变。

生产控制器配置、SQLite、私钥仅存在云端 `/srv/hermes/release-control` 的独立目录；仓库中只放拒绝默认配置样例，绝不复制现有 `.env` 或 key。

## Task 1: 固定配置与持久状态机

**Files:** Create `integrations/hermes/release/{__init__,config,models,store}.py`、`test_store.py`、`config.example.json`。

**Interfaces:** `load_config(path: Path) -> ReleaseConfig`；`Store.prepare(manifest: dict) -> dict`；`Store.approve(release_id: str, message_id: str, actor_id: str, now: int) -> dict`；`Store.claim(release_id: str, run_id: str, run_attempt: int, now: int) -> dict`；`Store.transition(release_id: str, expected_state: str, next_state: str, evidence: dict) -> dict`。

- [ ] 写失败测试：classgames 之外项目拒绝、空 allowlist、默认 production disabled、未终结发布互斥、消息 ID 单次消费、并发 approve/claim 仅一方成功、重开数据库不丢 claim、过期拒绝。
- [ ] 执行 `python3 -m unittest discover -s integrations/hermes/release -p 'test_store.py'`，确认失败原因是缺失实现，而非测试依赖错误。
- [ ] 用 SQLite transaction/唯一约束和 `BEGIN IMMEDIATE` 实现，保护状态不回退；区分 DISPATCH_UNCERTAIN、DEPLOY_UNCERTAIN、DEPLOYED_UNHEALTHY。固定上限与字段验证，不接受任意路径/命令。
- [ ] 重跑测试通过；检查 sqlite 0600、目录 0700；提交范围仅本任务文件，提交与否遵循用户后续授权。

## Task 2: 飞书真实确认验证与原始消息定位

**Files:** Create `integrations/hermes/release/{feishu,approval}.py`、`test_approval.py`。

**Interfaces:** `FeishuClient.get_message(message_id: str) -> dict`；`FeishuClient.find_confirmation(chat_id: str, exact_text: str, since_ms: int) -> list[str]`；`verify_confirmation(message: dict, manifest: dict, config: ReleaseConfig, now_ms: int) -> dict`，返回经验证 actor/message ID，不签发回执、不自动 dispatch。

- [ ] 写失败测试：sender_type=app、非白名单/其他 tenant、错误 chat、非 text、编辑/撤回、超时、引用/多余文字、错误 release/nonce、缺失字段、多人候选歧义、API 403/429 均拒绝。有效原文只允许精确 `确认发布 <release_id> <nonce>`；禁止对转发内容递归提取。
- [ ] 执行该文件 unittest，观察预期失败；实现应用身份 GET，不接受用户 token。不记录消息正文、token 或其他会话内容。
- [ ] 定位仅查询配置中的固定群和当前待确认窗口，分页有界；拿到候选 ID 后仍重新 GET 验证，不能信“最新一条”。群级初版不承诺 topic 隔离；若清单绑定特定 thread 则缺失关联证据必须拒绝，不能退化到群授权。
- [ ] 重跑通过。后续真实真人验证只使用 `授权预检 <随机码>` 专用非发布挑战，不写 release approval，不签 ticket，不 dispatch；操作者 ID 由用户明确确认后才能写 allowlist。

## Task 3: 外部只读盘点与不可变清单

**Files:** Create `integrations/hermes/release/{github,cloudflare,manifest}.py`、`test_manifest.py`。

**Interfaces:** `GithubClient.repository() -> dict`、`main_head() -> str`、`checks(sha: str) -> list[dict]`；`CloudflareReadClient.snapshot() -> dict`；`prepare_manifest(config: ReleaseConfig, gh: GithubClient, cf: CloudflareReadClient, now: int) -> dict`。

- [ ] 写失败测试：仓库改名/ID不符、Cloudflare Worker/account 不符、多版本切流、CI pending/failed、main changed、基线变动、缺失 Git SHA、危险 runtime binding/config 漂移、错误 operation。
- [ ] 运行失败测试；实现仅 GET 的适配器，401/403/超时报告 unknown，不当成空数据。检查明确的 workflow/check 来源和精确 SHA，而不是只找任意同名 verify。
- [ ] 清单绑定 source_sha/target_sha、current version/deployment、config digest、nonce、10分钟 expiry；首发 source_sha 可以 null，但必须有 `baseline_unmapped=true` 及显式风险文案。该模式不得自动显示完整差异，用户须批准整个目标版本；不自动关联猜测的旧 SHA。
- [ ] 重跑通过；用 fake API 完成 dry-run 清单，真实 HTTP 只读行为另以只读凭据验证；不创建 GitHub deployment 记录或 Base 行。

## Task 4: 签名授权、OIDC 与 claim 服务

**Files:** Create `integrations/hermes/release/{tickets,oidc,server}.py`、`requirements.lock`、`test_tickets.py`、`test_claim.py`。

**Interfaces:** `sign_ticket(approval: dict, private_key: bytes) -> str`；`verify_ticket(ticket: str, public_key: bytes, now: int) -> dict`；`verify_github_oidc(jwt: str, expected: dict, now: int) -> dict`；HTTP `POST /v1/claims`，JSON `{release_id,ticket}`，从已验证 OIDC 取 run_id/run_attempt，不信请求体自报身份。

- [ ] 写失败测试：签名篡改、错误 operation/version/config、票据超过90分钟、错误 alg/iss/aud/repo ID/ref/workflow SHA、过期 JWT、JWKS 轮换失败、run_attempt不为1、重复请求与并发运行。
- [ ] 选定维护中的密码/JWT依赖并固定版本/哈希；以 fake JWKS 运行红测试，实现限制 issuer `https://token.actions.githubusercontent.com`、audience `classgames-release-control`、repo ID `1223017142`、workflow_ref `blackpill/classgames.net/.github/workflows/deploy-production.yml@refs/heads/main`；workflow_sha 与授权目标及运行证据核对。
- [ ] claim 在票据验真、外部基线重新检查和 production enabled 检查之后原子消费；客户端超时即转未知，不自动再次尝试生产写。相同 run 的 claim 重传只能返回原状态，不再次授予执行许可。
- [ ] 对该服务只开放 claim/最小状态；不开放确认、任意 prepare、shell、私钥或完整台账。Unix 本地控制接口与外部接口分离。离线服务测试通过后才准备待审核的 Tunnel/HTTPS 配置；不在本阶段安装启用。

## Task 5: ClassGames 可信产物与 Worker 验证

**Files (ClassGames repo):** Create `scripts/release/{package,verify-manifest}.mjs`、`scripts/release-contract.test.mjs`、`wrangler.release.jsonc`、`scripts/release-worker.test.mjs`；Modify `src/worker.mjs` 仅新增版本标记和受限 staging host 处理，保持 production canonical/HTTPS/Markdown/安全头逻辑。

**Interfaces:** `packageRelease({sha,distDir,workerBundle,configPath,outDir}) -> manifest`；`verifyPackage(root,expectedSha,expectedConfigDigest) -> manifest`。包包含 bundle、assets、审核的固定配置以及逐文件 SHA-256；不携带网站 node_modules、.env、私钥或可执行安装脚本。

- [ ] 写失败测试：未知文件、symlink/路径穿越、digest不符、Worker/account/routes不符、build.command、错误兼容日期、外部模块未打包、版本标记 SHA 错、staging 301 到生产被误判成功。
- [ ] 在无 Cloudflare 凭据的隔离快照运行测试红灯。实现用锁定 `pnpm exec wrangler deploy --dry-run --outdir <bundle-dir>` 预打包，独立 assets 目录，不覆盖 dist；部署配置指定打包结果与 no_bundle、禁止 custom build。先在断网/无凭据环境验证打包不需要访问 Cloudflare。
- [ ] SHA marker 建议固定 `/__release.json` 返回完整 SHA、Cache-Control no-store，不包含路径/内部信息；测试其在根域返回、www仍301、Markdown/未知路径/robots不回归。生成 marker 必须在最终打包/测试前完成。
- [ ] 默认 staging 关闭。临时 Worker 域名仅来自审核配置，不能运行时信任请求 Host 任意决定 canonical；staging noindex，禁止生产 routes。固定测试确保真正访问新 Worker，redirect 到生产即失败。
- [ ] 重跑 unit/现有 CI contract/full `pnpm verify`，验证最终包可本地 Worker+assets 运行；真实 E2E 使用独立端口/环境，不占用户4322服务。保留上次波动事实，失败不删测试。

## Task 6: Actions 只触发入口与固定部署工具

**Files (ClassGames repo):** Create `.github/workflows/deploy-production.yml`、`scripts/release-workflow.test.mjs`。**Files (Bot repo):** Create `integrations/hermes/release/deploy_tools/`，存放独立固定验证/claim/部署工具和受维护工具依赖锁，不从被构建网站 artifact 接收工具代码。

**Interfaces:** workflow_dispatch inputs=`release_id,target_sha,approval_ticket`；run-name 含 release_id；产出 `release-result.json`：operation/run_id/sha/artifact_digest/previous_version/version_id/deployment_id/deploy_status/health_status。

- [ ] 写失败合同测试：任何 push/pull_request_target/issue 自动生产事件、缺失生产开关、build job 有生产 secret、deploy job 网站 npm install/custom run/build、未固定 Action SHA、错误 artifact run ID、错误 repo/actor/ref 等都不允许。
- [ ] 实现 `validate-build` 和 `deploy` 分离，部署 job 仅从当前成功运行下载具名 artifact；不 checkout/执行 artifact 中脚本；可信工具取审核且固定的工具提交，不能动态抓 main 最新脚本。写 secret 注入仅实际部署步骤；票据和OIDC不入日志。
- [ ] 部署 job `id-token:write`，Contents 最小只读；固定 concurrency `classgames-production`、cancel-in-progress=false、超时上限。调用 Task4 claim，验证 main/线上版本后才执行固定 Wrangler 4.116.0，`--config` 指定受信生成配置，`--no-bundle` 使用已验证 bundle。
- [ ] 模拟重复 dispatch/rerun/取消/网络断开、Wrangler非零和部署成功后健康失败；结构化区分未知与未发布。审核 Wrangler 自身重试行为并记录，拒绝控制器盲重试。
- [ ] 保持既有 Issue Auto CI 不变，新增workflow缺省生产 disabled；本阶段只本地解析/合同测试，不 push、dispatch 或放入真实生产 secret。

## Task 7: 受限 CLI、Hermes Skill 与结果对账

**Files:** Create `integrations/hermes/release/{cli,reconcile}.py`、`test_cli.py`、`test_reconcile.py`；Create `integrations/hermes/release/templates/{classgames-release-skill.md,hermes-release-control.service}`，模板不是已安装 Skill/service。

**Interfaces:** 固定命令 `prepare --project classgames`、`locate-confirmation --release-id ID`、`confirm --release-id ID --message-id ID`、`status --release-id ID`、`prepare-rollback --project classgames --version-id ID`。`reconcile(release_id: str) -> dict` 仅拉取 GitHub/Cloudflare 状态，不发起新的部署。

- [ ] 写失败测试：其他 project、未知参数、任意命令/path、空 allowlist、定位歧义、失败重试dispatch、回滚票据当deploy、通知失败触发重发部署、伪造结果artifact。
- [ ] 串接 Task1–4 与 fake GitHub dispatch，dispatch 前持久化意图；记录 run ID，响应未知按 release_id对账，不能自动POST第二次。GitHub App 仅 classgames，Actions写+Contents/Checks/PR只读，不申请与当前实现无关的管理/部署权限。
- [ ] poll精确 run并验证同次结果 artifact；结合Cloudflare版本和版本标记，跳转、缓存旧SHA或HTTP200不算健康。回滚只选择本服务记录中经验证的同Worker旧version，独立清单确认；首次基线需按盘点例外处理。
- [ ] 生成无密钥配置样例、默认禁用 systemd 模板与 Skill 文案，明确 root 威胁模型；本阶段不安装/启动/改云端 AGENTS。
- [ ] 全套 `python3 -m unittest discover -s integrations/hermes/release -p 'test_*.py'` 和网站相关合同通过；独立审阅后保留代码为待审核PR，不擅自合并。

## Task 8: 分阶段基础设施与生产启用（必须另行授权）

**Files:** 后续更新 `docs/test/2026-11-07-classgames-release-preflight.md`，新增实际操作日期对应 rollout 记录；敏感配置不写入仓库。

- [ ] 用户确认实施计划/方式和隔离工作区后才开始 Tasks1–7；若scope/接口有重大变化，先回设计，不静默缩减授权验证。
- [ ] 单独审核创建 GitHub App/安装、Worker专用发布token、私钥、Tunnel/HTTPS和服务的操作。配置 production开关仍false；现有只读token保留只读，不能替代部署token。
- [ ] 用户明确发布者 open_id 后，以非发布挑战实测真实消息读取和拒绝机器人确认；不自动把群主或最近发言者注册为授权者。
- [ ] 单独授权后部署无生产域名、无生产写存储的临时 staging，验证签名/claim/实际发布工具/版本标记；不得跳过 staging canonical重定向验证。
- [ ] 核实GitHub套餐/保护能力和现有生产写入口，先落实保护或取得明确替代风险批准；不擅自付费升级。当前无Cloudflare Git构建，不增加多余的“关闭自动部署”变更。
- [ ] 生成首次生产发布清单（新鲜main、CI、version基线、线上SHA未知风险或已对账映射、回滚候选），由用户再次明确确认；此前不配置/启用会导致生产运行的通路。
- [ ] 确认生产设置启用与该次发布授权分开记账；执行一次生产发布并验证。回滚演练仍另行确认，不能把首次发布许可视为回滚许可。
- [ ] 保留所有外部事实证据，仅classgames enabled；不扩展colorearmundo/usmapgames，其他项目需独立启用。

## 本次准备完成检查

- [x] 用户已批准 classgames 试点设计，但没有授权实际生产部署。
- [x] 取得 Cloudflare 当前版本、域名、bindings、构建/钩子事实；未升级凭据。
- [x] 核验精确 main、现有CI、锁版本与本地合同测试4/4。
- [x] 飞书应用可读取固定群及按 ID 读取消息；源码保留原始message_id。
- [x] 标明线上SHA未知、人工身份尚未注册、私有仓库套餐未知、preview重定向陷阱和claim公网通路尚不存在。
- [x] 对照设计自审：Tasks1–7覆盖状态/确认/清单/签名/幂等/构建/部署/通知，Task8覆盖迁移、维护窗口和独立授权。没有在准备阶段实现或启用生产功能。

实施建议：Native 在隔离工作区逐项TDD，再做独立整分支审阅；该选择和隔离工作区创建须由用户确认。实际生产部署仍保留独立确认门槛。

## Native 执行结果

见[离线验收](../test/2026-11-07-classgames-manual-release-offline.md)。逐项执行与审阅修复记录保留于本工作区 `.superpowers/sdd/2026-11-07-classgames-manual-release-plan/progress.md`；未提交/推送/合并，Task8不因离线通过而自动执行。
