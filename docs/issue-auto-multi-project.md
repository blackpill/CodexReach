# Issue Auto 多项目接入（尚未部署）

## 已实现与未启用

- 一个 Worker/D1 队列，一个 Mac IssueStore/IssueService，一个 PID 单实例锁，一个持久开发 Turn 执行槽。不能为每仓启动独立 Runner 或配置不同 DB 来绕开全局串行。
- 仅允许 `blackpill/usmapgames.com`（1444221313）和 `blackpill/classgames.net`（1223017142）；仍只有 GitHub 用户 ID 1231245（blackpill）的人工 `Auto` 触发有授权。普通 bot/其他作者不能触发。
- 没有 `ISSUE_AUTO_PROJECTS_JSON` 时原 env 零改仍为 usmap。设置 JSON 后，它**替换**原单项目配置；只有显式 `enabled:true` 项目被领取，配置缺失/未知/禁用仓库从不落库和 ACK。
- 不自动合并、部署或关闭 Issue；由原流程独立 worktree、验证、push 任务分支、创建 PR、等待精确 required checks 后请人审核。命令只来自本地受信任配置，不来自 Issue/队列，不经过 shell；项目脚本和依赖仍是完整权限执行，**不是安全沙箱**。
- 本次仅本地代码与测试，没有修改真实 env、Worker 资源、仓库 webhook、classgames 工作区或远端。配置示例不是上线确认。

## classgames 上线前置条件

只读核查 2026-11-06 时，classgames 的远端 main 为 `ea033ff1ff744b6ae0a3250610bbcee91eac7e81`，没有 `.github/workflows`、Actions workflow/run、main check-runs 或 status checks；main 未启用 branch protection。不能填写一个不存在的 check 后声称已有 CI。

远端契约是 `pnpm@10.18.2`、`pnpm-lock.yaml`，无 npm lockfile、无 verify 脚本；验证为 `pnpm check` 和 `pnpm test:e2e`（内部先 build）。Playwright 单 worker，`channel:'chrome'`、本地 4322 端口、`pnpm preview`；Linux CI 须安装对应 Chrome，而不是假设默认 Chromium 满足 channel。生产 Worker 行为测试在测试中直接导入 Worker，并非静态预览证明了线上 Worker。

先在**独立 classgames worktree**提交并人工合并 PR CI，锁定 pnpm/Node、浏览器依赖、固定唯一 check 名（例如 verify），运行真实远端 PR 验证，再把项目 enabled 和 Worker allowlist 打开。不能 reset/clean/stash 原脏工作区。其 origin 当前为 SSH，保留，不改成 HTTPS。

classgames 当前没有无 analytics/noindex 的 preview build 契约，因此 `previewEnabled` 默认 false，设为 true 将拒绝配置。它的 PR CI 通过通知不依赖局域网预览。usmap 保持现有可选预览，全球统一端口/容量；PreviewStore 已迁移去掉跨仓 `pr UNIQUE`，保留 task_id 和全局 port 唯一。旧预览数据保留。

## 配置示例

保留全局 queue URL、secret、GitHub auth、风险接受、DM 与 LAN 端口参数。`ISSUE_AUTO_PROJECTS_JSON` 是下列数组的 JSON 字符串（环境文件用单引号包住完整 JSON；不要把 GitHub token 放进数组）。项目路径、精确 remote、安装和验证命令仅由本地管理员维护：

```json
[
  {
    "enabled": true,
    "repositoryId": 1444221313,
    "owner": "blackpill",
    "repo": "usmapgames.com",
    "baseBranch": "main",
    "projectPath": "/Users/kenny/Web/usmapgames.com",
    "expectedRemote": "https://github.com/blackpill/usmapgames.com.git",
    "packageManager": "npm",
    "install": { "executable": "npm", "args": ["ci", "--no-audit", "--no-fund"] },
    "validate": [{ "executable": "npm", "args": ["run", "verify"] }],
    "build": { "executable": "npm", "args": ["run", "build"] },
    "required": ["verify"],
    "ciTimeoutMs": 1800000,
    "previewEnabled": true
  },
  {
    "enabled": false,
    "repositoryId": 1223017142,
    "owner": "blackpill",
    "repo": "classgames.net",
    "baseBranch": "main",
    "projectPath": "/Users/kenny/Web/classgames.net",
    "expectedRemote": "git@github.com:blackpill/classgames.net.git",
    "packageManager": "pnpm",
    "install": { "executable": "pnpm", "args": ["install", "--frozen-lockfile"] },
    "validate": [{ "executable": "pnpm", "args": ["check"] }, { "executable": "pnpm", "args": ["test:e2e"] }],
    "build": { "executable": "pnpm", "args": ["build"] },
    "required": ["verify"],
    "ciTimeoutMs": 1800000,
    "previewEnabled": false
  }
]
```

