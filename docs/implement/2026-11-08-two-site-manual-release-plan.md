---
updated_at: 2026-11-08T20:11:02+08:00
git_commit: dbd4043703714d78e35698d2e6e54daaf336371a
---

# Two-site Manual Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (Native, already selected). Execute tasks in order, use checkbox tracking, and request one fresh whole-branch review after integration. Do not delegate product implementation.

**Goal:** 实现 USMapGames 与 ColorearMundo 的隔离人工发布支持，并提交三个待审核 PR；不触碰 classgames 或任何生产权限/部署。

**Architecture:** 新增 `integrations/hermes/site_release/`，两站共享受审内核但锁定独立目标/状态/密钥。网站在无凭据构建 job 产出不可变包，独立发布 job 仅以已审工具 commit 验签、claim 和发布。现有 `integrations/hermes/release/`、classgames 工作流/实例和 pin 不变。

**Tech Stack:** Python 3.12-compatible standard library, locked cryptography/PyJWT; Node 22, existing Astro/Worker code, locked Wrangler; GitHub Actions; Feishu bot API; SQLite; local-only workerd/R2 fixtures.

**Spec:** `docs/spec/2026-11-08-two-site-manual-release-design.md`（用户已批准）。

**Execution method:** Native；本计划审核后在当前会话连续执行至三个 PR，不逐任务再次询问。两个网站使用独立本地工作区与 `codex/` 功能分支，不修改正常检出中的用户文件。优先使用 Codex 原生 worktree 工具，缺少该能力时使用 git worktree；计划批准包含这些本地工作区准备，不包含任何云服务安装。

## Global Constraints

- 固定新目标仅 `usmapgames` / `colorearmundo`，repo IDs 分别 `1444221313` / `1316936114`；production Worker 分别 `usmapgames-preview` / `colorearmundo`。
- 账户、Zone、精确域名集合、管理群、日期、ASSETS 行为与 R2 binding 均取 Spec 第 3 节；不得推测或接受请求覆盖。USMap 不添加 www Worker binding、不重命名 Worker。
- 新控制器 `production_enabled=false`、`allowed_users=[]` 为默认/示例值；不创建 App、Token、Secrets、Environment、DNS、Tunnel、云账号/服务、main 保护或其他生产权限；不派发 workflow 或部署。
- 仅发布网站代码与构建静态资产，不运行 `upload:r2` / `generate:resources`，不接触真实桶数据；R2 仅本地仿真 fixture。
- classgames 的生产和旧 `integrations/hermes/release/` 零变更；旧站全部测试保留。保留现有未提交运维文档，不把它们混进提交。
- 网站 PR 均 Draft，工具 pin 初始为空且 guard 拒绝；依赖内核 PR 合并后更新真实已审 merge SHA。不得用新 PR head、branch、全零值或旧 classgames pin 冒充已审新工具。
- 只推送本次 `codex/` 分支、创建三个 PR；绝不 merge、auto-merge、publish 或冒充真人确认。仅离线/本地验证不能宣称生产链路验收。

## Cross-repository ABI（以下名称由本计划固定）

