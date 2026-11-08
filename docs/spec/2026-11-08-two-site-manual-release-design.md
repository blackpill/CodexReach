---
updated_at: 2026-11-08T19:14:50+08:00
git_commit: 6d850b18e0e990ebb300eddc085d2a136aa5565e
---

# USMapGames / ColorearMundo：Native 人工发布接入设计

状态：方案已选定；本设计待用户审核。尚未开始产品代码实现或创建实施 PR。

## 1. 目标与授权边界

用户已确认：复用 Native Hermes → 飞书真人确认 → GitHub Actions 的发布方式；共享受审代码，但两站的运行服务、数据库、凭据、签名和确认群独立。先提交待审核 PR；仅发布网站代码与同次构建的静态资产，不改写 ColorearMundo R2 数据。

本轮允许只读调查、设计、离线实现/测试及提交待审核 PR。当前尚未进行后者；不得因此合并 PR、修改生产 Worker/DNS/R2、创建生产凭据/权限、启用生产开关或派发部署。生产接入配置、开启入口与每站首次上线另取明确授权。classgames 已运行的服务、源码 pin、密钥、数据库、Tunnel、DNS、Environment 和开关不变；不借用它的生产权限。

## 2. Approaches 与已选择方案

1. **共享受审内核 + 每站独立控制器/凭据/数据库/确认群（用户已选择）**：便于统一维护确认、OIDC、防重放和发布校验，同时在运维与凭据层隔离站点；多两套服务与凭据配置。
2. 单一多站控制器、共享生产权限：部署较少，但一个路由或凭据错误会影响多站，违背用户选择，不采用。
3. 复制两份硬编码 classgames 控制器：初始修改少，后续安全修复易漂移，不采用为长期方案。

**实现者提议**：在 CodexReach 增加新模块 `integrations/hermes/site_release/`，作为新两站共享内核；旧 `integrations/hermes/release/` 的生产实现和 classgames 的运行 pin 保持原样。本轮不迁移 classgames，不以全局变量替换或 monkeypatch 将其固定目标改成别站。共享代码是两新站同一模块与同一最终受审 commit；v1/v2 暂时并存是控制迁移风险的取舍，而不是宣称三个实例都已迁移到同一代码。

## 3. 已核实事实（2026-11-08，只读）

### 固定目标登记

| 字段 | usmapgames | colorearmundo |
| --- | --- | --- |
| 仓库 | `blackpill/usmapgames.com` | `blackpill/colorearmundo.com` |
| repository_id | `1444221313` | `1316936114` |
| 调查时 main | `4b23fdd10128c198ef9a9e4a92ab66db625ddc15` | `31ac0965da06655f75584b76245b28670d7f344b` |
| 真实生产 Worker | **`usmapgames-preview`** | `colorearmundo` |
| Worker 自定义域名 | 仅 `usmapgames.com` | `colorearmundo.com`、`www.colorearmundo.com` |
| Zone | `ca4748ef20171b92930122de9ed8b726` | `c11088f63851408026db85262ea07528` |
| compatibility_date | `2026-11-03` | `2026-07-29` |
| bindings | `ASSETS: assets` | `ASSETS: assets`；`COLORING_ASSETS: r2_bucket` → `colorearmundo-assets` |
| 线上 version | `e38838a1-fe64-4e56-9af1-c2dc58441cfc` | `dc437683-ce22-49cd-8144-34fc00b5f299` |
| 线上 deployment | `682c23c3-c1bb-493d-8221-d17e237cc4e0` | `9a3d1c94-2bcd-4f19-a88c-f06ba892cc84` |
| 线上流量 | 单版本 100% | 单版本 100% |
| Native profile | `usmapgames` | `colorearmundo` |
| 管理群（不是开发通知群） | `oc_9ef60f6e8069fb46230a30e2bbc17bb4` | `oc_bde0a8380d3eb57aa0edcf28edb2ffc5` |

账户均为 `7daf69e93f12575570a679bb91cc1e76`。以上 Worker 名、域名、绑定和版本来自既有 Cloudflare **只读**凭据的真实 GET；管理群来自云端既有项目注册表。不是根据仓库名猜测，也不等于发布授权。调查证据保留在 ignored `.superpowers/two-site-*-inventory.json`；不包含令牌。

### 不可照搬 classgames 的差异

