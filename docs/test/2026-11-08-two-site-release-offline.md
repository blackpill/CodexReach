---
updated_at: 2026-11-08T20:08:44+08:00
git_commit: 86d06c9e1eabd5e7fddc5e35eaf8b7d31a8e6b27
---

# 两站人工发布离线验证与 PR 边界

## 范围

新 site_release 模块与两站网站适配；既有 classgames release 源码、workflow pin、云服务、密钥、DB、开关、Tunnel/DNS 未变。本轮无任何生产资源/权限创建、安装、入口开启或派发部署；没有真实 R2 对象写入。网站工具pin为空且发布guard拒绝，两个网站PR必须等待内核已审mergeSHA。

## 已实测

- 控制器 Node22：210 server + 8 Worker + 114 Hermes（含34新增）通过，check:all/build通过。旧代码 Python3.14有SQLite ResourceWarning，未隐藏或归因于新模块。
- 新增目标注册、跨站原始消息/签名/key/OIDC/包校验、SQLite跨重启一次性预约、claim拒绝/结果未知无重试、慢请求并发、实际HTTP wire UA/auth/body、两站sitemap/headers/marker/部分PDF业务检查。
- Fresh全分支审查发现主干push证据与rollback结果绑定2项重要问题，最小回归先复现失败；修复为两项workflow均成功main push、完整结果schema、独立小型manifest artifact验摘要、确定性rollback action digest、严格目标version绑定。有效回滚正例与错version/缺digest负例通过。健康覆盖补安全/no-store/尾斜杠/PDF。
- USMap沿用仓库.nvmrc Node26.8.1；与原计划Node22假设不同但不降级/弱化原检查。22.16不支持现Astro，22.23.4既有PNG渲染等值检查失败；正确26.8.1通过该检查。首次并行本地build干扰时221/222浏览器测试；随后串行完整verify222/222通过。生产release必须DEPLOY_ENV=production；真实最终包smoke发现预览默认robots禁索引后，新增生产env回归并修复，不放宽robots断言。生产模式原verify暴露原测试明确要求preview noindex；新workflow保留 DEPLOY_ENV=preview 的全套verify，再以production重建、SEO/预算检查及真实最终包烟测，绝不删减原测试。最终生产包已通过。
- Colorear npm test11项、release7项通过；真实最终包Worker + 临时本地R2命中和fallback均通过，源包未变；同一shared Python验包与trusted --no-bundle --strict --dry-run退出0。最终featureSHA包已再次核验通过。

## 尚未验收/启用前门禁

无真实GitHub OIDC正向claim、Cloudflare写入/回滚或新站Feishu身份验证；local fixtures/negative tests/dry-run不代表生产发布验收。App/Token/Secrets/Environment/main保护/DNS/Tunnel/服务/群权限均待另行授权。首次线上GitSHA未知时必须警告并审批整个版本，拒绝无可信mapping自动回滚；R2数据不随Worker版本恢复。

Socket模板按现有root Native operator连接service-owned0600 socket；若部署为非root，必须单独批准受限bridge/ACL，不能授予私钥读取组权限或全局sudo。本轮只提供模板不安装。

## 已提交的三个待审核 PR

- [CodexReach #10](https://github.com/blackpill/CodexReach/pull/10)
- [USMapGames #16](https://github.com/blackpill/usmapgames.com/pull/16)
- [ColorearMundo #4](https://github.com/blackpill/colorearmundo.com/pull/4)

三者均Draft/open、未合并、auto_merge=null。新两仓Environment=0、Actions变量=0已只读核实；未创建生产权限。网站pin仍空且guard拒绝。新发布/合同工作流Actions固定SHA；旧CI既有步骤能力保留。

最终包数据（业务源未再变化，静态产物与最终featureSHA匹配）：

- usmapgames `a3940362c5121a995012e01aff49bebe7e93422d`：66个哈希文件，manifest `3ed68bed57a9ecaa4ab3894ea06f898d239b6fa6ab1bea84346638a7304b40f3`；shared verifier、交换target拒绝、真实本地Worker、exact trusted dry-run通过。

- colorearmundo `300f9c348d2a78f055f47efb537cb8ff61fc94cd`：397个哈希文件，manifest `09e1f326b2a606c0c253a19a61ee2f421aff73e32f43018c66b3cf5b0ba31a6d`；shared verifier、交换target拒绝、真实本地Worker、exact trusted dry-run通过。

USMap生产robots保留对GPTBot的明确禁止；校验按User-agent分组只判断通用爬虫是否被全站禁止，不修改robots策略。Colorear R2仿真fixture与fallback烟测始终 --local。
