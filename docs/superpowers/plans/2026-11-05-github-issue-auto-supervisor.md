# GitHub Issue Auto Supervisor Implementation Plan

> **执行方式：** 逐任务执行并验证；实施前先审阅本计划和关联设计。

> 历史实施计划：功能已在后续轮次实现与实测；原始清单保留为设计记录，不是实时完成状态。当前使用与限制见 `docs/issue-auto-runbook.md`。

**目标：** 将可信 GitHub Issue 的 `Auto` 事件经 Cloudflare 投递给 Mac，在隔离 worktree 内驱动 Codex 开发、验证和 PR CI，并在可审核或阻塞时飞书提醒。

**架构：** Cloudflare Worker 验签并将事件写入 D1；Mac 主动领取且持久化到本地 SQLite 后确认。Supervisor 以持久状态管理 Codex Turn、独立验证、PR/CI 和通知，异常后对账恢复。

**技术栈：** TypeScript、Fastify、better-sqlite3、Vitest、Codex App Server、Cloudflare Workers/D1、GitHub API、飞书机器人。

**设计文档：** `docs/superpowers/specs/2026-11-05-github-issue-auto-supervisor-design.md`。

## 全局约束

- 首版仅允许 `blackpill/usmapgames.com` 和 GitHub 用户 ID `1231245`，以实际仓库 ID 绑定本机 `/Users/kenny/Web/usmapgames.com`；`Auto` 标签区分大小写。
- 不轮询 GitHub Issue；队列领取默认 10 秒。Webhook 和 Runner 使用不同密钥。
- 不自动合并、部署或关闭 Issue。独立 worktree 不是安全沙箱；不得覆盖现有工作区改动。
- CI 对最新 head SHA 的指定检查全部成功之前，不得发送成功通知；缺失、跳过、取消、超时均不可视为成功。
- 对外部副作用采用至少一次投递、幂等和恢复对账，不承诺 exactly-once。
- CI 连续修复上限默认 3 次，连续 2 次无可验证进展暂停；总轮次、时间、CI 等待时限须在启用前配置。
- 设计和本计划的新增配置默认关闭；不读取或输出真实 secret；远端部署、权限更改与启用须另行确认。

## Review Focus

1. Webhook 重投及不同投递引起同一 Issue：任务 2 的双重去重测试。
2. 本地落库后确认前崩溃或租约失效：任务 3 的故障注入测试。
3. Codex 断线后 Turn 仍运行：任务 5 的恢复对账测试。
4. PR 最新 SHA 改变、检查缺失/跳过：任务 7 的 CI 状态矩阵测试。
5. 飞书投递失败和 Mac 离线：任务 8 的通知重试测试及远端告警限制说明。

## 文件结构

- 新建 `worker/`：Cloudflare Worker、D1 schema、Worker 独立测试及配置模板。
- 新建 `src/issue-auto/`：类型、持久状态库、领取器、workspace、Supervisor、验证、PR/CI 和通知适配器；测试与模块同目录。
- 修改 `src/server.ts`：按配置启动/关闭 Issue Auto 服务，分发 App Server 通知。
- 修改 `src/feishu.ts`：抽取原项目与 worktree 的显式关联、任务话题和通知接口，不修改已有飞书流程语义。
- 修改 `src/codex-client.ts`：提供必要的受控执行/状态查询接口，保留旧接口兼容。
- 修改 `.env.example` 和 `README.md`：禁用默认配置、部署/恢复、权限及风险说明。
- 试点仓库 `/Users/kenny/Web/usmapgames.com` 的 CI 配置在独立 worktree 完成，不修改其原工作区。

## Task 1：试点前置检查与 CI 契约

**文件：** 修改设计文档；试点仓库独立 worktree 中创建 `.github/workflows/issue-auto-ci.yml`（启用或推送前须确认）。

**输入/输出：** 输入仓库 `blackpill/usmapgames.com`；输出稳定 repository ID、默认分支 SHA、可重复执行的验证命令、固定 check 名称和时限。禁止读取凭据内容。

- [ ] 查询仓库 ID、PR 访问和分支权限；记录只读结果，验证本机路径 origin，保留原工作区改动。
- [ ] 在独立 worktree 检查 Node 版本、lockfile、Playwright 运行配置；验证 `npm ci` 和 `npm run verify` 的依赖、执行时长及外部服务需求。未验证项标明阻塞，不能缩小检查范围冒充完整通过。
- [ ] 为 PR CI 设计固定工作流与检查名；以该仓库自身规范选择 Node、浏览器安装及缓存。运行验证，记录完整命令和结果；无实际通过前不配置为成功门槛。
- [ ] 检查正常、失败、取消和缺失检查在 GitHub API 的实际表现。远端创建 workflow 或修改保护规则前获得用户确认。

## Task 2：Worker 验签、鉴权和 D1 原子入队