- USMap 仓库 `wrangler.jsonc` 的 `name=usmapgames-local-preview` 是本地配置；实际生产 Worker 虽带 `preview` 后缀，却服务生产域名。保留真实生产名称，不重命名、不切换到 `usmapgames-seo-review`，不新建替代 Worker。
- USMap 真实 Worker 自定义域名仅根域；www 实测 301 到根域，但不能据此假设 www 绑定到同一 Worker。本次保持这一拓扑，不自动增加 www route、不迁移既有跳转规则。
- USMap 必须保留 `html_handling=force-trailing-slash`、`404-page`、`run_worker_first=true` 以及构建生成的 `_headers`/`_redirects`。当前 observability 为未设置，不趁机开启。
- USMap 的 robots 指向 `/sitemap.xml`，`/sitemap-index.xml` 当前 404。健康检查必须按站点配置，不能固定复制 classgames 的 sitemap-index 断言。
- USMap `issue-auto-ci.yml` 目前只监听 PR，但控制器要求目标 main 上成功的 push CI。需增加 main push 触发，保留 build/checks、三个浏览器矩阵与依赖全部成功的 `verify` 汇总；不删减为仅构建通过。
- Colorear 现有 Worker 在 `/media/` 读取 R2，未找到对象时回落到 ASSETS；保留原绑定、路径、canonical/www 跳转和安全头，不将“接入发布”变成存储迁移。
- Colorear `verify.yml` 已监听 PR 和 main push，运行 `npm test`；保留原验证能力，并增加发布合同与最终包测试。
- 两仓目前无人工生产 workflow、无 Actions 仓库变量、无 Environment；分支保护查询均明确返回 `Branch not protected`。这些是后续独立运维授权清单，不在离线 PR 中擅自创建。
- 两站首页/robots 当前 200，www 301，缺失路径 404，`/__release.json` 404。后者是首次接入前的正常现状，不是现有站点健康失败。

## 4. 共享内核与隔离模型

### 4.1 不可变目标注册表

新模块提供受版本控制、只读的两项 `ReleaseTarget` 注册表。固定 project、repo/id、账户、Worker、Zone、精确域名集合、运行时配置、允许绑定、管理群、OIDC audience、workflow 路径、业务健康检查路径。仅允许这两项显式注册目标；外部输入不能提供任意域名、账户、bucket 或命令。

运行进程启动时锁定一个 project；私密配置只允许生产布尔开关、发布人白名单与 tenant 等运行授权字段，不允许覆盖发布目标。每个请求/回执/清单/包标记都绑定 project 与 repo。客户端 wrapper 固定目标、Unix socket 与 Python 环境；不能拿 A 站客户端的参数把请求改发给 B 站。

### 4.2 每站运行与凭据

建议运行目录分别 `/srv/hermes/release-control-usmapgames`、`/srv/hermes/release-control-colorearmundo`，独立 Linux 服务用户、0600 私钥/精选 env/数据库/Unix socket、独立 SQLite 发布记录/通知 outbox。每站仍只能有一个活动发布；不同站可独立推进。

每站使用独立 Ed25519 签名密钥、公钥仓库变量、GitHub App 及私钥（仅安装该站仓库）、最小范围 CF 只读/部署凭据、工具读取凭据、Tunnel 凭据。不得扩展 classgames App 的仓库范围或复用其生产密钥。工具只读 PAT 仅可读 CodexReach 的 Contents/Metadata，放该站 `production` Environment，不放仓库级 secret；期限和轮换清单须记录。

独立账号/服务隔离用于减少意外串站和凭据泄漏影响，不宣称能抵御同机 root 完全失陷。Native Hermes 不接触服务私钥/Token；它只通过固定 wrapper 发起受控动作。

### 4.3 身份与消息校验

白名单默认空、生产默认 false。后续配置阶段分别在两站管理群验证拟发布人的真实账号/租户及群可用性；不能仅从“在 classgames 有权限”推导新站权限，也不增加全局聊天访问。

确认必须来自目标管理群的白名单真人，使用当前有效单的精确 `确认发布 RELEASE_ID NONCE`；校验原始消息的 sender 类型、open_id、tenant、chat、创建时间、未编辑/撤回、完整正文及未使用状态。机器人转述、开发群、旧 nonce、入口开启授权和“PR已合并”都不是部署批准。

过期后不延长原 nonce、不自动确认；用户要求重发时，先读状态。仅尚未确认的 PREPARED 旧单可取消，再重核 main/基线并生成新单；已派发或结果未知时绝不因“重发”重新部署。

## 5. 发布与回执协议

