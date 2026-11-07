---
updated_at: 2026-11-08T07:52:40+08:00
git_commit: 885e3c2a5553b88d41d3366cdc346c238ceafe79
---

# ClassGames 双仓库 PR 草稿与上线门槛

状态：用户已于2026-11-08授权两仓提交、推送和创建待审核PR；本文件保留PR正文草稿。真实配置、合并和生产部署均未授权。

## PR 1：CodexReach 控制器

- 分支：`codex/classgames-release-control`
- 工作区：`/Users/kenny/.codex/worktrees/classgames-release-control/Feishu AI Codex Bot`
- 建议标题：`feat: add disabled ClassGames manual release controller`

### 正文草稿

新增独立人工发布控制器：固定项目/群白名单、真实飞书消息校验、不可变发布清单、SQLite 单次执行意图和通知 outbox、App 短时令牌、EdDSA/OIDC、受限 Unix CLI、HTTP claim 和已验证版本回滚。生产开关默认 false、授权用户默认空，只交付未安装的 service/Skill 模板。

可信发布工具不运行网站依赖/构建脚本；票据从事件文件读取，不经步骤环境变量展开。未知结果先对账，最多一次受控部署尝试，不承诺供应商 API 严格 exactly-once。

验证：Bot389、Worker8、Python96项通过；check:all/build通过。既有Python3.14 SQLite ResourceWarning已记录，没有通过屏蔽或删除测试隐藏。

此PR不安装服务、不创建App/密钥、不启用生产、不重启Mac或Hermes。

## PR 2：ClassGames 网站

- 分支：`codex/classgames-manual-release`
- 工作区：`/Users/kenny/.codex/worktrees/classgames-manual-release/classgames.net`
- 建议标题：`feat: add manually approved Cloudflare release workflow`

### 正文草稿

新增仅支持 workflow_dispatch 的生产发布入口，验证/构建与可信工具部署分离。最终 Worker+assets 包在无生产凭据的本地 Worker 上验证后上传；包含精确SHA标记、完整性清单和固定生产配置。

每个job首步从事件文件读票据并注册掩码，拒绝恶意输入；签名与一次性授权仍由可信工具/控制器验证，解码operation不构成授权。新增只读 Release Contracts CI 自动覆盖PR/main push；原Issue Auto CI与verify合同不变。

验证：13项CI/发布Node合同、91项浏览器测试通过；Astro check 0错误，build43页；最终包本地冒烟通过。

此PR保持生产变量未配置、可信工具提交为全零。即使误开生产变量，也会在工具提交检查处停止。没有Cloudflare真实发布。

## 提交前检查

- [x] 用户明确授权两仓 git commit、推送和创建待审核PR；不会因此合并或部署。
- [ ] 只暂存两个隔离工作区中属于本功能的文件，不带`.superpowers`、node_modules、构建产物、.env或真实凭据。
- [ ] 再确认远端main是否变化，必要时在隔离分支解决冲突并重新回归；不修改用户原checkout。
- [ ] 审阅PR1可信工具后，将实际固定提交SHA提供给PR2；不把main/latest作为替代。

## 真实配置前需单独确认

- GitHub App/安装范围、只读工具仓库token、Cloudflare最小写token及只读域名查询能力。
- 云端专用账户、私钥、状态目录、service及HTTPS/Tunnel/OIDC接线。
- 飞书发布者open_id/tenant注册与无部署确认预检；不得沿用全局开放聊天权限。
- 私有仓库保护能力、真实Actions票据掩码验收、Cloudflare API兼容性/重试行为。
- legacy旧生产version缺GitSHA的恢复预案或可信映射。

## 真实生产发布前必须再次确认

展示新鲜main SHA、全部已知提交/PR差异、当前线上version/deployment、目标域名、风险和回滚候选；用户明确确认该发布编号后才可执行。合并PR或开启功能不等于批准某次生产部署。
