---
updated_at: 2026-11-07T17:20:50+08:00
git_commit: 885e3c2a5553b88d41d3366cdc346c238ceafe79
---

# ClassGames 人工发布离线验收

## 范围

用户选择 Native；仅实现/测试两个隔离工作区中的代码，不提交、推送、合并，不安装服务或配置真实写权限，不触发 GitHub Actions 或 Cloudflare 发布。Task8 保持等待单独授权。

## 最终验证

以下为2026-11-07原本地集成基线的验证记录；2026-11-08提交PR时已将本功能单独重放到远端main，新基线结果见[PR交接记录](2026-11-08-classgames-release-pr-handoff.md)。未把其他本地功能带入PR。

| 范围 | 结果 |
| --- | --- |
| Bot Vitest | 69 个文件、389/389 |
| Worker Vitest | 8/8 |
| Python Hermes（含 release） | 96/96；其中新增 release 30/30 |
| Bot check:all / build | 通过 |
| 网站 CI/发布 Node 合同 | 13/13（发布9+原CI合同4） |
| 网站 Astro check / build | 0 errors / 43 pages |
| 网站原有 Playwright | 91/91；隔离端口14322，不更改原4322合同 |
| 最终包本地 Worker 冒烟 | 通过；marker精确SHA/no-store、首页canonical/安全头、www301、robots、sitemap、404、关键页面、Markdown |
| git diff --check | 两仓通过 |

所有云写入在这些测试中均使用 fake。实际本地 Wrangler 使用 --local，不是 remote dev。最终包中的测试 SHA 为基线 fixture，不把未提交代码误归为该基线提交。实际生产 workflow 必须 checkout 已提交的精确 SHA。

Python 3.14 的既有 SQLite ResourceWarning 在功能前66项基线已出现，未通过删测试或屏蔽告警隐藏。

## 独立审阅与单轮修复

一次全分支独立审阅由 gpt-6-astra 完成；之后由 Native 实施者进行一次 RED→GREEN 修复，不宣称经过第二轮独立复审。

1. 审批与 dispatch 意图合为一个 SQLite 事务；重开数据库验证不会留下无法恢复的审批窗口。旧的未尝试 APPROVED 允许取消，未知请求不自动重发。
2. Custom Domains 的hostname/Worker/environment/zone/enabled加入严格验证与基线摘要；移除、禁用、迁移均拒绝。
3. 失败、结果未知和对账异常进入持久通知 outbox；有限次、短窗口、同UUID重试，不进入部署路径。通知去重的供应商实际语义仍须真实联调，不承诺外部消息严格 exactly-once。
4. 对当前精确 version 使用已 HEALTHY 的SHA映射；已知基线保存完整且有界的提交/关联PR列表。超限/不完整比较拒绝，不截断后声称完整。
5. 每次 workflow 对最终部署包运行本地 Worker 冒烟，检查后同一包上传。Wrangler dev 会写本地缓存且把域名归一到第一个route，因此本地测试对字节相同的临时副本运行，仅移除副本的部署routes以真实验证Host/canonical；源包和生产配置校验前后不变。
6. HTTP claim 设置读取超时、有界并发，慢body不会阻塞另一个合法claim；公开接口在加载App权限前预验证OIDC。

以上回归测试先对未修复实现运行并失败，再修复通过；完整两仓验证随后通过。

## 原遗留 Minor：本轮已完成离线修复

**授权票据日志脱敏**：两个 job 均从 `GITHUB_EVENT_PATH` 读取、限制长度及字符集，并在任何票据使用前注册 `::add-mask::`。票据不再出现在 workflow 表达式、step env 或 shell source 中；可信发布工具也直接读取事件文件，不经环境变量传递。两个 job 分别注册掩码，不能依赖跨 job 掩码传播。恶意换行/命令注入、错误类型、超长和不支持 operation 均拒绝，错误信息不包含原票据。

已对实际 workflow bootstrap 脚本做离线执行测试；没有触发真实 GitHub Actions，真实 runner 日志仍属于后续预发布验收。掩码不是加密，`workflow_dispatch` 输入/原始事件仍可能被有权访问该运行的 GitHub 用户读取；签名票据受时限和单次 run 绑定，不包含私钥。不得将日志脱敏描述为事件输入保密。

官方依据：[GitHub 日志掩码命令](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)。

## 生产仍被阻止

- 控制器默认 production=false、allowlist空；Actions默认缺少enabled变量。
- 可信工具提交仍为全零占位，必须审核提交后固定真实SHA，不能使用main/latest代替。
- 未创建/安装App、部署token、签名密钥、Tunnel、service或Secrets。
- 实际Cloudflare域名读取权限、vendor API兼容性和Wrangler内部重试语义尚未云端验收。
- 真人确认/转发消息字段形态需要无副作用真实预检，fake测试不是全客户端证明。
- 旧生产version缺GitSHA，自动回滚不会伪造映射；首次生产前仍须恢复预案/映射和用户单独确认。

代码保留在两个隔离分支；后续提交/推送/PR/合并/基础设施操作都不是本次离线验收的隐含授权。
