# GitHub Issue Auto 开发监督器设计

- 日期：2026-11-05
- 状态：已实现并完成单仓库试点；本文保留初始设计，当前运维限制见 README 和 docs/issue-auto-runbook.md
- 范围：CodexReach 首版 Issue 自动开发及 PR 交接

## 1. 目标与交接边界

可信仓库中的 Issue 满足 `Auto` 触发规则后，自动创建可追踪的 Codex Session，由 Supervisor 驱动分析、规划、开发、独立验证、创建 PR 和 CI 修复。仅当 PR 最新提交的指定 CI 全部成功时，通过飞书提醒用户审核。CI 持续失败、权限不足、需求冲突、额度不足或其他需要人工处理的情况应及时提醒。

首版自动流程的成功终点是 `PR_READY`，不是 Issue 完成：不自动合并 PR、不部署生产环境、不关闭 Issue。局域网验收预览属于后续批准的独立扩展。不能保证任一 Issue 最终必定成功。自动化未能证明的主观或业务验收项必须在 PR 和通知中说明，不能声称全部满足。

非目标：处理其他标签、Issue 评论触发、多机并行、自动发布、自动合并、通过模型自述替代检查。

## 2. 已有基础与约束

- `src/codex-client.ts` 使用 Codex App Server，已具备 Thread 创建、读取、恢复、Turn 发送和进程重连；重连不等于长任务恢复。
- `src/server.ts` 分发 App Server 通知；`src/feishu.ts` 已支持项目群、话题、任务消息、超时处理；`src/state-store.ts` 使用 SQLite。
- 项目按 Thread `cwd` 分组。worktree 是不同路径，必须建立原项目、worktree 与会话的显式映射，避免创建多余项目群。Codex Desktop 的分组显示需要实测，不能假设会归入原项目。
- 当前 Codex 使用 `approvalPolicy: never` 和 `dangerFullAccess`；worktree 不是沙箱。首版仅限可信项目、可信维护者和明确的风险接受，不应宣称隔离了文件或网络访问。
- `scripts/install-launch-agent.sh` 提供登录后启动及 KeepAlive；Mac 重启后登录、网络和凭据可用性仍需验证。

## 3. 事件接入：GitHub Webhook + Cloudflare D1 + Mac 领取

### 3.1 已选方案

`GitHub issues Webhook → Cloudflare Worker 验签及授权 → D1 持久化任务 → Mac 主动领取 → 本地 Supervisor`

不轮询 GitHub Issue，不向公网暴露 Mac 端口，不依赖 Cloudflare Tunnel。Mac 默认每轮完成后约 10 秒向 Worker 发起 HTTPS 领取请求；这是**队列领取**，不是轮询 Issue。CI 状态跟踪以及可选的 webhook 失败投递检查不属于 Issue 轮询。WebSocket 可作为未来降低延迟的通知层，不能替代持久队列及重连后的领取。

| 方案 | 决策 |
| --- | --- |
| GitHub Issue API 轮询 | 不采用 |
| Webhook + D1 队列 + Mac 主动领取 | 首版采用；离线期间已写入 D1 的任务可保留 |
| Webhook + WebSocket | 后续选项；多连接管理，仍需持久化和断线补领 |

正常领取的额外等待约 0–10 秒，但 GitHub 投递、网络和服务可用性也影响端到端时延，不承诺实时。一天每 10 秒约 8,640 次领取请求；这是近似值，不含重试、心跳、Webhook 和其他服务请求。Cloudflare 额度、D1 读写、请求及其他费用按账号实际套餐在部署前核验，不以该次数保证免费。参考 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/) 和 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)。

### 3.2 Webhook 验证、授权与去重

