---
updated_at: 2026-11-08T19:57:58+08:00
git_commit: 9b418eea30abab12c661389cecac9d73e70cc6cf
---

# 两站人工发布离线验证与 PR 边界

## 范围

新 site_release 模块与两站网站适配；既有 classgames release 源码、workflow pin、云服务、密钥、DB、开关、Tunnel/DNS 未变。本轮无任何生产资源/权限创建、安装、入口开启或派发部署；没有真实 R2 对象写入。网站工具pin为空且发布guard拒绝，两个网站PR必须等待内核已审mergeSHA。

## 已实测

- 控制器 Node22：210 server + 8 Worker + 113 Hermes（含33新增）通过，check:all/build通过。旧代码 Python3.14有SQLite ResourceWarning，未隐藏或归因于新模块。
- 新增目标注册、跨站原始消息/签名/key/OIDC/包校验、SQLite跨重启一次性预约、claim拒绝/结果未知无重试、慢请求并发、实际HTTP wire UA/auth/body、两站sitemap/headers/marker/部分PDF业务检查。
- Fresh全分支审查发现主干push证据与rollback结果绑定2项重要问题，最小回归先复现失败；修复为两项workflow均成功main push、完整结果schema、独立小型manifest artifact验摘要、确定性rollback action digest、严格目标version绑定。有效回滚正例与错version/缺digest负例通过。健康覆盖补安全/no-store/尾斜杠/PDF。
- USMap沿用仓库.nvmrc Node26.8.1；与原计划Node22假设不同但不降级/弱化原检查。22.16不支持现Astro，22.23.4既有PNG渲染等值检查失败；正确26.8.1通过该检查。首次并行本地build干扰时221/222浏览器测试；随后串行完整verify222/222通过。生产release必须DEPLOY_ENV=production；真实最终包smoke发现预览默认robots禁索引后，新增生产env回归并修复，不放宽robots断言。生产模式完整verify/最终包正在复核，最终结果见PR。
- Colorear npm test11项、release7项通过；真实最终包Worker + 临时本地R2命中和fallback均通过，源包未变；同一shared Python验包与trusted --no-bundle --strict --dry-run退出0。后续工作流metadata变更的最终featureSHA包会再次核验。

## 尚未验收/启用前门禁

无真实GitHub OIDC正向claim、Cloudflare写入/回滚或新站Feishu身份验证；local fixtures/negative tests/dry-run不代表生产发布验收。App/Token/Secrets/Environment/main保护/DNS/Tunnel/服务/群权限均待另行授权。首次线上GitSHA未知时必须警告并审批整个版本，拒绝无可信mapping自动回滚；R2数据不随Worker版本恢复。

Socket模板按现有root Native operator连接service-owned0600 socket；若部署为非root，必须单独批准受限bridge/ACL，不能授予私钥读取组权限或全局sudo。本轮只提供模板不安装。
