# Issue Auto 试点运维

## 范围与安全边界

默认兼容原 `blackpill/usmapgames.com`（仓库 ID `1444221313`）配置；可显式声明 `blackpill/classgames.net`（ID `1223017142`），接入前必须补齐其远端 PR CI，详见 [多项目配置](issue-auto-multi-project.md)。可信 GitHub 用户仍只允许 `blackpill`（ID `1231245`）。Worker 与 Mac 两端都有限制；不是任意仓库的通用 Runner。新建带 `Auto` 的 Issue 或可信人员添加 `Auto` 标签时启动，同一 Issue 不会因移除并重新加标签重复执行。

默认关闭。开启前必须明确接受本机 `dangerFullAccess` 风险；独立 worktree 不等于安全沙箱，模型、项目脚本和依赖可访问本机文件与网络。自动流程不合并 PR、不部署生产站点、不关闭 Issue。敏感文件名检查只是额外防线，不是完整 secret 扫描；PR 仍需人工审核。

## 环境与验证

- 服务使用 Node 22 和 `npm ci`；better-sqlite3 是原生模块，切换 Node 大版本后必须在正确版本重新安装，不要直接复用其他 ABI 的 node_modules。
- 试点站点构建使用已安装的 `/Users/kenny/.local/bin/node`（实测 Node 26），对应 `.nvmrc`；构建脚本不会修改用户的原始项目工作区。
- Codex CLI 需支持当前用户的 config；旧版 CLI 可能在 `thread/start` 时拒绝新配置。安装 LaunchAgent 前核对 `CODEX_BIN`。
- `npm run test:all` 同时运行应用和 Worker 测试；`npm run check:all` 检查两端类型；`npm run build` 构建本机服务及网页。
- 测试不需要真实凭据。飞书测试使用临时 SQLite 和不存在的旧版 JSON 路径，禁止改为真实 `.data/feishu-state.sqlite`。

## 首次启用

1. 复制 `.env.example` 并保留原有配置；凭据文件权限设为 `0600`。不要提交 `.env`、`.data`、数据库或日志。
2. 创建独立 D1，应用 `worker/migrations/0001_tasks.sql`；在自己的 Wrangler 配置中将其绑定为 `DB`。仓库的 `worker/wrangler.jsonc` 是未绑定真实资源的模板。可使用已验证的 `wrangler@4.156.2`，不要把真实账号 secret 写入配置。
3. 部署 Worker，设置不同的 `WEBHOOK_SECRET` 和 `RUNNER_SECRET`。给试点仓库配置 HTTPS JSON `issues` Webhook；先检查 GitHub ping 及错误签名拒绝，再启用 Issue 标签。
4. 同步飞书项目群：`/sync-project /Users/kenny/Web/usmapgames.com`。确认 CI 的实际检查名、Git push、读取 Actions 和创建 PR 的权限。
5. 配置 `ISSUE_AUTO_ENABLED=true`、`ISSUE_AUTO_FULL_ACCESS_ACCEPTED=true`、队列 URL、Runner secret 文件、GitHub 认证、检查名及 CI 超时。可用 `ISSUE_AUTO_USE_GH_AUTH=true` 从当前用户 GitHub CLI 已登录凭据读取 token，不在环境文件复制 token。
6. 配置 `ISSUE_AUTO_WEBHOOK_ID` 可开启投递检查和有限重投；凭据需有仓库 Webhook 读取/重投权限。这只检查投递历史，不轮询 Issue。
7. 在无开发、验证和推送任务时重启；确认日志出现 `issue_auto_started`，不要仅凭进程存活判断功能已开启。启动配置失败时普通 Bot 可继续运行，Issue Auto 保持关闭。

## 可选验收与通知

- `ISSUE_AUTO_LAN_PREVIEW_ENABLED=true`：按 CI 对应 SHA 独立构建静态预览，默认私网地址、8800 起的独立端口、最多 5 个。知道地址的局域网设备可访问，无密码；不运行 Worker/API、不发布公网。Mac 需开机联网；防火墙和飞书客户端可能阻止 HTTP。不能保证跨 Wi-Fi、休眠或更换地址后的旧链接可用。
- 每个预览保存 SHA 元数据，响应 noindex/no-store；已知过期状态返回 503，成功通知前再查 GitHub head。PR 关闭后在后续复核回收。依赖与构建产物占磁盘，及时关闭不需要的 PR。
- `ISSUE_AUTO_DM_NOTIFY_ENABLED=true`：关键事件 Topic 留档并单聊。接收人必须在允许名单中且唯一；不会广播。单聊定位的是本条 Topic 通知的位置，不是永远动态跳到末尾。普通进度仅更新卡片。
- Topic/单聊回执分别持久化。失败保留 outbox，其他通知仍能继续；跨平台响应丢失时仍不能绝对保证恰好一次。
- 受管 Session 拒绝普通直接发送、steer 与修改性控制，避免并发。原 Topic 可通过“人工接管”或 `/takeover` 安全进入人工模式，串行处理验收意见，再用“继续自动修改”或 `/auto` 交回自动闭环；权限与恢复细节见 [人工接管说明](implement/issue-topic-handoff.md)。不能限制 Codex Desktop 或其他工具直接操作。停止按钮只针对运行中的 Codex Turn，不会中止独立验证或远端 CI。

## 故障和恢复

- `RECEIVED → PREPARING → DEVELOPING → VALIDATING → CREATING_PR → CI_CHECKING → PR_READY`；Turn 成功不等于任务或 Issue 完成。
- 首版限制 6 个 Turn、2 小时累计执行；连续无可验证进展或修复超限进入阻塞。CI 失败最多修复 3 次，指定检查缺失/跳过/取消不能作为通过。
- 已记录 Thread/Turn 通过读取状态继续对账；安装、验证、会话启动或 PR 推送结果不确定时阻塞，避免盲目重复副作用。恢复前核对真实进程、Git 分支和远端 PR；不要直接清空 SQLite 或重加标签。
- 验证在临时 worktree 中进行；仅允许已知两张生成截图变化，其余源文件修改仍使验证失败。中断后可能有残留验证进程/临时工作区，需人工核对，不会盲目重新执行。
- GitHub 不自动重投。服务约每 5 分钟（长时工作可能延迟）按 GUID 检查，至少等待 60 秒、重投间隔 5 分钟、最多 3 次；超过保留窗口或检查持续失败会告警。Mac 离线时不能从本机发通知；离线超过 3 天的事件可能无法自动恢复。
- CI job 完整日志最多 10 MiB，以 `0600` 保存在 `.data/issue-auto-logs`；字段/权限缺失、超限或下载失败阻塞。部分脱敏不能证明日志完全无敏感信息。
- 单实例保护依赖同一 Mac、同一个 SQLite；不是多机协调器。PID 被复用时可能保守拒绝启动，需人工检查。

## 停用与备份

先停止新的触发（停用仓库 Webhook），再等待当前本地工作到安全点，把 `ISSUE_AUTO_ENABLED` 设为 false 后重启。不要在运行 Turn、构建或推送时粗暴重启。不要自动删除用户工作区；仅清理由系统创建的预览 worktree。

SQLite 在 WAL 模式下备份时应使用 SQLite backup API；不要仅复制主 sqlite 文件而忽略 WAL。备份、hook 配置、测试资源标识仅保存在本机私有目录，不放进 Git。当前代码不包含自动数据库灾备、多机迁移或生产发布功能。
