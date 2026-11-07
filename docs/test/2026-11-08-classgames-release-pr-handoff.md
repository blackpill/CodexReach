---
updated_at: 2026-11-08T07:55:17+08:00
git_commit: d8ecc6f42a8f96f3e1597943568a4ba49c2d68ed
---

# ClassGames 人工发布 PR 交接（2026-11-08）

用户明确授权两个功能分支的提交、推送和创建待审核PR；不授权合并、部署、创建生产权限。

## 分支基线与范围

- 控制器仓库：`blackpill/CodexReach`，目标main为`d8ecc6f42a8f96f3e1597943568a4ba49c2d68ed`。
- 原开发基线还包含9个未进入远端main的其他本地提交。本次仅将发布控制器功能重放到最新main，原本地提交和原checkout保留，没有带入PR或删除它们。
- 只解决了本功能`.gitignore`和新增文档索引的冲突，没有改动远端main或合入其他本地功能。
- 网站仓库：`blackpill/classgames.net`，目标main仍为`13fe3976db0a865c9884a69efeeb4440b38e7b4c`。

## 当前PR基线验证

- 控制器：Bot203/203、Worker8/8、Python73/73，check:all/build通过。
- 网站：发布合同9项和原CI合同4项、浏览器91项；check/build通过。
- 暂存源文件清单检查通过；未带入.env、真实私钥/token、node_modules、本地ledger或构建产物。
- 历史集成基线389/96等测试数字不等于本次PR上的项目总数，不用它们声称本PR包含其他功能。

## 权限和上线边界

两个PR以Draft/待审核状态创建，不启用auto-merge。控制器production默认false且allowlist空，网站生产变量未配置、可信工具pin保持全零。没有创建App、token、密钥、服务或Tunnel，没有运行生产发布workflow。

PR1控制器工具须先经审核，PR2后续才能配置其固定可信工具SHA；当前不为了完成创建PR而把全零pin改成未经审核的提交。

实际PR链接和远端CI状态以本次聊天返回和GitHub为准。真实生产部署仍需单独展示发布清单并由用户再次确认。
