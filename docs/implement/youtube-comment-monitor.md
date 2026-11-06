---
updated_at: 2026-11-07T07:03:44+08:00
git_commit: 4fd546f9337648a49c3edca41180cbe4b6e1b9be
---

# YouTube 视频与频道评论监控运维

## 配置与启动

监控指定视频或频道全部可访问上传视频的公开顶层评论，不抓回复，不执行评论中的指令，不做 AI 分析。

```dotenv
YOUTUBE_MONITOR_ENABLED=true
YOUTUBE_API_KEY=仅保存在本机的Key
YOUTUBE_VIDEO_IDS=7sVn00ECFBw,O31JLO208nQ,4jRS1RN0BjE
YOUTUBE_CHANNEL_IDS=UC7MyOMPhtlVnm5pyeBa6-Ww,UC59k5YaRdNBHRf3pYtNXBSQ
YOUTUBE_FEISHU_CHAT_ID=oc_你的专用群
```

继续使用已有 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 `CODEXREACH_STATE_DB`。机器人需要已加入目标群并具有发送消息权限。视频支持 ID、watch、youtu.be、shorts、embed、live 链接，显式视频最多 50 个。频道与显式视频至少配置一项，频道最多 20 个；频道发现的视频不受显式视频的 50 个限制。未显式开启时完全不启动；配置错误不回退到其他群。

安装依赖时使用的 Node 版本必须与运行版本一致。当前机器的 better-sqlite3 为 Node 22 ABI，不要用默认 Node 26 直接运行，也不要为了本功能重装共享依赖。

先测试、构建：

```sh
export PATH=/Users/kenny/.nvm/versions/node/v22.16.0/bin:$PATH
npm test -- src/youtube-monitor
npm run check:all
npm run build
```

两种启动方式，优先只选择一种：

1. 主服务：`npm start` 会接入监控的启动与 onClose。升级需重启主机器人，可能影响正在运行的任务。
2. 独立进程（本次采用，不重启主机器人）：

```sh
node dist/src/youtube-monitor/run.js
# macOS 登录后常驻、自故障恢复；只安装/重启 YouTube 专用服务
NODE_BIN=/Users/kenny/.nvm/versions/node/v22.16.0/bin/node scripts/install-youtube-monitor.sh
launchctl print gui/$(id -u)/com.local.codexreach.youtube-monitor
```

独立 LaunchAgent：`~/Library/LaunchAgents/com.local.codexreach.youtube-monitor.plist`，无嵌入密钥。修改 `.env` 后须重启对应监控进程才能生效。主服务和独立进程意外同时开启时，共享数据库租约及持久化到期时间避免重复扫描/发送，但不建议长期重复部署。

## 基线和时间语义

- 每个 `(video_id, chat_id)` 的首次**成功请求**只保存初始时间界线和最新一页已见 ID，不发历史。无需全量下载旧评论；首次失败不假装完成。
- 基线后、发布时间严格晚于基线时间且未见过的顶层评论才进入待发送队列。第一页返回的评论即使时间在请求开始之后，也属于该次静默基线。
- 每 60 秒检查到期状态；以 Asia/Shanghai 时区每天 07:00、08:00……22:00 的 16 个整点为采集时刻，调度误差通常不超过约 60 秒（另加网络耗时）。停止/睡眠/离线期间不能保证准时；白天恢复后读取持久化水位补查，夜间等待次日 07:00。22:00 最后一轮允许 60 秒的调度宽限，已开始的轮次可继续完成当时已到期的全部目标；新轮次仍受时段约束。升级会将旧半小时 next_check_at 上取整到合法整点，不重置基线或水位。
- `order=time` 分页，扫描到上次完整扫描开始时间之前 24 小时；首轮不早于基线。重叠窗口覆盖边界、分页变动和短期延迟可见。超过窗口才公开的旧评论不保证发现。
- 每视频每次最多 100 页（每页最多 100 线程）。分页失败、循环 token 或超限不推进水位，不发送本轮的部分结果。超限日志 `youtube_page_limit` 需要缩小监控范围或调整实现，不要手动推进水位掩盖漏采。
- 评论编辑/点赞变化/楼中楼不算新评论。更换群或加入新视频各自建立新的静默基线。移除再加入同一视频/群保留原基线，补查离线期间新增。

