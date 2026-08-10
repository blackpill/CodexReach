# CodexReach

在飞书手机端查看和控制 Mac 上的真实 Codex Projects 与 Sessions。系统通过 Codex App Server 共享同一份 Thread 数据，支持 Computer Use、Browser Use 和实时执行事件。

## 当前能力

- 按工作目录展示全部 Codex Projects 和 Sessions
- 读取完整 Session、继续发送任务、实时刷新、停止运行
- 飞书实时任务卡片，显示执行状态、耗时、队列和最近进展
- 卡片内停止、刷新与失败重试
- 图片/文件自动下载到本地后交给 Codex
- Session 级消息队列与连续消息合并，避免并发写入冲突
- `/status` 服务与任务状态、`/doctor` 脱敏诊断
- Codex App Server 自动重连、任务空闲超时保护
- JSONL 结构化日志与自动清理
- SQLite 状态库，保存群聊、话题、文档绑定、同步游标及 Session/Turn/event_id 关联
- 飞书 doc/docx 文档绑定：在评论中 `@Bot` 创建独立 Codex Session，并将执行结果回写文档评论
- 飞书长连接机器人，无需公网回调地址
- 每个 Codex Project 自动对应一个飞书话题消息群
- 每个 Codex Session 自动对应群内一个独立话题，对话历史与上下文严格隔离
- Codex Desktop 中新增的 Session 与完成回合自动增量同步到对应飞书话题
- 所有自动创建的项目群均使用 `CodexReach｜` 群名前缀作为可见标签
- Safari 手机控制台、二维码配对、Bearer Token 校验
- `approvalPolicy=never` 与 `dangerFullAccess` 完全自动模式
- macOS 登录后自动启动

## 事件关联与通知去重

CodexReach 为从飞书发起的每个 Turn 写入统一关联信息：

```text
event_id = codex:<event_type>:<session_id>:<turn_id>
session_id
turn_id
notification_id
origin = codexreach
```

状态保存在 `CODEXREACH_STATE_DB` 指定的 SQLite 数据库中。首次启动会自动读取旧的 `.data/feishu-state.json` 并导入 SQLite，之后不再以 JSON 作为运行状态源。

Codex 通知 Hook 会查询同一个 `turn_correlations` 表：由 CodexReach 发起的普通完成事件只更新原 Session 话题和任务卡片，不再向 Codex 通知群重复推送；失败、需要授权或需要人工关注的事件仍作为升级提醒发送。Codex Desktop 发起的 Turn 不受此规则影响。

## 安装

```bash
cp .env.example .env
npm install
npm run build
npm start
```

启动日志会显示局域网地址、六位配对码和二维码。手机与 Mac 连接同一 Wi-Fi 后扫码即可。

> Computer Use 首次使用时，仍需在 macOS「隐私与安全性」中允许辅助功能与屏幕录制。这是系统权限，无法由应用绕过。

## 飞书机器人

应用名称使用 **CodexReach**。推荐在飞书开放平台上传仓库中的醒目头像：[`assets/codexreach-avatar.png`](assets/codexreach-avatar.png)。名称与头像属于飞书应用资料，需要在开放平台修改并发布新版本后才会对群聊生效。

