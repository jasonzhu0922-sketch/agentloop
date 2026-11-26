# 本机内核发布通道

适用当前同一台机器上的三个独立仓库：AgentLoop、report-agent、data-agent。它是本机发布机制；跨机器部署仍需要 registry、制品分发或镜像发布。

## 日常使用

在 AgentLoop 根目录执行：

```sh
npm run release:kernel
npm run release:kernel:status
```

发布成功后，按各项目原有方式停止旧进程，再执行 `npm start`。消费端无需复制 tgz、修改 package.json、运行 npm install，也不需要修改业务代码。发布命令不重启服务。

`npm run build:kernel` 只构建源码，`npm run pack:kernel` 只生成普通 npm 包；两者都不会切换已发布通道。发布默认离线复用缓存与根 lockfile 的确定版本。新依赖未缓存时发布会失败并保留 current；确需下载依赖时显式执行 `npm run release:kernel -- --online`。

## 一次性绑定

当前两个独立仓库已完成绑定。新增本机消费端可以执行：

```sh
npm run release:kernel:bind -- /absolute/path/to/consumer
```

绑定由 npm 管理依赖声明、锁文件与链接；`.npmrc` 设置 `install-links=false`，使以后 `npm ci` 也保留通道链接。

当前两个项目的依赖都是：

```json
"@zhujun/agentloop": "file:../agentloop/.releases/kernel/package"
```

需要保持这些仓库的相对位置，以及 AgentLoop 的本机发布目录。新机器先安装 AgentLoop 构建依赖并发布一次，再安装消费端。不要把此本机 file 依赖当作可独立分发的生产安装包。

## 文件布局与执行边界

```text
agentloop/.releases/kernel/
  package/                         npm 链接的稳定目录
    package.json                   将 exports 路由到 current；没有自己的依赖实现
    current -> ../current/node_modules/@zhujun/agentloop
    dist -> current/dist           兼容已有诊断脚本的物理路径
  current -> releases/<releaseId>   原子切换的发布选择
  releases/<releaseId>/
    agentloop-release.json         产物、源依赖锁、安装依赖锁的 SHA-256
    zhujun-agentloop-0.1.0.tgz
    package.json / package-lock.json
    node_modules/                  独立依赖树与声明的可选宿主驱动
```

直接把 npm 目录依赖指向 current symlink 不够：npm 会 realpath 后锁住具体版本。这里保留稳定 package 根目录，通过 exports 内的 current 路径加载真实发布文件；Node 默认 realpath 将模块固定在不可变版本目录。新进程解析新版本，已加载的模块及其内部延迟导入继续使用原版本。不要启用 `--preserve-symlinks` 来破坏这一版本隔离。

发布流程为：构建 → npm pack → 独立安装 → 校验依赖解析不逃出快照 → 导入检查 → 写入 manifest → 原子切换 current。构建或安装失败不会切换 current；同一包与同一源依赖锁对应同一个 releaseId。工作区改动、build、其他项目的 npm install 不会直接改写已发布文件。

普通 npm 包仍把 PostgreSQL/TiDB 驱动作为可选 peer；本机共享发布显式安装这些驱动，并按根 lockfile 固定版本，避免内核移出消费端后借用源码仓库的 node_modules。消费端自身的 Redis、MySQL 等业务依赖仍由自己的 package.json 管理。

旧发布目录保留。它们可能仍被旧进程的延迟导入使用，不自动回收。回滚也只是切换通道，之后正常重启消费服务：

```sh
npm run release:kernel:activate -- <releaseId>
```

`release:kernel:status` 报告磁盘上下一次启动将解析的发布，不证明已有进程已经重启。

## 2026-11-26 验证

- 真实发布后，把两个独立项目从 vendor tgz 一次性绑定到稳定通道；随后再次发布，两个 package.json 与两个 lockfile 的 SHA-256 均未变化，新进程已解析新快照。
- 发布机制的隔离测试覆盖两个消费端、源码修改不等于发布、失败不切换、重复发布、冷进程切换、旧进程及延迟导入固定版本、npm ci、回滚与并发发布锁。
- 两个消费端 TypeScript 检查通过。
- Report Agent 隔离测试 9/9：包括临时 SQLite Run 执行、重开与临时 HTTP 服务。
- Data Agent 共享 Python 扩展测试 7/7：使用其 `.env` 中已配置的 Python，只操作临时测试文件。
- 从两个消费端实际解析到的发布包回放历史结构化事实，最终均绑定 v3，保留 54 个文件观察；没有改写历史 Run。
- 未重启原有业务服务，未提交、推送或执行 npm registry 发布。新版本服务中的真实业务 Run 仍需在重启后验收。

证据目录：`packages/agentloop/verification/kernel-release-20261126/`。
