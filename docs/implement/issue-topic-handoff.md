---
updated_at: 2026-11-07T06:22:57+08:00
git_commit: 4fd546f9337648a49c3edca41180cbe4b6e1b9be
---

# Issue Topic 人工接管

## 使用流程

1. 在受管 Issue 的原 Topic 进度卡点击 **人工接管**，或发送 `/takeover`。
2. 等卡片显示 **人工模式**，再直接在同一 Topic 发送验收修改意见。Codex 按顺序执行，后续意见排队。
3. 修改完成后点击 **继续自动修改**，或发送 `/auto [补充意见]`。如果人工回合尚未结束，会先等待，不会启动第二个写入回合。
4. Supervisor 重新核对 Issue、PR 和工作区身份，然后继续修改、本地验证、提交推送、原 PR 的 CI 跟踪及预览。CI 通过后仍使用 Topic 记录＋单聊定位本次通知的链路。

`/issue-status` 查看控制模式和未交回自动流程的意见数量。单聊先 `/use <session-id>` 也可使用这些命令，但原 Topic 仍是进度和通知的记录位置。

自动模式直接发的普通意见只保存，不会并发发送或 steering；先接管后再恢复，会将这些意见交给自动流程。人工模式普通意见依次调用 Codex；点击继续自动后，尚未执行的排队意见会交给自动回合，而不是另起人工回合。已执行的人工意见会标注“已执行，核对差异避免重复”。

## 安全边界

- 只有 `FEISHU_ALLOWED_OPEN_IDS` 中显式登记的飞书用户可操作；空名单不会开放 Issue 控制。同一轮人工接管有唯一操作者。
- 接管只等待安全边界，不强杀 Turn。安装、验证、推送等已记录为结果不确定的阶段不会由按钮解锁。普通网页/飞书发送与写控制的永久 Session guard 继续有效，人工消息只经专门队列执行。
- 人工模式下系统不执行提交、推送或 PR 发布；模型提示也禁止这些动作。但 Codex 仍具备已有的完整本机权限，提示不是安全沙箱，无法阻止用户经 Desktop 或其他工具直接写同一工作区。
- 初始 usmap 试点的旧任务可以沿用 `issue-worktrees/codex-issue-*`；仅兼容仓库 ID `1444221313` 在迁移到同父目录下 `1444221313/` 前的既有布局，仍核对 Git common-dir、任务分支、push remote 和 base ancestry，不创建或移动目录。
- `/auto` 的附加文字只保存为自动恢复意见；若恢复校验失败，不会误转为人工执行。
- 原 PR 已关闭或合并时拒绝继续自动修改，保留意见并提示创建后续 Issue，不自动复活旧 PR 或创建替代 PR。
- 暂停期间旧局域网预览可能返回 503；恢复自动验证、CI 通过后更新测试链接。
- 不自动合并、部署或关闭 Issue。

## 持久化与故障恢复

SQLite 的 `issue_auto_controls` 保存 auto/requested/manual/resume_requested/blocked 模式和操作者；`issue_auto_feedback` 保存意见、幂等消息 ID 和人工 Turn 的 queued/launching/running/terminal 状态。自动及人工 Turn 共用全局 `issue_auto_execution` 执行槽。

发送前先落 launching 意图；只有读取到记录 Turn 的明确终态才释放执行槽。服务重启恢复已记录 running Turn；若停在 launching、返回结果丢失或身份不符，则保持锁并通知核查，绝不盲目重发。需要运维核对旧进程、实际 Thread、Git 和远端状态后协调，不能直接清空数据库或强行点击恢复。

控制卡的刷新失败不改变锁或队列状态；发送未知结果与 UI 错误分别处理。项目被禁用后不启动遗留手工队列，保留已有锁和意见。累计意见超过 30000 字符时，原文保存到 `.data/issue-auto-logs` 下不可覆盖的 0600 私有快照；自动回合收到必须完整读取该文件的指令，不截断或要求用户反复补交短版。存储失败则不消费意见。

## 验证

使用 Node 22：`npm run test:all`、`npm run check:all`、`npm run build`。

聚焦用例位于 `src/issue-auto/handoff*.test.ts`、`boot.test.ts`、`service.test.ts` 及 `src/feishu.test.ts`，覆盖串行队列、异步接管、未知启动、恢复、授权和关闭 PR 等边界。手机 Topic 交互验收记录见下节；部署状态以真实服务和消息回执为准，不以单元测试代替。


首轮隔离验证：基于 `4fd546f` 加本功能变更的独立快照，应用 225、Worker 8、Hermes 40 项测试通过，`check:all` 和 `build` 通过。当时共享工作区还有其他会话正在开发的 YouTube 模块，其缺失模块曾导致全量测试失败，因此首轮未使用该部分构建部署；随后统一绿测并部署，见下节。


## 真实环境验收（2026-11-07）

- 先确认 36 个桥接关联 Session 均无运行 Turn、Issue 活跃任务及执行槽为 0；SQLite 在线备份并准备已验证回退构建后重启。YouTube 监控仍由独立 LaunchAgent 运行，主服务配置明确禁用重复实例。
- Issue #7 原 Topic 的真实 `/takeover` 进入人工模式；人工标记回合完整经过 queued/launching/running/done，回复正确，无工具调用、无文件修改。
- 用户真实点击“继续自动修改”，进入 resume_requested/auto；新自动 Turn 执行期间，普通 HTTP 发送仍被永久 guard 拒绝，执行槽仅属于当前任务。
- 走完独立验证、原 PR 发布复核、现有 CI 复核、预览与通知，最终 PR_READY v48，Topic 与单聊均有真实消息回执，单聊含定位到本次 Topic 回复的链接。
- PR #8 提交仍为 `bb4077996e14fae4f9ddbb2c3bc054bf54d15684`，工作区干净，无新增提交或替代 PR；未合并/部署。LAN 预览 200、noindex/no-store、元数据 SHA 匹配。
- 验收发现旧路径兼容和恢复失败附加意见误入人工队列两项问题，均已 RED→GREEN 修复并安全重载；最后一次统一构建前应用 311、Worker 8、Hermes 64 项测试以及 check:all/build 全部通过。
- PR #8 与 main 的既有合并冲突不属于本次控制通道验收修改范围，未自动处理。

用户已确认本轮 PR #8 单聊提醒收到，链接定位到本次 Topic 通知正确；真实手机验收完成。