**文件：** 新建 `worker/src/index.ts`、`worker/src/webhook.ts`、`worker/src/store.ts`、`worker/migrations/0001_tasks.sql`、`worker/test/webhook.test.ts`、`worker/wrangler.jsonc`、`worker/package.json`。

**接口：** `handleWebhook(request: Request, env: Env): Promise<Response>`；`enqueueDelivery(input: VerifiedIssueEvent): Promise<'created' | 'duplicate'>`。`VerifiedIssueEvent` 包含 deliveryId、repositoryId、issueNumber、actorId、action 和 payloadDigest。

- [ ] 写测试：原始字节有效/无效 HMAC、缺失头、超大请求、`ping`、`opened` 自带 `Auto`、`labeled` 加 `Auto`、错误 action/仓库/操作者；前者接受，后者不得入队。
- [ ] 写测试：相同 delivery 重投、不同 delivery 命中相同 Issue 均仅生成一个任务；并发入队下事件与任务保持一致。
- [ ] 运行 `npm --prefix worker test`，确认新增测试因缺少实现失败；实现 Worker、schema 与 D1 原子写入，成功写入后响应 2xx，写入失败返回失败。
- [ ] 重跑测试并执行 `npm --prefix worker run check`；检查响应和日志不含密钥、Issue 敏感正文。确定 Wrangler/D1 测试工具及依赖版本后锁定，不部署。

## Task 3：租约领取与本地交接

**文件：** 新建 `worker/src/queue.ts`、`worker/test/queue.test.ts`、`src/issue-auto/store.ts`、`src/issue-auto/claim-client.ts` 及同名测试。

**接口：** `claim(runnerId: string): Promise<Claim | null>`；`ack(taskId: string, leaseToken: string, leaseVersion: number): Promise<boolean>`；`importClaim(claim: Claim): 'inserted' | 'existing'`。`Claim` 包含稳定 taskId、事件摘要及租约版本。

- [ ] 写测试：Runner 凭据错误拒绝；并发领取只能成功一个，过期租约可重领，旧 token/version 不可确认。
- [ ] 写测试：本地导入失败不确认；导入成功后确认丢失、重复领取、重启后仅一条本地任务并可重确认；模拟 D1 暂不可用不丢本地任务。
- [ ] 分别运行 `npm --prefix worker test` 和 `npx vitest run --config vitest.config.ts src/issue-auto/claim-client.test.ts`，先确认失败；实现 D1 条件更新、独立 Runner 鉴权、本地 SQLite 唯一键事务、10 秒带抖动领取和退避。
- [ ] 重跑测试，验证远端 `delivered` 仅表示移交，不代表任务完成；禁止把远端租约当作执行锁。

## Task 4：工作区与项目映射

**文件：** 新建 `src/issue-auto/workspace.ts`、`src/issue-auto/workspace.test.ts`；修改 `src/feishu.ts`。

**接口：** `prepareWorkspace(task: IssueTask): Promise<{ projectPath: string; worktreePath: string; branch: string; baseSha: string }>`；`resolveProjectPath(worktreePath: string): string | null`。

- [ ] 写临时 Git 仓库测试：worktree 从确认的远端 base 创建、分支 `codex/` 前缀、路径规范化、重复调用对账；原目录未提交改动不变、非法路径拒绝。
- [ ] 写飞书映射测试：worktree Session 使用原项目群和独立话题，不改变普通 Session 分组；项目群缺失时明确阻塞并通知，而非静默丢失。
- [ ] 先运行 `npx vitest run --config vitest.config.ts src/issue-auto/workspace.test.ts src/feishu.test.ts` 观察新增用例失败；实现并重跑。记录 Codex Desktop 对 worktree 的显示实测结果，不假设它归入原项目。

## Task 5：持久 Supervisor 与恢复

**文件：** 新建 `src/issue-auto/types.ts`、`src/issue-auto/supervisor.ts`、`src/issue-auto/supervisor.test.ts`；修改 `src/codex-client.ts`、`src/server.ts`。

**接口：** `Supervisor.start(): Promise<void>`、`Supervisor.onCodexNotification(event: RpcNotification): Promise<void>`、`Supervisor.reconcile(taskId: string): Promise<void>`、`Supervisor.stop(): Promise<void>`。状态包括 `RECEIVED`、`PREPARING`、`DEVELOPING`、`VALIDATING`、`CREATING_PR`、`CI_CHECKING`、`PR_READY`、`BLOCKED`、`WAITING_QUOTA`、`PAUSED`。

