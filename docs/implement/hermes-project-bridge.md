---
updated_at: 2026-11-06T10:46:44+08:00
git_commit: 8d0c0a1a87f80f18294dc01f720775bc01b5b7ce
---

# Linux Hermes ↔ GitHub Issue ↔ 飞书台账

这是专用用户的运营桥，Python 3.10+ 标准库 + 已登录的 GitHub CLI。它不加载Mac Codex凭据，不提供Auto/merge/deploy命令，不直接控制Codex Thread。

## 当前部署边界

- 云 Linux `/srv/hermes/integrations/`：project_bridge.py、provision_base.py、receive_execution.py、bridge_sync_loop.py。
- `.env` 仍只在云 `/root/.hermes/.env`，不拷入仓库；沿用云端已有gh登录，不能把该登录的宽权限说成“草稿专用token”。本桥只允许白名单owner/repo和稳定ID，无Auto标签写操作；root/terminal仍可绕过软约束。
- `/srv/hermes/integrations/projects.json` 为运维控制的项目映射：`{"projects":{"usmapgames":{"repository_id":1444221313,"repository":"blackpill/usmapgames.com"},"classgames":{"repository_id":1223017142,"repository":"blackpill/classgames.net"}}}`。
- `provision_base.py` 成功后原子写 `base-manifest.json`，包括base_token/base_url和三张表ID。原有月度进展Base完全不变。
- 云 `hermes-project-sync.service` 每60秒只refresh/sync已登记需求，不创建新Issue，不修改标签。Mac `com.local.hermes-project-sync` 每60秒只读既有SQLite后主动SSH出站发送快照；不暴露Mac入站端口。
- GitHub开发入口仍为原Worker/D1 → Mac Supervisor；不能用这套状态快照替代队列ACK或启动第二个执行器。

## 调用

JSON草稿需request_id、title、body、acceptance，project_id如提供必须匹配。稳定request_id不可因聊天重试换新；同ID内容变更要求新版本人工确认。

```bash
python3 /srv/hermes/integrations/project_bridge.py --project usmapgames create --file /srv/hermes/projects/usmapgames/drafts/request.json
python3 /srv/hermes/integrations/project_bridge.py --project usmapgames list
python3 /srv/hermes/integrations/project_bridge.py --project usmapgames refresh
python3 /srv/hermes/integrations/project_bridge.py --project usmapgames sync
python3 /srv/hermes/integrations/project_bridge.py --project usmapgames base-read --table requests
```

另一项目使用classgames。base-read只输出指定项目，表名只允许projects/requests/metrics。不要把项目ID当独立OS/服务身份的硬授权：本试点仍为同一root用户，严格多租户必须另做账户/凭据/容器隔离。

## 安全与恢复

- SQLite先持久保留Issue创建意图；未知POST结果标uncertain，不能重复POST。手工用仓库内 `hermes_request:<project>:<request_id>` 标记对账，核对具体规格指纹和Issue身份后再修复本地记录。当前没有一键强制重跑入口。
- Base写入有单机进程锁和持久pending意图；响应丢失只查询对账，短时不可见不能新建重复行。Base行并没有数据库级跨系统唯一约束，禁止其他副本并发写同一台账。
- Mac快照按稳定repo、Issue和task ID核验，BEGIN IMMEDIATE包住版本检查与写入；旧版本不回退，同版本不同数据拒绝。只接受已登记项目。
- last_seen仅表示刚读取过SQLite，不证明Supervisor在线或GitHub最新SHA仍通过CI。Base显示“本地执行记录（需复核）”，人工审核前以GitHub和CodexReach正式通知为准。
- 标签存在不等于审批身份已验证；桥不会据标签自动作开发决定。PR_READY、合并、上线与收益验证严格区分；关闭Issue不继续投影为待执行。
- 凭据/SQLite/manifest/日志权限0700目录、0600文件；不要下载包含凭据的完整Hermes备份。日志须定期清理。
- Base权限需要应用身份bitable:app及space:document:retrieve（按发布审核流程）；用户身份权限不能挪用。创建的Base另外给用户授予编辑权限，不能把链接公开分享当授权。
- 指标表仅建结构，未授权GSC/Analytics/ASC等数据源前保持空，不填假0或假增长。

## 测试与发布

`npm run test:hermes` 只用临时SQLite/fake API，不读真实.env或请求远端。源代码中固定路径/两个项目是本轮专用配置，不是通用多租户服务。运行测试不等于云端scope、资源ACL或macOS钥匙串已验收。

本PR的多仓库Runner仍待人工审核合并和维护窗口接入。classgames必须先合并并验收独立CI PR、配置可信测试命令与精确remote、绑定项目群，再打开两端allowlist；目前保持disabled。不自动合并、部署或关闭Issue。
