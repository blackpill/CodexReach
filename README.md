# Feishu Codex Bridge

在飞书手机端查看和控制 Mac 上的真实 Codex Projects 与 Sessions。系统通过 Codex App Server 共享同一份 Thread 数据，支持 Computer Use、Browser Use 和实时执行事件。

## 当前能力

- 按工作目录展示全部 Codex Projects 和 Sessions
- 读取完整 Session、继续发送任务、实时刷新、停止运行
- 飞书长连接机器人，无需公网回调地址
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
3. 授予读取和发送消息所需权限，并发布应用版本。
4. 将 App ID、App Secret 和允许控制的用户 `open_id` 写入 `.env`：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ALLOWED_OPEN_IDS=ou_xxx
```

机器人命令：

- `/projects`：列出项目
- `/sessions`：列出最近 Session
- `/use <session-id>`：选择 Session
- `/new <绝对路径> <任务>`：创建真实 Session
- `/stop`：停止当前任务
- `/help`：查看帮助
- 选择 Session 后，普通文字会直接作为下一轮任务发送。

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
