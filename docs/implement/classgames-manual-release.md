---
updated_at: 2026-11-07T17:20:50+08:00
git_commit: 885e3c2a5553b88d41d3366cdc346c238ceafe79
---

# ClassGames 人工发布：离线实现说明

状态：Native 离线实现及独立审阅重要问题的单轮修复完成；未启用生产。实现位于两个隔离工作区；用户已于2026-11-08授权提交/推送及创建待审核PR，不授权合并、云端安装、权限创建或部署。

## 工作区

- 控制器：`/Users/kenny/.codex/worktrees/classgames-release-control/Feishu AI Codex Bot`，分支 `codex/classgames-release-control`。
- 网站：`/Users/kenny/.codex/worktrees/classgames-manual-release/classgames.net`，分支 `codex/classgames-manual-release`，基于 main `13fe3976db0a865c9884a69efeeb4440b38e7b4c`。
- 原两个 checkout 的未提交改动均保留。`git fetch` 仅更新本地远端跟踪引用。

## 已有实现

`integrations/hermes/release/`：固定配置、SQLite 事务/单次 claim、真实消息校验、只读清单、GitHub App 短时令牌、EdDSA 签名、GitHub OIDC、claim-only HTTP 接口、独立 Unix CLI、对账和通知；只提供默认禁用的 service/Skill 模板。

网站新增可校验部署包、生产固定配置、no-store SHA 标记、严格限定 staging host 和 JSON 形式的合法 YAML workflow。现有 Issue Auto CI 保持原样。部署工具独立放在控制器仓库，不执行网站产物中的安装/构建脚本。

## 默认拒绝边界

- 控制器 `production_enabled=false`、人工 allowlist 空。
- Actions 生产变量必须精确为 true；缺失时跳过生产 job。
- 可信工具提交固定为全零占位，生产 job 即使误开开关也会停止。后续必须在独立审阅、提交并取得配置授权后写入真实固定提交，不能直接改用 main/latest。
- 没有新建 GitHub App、token、签名密钥、Tunnel、服务、GitHub Secrets/Environment 或发布者注册。
- 自动回滚只接受控制器记录中已 HEALTHY 的精确 version/SHA，且独立确认。当前旧生产版本缺少 Git SHA，不能凭空导入为已知版本；首次生产前须另行落实旧版本恢复预案或可信映射。

## 测试运行

在控制器工作区创建独立 venv，安装 `integrations/hermes/release/requirements.lock` 的带哈希依赖。不要将 root Hermes 的 .env 或生产凭据复制入开发工作区。

```bash
python3 -m venv .superpowers/release-venv
.superpowers/release-venv/bin/pip install --require-hashes -r integrations/hermes/release/requirements.lock
.superpowers/release-venv/bin/python -m unittest discover -s integrations/hermes -p 'test_*.py'
```

完整 Node 回归使用 Node 22，并将该 venv/bin 放入 PATH，让既有 `npm run test:all` 能加载独立密码依赖。CI 已增加带哈希 Python 依赖安装。

网站现有 verify 的各组件已执行：CI 合同、Astro check、build、现有 91 项 E2E；E2E 使用隔离配置和端口 14322，不修改原4322合同。CI/发布 Node 合同合计13/13通过（发布9+原CI合同4）。无生产凭据的 Wrangler dry-run 打包后，用本地 Worker 14323 验证 `/__release.json` 为200、精确SHA和 no-store；未使用 remote dev 或真实 Cloudflare deploy。该本地产物的 SHA 是测试 fixture（基线 SHA），不声称未提交代码已属于基线提交；实际 workflow 必须从已提交精确 SHA checkout 后构建。

## 后续配置所需（尚未授权执行）

- 云控制器专用用户、只读代码目录、私有状态目录、应用/签名凭据和 HTTPS claim 通路。
- GitHub App 只安装 classgames，请求 Actions write 和 Contents/Checks/PR read，短时 installation token 每次服务请求获取，不复用宽权限 gh 登录。
- 可信工具仓库若仍为 private，另设仅允许读取 CodexReach 的 `CLASSGAMES_TOOLS_READ_TOKEN`；不能给网站发布 App 扩大到控制器 workflow 写权限。
- 网站生产 secret `CLASSGAMES_CLOUDFLARE_DEPLOY_TOKEN`；变量 `CLASSGAMES_RELEASE_PUBLIC_KEY`、`CLASSGAMES_RELEASE_CLAIM_URL`、`CLASSGAMES_PRODUCTION_RELEASE_ENABLED`。
- 真实用户 open_id/tenant 注册、无副作用确认预检、GitHub 私有分支/环境能力、首次回滚方案和单一生产写入口约定。

所有基础设施和真实预发布/生产发布均需另行批准。离线测试通过不代表部署或飞书真人端到端验收完成。

## 基线警告

Python 3.14 的既有 Hermes 测试存在 SQLite ResourceWarning；已在本功能前的66项基线日志中复现。测试均通过，本功能没有修改这些既有测试来隐藏警告。

## 审阅结论

6项 Important 已补充回归并修复；原1项 Minor（票据日志脱敏）已通过事件文件读取和每job首步掩码完成离线修复；输入/原始事件对授权GitHub读者的可见性不变。不宣称已完成真实Actions日志、飞书/Cloudflare端到端验收。详见[离线验收](../test/2026-11-07-classgames-manual-release-offline.md)。

## PR 准备

已整理[双仓库 PR 草稿和启用门槛](classgames-manual-release-pr-drafts.md)，已于2026-11-08取得提交/推送及创建待审核PR的授权；真实发布仍须另行确认。网站新增独立 Release Contracts CI，使用只读权限在 PR/main push 运行发布合同测试；生产发布仍仅 workflow_dispatch。