- `ReleaseTarget` 为不可变值对象；`get_target(project: str) -> ReleaseTarget` 仅登记两站，含 repository/id/account/worker/zone/domains/chat/audience/claim_url/workflow/sitemap/生产配置；`production_config(target) -> dict` 每次返回独立字典。
- Runtime 私密配置通过 `load_config(project: str, path: Path) -> ReleaseConfig` 加载，只接受 production_enabled/allowed_users/tenant_key；`ReleaseConfig.target` 必须与注册表一致，未知键/错误类型/覆盖目标均拒绝。
- marker: `{ "schema": 1, "project": "usmapgames|colorearmundo", "sha": "<40hex>" }`；仅 marker 路径响应 no-store，其余原行为不变。
- manifest: `{schema:1, project, repository, repository_id, sha, config_digest, files:{relative_path:sha256}}`；包根仅 `bundle.mjs`, `wrangler.json`, `manifest.json`, `assets/**`。摘要为递归键排序、无空白、UTF-8 JSON 的 SHA-256；数组顺序保留。
- workflow inputs: `release_id`, `target_sha`, `approval_ticket`。repo variables: `SITE_PRODUCTION_RELEASE_ENABLED`, `SITE_RELEASE_PUBLIC_KEY`, `SITE_RELEASE_CLAIM_URL`；Environment secrets: `SITE_CLOUDFLARE_DEPLOY_TOKEN`, `SITE_TOOLS_READ_TOKEN`。名称相同但每个仓库/Environment 值独立；本轮不创建它们。
- publisher env: `SITE_RELEASE_PROJECT`（workflow 固定字面量）、`SITE_PRODUCTION_RELEASE_ENABLED`, `RELEASE_PACKAGE`, `RELEASE_TARGET_SHA`, `RELEASE_ID`, `RELEASE_PUBLIC_KEY`, `RELEASE_CLAIM_URL`, `RELEASE_RESULT`, GitHub event/run/OIDC env；CF Token 仅 publish 步骤映射为 `CLOUDFLARE_API_TOKEN`。
- 工具命令：`python -m integrations.hermes.site_release.deploy_tools.runner`；工具 lockfiles 位于该模块下；`RELEASE_TOOLS_COMMIT` 是网站 job 的固定 SHA。
- 独立 claim URL 固定为 `https://release-control.usmapgames.com/v1/claims` / `https://release-control.colorearmundo.com/v1/claims`；OIDC audiences 依次 `usmapgames-release-control` / `colorearmundo-release-control`。只生成未来配置模板，不创建 DNS/endpoint。
- result: `{schema:1,project,repository_id,release_id,run_id,sha,operation,artifact_digest,previous_version,version_id,deployment_id,deploy_status,health_status}`；校验 project/repo/operation/run/基线后才可用于 reconcile。

## Review Focus

1. 生产名称含 preview：注册表/CF client/网站 package 只允许真实 `usmapgames-preview`，不得误用 local-preview、seo-review 或新建 Worker（Tasks 1, 3, 6）。
2. 同一发布人在错群或 A/B 同 release_id：原始消息、receipt/OIDC/key/artifact/version 的完整目标绑定先于状态写入（Tasks 2–5）。
3. R2 fallback 掩盖绑定失败：分别测试本地 R2 命中和未命中，不因静态 fallback 成功就宣称真实 R2 验收（Tasks 3, 7）。
4. PR CI 绿但 main 无 push 证据：严格 main SHA + 完成成功的受信 push workflow，USMap 原 verify 汇总不能削弱（Tasks 3, 6）。
5. 过期重发或网络结果未知造成重复发布：仅取消未确认 PREPARED；dispatch/claim 不重试、跨重启仍保留一次性预约（Tasks 2, 4, 5）。

---

### Task 1: 工作区/基线与不可变目标

**Files:** 新模块 `__init__.py`, `config.py`, `config.usmapgames.example.json`, `config.colorearmundo.example.json`, `requirements.lock`, `test_config.py`；三个独立功能分支。新站 workspace 建议名 `usmapgames-manual-release` / `colorearmundo-manual-release`；控制器复用当前隔离分支。

**Interfaces:** 产出上述 ABI 的 `ReleaseTarget`, `get_target`, `ReleaseConfig`, `load_config`, `production_config`；复用既有受审 Python 依赖版本与 hashes，不升级 classgames 依赖。

- [x] 检查/遵循每仓 AGENTS 与工作区状态；准备隔离 workspace，记录三个 base SHA；不覆盖正常检出。用 Node 22 与独立 hash-pinned Python venv 跑基线：控制器 `npm run test:all && npm run check:all && npm run build`；USMap `npm ci && npm run verify`（含所需 Playwright 浏览器）；Colorear `npm ci && npm test`。失败按测试名记录，先定位环境/既有失败，不删测试。
- [x] RED：`test_default_disabled_and_empty_allowlist`；`test_unknown_project_and_override_rejected`；`test_production_worker_is_preview_not_local_preview`；`test_configs_are_independent`。断言两 repo IDs、精确 domains/date/ASSETS/R2 与 Spec 相同，返回配置的修改不能影响其他调用/站。
- [x] 运行 `python -m unittest integrations.hermes.site_release.test_config -v`，确认因缺实现失败；实现 ABI，复跑至通过。
- [x] commit：`feat(release): register isolated site release targets`（只提交新增模块，不包含旧 v1 文件）。

### Task 2: 状态、真人确认、签名与 OIDC

**Files:** `site_release/store.py`, `approval.py`, `tickets.py`, `oidc.py`, `event_input.py`；`test_store.py`, `test_approval.py`, `test_tickets.py`, `test_oidc.py`, `test_event_input.py`。

