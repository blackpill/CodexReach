---
updated_at: 2026-11-07T07:03:44+08:00
git_commit: 4fd546f9337648a49c3edca41180cbe4b6e1b9be
---

# YouTube Comment Monitor Implementation Plan

> Execution: native, test-first; preserve unrelated dirty files; no commit, deployment or service restart in this task without explicit request.

**Goal:** 北京时间 07:00–22:00 每小时检查指定视频，仅推送基线之后新增顶层评论至指定飞书群。
**Architecture:** 独立 config/client/store/service/notifier/boot 模块；server 仅接入启动/关闭。SQLite 原子 outbox +稳定 UUID，原文按 text 显示。
**Tech Stack:** TypeScript、Node fetch、better-sqlite3、现有飞书应用凭据，无新增依赖。
**Spec:** [设计](../spec/youtube-comment-monitor.md)

## Global Constraints
Asia/Shanghai 07:00–22:00 每小时整点采集；首次静默；默认关闭；不触发 Codex；不改其他未提交代码；不推断接收群。

## Review Focus
- 首次失败、分页失败、空页、时间相同不应漏报/误发历史。
- 发送成功但落库前崩溃只能做到至少一次，固定 UUID 要稳定。
- 重启和多进程必须复用基线并避免重复发送。
- 外部评论内容不能被当成飞书标签或执行指令。
- 配置/网络错误不得泄漏环境密钥。

## Tasks
- [x] 1. config/client：先测试 URL 规范化、禁用/缺配置、API 参数/分页/错误，再实现并跑测试。
- [x] 2. store/service：先测试真实 SQLite 首次静默、30 分钟、重启、跨页、失败恢复、并发/停止/租约，再实现。
- [x] 3. notifier/boot：先测试 post 原文、固定 uuid、业务错误、启动关闭，再实现；server 添加小范围接线。
- [x] 4. 更新 .env.example、README 和运维文档；运行 npm test、npm run check:all、npm run test:worker、npm run test:hermes、npm run build；独立审查并修复。

## Execution notes
- 用户已选定方案并明确要求继续实现；不再次选择采集方案。
- 当前工作分支已有其他任务未提交改动，原地仅新增独立模块与修改干净入口文件，避免切换分支/移动其他任务工作。
- 未收到目标视频和 chat_id 前，不启用实际监控或发测试消息。

- 追加：用户指定 3 个视频并要求新建群；独立 LaunchAgent 部署避免重启主机器人。
- 审查修复：outbox 每分钟独立投递；单条拒绝指数退避，其他消息继续。
- 验证与部署结果见 [验证记录](../test/youtube-comment-monitor.md)。

- 2026-11-07 调度变更：旧到期时间安全对齐合法整点，保留基线/水位；07点前和22:01以后不发起YouTube采集；最后22点轮次允许60秒调度宽限。新增14项边界/迁移测试。

## 频道扩展执行清单
- [x] 配置允许 channel-only 或与显式视频混合，严格校验/去重。
- [x] 官方频道上传列表客户端，分页/空列表/异常/配额/续租测试。
- [x] SQLite原子频道清单+调度；发现失败保留缓存；每轮动态目标合并；复用原基线。
- [x] 真实频道全量核验、更新配置、独立审查、完整测试与构建，重启独立监控，验证首次基线及原状态不变。

- 频道扩展验证：84项聚焦、311项全量测试通过，check:all/build通过；独立审查后的待发取消策略已回归。真实分页核验11+37=48个视频，原3基线保留，新增45个等待07:00初始化。

## API 额度统计执行清单
- [x] PT配额日/DST重置、持久化分接口计数与阈值事务队列（TDD）。
- [x] 统一YouTube fetch计量边界、提醒发送重试/去重/过期、飞书提醒格式（TDD）。
- [x] boot/service接线及只读统计命令，默认10,000/日、70%与90%，本机项目配置。
- [x] 独立审查、全量验证、部署并核验旧基线/定时规则不变，不制造真实额度告警。

- 额度统计验证：108项聚焦测试、335项全量测试、8项Worker测试、64项Hermes测试通过；check:all/build通过。审查的22点告警延迟与正常停止确认问题均红测复现后修复。真实channels.list验证计数0→1，无伪造告警，48个目标基线/水位/下次时间完全不变。