1. 在飞书开放平台创建企业自建应用并开启机器人。
2. 开启长连接事件订阅，订阅 `im.message.receive_v1`。
3. 授予读取和发送消息、创建群、更新应用创建的群、管理群 Label、获取群分享链接所需权限，并发布应用版本。若希望话题中无需每次 @ 机器人，还需开启“获取群组中所有消息”。
4. 将 App ID、App Secret 和允许控制的用户 `open_id` 写入 `.env`：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ALLOWED_OPEN_IDS=ou_xxx
```

机器人命令：

- `/projects`：以可翻页卡片列出项目，可直接点击查看该项目的 Sessions
- `/sync-projects`：为每个 Project 创建或同步一个带 `CodexReach｜` 前缀的话题消息群，并为已有 Session 创建独立话题
- `/sync-project <项目名称|绝对路径|编号>`：只创建或同步指定的一个 Project
- `/sessions`：列出最近 Session
- `/use <session-id>`：选择 Session
- `/new <绝对路径> <任务>`：创建真实 Session
- `/stop`：停止当前任务
- `/retry`：重试上一条失败或中断的任务
- `/continue [指令]`：恢复任务；运行中使用时作为 same-turn steering 追加指令
- `/model [模型 ID]`：卡片选择或直接设置当前 Session 模型
- `/mode [default|plan]`：切换默认执行或先规划模式
- `/diff`：用 Git 卡片查看未提交变更
- `/commit [提交说明]`：预览变更并通过卡片确认本地 Commit（不 Push）
- `/status [session-id]`：查看服务或任务状态
- `/doctor`：运行不包含凭据的连接与目录诊断
- `/bind-doc <文档链接>`：在 CodexReach Project 群中绑定 doc/docx 文档
- `/docs`：查看当前 Project 已绑定文档
- `/unbind-doc <文档链接>`：解除当前 Project 的文档绑定
- `/help`：查看帮助
- 选择 Session 后，普通文字会直接作为下一轮任务发送。
- 直接发送飞书图片、音频或文件时，Bot 会下载到本地附件目录；图片/音频转为 Codex 原生多模态输入，其他文件转为文件 mention。
- 消息中可用 `@相对路径` 引用当前 Project 内的文件，例如 `检查 @src/server.ts`；路径含空格时使用 `@"docs/my file.md"`。
- 消息中可用 `$技能名` 调用当前 Project 可用的已安装 Codex Skill，例如 `$audit 检查这个项目`。
- `/files [关键词]` 和 `/skills [关键词]` 会返回可点击候选卡片；可连续选择多个项目，然后直接发送任务内容。
- `/context` 查看已经选择、等待随下一条任务发送的上下文，可逐项移除；`/context clear` 全部清空。选择会保存到 SQLite，30 分钟未使用自动过期，任务发送成功后自动清空。
- `/apps [关键词]` 读取 Codex App Server 的 App/Connector 列表，显示可调用、待安装或待授权状态；可调用 App 能加入 Context，未授权 App 提供安装/授权入口。
- `/plan` 查看当前 Session 最近的 Codex Plan；`/plan <任务>` 要求 Codex 先制定计划。
- `/goal` 查看原生 Codex Goal；支持 `/goal create <目标> [--budget 数字]`、`/goal pause|resume|complete|clear`。
- Plan 卡片会随 Codex 的步骤更新自动刷新并显示完成进度；Goal 卡片可直接暂停、恢复、完成或清除。两类卡片状态和消息关联均保存到 SQLite，服务重启后仍可继续刷新。

首次配置权限并发布应用后，在机器人单聊中发送 `/sync-projects`。之后：

- Project 名称与飞书群名称保持一致；群描述记录项目绝对路径。
- 在项目群内新建一个话题，会自动创建并绑定一个新的 Codex Session。
- 在已有 Session 话题内发送消息，只会继续该话题绑定的 Session。
- 已开通群消息事件权限，在 CodexReach 话题内可直接发送命令，无需 `@Bot`。
- Bot 的执行结果始终回复到原话题，不会进入其他 Session 的消息历史。
- Desktop 端新建或继续的会话会在约 10 秒内同步；启动时只建立历史基线，不会把全部旧消息重新刷入群聊。

## 云文档评论

在飞书开放平台为应用订阅 `drive.notice.comment_add_v1`，并授予读取评论与 `docs:document.comment:create` 权限，重新发布应用版本。然后：

1. 在目标 `CodexReach｜项目名` 群中发送 `/bind-doc <飞书文档链接>`。
2. 在已绑定的 doc/docx 文档评论里 `@Bot` 并写明任务。
3. Bot 在绑定 Project 中创建或续接该评论对应的 Codex Session；接收状态只显示在 Codex 会话中，完成后才将结果回写文档评论。若文档关闭了评论内回复，结果会作为新的全文评论写入。

文档未绑定时不会执行；评论人仍必须在 `FEISHU_ALLOWED_OPEN_IDS` 中。当前不支持 Wiki、表格、多维表格和幻灯片链接。

## 自动启动

```bash
chmod +x scripts/install-launch-agent.sh
./scripts/install-launch-agent.sh
```

日志位于 `.data/bridge.log`。要取消自动启动：

```bash
launchctl bootout "gui/$(id -u)/com.local.codexreach"
rm "$HOME/Library/LaunchAgents/com.local.codexreach.plist"
```

## 后续评估试点

通用后续评估系统默认关闭。启用前，需要在飞书开放平台为应用增加任务与任务清单的读写权限，并发布新版本：

- `task:task:write`
- `task:tasklist:read`
- `task:tasklist:write`
- Base 表格与记录的读写权限（例如 `bitable:app`）

然后配置默认负责人并开启功能：

```dotenv
EVALUATION_SYSTEM_ENABLED=true
EVALUATION_PROJECT_PATHS=/Users/kenny/Documents/classgames.net
EVALUATION_DEFAULT_ASSIGNEE_OPEN_ID=ou_xxx
EVALUATION_SCHEDULER_INTERVAL_SECONDS=60
EVALUATION_BASE_TOKEN=<当前项目进展 Base Token>
EVALUATION_BASE_PROJECT_TABLE_ID=<项目清单 table_id>
EVALUATION_BASE_ACTION_TABLE_ID=<行动记录 table_id>
EVALUATION_BASE_PLAN_TABLE_ID=<评估计划 table_id>
EVALUATION_BASE_RESULT_TABLE_ID=<评估结果 table_id>
```

启用后，白名单项目中新完成的 Codex 回合会进入行动识别流程。确认部署草稿后，系统创建 7/28 天等评估节点和飞书任务；任务到期时先在原项目话题询问，确认后才创建新的 Codex 评估 Session。`EVALUATION_PROJECT_PATHS` 留空表示允许所有项目，试点阶段不建议留空。

评估台账使用三张表：`行动记录`、`评估计划`、`评估结果`。本地 SQLite 保存每个实体对应的 Base `record_id`，因此网络重试或按钮重复点击只会更新原记录，不会重复新增。按月复制项目进展 Base 时，需要同步更新上述 Base Token 和 table ID 配置。

## 安全说明

服务仅用于可信局域网。务必配置 `FEISHU_ALLOWED_OPEN_IDS`。完全自动模式能读写本机文件并控制屏幕，不应在公共 Wi-Fi 使用。删除 `.data/auth.json` 并重启服务可撤销所有已配对浏览器。