- Worker 限制请求体大小，以 secret 对原始字节验证 `X-Hub-Signature-256`；拒绝无效签名，不记录 secret。处理 `ping`；只接收 `issues.opened` 且创建时含 `Auto`，或 `issues.labeled` 且新增标签为 `Auto`。事件名、action、repository、Issue 和操作者须完整校验。
- 只允许配置的 repository ID 和可信 GitHub 用户 ID：创建事件检查创建者，添加标签事件检查添加者。仓库、操作者规则在服务端强制执行；Issue 正文不是授权来源。
- D1 以 `X-GitHub-Delivery` 唯一约束去重投递，并按 repository ID、Issue 编号和任务代次约束业务去重。事件记录和任务创建须在可验证的原子事务内完成，成功持久化后才返回 2xx；持久化失败返回失败状态。重投同一 delivery 安全返回成功且不重复创建。
- 同一 Issue 默认只创建一个任务；已结束后移除并重加标签不自动重跑。乱序事件不可仅靠到达顺序推断当前状态；开始前通过 GitHub 查询 Issue 是否仍开放且仍有 `Auto`，不满足则暂停或取消并通知。运行中移除标签或关闭 Issue 的具体取消处理须实现时确保不依赖单次事件可靠有序。
- GitHub 不自动重投失败 Webhook；D1 持久化只能保护**已成功写入**的任务，不能覆盖 Worker 不可用、验签失败或 D1 写入失败。试点必须有投递失败可见性：人工检查及重投，或单独定时检查失败投递并重投；超过可重投窗口时人工核对。后者检查的是投递记录而非轮询 Issue。参见 [GitHub 失败投递说明](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)。

### 3.3 远端队列到本地持久任务的交接

- Worker 的领取/确认接口使用独立于 Webhook secret 的 Runner 凭据认证，所有请求走 HTTPS；密钥由 Cloudflare Secrets 和本机安全存储管理，支持轮换、最小权限、访问日志脱敏与限流。
- D1 存储远端投递 `pending / leased / delivered`、租约拥有者、到期时间和递增版本；通过原子条件更新领取，响应含稳定 task ID、租约 token/版本和最小必要任务数据。并发领取、到期重领与旧确认都必须经过 CAS/fencing 检查，拒绝过期租约。
- Mac 收到任务后，先在本地 SQLite 以远端 task ID 唯一键事务性写入完整任务及调度记录，成功提交后再发送带租约版本的确认；Worker 校验后标记 `delivered`。确认丢失或租约过期时允许重投，本地幂等导入再确认。不能先确认再本地落库。
- `delivered` 只表示**安全移交给本地队列**，不是开发成功；远端 D1 是交接前队列权威，本地 SQLite 是交接后执行状态权威。确认后 Mac 故障由本地持久数据和重启恢复处理；本地磁盘丢失不在该机制的保证范围内，需备份/灾备策略。
- 未确认的远端租约到期可重领。单 Mac 首版不自动向其他机器转移已确认任务；如以后支持多 Runner，须另设计执行所有权、续租与 fencing，不能仅靠队列租约防止重复代码修改。
- D1 不提供与本机 SQLite 跨系统原子事务；采用至少一次投递 + 两端幂等 + 对账，不承诺恰好一次。队列长度、最早待领时间、Worker 错误、Mac 长时间未领取及本地通知失败应可观测；远端告警通道首版另行确认，Mac 离线时不能保证本地飞书通知。

## 4. 执行架构

### 4.1 部件职责

- Worker / EventSource：Webhook 验签、授权、D1 持久接收和去重；Mac 领取并导入本地任务，不执行开发。
- Supervisor：状态转换、持久调度、预算、租约、恢复、通知；一次只调度一个可持久化工作单元，不依赖永久循环。
- Workspace Manager：按仓库配置的基线创建独立 worktree 和 `codex/` 分支，不修改原工作区；保留失败现场，不自动删除有用户数据的工作区。
- Codex Adapter：启动或恢复 Thread，驱动 Turn，监听状态；断线后先查询并对账，不盲目重发。
- Validator：按仓库可信配置独立执行测试、类型检查、构建；记录命令、退出码、日志、时间及 commit SHA。
- PR/CI Controller：推送分支、幂等创建 PR、检查最新 SHA 的指定 CI、获取失败证据并调度修复。
- Feishu Notifier：绑定原项目群和任务话题，最终/阻塞提醒可靠投递；失败待重试并可见。

