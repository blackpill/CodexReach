# Feishu Codex Bridge

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
- 飞书 doc/docx 文档绑定：在评论中 `@Bot` 创建独立 Codex Session，并将执行结果回写文档评论
- 飞书长连接机器人，无需公网回调地址
- 每个 Codex Project 自动对应一个飞书话题消息群
- 每个 Codex Session 自动对应群内一个独立话题，对话历史与上下文严格隔离
- 所有自动创建的项目群均使用 `CodexReach｜` 群名前缀作为可见标签
- Safari 手机控制台、二维码配对、Bearer Token 校验
- `approvalPolicy=never` 与 `dangerFullAccess` 完全自动模式
- macOS 登录后自动启动

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
- `/status [session-id]`：查看服务或任务状态
- `/doctor`：运行不包含凭据的连接与目录诊断
- `/bind-doc <文档链接>`：在 CodexReach Project 群中绑定 doc/docx 文档
- `/docs`：查看当前 Project 已绑定文档
- `/unbind-doc <文档链接>`：解除当前 Project 的文档绑定
- `/help`：查看帮助
- 选择 Session 后，普通文字会直接作为下一轮任务发送。

首次配置权限并发布应用后，在机器人单聊中发送 `/sync-projects`。之后：

- Project 名称与飞书群名称保持一致；群描述记录项目绝对路径。
- 在项目群内新建一个话题，会自动创建并绑定一个新的 Codex Session。
- 在已有 Session 话题内发送消息，只会继续该话题绑定的 Session。
- 已开通群消息事件权限，在 CodexReach 话题内可直接发送命令，无需 `@Bot`。
- Bot 的执行结果始终回复到原话题，不会进入其他 Session 的消息历史。

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
launchctl bootout "gui/$(id -u)/com.local.feishu-codex-bridge"
rm "$HOME/Library/LaunchAgents/com.local.feishu-codex-bridge.plist"
```

## 安全说明

服务仅用于可信局域网。务必配置 `FEISHU_ALLOWED_OPEN_IDS`。完全自动模式能读写本机文件并控制屏幕，不应在公共 Wi-Fi 使用。删除 `.data/auth.json` 并重启服务可撤销所有已配对浏览器。