- [ ] 写测试：完成一个 Turn 不代表任务完成；验证失败带证据开启下一轮；失败三次或两次无进展进入阻塞；额度/需求冲突分别暂停并保存恢复阶段。
- [ ] 写恢复测试：请求超时但 Turn 实际启动、App Server 重连时 Turn 仍运行、租约过期但旧进程仍活跃、进程在状态转换中崩溃；先对账再发起新操作，不能并发执行。
- [ ] 运行 `npx vitest run --config vitest.config.ts src/issue-auto/supervisor.test.ts` 确认失败；实现状态机、乐观版本/租约、预算、Codex 适配及服务启动恢复。
- [ ] 重跑测试并运行 `npm run check`；验证既有飞书超时器与 Supervisor 不会同时中断同一 Turn。

## Task 6：独立本地验证

**文件：** 新建 `src/issue-auto/validator.ts`、`src/issue-auto/validator.test.ts`。

**接口：** `validate(task: IssueTask, config: ValidationConfig): Promise<ValidationResult>`，结果包含命令、退出码、日志位置、运行时间、commit SHA、通过/失败/未配置。

- [ ] 写测试：固定可信配置命令执行、非零退出、超时、输出截断、未配置、commit 变化；不能把未配置和 Codex 声称通过当作验证成功。
- [ ] 先运行 `npx vitest run --config vitest.config.ts src/issue-auto/validator.test.ts` 确认失败；实现受控进程执行、日志脱敏及结果持久化。
- [ ] 重跑测试；使用任务 1 验证过的命令在试点独立 worktree 演练，记录实际结果，不操作生产部署。

## Task 7：PR、CI 与修复循环

**文件：** 新建 `src/issue-auto/github.ts`、`src/issue-auto/pr-controller.ts`、`src/issue-auto/pr-controller.test.ts`。

**接口：** `ensurePullRequest(task: IssueTask): Promise<PullRequestRef>`；`checkRequiredCi(pr: PullRequestRef, required: string[]): Promise<CiResult>`；`CiResult` 记录 headSha、每项状态和证据。

- [ ] 写测试：创建 PR 响应丢失后按分支、base 和任务标识对账；不重复创建；Issue 已关闭或标签移除不再开始新执行。
- [ ] 写测试：最新 SHA 全部指定检查成功才 `PR_READY`；旧 SHA、空/缺失/等待/失败/取消/跳过均不通过；通知前 SHA 变化回到检查；失败日志可驱动最多三次修复。
- [ ] 先运行 `npx vitest run --config vitest.config.ts src/issue-auto/pr-controller.test.ts` 确认失败；实现 GitHub API 适配、PR 对账和 CI 状态机；确保无自动合并、部署或关闭。
- [ ] 重跑测试并用 mock GitHub 验证分页、限流、网络中断及重试；实际推送分支或创建 PR 前确认试点已获授权。

## Task 8：飞书交接与可观测性

**文件：** 新建 `src/issue-auto/notifier.ts`、`src/issue-auto/notifier.test.ts`；修改 `src/feishu.ts`、`src/logger.ts`。

**接口：** `notifyReady(taskId: string, headSha: string): Promise<void>`；`notifyBlocked(taskId: string, reason: string): Promise<void>`；通知记录以任务、状态版本去重。

- [ ] 写测试：CI 通过通知带真实 PR、Issue、SHA、结果与未自动验证项；失败耗尽、权限/额度问题与 CI 等待超时及时通知；重复事件不重复发送。
- [ ] 写测试：飞书失败后持久重试，重启不丢通知；旧 SHA 不发成功通知；对公网 Worker/Mac 离线明确告警不保证由本机飞书发送。
- [ ] 先运行 `npx vitest run --config vitest.config.ts src/issue-auto/notifier.test.ts src/feishu.test.ts` 确认失败；实现通知 outbox、失败日志和重试；重跑测试。

## Task 9：部署文档与端到端故障演练

**文件：** 修改 `.env.example`、`README.md`、设计文档；新建 `docs/issue-auto-runbook.md`、`src/issue-auto/integration.test.ts`。

- [ ] 写端到端测试：有效事件 → D1 → 本地导入 → Codex mock 多轮 → 本地验证 → PR → 最新 SHA CI 通过 → 飞书提醒；覆盖 Worker 写失败、重投、领取确认丢失、Mac 重启、CI 重试耗尽和通知失败。
- [ ] 先运行 `npx vitest run --config vitest.config.ts src/issue-auto/integration.test.ts` 确认失败；完成接线与恢复后重跑。
- [ ] 更新配置模板和运维手册：Worker/D1、独立 secret、仓库 ID、用户 ID、必需检查、预算、launchd 登录后启动限制、Webhooks 失败投递重投和 Mac 离线监控；标明部署步骤不自动执行。
- [ ] 运行 `npm test`、`npm run check`、`npm run build`、`npm --prefix worker test` 和 Worker 类型检查；记录结果。检查原试点工作区未被修改，不提交或部署无关改动。
- [ ] 在用户确认实际权限、安全风险、CI 检查名、飞书接收人及 Cloudflare 账号后，执行单 Issue 试点并核对 CI、PR、提醒和失败路径；不得自动合并。