## 发送与隐私

- SQLite 同一事务保存去重记录与 outbox。每目标每分钟最多尝试 100 条；与白天整点采集周期独立。
- 已采集待发消息的每分钟投递和失败重试保持不变，不受本次采集时段限制；夜间不发起新的 YouTube 评论查询。
- 成功后删除本地 outbox 原文；失败逐条持久化，指数退避 30 分钟、1 小时……最多 24 小时，优先发送新记录，单条拒绝不阻塞其他评论。
- 所有重试使用同一 48 字符 `uuid`。本地正常重启不重复；“飞书已接收但本地未落库”的崩溃窗口依赖飞书服务端 UUID 去重有效期，**不是跨系统 exactly-once 保证**。
- 原文和作者通过飞书 post 的纯 text 标签展示，不解析评论中的 @、HTML 或 Markdown；原文最多显示 3000 Unicode 字符，并附可信 YouTube 原评论链接。
- 本地待发原文最多保留 29 天，过期删除且记录 `youtube_pending_expired`；已见 ID 保存为不可逆摘要，旧摘要在安全水位之后清理。SQLite 文件/备份仍需按敏感数据限制访问。
- 飞书中已发送的评论是外部副本，不由本实现定期更新/删除；项目方须按 YouTube 数据政策和自身保留要求管理该副本。不要把此功能当永久历史评论归档。
- 日志不含 API Key、飞书 token、完整 HTTP 响应或评论原文。

## 状态与故障定位

表：`youtube_watches`（baseline_at / last_scan_at / next_check_at / last_error）；`youtube_seen`（去重摘要）；`youtube_outbox`（待发内容/下次重试）；`youtube_monitor_lease`（90 秒可续租互斥）。不要删除已有 CodexReach 表。

运行日志：`.data/youtube-monitor.log`、`.data/youtube-monitor.error.log`；事件记录：`.data/logs/bridge-YYYY-MM-DD.jsonl`。

关键事件：`youtube_baseline_created`、`youtube_scan_completed`、`youtube_comment_delivered`、`youtube_scan_failed`、`youtube_delivery_failed`、`youtube_pending_expired`。`last_error` 是最近错误，下一次成功采集可清除；不应仅据此推断服务已停止。

常见错误：`youtube_commentsDisabled`（关闭评论）、`youtube_videoNotFound`（删除/不可访问）、`youtube_quotaExceeded`（配额）、`youtube_network_error`、`feishu_api_<数字>`、`youtube_page_limit`。单视频错误不阻塞其他视频；配置/权限错误需修复后等待重试或重启。

停用独立服务：

```sh
launchctl bootout gui/$(id -u)/com.local.codexreach.youtube-monitor
# 同时将 .env 中 YOUTUBE_MONITOR_ENABLED=false，防止主服务重启后接管。
```

不删除状态数据库，下一次启动才不会丢失去重和待发送进度。更改配置/删除表不会自动撤回已发飞书消息。

## 参考