### 4.2 生命周期

`RECEIVED → PREPARING → DEVELOPING → VALIDATING → CREATING_PR → CI_CHECKING → PR_READY`

本地验证失败回到 `DEVELOPING`；CI 失败回到修复并重新验证、推送、CI 检查。可进入 `PAUSED`、`WAITING_QUOTA`、`BLOCKED`，保留恢复阶段和原因。检查中或暂停时不算成功。`PR_READY` 不是 GitHub Issue 关闭状态。

- 初始建议：CI 连续修复最多 3 次；连续 2 轮无可验证进展暂停。任务的总轮次、耗时和资源预算配置化，初始值实施前确定。
- 网络错误指数退避；额度不足或需人工判断时暂停并通知。空闲超时先检查实际活动、进程和工具状态，再谨慎中断；现有飞书超时与 Supervisor 不得双重控制。
- CI 等待超时、指定检查缺失、跳过、取消、结果未知或无检查都不得视作通过；检查规则与等待时限按仓库配置，未配置时阻塞并提醒。
- 对同一 PR 最新 head SHA 的全部指定检查成功才进入 `PR_READY`。即将通知前复核 head 和检查状态；通知后若 head 或结果发生变化，取消就绪并再次跟踪。不得把旧提交的 CI 结果用于新提交。
- 成功提醒包含 Issue、PR 链接、摘要、验证结果、未自动验证项及 Session/飞书话题入口；持续失败或人工阻塞时包含阶段、错误、修复次数和接管入口。通知按任务与状态版本去重，并记录投递失败。

## 5. 持久化和恢复

SQLite 是权威状态源；新增任务、事件、轮次、验证、通知和租约记录。至少保存仓库稳定 ID、Issue 编号、事件 ID、触发者、规则版本、原项目与 worktree 路径、分支/base SHA、Thread/Turn ID、PR URL/编号/head SHA、CI 证据、状态、预算、租约和最后错误。敏感凭据不写入数据库或日志。

任务状态转换与本地入队尽可能在同一事务中完成；外部调用不可能与 SQLite 原子提交。所有有副作用的步骤都要存储操作意图，并以分支名、任务标识、PR head/base 等在重试前查询对账；若结果不确定则暂停交人工，不承诺严格 exactly-once。租约需有到期、续租和 fencing/版本检查；恢复前核查旧执行者，不能仅因租约过期就并发修改同一 worktree。

启动恢复：扫描非终态任务 → 获取租约 → 检查进程和 Thread/Turn → 核对 worktree/分支/PR/CI → 从最后确认的阶段继续；不能恢复 Thread 时依据持久记录和 Git 状态新建 Thread。工作区和日志必须有保留、清理和脱敏策略。

## 6. 安全与运行约束

- Issue 正文、评论、仓库代码和 CI 日志均是不可信输入，不构成提升权限或自动执行外部指令的授权。只运行仓库预先配置、经信任的验证命令；仓库代码和依赖仍可能执行任意操作。
- GitHub 身份最小权限：按实际 API 和仓库配置授予读取 Issue/事件、读取 CI、推送分支和创建 PR 所需权限；试点前核验具体权限与令牌过期策略。不得把令牌写进提示词、日志或 PR。
- 明确仓库和操作者白名单、路径 canonicalization、worktree 根目录和并发上限；默认单任务执行。对外通知不得泄露 secret。
- 建议独立低权限运行账户或容器/虚拟机作为后续安全加固；现有完整权限模式下，需要用户明确接受执行可信仓库代码的风险。