**Interfaces:** `Store(path:Path,target:ReleaseTarget)` 提供与 v1 同义的 prepare/get/approve_for_dispatch/claim/transition/note/healthy_version/cancel/outbox 方法，所有读写校验目标；`verify_confirmation(message,manifest,config,now_ms)->{actor_id,message_id}`；`sign_ticket(approval,key)->str`；`verify_ticket(token,key,now,target)->dict`；`verify_github_oidc(token,expected,now,target,key_resolver=None)->dict`；`read_ticket_from_event(path)->str`。

- [x] RED：测试独立 DB、活动发布互斥、预约跨 reopen 持久化、同消息重放、错群/机器人/错租户/编辑撤回/精确文字/时间边界；取消仅 PREPARED，过期不自动延长。A/B 同 release_id 与篡改 manifest.project/repo/worker 必须在写入前拒绝。
- [x] RED：receipt 必须包含 schema/project/repository/repository_id/worker/environment/operation/release_id/target_sha/target_version/config_digest/expected_previous_version/approved_by/approved_at/expires_at；只允许 EdDSA 与 `typ=release+jwt`、90 分钟严格有效期。用两组本地临时 key 测试换站、换 key、未知/缺字段、错误类型/过期均失败。
- [x] RED：本地 RSA/JWKS fixture 验证官方 issuer + per-site audience + 固定 workflow_ref/main/GitHub-hosted/workflow_dispatch/attempt1 与匹配 run/SHA；key resolver 仅测试注入，不放宽生产校验。Event reader 大小/格式限制与遮罩回归保留。
- [x] 分别运行新增 unittest 模块看到失败，再实现并复跑；commit：`feat(release): bind approvals and claims to isolated sites`。

### Task 3: 有界外部读取、基线与站点健康

**Files:** `site_release/transport.py`, `app_auth.py`, `github.py`, `cloudflare.py`, `feishu.py`, `manifest.py`, `smoke.py`；对应 `test_transport.py`, `test_clients.py`, `test_manifest.py`, `test_smoke.py`。

**Interfaces:** `request(method,url,data=None,headers=None)` 默认 UA `SiteReleaseControl/1.0`，无重定向、20 秒、有界 JSON、无写重试、脱敏异常；客户端构造均锁定 target；`verified_head(config,gh)->sha`、`prepare_manifest(config,gh,cf,now)->dict`、`check_baseline(manifest,gh,cf)`；`CloudflareReadClient.snapshot()->{version_id,deployment_id,source_sha,config_digest}`、`health(sha)->bool`；`smoke(target,fetch=None)->bool`。

- [x] RED wire：真实 loopback 收到默认/显式大小写 UA、Authorization/body；403/redirect/超时只请求一次，无 token/远端错误正文泄漏。App token body 固定该站 repository_ids，GitHub URL 不能跳到另一仓；只接受 App15368 的 verify + release-contracts 及成功 main push workflow（USMap issue-auto-ci.yml / Colorear verify.yml）。
- [x] RED CF fixture：真实调查形状的 ASSETS/R2/settings/domain/version；错 Worker/Zone、额外域名/绑定、换桶、分流、runtime/date 漂移均失败。分别保留 USMap html_handling 与 Colorear R2；normalize 仅去非配置动态字段，不忽略有安全意义的额外绑定。
- [x] RED health：marker project+SHA、canonical、robots 实际 sitemap（USMap `/sitemap.xml`、Colorear `/sitemap-index.xml`）、缺失404、www301。固定样本 USMap `/us-states-quiz/`、`/printables/blank-us-map-a4.pdf`；Colorear内容页及 `/media/pdfs/animales-para-colorear/buho-en-una-rama-a4.pdf`（路径由受审仓库文件和 Worker `/media/` 前缀导出，启用前必须再读线上验证）。PDF 有界前缀 `%PDF-`，不读取整个大文件。
- [x] 先测试失败再实现；first legacy SHA 未知只产生清单警告，不阻止新发布，也不制造 mapping。commit：`feat(release): verify per-site baselines and health`。

### Task 4: 控制器、Native CLI、claim HTTP 与只读协调

**Files:** `site_release/controller.py`, `server.py`, `runtime.py`, `cli.py`, `reconcile.py`, `notices.py`, `templates/*`；`test_controller.py`, `test_server.py`, `test_cli.py`, `test_reconcile.py`。

