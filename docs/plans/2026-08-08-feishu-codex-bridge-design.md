# Feishu Codex Bridge 设计

## 目标

通过飞书机器人和手机 Safari 控制 macOS 上的真实 Codex Desktop Projects/Threads。手机与桌面共享 Codex 本地数据源，并允许在完全自动模式下使用 Computer Use、Browser Use 等能力。

## 架构

- Mac Bridge：局域网 HTTP/WebSocket 服务，负责认证、聚合和实时广播。
- Codex Adapter：通过 `codex app-server --stdio` 的 JSON-RPC 协议列出、读取、创建、继续和停止真实 Thread。
- Feishu Gateway：使用飞书长连接接收消息，无公网回调。
- Mobile Console：React 手机页面，由飞书跳转到 Safari；按 cwd 聚合 Projects。
- Security：一次性配对码换取 Bearer Token；仅监听局域网；配置飞书用户白名单。

## 数据流

手机或飞书消息进入 Bridge，Bridge 调用 Codex App Server。Codex 的通知事件通过 WebSocket 广播给手机，Desktop/CLI 从相同 Codex 状态读取更新。Bridge 不复制消息正文，仅保留安全配置与瞬态事件。

## 权限

按用户选择，Turn 使用 `approvalPolicy: never` 与 `dangerFullAccess`。系统保留中断当前 Turn、停止 Bridge 与移除浏览器令牌的能力。macOS 屏幕录制与辅助功能权限仍由系统首次授予。

## 容错与测试

App Server 异常退出自动重启；请求超时返回结构化错误；移动端断线指数退避重连并刷新真实 Thread。单元测试覆盖项目聚合、命令解析与认证；集成测试覆盖 App Server 握手、列表、读取、发送和中断。