## 7. 首个试点仓库：usmapgames.com（首次勘察历史）

用户指定首个试点为 `blackpill/usmapgames.com`，唯一可信 GitHub 触发者为 `blackpill`（已查询稳定用户 ID `1231245`）。必须用已核验的用户 ID 授权，显示名仅用于展示；不因此信任其他维护者或 Issue 作者。

以下为实现前的 2026-11-05 只读核实结果，不代表部署后的当前配置；试点 CI、Webhook、飞书通知和预览已随后配置并验收：

- GitHub 仓库为私有仓库，仓库 ID `1444221313`，已启用 Issues，默认分支 `main`；本机工作目录为 `/Users/kenny/Web/usmapgames.com`，`origin` 指向该仓库。
- 仓库当前 Actions workflow 数量为 0，`main` 未启用分支保护；故现阶段没有可以作为 `PR_READY` 门槛的已确认 CI。必须先由实施阶段配置并验证 PR CI 和明确必需检查名称；无 CI 不可视为成功。是否启用分支保护另行决定，不等同于 Supervisor 自行检查 CI。
- 项目提供 `npm run verify`，包含 lint、类型、数据、单元测试、构建、SEO、体积及 Playwright E2E；还提供单独的 `test:iphone13`。首版本地和 CI 分别运行什么、浏览器依赖和运行时间上限，须验证后确定，不能直接假定全套在 CI 可运行。
- 原工作区存在未提交改动 `output/qa/chromium-play.png`。不修改、清理或纳入它；使用从远端 `main` 建立的独立 worktree，并在试点前核验基线 SHA。
- 这是非控制器自身的仓库，避免自修改 CodexReach；但仍可能涉及生产站点、Cloudflare 凭据和外部资源。首版不自动部署或操作生产环境，敏感数据不写入远端队列、日志或通知。

仓库稳定 ID `1444221313` 在正式配置前再次核验；仓库验证命令及 CI 必需检查名称须验证并显式记录；本机 GitHub 登录状态不等于自动 PR/CI 访问权限已全部验证。生产配置和 Cloudflare 部署均未执行。

## 8. 验收与故障演练

1. 非 `Auto`、非白名单仓库/人员、无效签名的事件不启动；有效创建带标签和后加标签各只创建一次任务。
2. 模拟重复 Webhook、乱序、Worker/D1 故障、GitHub 失败投递及重投；本地落库前后中断、确认丢失、租约过期和重复领取均不丢失已持久化任务或重复执行。
3. 同一任务不会并发运行；Turn 完成不直接标记 Issue 完成。本地验证失败进入修复，超过预算进入阻塞并通知。
4. 模拟创建 PR 前后中断，恢复时对账、不重复建 PR；模拟 CI 失败后修复、重试耗尽与缺失检查。
5. CI 全通过但 SHA 变化、空检查、取消/跳过/超时不触发成功通知；最新 SHA 全部指定检查通过才通知。
6. 飞书通知失败重试；工作区原有改动不受影响；Issue 任务归属原项目群；Desktop 展示与恢复能力通过实测记录限制。
7. 人工验证需求不确定、权限/额度不足、Mac 重启及无网络情况，不得静默丢任务或自动合并。

## 9. 需要确认的实施参数

- 飞书接收人和是否接受完整权限风险；试点仓库及可信触发者已分别确定为 `blackpill/usmapgames.com` 和 `blackpill`。
- 该仓库的检查名称、命令、CI 等待时限、任务总预算，以及是否有必须人工验收的条件。
- 创建 PR 使用 draft 还是普通 PR；Webhook 启用前已有的历史 Issue 默认不自动导入，是否需要人工补录。
- Cloudflare 账号及配额、Worker/D1 原子领取实现、GitHub Webhook 凭据和失败投递告警、Codex Desktop worktree 展示、launchd 重启恢复和通知链路均需先做技术验证。