**Interfaces:** `Controller(config,store,gh,cf,feishu,private_key)` 暴露 prepare/prepare_rollback/locate/confirm；`ClaimService(...).claim(release_id,ticket,oidc_token,now)`；`approval_claims(row)->dict` 必须符合 Task2 receipt 字段；`reconcile(controller,rid,now=None)->row` 绝不派发。runtime 固定启动 project，template wrappers `usmapgames-release` / `colorearmundo-release` 固定 socket；仅输出模板，不安装。

- [x] RED：prepare 发完整目标/基线/未知警告/10分钟 nonce；通知不确定保留 durable row，不盲创建第二单。confirm 前任一开关/白名单/主干/基线不符均无 dispatch；真正真人确认只原子预约一次，204/timeout 转 uncertain 后只 locate/reconcile，禁止重发。
- [x] RED HTTP：公网仅精确 `/v1/claims`，初步 OIDC 拒绝、目标独立 audience、请求大小与 JSON shape、慢请求读超时/并发上限；不能在公网 prepare/approve/dispatch。cross-target HTTP/CLI payload 不写入另一 DB。
- [x] RED reconcile：匹配 project/repo/run/SHA/operation/claim 与控制面、双重健康后才 HEALTHY；missing result/未知结果保留待处理；通知有限重试不触发部署；未知旧 mapping 的 rollback 拒绝。
- [x] 实现与复跑；模板默认 disabled/empty allowlist、独立用户/key/env/socket/tunnel目录，说明安装另取授权。commit：`feat(release): add isolated native controller runtime`。

### Task 5: 受信发布工具和跨站验包

**Files:** `site_release/deploy_tools/{__init__.py,runner.py,package.json,package-lock.json}`；`test_deploy_tools.py`, `test_package_wire.py`。

**Interfaces:** `verify_package(root:Path,sha:str,target:ReleaseTarget)->manifest`；`run_release(root,sha,release_id,run_id,ticket,public_key,claim,deploy,snapshot,health,now,target)->result`；runner env/输出遵循 ABI。独立 trusted Wrangler lockfile 可从旧受审版本机械复用，不修改 v1。

- [x] RED：精确 config/project/repo/sha/marker/config_digest/files 集合，symlink/traversal/额外文件/错误 R2/跨站包拒绝；receipt 与 artifact 不一致时没有 claim；claim denied/unknown 时没有 deploy；一次 publish 结果未知不重试。
- [x] RED entrypoint wire：执行真实 main 的 OIDC GET/claim POST/marker GET 回调，loopback fixture 验证实际 UA/auth/body；claim_url 必须精确等于 target.claim_url，不能只 startswith HTTPS/endswith claims。receipt 从 event 文件读，不取可展开回执 env。
- [x] RED：main 在生产开关非精确 true、未知 project、无匹配 public key、错误 run/attempt 或完整包不符时拒绝。publisher 只调用 trusted Wrangler `--config --no-bundle --strict`，无 shell/网站构建脚本；rollback 仅明确可信 version，不自动执行。
- [x] 实现至全部新测试和旧 v1 测试通过；commit：`feat(release): add site-bound trusted publish tools`。

### Task 6: USMap 网站接入

**Files:** `src/worker.ts`；新增 `wrangler.release.jsonc`, `scripts/release/{package,verify-manifest,smoke-package}.mjs`, `scripts/release-*.test.mjs`, `.github/workflows/{deploy-production,release-contracts}.yml`, `docs/implement/manual-release.md`；修改 `package.json` 与 `issue-auto-ci.yml`。原 local `wrangler.jsonc` 不改。

**Interfaces:** 产出 ABI 的 USMap manifest/marker/config；`npm run test:release` 为新增合同命令。生产 config 精确 Worker `usmapgames-preview`、根域单 route、date2026-11-03、ASSETS trailing-slash/404/run-first、不增 observability。

- [x] RED：package fixture 验摘要/拒绝坏路径跨站项目；Worker marker GET/HEAD no-store，既有 Workers.dev 重定向与 ASSETS 行为不变。CI合同验证 PR+main push、现有三个浏览器和 verify 依赖不削弱。
- [x] 实现 marker、生产打包与 immutable 校验、本地真实最终 Worker 冒烟（marker/canonical/headers/redirects/quiz/PDF/404；临时副本去 routes，原包不变）。不接生产 CF凭据。
- [x] 新工作流按 ABI：最先 mask；无 secret 构建；publish 的 production Environment/精确开关/main/concurrency/id-token；tool pin 初始空、发布前 guard 拒绝；工具 checkout/锁定依赖后 only runner；CF secret 只在 publish。Action SHA 使用现有受审 classgames 的固定版本，禁止引用可变 tags。
- [x] 跑 `npm run test:release && npm run verify`、真实最终包 smoke、trusted verifier 与 exact dry-run；用临时本地 key 做签名/包互认测试，不运行云 workflow。commit：`feat(release): prepare USMap manual production workflow`。