1. prepare 只读验证 repo/id、当前 main、受信 App 15368 的必要 CI/checks 与成功 push workflow；读 CF 精确运行时/绑定/域名/单版本流量，保存基线。发完整 SHA、线上 version、差异/未知警告、10 分钟有效期的确认单。
2. 真人确认时再次校验主干与基线；原子消费消息并预约唯一 dispatch。任何不确定结果保留状态并 locate/reconcile，不盲重发。
3. 每站回执由该站独立 key 签名，包含 schema/project/repo/id/environment/操作/目标 SHA/目标 version/目标配置摘要/原线上 version/操作者/批准与过期时间。验签与所有绑定必须通过；项目、仓库或签名不匹配立即拒绝。
4. GitHub OIDC audience 分别固定 `usmapgames-release-control` 与 `colorearmundo-release-control`；验证官方 issuer/JWKS、RS256、exp/iat/nbf、有界有效期、repo/id、main workflow_ref/workflow_sha/sha、workflow_dispatch、GitHub-hosted runner、run_id 和 attempt=1。任何其他站或 PR workflow 的 Token 都不得 claim。
5. claim 每站独立 HTTPS endpoint（后续授权创建），只暴露精确 `/v1/claims`；无 approve/dispatch/任意命令的公网 API。服务仅监听独立 loopback 端口及私有 socket。独立 Tunnel、无新公网入站端口；不修改现有 classgames Tunnel。域名/端口与 systemd 名称由实现者选择固定值并先检查冲突，不可从请求拼出。
6. claim 仅由匹配 run/attempt 消费一次，重新核对主干与线上基线。生产 job 的 GitHub 仓库变量必须精确 true，控制器生产开关也必须 true；漏项、未知项、类型错误均 fail closed。
7. Worker 发布后分别核验控制面 version/deployment 与业务健康，再保存该站可信 SHA↔version 映射。业务不健康或结果未知仅告警/等待处理，不盲部署或自动回滚。通知失败单独有限重试，不能重新 dispatch。

## 6. 两站网站 PR

各站新增 `deploy-production.yml`（仅 workflow_dispatch）和不含密钥的生产打包配置/脚本、marker 处理及合同测试；已有本地 Wrangler 配置和业务路由不被替换为生产配置。新工作流的部署入口仍默认关。

### 构建 job

- 验证固定 repo ID、main 与目标 SHA；使用 event 文件读取并最先 add-mask 回执，不经可展开 env 将其写进步骤日志。
- 锁定 Actions SHA、Node 与网站 lockfile，使用各站既有测试体系。USMap 保留完整浏览器矩阵；Colorear 保留 `npm test`，再补最终 Worker 包的真实本地测试。
- 构建环境没有 CF 部署密钥、工具私库 Token、OIDC 写权限。只执行受审 commit 的构建与测试；Colorear 不运行 `upload:r2`、`generate:resources` 等独立数据写入命令。
- 将 worker 预先 bundle，输出不可变目录：bundle、assets（含 marker）、受审完整生产 config、manifest；列出 SHA-256、project/sha/config_digest 和精确文件集合。拒绝 symlink/path traversal、额外文件和非预期绑定。
- `__release.json` 提议格式 `{schema:1, project, sha}`，响应 `Cache-Control: no-store`，不含凭据或回执。Worker 保留原行为，新增 marker 专用处理；v1 classgames 格式不改。
- 对最终完整包跑真实本地 Worker 冒烟，测试完成后重新校验包未变。仅临时本地适配副本去部署 routes，避免 Wrangler Host 归一化掩盖 www/canonical 问题；不改原包。

### 发布 job

- `production` Environment、main 限定、每站独立 concurrency（不取消已开始发布）、布尔开关条件与 id-token:write。
- checkout 私有 CodexReach 的最终已审核不可变 commit；不得指向分支、PR head、全零 placeholder 或未审核临时 SHA。首轮网站草稿 PR 可以无有效工具 pin，但必须明确阻塞且默认关闭；在共享内核 PR 合并后更新为实际 merge SHA，再转可合并状态。
- 只安装受信工具锁定依赖（Python hashes、`npm ci --ignore-scripts`）；不重新安装/构建网站源码，不执行网站包提供的脚本，不向构建 job 传 Token。
- 验签、验包、OIDC claim 一次后，以受信 Wrangler 对完整包 `--no-bundle --strict` 发布。敏感 CF Token 仅在该步骤存在；不运行网站 `npm run deploy`。
- Colorear 允许生产 config 固定已有 R2 binding；拒绝新增、改名、换桶或额外 KV/D1/Services 等绑定。发布不创建/上传/删除 R2 对象、不执行 bucket 迁移。不为方便部署申请 R2 数据写权限；若工具绑定校验另需元数据读取，应在运维授权阶段实测最小只读需求，不能静默扩大权限。

## 7. 站点专属业务验收