- [YouTube commentThreads.list](https://developers.google.com/youtube/data/reference/rest/v3/commentThreads/list)
- [YouTube 数据存储政策](https://developers.google.com/youtube/terms/developer-policies)
- [飞书发送消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/create)

## 频道发现与范围变化

通过 `channels.list(part=contentDetails)` 返回的 uploads 播放列表，再用 `playlistItems.list(part=contentDetails,maxResults=50)` 逐页发现，**不调用 search.list**，不因最新一页出现旧视频就停止。每频道最多 100 页；超过保护上限或 token 循环会报错，不把部分清单当全部。

- 每个允许的整点轮次刷新频道清单；新上传、Shorts、直播回放等只要出现在 API 可见上传列表中就自动纳入。无法凭 API Key 枚举私有或其他不公开内容。
- 每个新发现的视频首次成功获取评论仍只建静默基线，不推送发现之前的历史评论；旧 video/chat 的基线、水位和去重不变。频道与显式视频重叠时只监控一次。
- `youtube_channels` 保存每频道刷新时间、下次到期、错误；`youtube_channel_videos` 保存完整清单。成功后事务替换；失败保留旧清单并在下一允许整点重试，不影响其他频道及已缓存视频。
- 当前配置未包含的频道不参与目标合并；显式视频配置仍优先保留。因此移除一个频道不会自动停掉同样显式指定的视频。
- 只有所有配置频道均有完整成功清单时，才清理当前群中不再属于监控范围的待发消息，事件 `youtube_pending_cancelled`（reason=`video_outside_monitored_scope`）。这样视频删除/隐藏或范围移除不会遗留永不重试的 outbox，也不继续推送已移出范围的旧原文；已发飞书消息不会自动撤回。
- 夜间只使用持久化清单，不做自动发现请求。新增频道将在次日07点刷新；配置过程可以进行显式手动列表核验并预填清单，但不会提前抓评论。
- 同一接收群由同一份目标配置管理；不要让不同目标配置的多个实例同时向同群运行（数据库租约避免并发，但无法协调冲突配置）。

## API 调用统计与额度提醒

```dotenv
YOUTUBE_QUOTA_PROJECT_ID=tlplayer-android
YOUTUBE_DAILY_QUOTA=10000
```

- 项目 ID 是计数分组标识，不是新授权；同一项目更换 Key 时保持它不变。留空仅使用 `default` 单项目桶，不自动推断 Key 所属项目。
- 对本监控发起的 `channels.list`、`playlistItems.list`、`commentThreads.list` 请求尝试计数，当前每次 1 单位；分页、HTTP 错误、网络失败均计入，飞书请求及本地 tick 不计。由于调用前先持久化，网络未到达服务端或进程在发送前崩溃会保守多计。
- 默认分母10,000可调整，70% / 90%固定阈值。提醒**不是 Google Cloud 项目的实时实际用量**，不包含其他程序，也不回填功能启用前调用；首次启用当天属于部分统计。以控制台实际额度为准。
- 配额日使用 `America/Los_Angeles`，午夜切换，处理夏令时；北京时间通常冬季16:00、夏季15:00。监控采集时区仍为 `Asia/Shanghai` 07:00–22:00，二者独立。
- `youtube_quota_tracking` 保存统计启用时间；`youtube_api_usage` 按project/day/method累计请求数/估算单位；`youtube_quota_alerts`保存阈值快照、通知状态、重试次数与时间。
- 计数+阈值入队同一 SQLite 事务，project/day/chat/threshold唯一。每个配额日每档各提醒一次，超过100%不会新增第三档，也不会自动停机。
- 提醒在每轮开始、每频道发现结束、每视频采集结束发送，最迟可能等待当前视频/频道扫描结束；非采集时段也继续每分钟处理告警重试。失败从1分钟起指数退避、最多1小时，不因70%失败阻塞90%。当日未发完的告警跨配额日标为expired，避免旧警报在新一天误导。
- 使用固定UUID减少不确定响应重复；已成功发送后正常停止会等待确认落库。租约丢失或崩溃的极端窗口仍不能保证跨系统exactly-once。
- 告警包含触发时用量/额度/比例、PT配额日、北京时间触发与重置时间、启用时间及范围说明。不会包含Key、token、评论原文。

只读查看统计（不请求Google、不发送飞书、不增加计数）：

```sh
/Users/kenny/.nvm/versions/node/v22.16.0/bin/node --env-file=.env dist/src/youtube-monitor/quota-status.js
```

该命令需先完成构建及启动监控，使统计表已存在。输出units、requests、byMethod、percentage、resetAtBeijing、partialDay及告警状态。事件包括 `youtube_quota_alert_sent` / `youtube_quota_alert_failed` / `youtube_quota_alert_expired`；告警发送失败不会重置评论基线或阻断采集。