### Task 7: Colorear 网站接入与 R2 分支覆盖

**Files:** 同 Task6 的 `scripts/release/*`/workflow/docs 新文件；修改 `worker/index.ts`、`package.json`；不修改 `upload-r2.mjs`、原 `wrangler.jsonc` 或媒体/PDF 数据文件。

**Interfaces:** 同 ABI，project=`colorearmundo`，registry生产 config（date2026-07-29、两域名、ASSETS、固定 COLORING_ASSETS→colorearmundo-assets、原 observability）；`npm run test:release`。

- [x] RED：与 USMap 同一 canonical/hash/文件集合协议；Colorear精确 R2 binding；Worker marker 不破坏 canonical/www/security headers；本地 fixture 分别令 R2 get 命中/未命中，验证媒体头/正文与 static fallback。
- [x] 实现构建/打包/marker和workflow，保留 `verify.yml` 的 PR+main push/npm test 能力。所有构建/验证/publish步骤都不得运行 upload:r2 或资源生成/桶管理命令；模板不请求数据写权限。
- [x] 使用临时本地 R2 仿真 fixture 测试真实最终 Worker 命中和 fallback；真实桶不参与本地测试。跑 `npm test && npm run test:release`、final package smoke、trusted verifier/dry-run；验证包/签名换到 USMap 时拒绝。
- [x] commit：`feat(release): prepare Colorear manual production workflow`。

### Task 8: 集成复核、独立审查与三个 PR

**Files:** 三仓发布测试报告与 docs 索引；只纳入本次代码/文档与 lockfile 的必要变化。

- [x] 从两个网站实际 feature SHA 生成包，使用同一新 shared runner 分别验包；交叉 project/repo/key/OIDC/config/receipt 负向矩阵全部拒绝。复核 v1 路径与 classgames 源 pin/云资源零变更。
- [x] 重跑控制器 `npm run test:all && npm run check:all && npm run build`（匹配Node22及独立venv）；两网站上述全套、真包烟测与 dry-run。日志放 ignored scratch；失败按名称报告，不能把静态合同当正向云部署证据。
- [x] 按 Native 方法请求一位 fresh reviewer 做全分支审查（覆盖三仓相互协议、身份/密钥/项目隔离、CI门禁、R2边界），修复阻塞项并复测；不委派产品实现。
- [x] `git diff --check` 和范围检查后，仅 push 三个本次 codex 分支，使用 `gh pr create --draft` 创建：CodexReach 内核 PR、USMap PR、Colorear PR。不更改自动合并/生产设置，不派发工作流。
- [x] PR正文链接设计/计划和依赖；网站两 PR 明确“工具 pin 未定、不可合并部署，待内核审核合并后更新 merge SHA”；列明实测/未测、生产资源与身份另行授权、旧SHA未知与恢复限制。等各自 CI 完成；任何失败不删检查，调查或明确报告。
- [x] 最终返回三个真实 PR URL、验证结果、未验证的生产路径与下一授权步骤。阶段结果不是“已支持生产上线”，而是“离线实现及待审核 PR已交付”。

## Plan self-review

- Spec 第1–4节→Tasks1/2/4，协议第5节→Tasks2–5，网站/健康第6–7节→Tasks3/5/6/7，隔离失败场景第8节→Tasks2–8，交付/授权/排除项第9–10节→Global Constraints与Task8。
- 所有 later-task 消费的 profile、manifest、marker、env、runner/result ABI 均在上文固定；不留跨仓签名/命名猜测。
- Review Focus 五类风险各有明确 RED 测试；生产正向 OIDC/写入/回滚仍属本轮范围外，不能以 mock、dry-run 或模板声称验收。
- 用户已批准本计划并以 Native 连续执行到三个 Draft PR；测试模块合并组织、USMap Node26/preview→production构建顺序等实际调整与证据见离线验证报告，未突破生产授权边界。