- 通用：根域首页/canonical、robots、站点实际 sitemap、缺失路径、marker project+SHA、响应/安全头；诚实的显式应用 UA、HTTPS、有界读取、超时与不自动跟随不可信重定向。CF 控制面域名归属核验和 version 核验独立于网页返回成功。
- USMap：`/sitemap.xml`（不是 sitemap-index）、尾斜杠跳转、既有 `_headers`/`_redirects`、已存在的地图/quiz 和 PDF 样本；真实生产目标仍 `usmapgames-preview`；www 公网跳转保留现状，不据此新增绑定。
- Colorear：`/sitemap-index.xml`、www→根域、内容页、已有图片/PDF 样本和 `/media/` R2 get/未命中 fallback。选用仓库/线上实有且版本受审的同源样本路径，不接收任意请求 URL。大 PDF 使用有界前缀/类型/状态校验，不因完整文件超过 JSON 响应上限而误报。
- 本地 R2 使用临时本地仿真/fixture，绝不连真实桶；测试 fixture 写入仅发生在本地临时目录，不是生产 R2 上传。线上 R2 验证仅 GET/HEAD，不授予数据写权限；只读样本校验不冒充全桶完整性审计。

## 8. 必须测试的隔离与失败场景

- A 的确认单/真人消息、public key、回执、OIDC、run、artifact、CF version、Worker/Zone/R2 bucket/config 不能用于 B；包括 A/B 交换且 release_id 相同、同一账号在错群确认、注册外 project、claim URL/Repo ID 不符。
- 配置缺省 false、白名单空、任一开关 false、目标 main/push CI 未完成或 App 来源错误、基线变化/分流/域名或绑定漂移、缺少可信 SHA↔version 映射的自动回滚、过期/编辑/撤回/重放/重复 claim 均拒绝。首次旧 SHA 未知本身不阻止发布，但必须明确警告、由真人批准整个目标版本，不声称完整差异或伪造映射。
- 真实 wire 测试 OIDC GET、claim POST、marker GET 的显式 UA、原 Authorization/body 保真、禁止重定向/写重试与有界读取；不得仅 mock 成功返回，复用 classgames 1010 的实际教训。
- HTTP 慢请求不能阻塞其他请求；有界并发、读超时、SQLite 原子状态、结果未知不重发；飞书发送结果不确定先查 durable state，不重新 prepare 出多单。
- 原 classgames release 测试与仓库 Node/Worker/Hermes 全套测试保持通过；旧生产路径/服务/配置零变更。静态/合同验证不能替代真实本地最终包测试，也不能冒充正向 OIDC 或生产写入验收。

## 9. 阶段交付与再次授权

1. 设计审核 → 编写实施计划；建议先共享内核 + USMap 离线链路，再 Colorear R2 专属适配，减少同时调试两个差异目标。此顺序是实现者建议，非用户已单独指定。
2. 预期三个实施 PR：CodexReach 新共享内核及模板/测试；USMap 网站接入；Colorear 网站接入。网站 PR 必须等待工具的已审 merge SHA；提交待审核不等于自动合并。
3. 离线完成后的报告分别列出实测结果、未验证的生产路径和授权清单。新站生产开关/白名单继续关闭/空；此时不安装云服务、不创建 GitHub App/Token/Environment/DNS/Tunnel/分支规则，不影响 classgames。
4. 后续单独授权才配置两站独立生产权限、main 保护（含管理员约束、required `verify`+`release-contracts` App 15368）、main-only Environment 和生产 Secret；分别验证发布人身份/群、只读基线与负向拒绝。能否使用原生 required reviewer 需实测账户能力，不以不存在的 reviewer gate 冒充人工确认。
5. 工具 PR/网站 PR 均审核合并后，分别更新新控制器/pin 并复核实际 main 与 CI；正向 OIDC/非生产写入演练若未完成必须明确告知。生产入口开启与首发确认单另取授权；用户在各自群的精确真人确认才批准该次部署。
6. 首次线上版本的 Git SHA 未经可信证据核实前均标记未知；不得制造健康映射或宣称完整 Git 差异。记录实际旧 version 作为人工恢复候选，恢复前另取用户授权并核验资产可用性。R2 不随 Worker version 回退，不能把版本回退等同数据恢复。

## 10. 范围外与设计完成标准

不做 classgames 迁移、Worker 重命名、R2 数据生成/上传/删除、存储迁移、业务改版、WAF 放宽、全局聊天授权、自动合并或自动回滚。

本设计的完成是让实施者不必猜生产目标、边界和协议；不是声称功能已实现或生产可用。实现者可决定内部函数拆分、固定空闲端口、测试 fixture 文件名与受审健康样本路径，但不能改变上述授权边界/隔离模型/既有业务行为。发现额外绑定、main 新变更、CI 基线失败或生产拓扑变化时重新调查，不用放宽断言掩盖。