`webhookId` 可分别填真实仓库的数字 hook ID，开启各自投递历史检查。别复制另一个仓库的 hook ID。未填则不扫描，配置失败不暗中降级信任。项目 worktreeRoot 自动按 repositoryId 命名空间分配。两仓 baseBranch 当前仅允许 main；不得从事件 body 自定义分支、路径或命令。

## 领取、路由和发布顺序

1. Mac `/claim` 提交 `{runnerId:"mac", repositoryIds:[已启用的ID]}`。Worker 验证它是服务端 `REPOSITORY_IDS` 逗号列表的子集；SQL 只原子租赁相应仓，未知队首不会阻塞支持仓。
2. 旧客户端不传列表时，只使用旧 `REPOSITORY_ID`，**不会自动扩大到新 allowlist**。Worker 模板仍只 usmap；没有自动启用 classgames。
3. Mac 校验完整 task/actor/lease，原子写入 task+progress，验证幂等身份一致后才 ACK；未知/禁用仓或入库失败零 ACK。丢失 ACK 可安全重投。
4. 每次从持久 task.repositoryId 解析 Runtime/GitHub/CI/飞书通知 route，不相信 progress context 中的 repo；未知仓不回退 usmap。PR URL/job logs/分页链接/remote 均维持精确仓库边界。每次 GitHub API 读取及直接写入前还查询仓库元信息，核对稳定 repositoryId 与完整 owner/repo；不缓存核验结果，同名仓库被重建/占用或仓库改名会拒绝执行，不会在 publish 时继续 git push。
5. 先升级 Mac，再升级 Worker，保持 allowlist 只有 usmap；完成 classgames CI/群/权限验证后，才显式启用其 Mac 配置，再扩 Worker allowlist 并配置 webhook。两端能力不一致只会拒绝/保留待领取，不吞单。需要暂停/更改已启用项目时，先停止新入口并耗尽本地活动任务；直接移除路由不会把旧任务转移到其他项目。
6. Worker secrets 可共用当前 webhook secret，但各仓 webhook 必须配置相同值；不可把 secret 放 URL、日志或仓库。运行仅一个 Mac，不新增自动 merge/deploy 权限。

## 全局执行槽与人工恢复

启动 Codex 前先持久占有 `issue_auto_execution`。已有 running Turn 优先于较老 PR 的回归修复；只有观察到终止状态后才释放。启动响应丢失、读取 Turn 连续错误、两小时中断结果未确认等情形，BLOCKED 也不会放开执行槽。重启保留锁；旧数据库 running/launching 状态会恢复占有。发现多个旧 running/launching 时拒绝继续开发并报告错误，通知重试仍运行。

不确定状态不会自动删锁/重放 launch。管理员必须先核实并停止旧 Codex Turn/残留子进程，再在停机和 SQLite backup 后协调 progress.phase 与执行槽，必要时手动修复；目前没有一键“强制继续”接口。若崩溃发生在已记录终止到释放槽之间，也可能保守停住，不能只看 BLOCKED 或进程退出就判定安全。该锁只约束本 Runner，同一个 DB 之外的程序或用户直接操作 Codex Desktop 仍不受限。

## 本地验收

服务原生 SQLite 依赖使用 Node 22 ABI，本站点构建默认仍用 `/Users/kenny/.local/bin/node`。链接现有 node_modules 时用匹配 Node 22 执行应用测试，不要重编译正在运行 Bot 的共享模块：

```bash
PATH=/Users/kenny/.nvm/versions/node/v22.16.0/bin:$PATH npm run test:all
PATH=/Users/kenny/.nvm/versions/node/v22.16.0/bin:$PATH npm run check:all
PATH=/Users/kenny/.nvm/versions/node/v22.16.0/bin:$PATH npm run build
```

测试仅用内存/临时 SQLite、临时 git 远端与 worktree、fake HTTP，覆盖双仓同 Issue/PR 编号、未知仓不 ACK、租赁筛选、跨仓通知、旧配置、持久执行槽及预览表迁移。通过这些不代表 classgames CI/真实凭据/生产预览已验收。

### 本轮验证记录（2026-11-06）

在隔离分支 `codex/hermes-multi-project`、匹配 Node 22 ABI 下：应用 198/198（保留原 179 项），Worker 8/8（保留原 4 项），`check:all`、`build` 和 `git diff --check` 均通过。新增功能先运行失败测试，再实现；配置/claim/GitHub路由/执行槽/自定义预览构建/启动双仓路由都观察到预期红灯后转绿。没有运行真实 queue、创建 Issue/PR、推送、部署或访问真实 env/凭据。未执行 classgames 项目测试，未声称其 CI 可用。
