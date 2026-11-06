---
updated_at: 2026-11-07T07:03:44+08:00
git_commit: 4fd546f9337648a49c3edca41180cbe4b6e1b9be
---

# YouTube 评论监控验证记录

## 自动化验证（Node 22.16.0）
- 聚焦 `npm test -- src/youtube-monitor`：7 个测试文件，50 项通过。
- 全量 `npm test`：54 个测试文件，275 项通过。
- `npm run test:worker`：8 项通过。
- `npm run test:hermes`：64 项通过（测试内预期的 GSC failure 日志不代表失败）。
- `npm run check:all`、`npm run build`、`git diff --check`：通过。
- `zsh -n scripts/install-youtube-monitor.sh`、生成的 LaunchAgent `plutil -lint`：通过。

## 独立审查
发现并修复两个可复现问题：单条拒绝阻塞后续评论；100 条待发积压被迫等 30 分钟。先加入失败回归测试，再改为逐条退避和每分钟独立投递；审查者复核 22 项 service/store 测试通过。

## 真实环境
- 创建私有专用群「CodexReach｜YouTube 评论监控」，当前允许用户为群主，机器人管理。
- 3 个视频首次真实 API 请求成功，静默记录：7sVn00ECFBw 22 条、O31JLO208nQ 19 条、4jRS1RN0BjE 8 条。数字为首次一页观察条数，不宣称视频全量评论数。
- baseline_at：2026-11-07 06:29:45～06:29:47（Asia/Shanghai）。3 个目标 last_error 均为空，outbox 为 0，没有历史评论通知。
- 新群收到一条明确标注为系统配置的启动通知，通过飞书消息读取接口确认 chat_id、post 类型、未删除。
- 独立 LaunchAgent `com.local.codexreach.youtube-monitor` 为 running；Node 22；stderr 为空。未重启主 CodexReach 服务。
- 下一轮预计北京时间约 07:00（30 分钟采集周期 + 每分钟检查）。尚未等待真实用户发布新评论，新增评论路径由自动化测试覆盖；不声称已经收到一条真实新评论。

## 保留事项
Mac 休眠/离线时暂停。24 小时回看不覆盖无限延迟公开；超过 100 页不推进水位并报错；跨服务不承诺 exactly-once；飞书中已经投递的原文副本不在本地 29 天清理范围内。变更未提交 Git，保留其他并行任务未提交工作。

## 2026-11-07 调度更新

用户改为北京时间每天07:00–22:00每小时检查（包含22点，共16个整点）。新增14项测试：夜间不采集、07/22点边界、跨日/跨年、旧半小时水位对齐、跨07点批次。独立审查发现并修复窗口判断在整轮缓存导致跨07点跳过后续视频的问题。

- 聚焦：64项通过；全量：55个测试文件、289项通过。
- check:all、build通过；独立监控已重启为新版本，不重启主机器人。
- 3个目标的baseline_at和last_scan_at与升级前完全一致；next_check_at统一为2026-11-07 07:00:00（Asia/Shanghai）。
- 飞书群描述已更新；已有待发队列仍按原每分钟投递/退避规则运行。本次只改变YouTube采集计划。

## 2026-11-07 频道全部视频扩展

- 配置切换为 `YOUTUBE_CHANNEL_IDS=UC7MyOMPhtlVnm5pyeBa6-Ww,UC59k5YaRdNBHRf3pYtNXBSQ`，显式视频列表清空；视频原始基线未清除。
- 官方上传列表完整分页实测：TCool 11个，Tesla Display App 37个，去重共48个；包含先前3个视频。
- 聚焦10个测试文件84项通过；全量57个测试文件311项通过；check:all与build通过。
- 独立审查发现清单缩减后待发被遗弃，采用“移出监控范围则明确取消并日志记录”的策略修复；另补覆盖快照提交后崩溃、显式视频仍保留的回归。审查者复核13项测试通过。
- 当前配置过程仅手动查询/预填频道上传清单，不提前抓取新增视频评论；重启后数据库48个目标，已有基线3个、待建立45个，统一下一次07:00。原3个baseline_at、last_scan_at与迁移前完全一致，outbox为0。
- 独立LaunchAgent为running，stderr为空。首次bootstrap遇到旧job卸载尚未完成的错误；核实服务不存在、plist有效后重新bootstrap成功，未触碰主机器人服务。
- 公开列表不能代表私有/删除/不可访问视频；关闭评论的视频将在请求时记录安全错误，不宣称能读取其评论。未来新上传自动发现后首次仍静默基线。

## 2026-11-07 API 用量统计与70%/90%提醒

- 聚焦11个测试文件108项通过；主测试58个文件335项、Worker 8项、Hermes 64项通过。check:all/build/git diff --check通过。
- 覆盖PT午夜、夏令时23/25小时日、方法分项、错误/分页计数、数据库写失败不发出请求、计数+告警入队原子回滚、70%/90%边界/去重、重启/失败退避/跨日过期/跨午夜发送、租约失效、只读CLI、飞书不计入。
- 独立审查发现两个问题并补红测修复：首次告警await会错过22点轮次；正常stop会使已成功告警仍pending。复核38项service/quota相关测试通过。
- 本机配置项目tlplayer-android、额度分母10000。单独监控服务优雅停止后kickstart为新版，不重启主机器人。
- 真实只读channels.list验证返回2个频道、本地计数0→1（1单位），alerts为空；未消耗7000/9000额度或制造真实阈值告警。
- 统计启用北京时间2026-11-07 07:02:49，对应PT配额日2026-11-06，下一重置北京时间2026-11-07 16:00。07点首轮监控发生在功能上线前，不进行推测性回填；本日partialDay=true。
- 48个视频的baseline_at、last_scan_at、next_check_at与升级前完全一致，评论outbox为0；LaunchAgent运行中，stderr为空。计数是本监控估算，其他程序/启用前调用不可见。
