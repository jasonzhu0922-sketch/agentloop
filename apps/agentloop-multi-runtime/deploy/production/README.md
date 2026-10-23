# 生产操作脚本

完整配置说明见 [生产配置、容量与发布手册](OPERATIONS.md)：模型与 Key 更新、两类 env 的职责和覆盖顺序、生效与回滚、Runtime 扩缩容、服务进程与 Run 并发、数据库连接池和端口冲突排查。

从仓库根目录执行。默认服务器为 `root@47.101.178.145`，可用 `--server USER@HOST` 覆盖。云端脚本适配当前 `/opt/agentloop`、两个 PostgreSQL 库及可配置 Runtime 数量的 Compose 部署；须具备 SSH、Docker 和 PostgreSQL 备份权限。脚本保留现有端口、Nginx、业务数据和配置。

## 1. 云端增量发布

```bash
# 预览；未提交改动不进入发布包
bash apps/agentloop-multi-runtime/deploy/production/release-cloud.sh --ref HEAD

# 发布指定的已提交版本
bash apps/agentloop-multi-runtime/deploy/production/release-cloud.sh --ref HEAD --apply
```

脚本使用 `git archive` 导出完整源码，在服务器复用上一版 manifest 的固定 Node 镜像摘要、依赖源、BuildKit builder 和缓存；增量指 Docker 层缓存，并非二进制差分。首次安装不适用此脚本，必须先有有效部署和固定基础镜像的发布记录。

镜像构建完成后检查非终态 Run 数量；有任务时停止，待任务结束后重新执行。没有活动任务时备份部署配置、LLM 配置及两个 PostgreSQL 库，切换镜像，并等待 Router、Web、所有已部署 Runtime **各自**就绪。失败恢复旧镜像选择。该单机流程会重建服务，操作期间应暂停新任务提交；活动任务检查本身不提供流量排空或跨库原子快照。

配置和自定义 Skills 不随代码发布替换。已提交的 schema 迁移随新版本启动运行；自动回滚仅恢复代码/配置，不自动还原数据库。含破坏性迁移的发布需单独评审恢复方案。

发布目录：`/opt/agentloop/releases/<完整 SHA>/`。备份目录和 `rollback.sh` 在输出中给出。服务就绪不等同于真实模型任务通过，仍需发起新 Run 检查 Outcome。

## 2. 单独打包 macOS Local Agent

```bash
bash apps/agentloop-multi-runtime/deploy/production/package-local-agent.sh \
  --ref HEAD \
  --version 0.1.4
```

要求 Apple Silicon Mac、Node 26、Xcode 命令行工具、Python 3，以及 npm 依赖源访问。脚本在独立临时目录导出指定提交、安装锁定依赖并打包；`--version` 只修改构建副本，不修改仓库。已发布版本不能替换，重新构建请使用新版本号。

默认固定地址：

```text
Router https://47.101.178.145:5001
Web    https://47.101.178.145:3001
Agent  http://127.0.0.1:18790（用户设备；开发源码使用 8790）
```

生产 Web 的 `LOCAL_AGENT_URL` 必须指向安装版端口 `18790`；新版部署模板已设置此默认值。已运行的 Web 需重新应用新版模板并重建 / 重启，客户端需安装新版包，才能完成端口切换。

可通过 `--router-url`、`--web-origin` 修改。产物和 `build-manifest.json` 放在 `apps/agentloop-multi-runtime/release/local-agent/<版本>-<SHA前12位>/`，可用 `--output` 指定父目录。脚本验证最终 PKG 可展开及 App 代码签名；原生覆盖安装、设备配对和真实 Run 需要另行验收。未设置签名身份时仍是 ad-hoc App 签名、未签名/未公证 PKG。

此脚本只打包，不上传、不修改生产下载清单。发布下载页沿用 `scripts/publish-local-agent.mjs` 的不可变版本流程。Windows MSI 仍须在 Windows x64 构建机上运行 `npm run package:local-agent:win`。

## 3. 单独提交云端 LLM 配置

```bash
# 仅更新 Provider/模型配置，密钥文件保留
bash apps/agentloop-multi-runtime/deploy/production/update-cloud-llm.sh \
  --config /absolute/path/llm-providers.json

bash apps/agentloop-multi-runtime/deploy/production/update-cloud-llm.sh \
  --config /absolute/path/llm-providers.json --apply

# 同时替换完整的 Runtime 密钥/环境文件
bash apps/agentloop-multi-runtime/deploy/production/update-cloud-llm.sh \
  --config /absolute/path/llm-providers.json \
  --env-file /absolute/path/runtime.env --apply
```

`--env-file` 是**完整文件替换**，不是几个变量的补丁。必须保留仍需使用的其他模型、Skill、MCP 环境变量。省略时密钥文件保留。不要把密钥放进 JSON、Git 或命令行参数；JSON 通过 `apiKeyEnv` 引用环境变量。提交表示上传到服务器并生效，不是执行 Git commit。

仅换 Key 也要提供现有完整 JSON。`--apply` 已自动重建所有已部署 Runtime 以加载新环境，无需再手动重启；只在服务器编辑文件则须执行 `up --force-recreate`，单纯 `restart` 不会重新读取 `env_file`。

也可以在 `/cloud-models` 页底部点击「重新加载 Runtime」，应用服务器上已经保存的配置。首次须在宿主机执行 `install-runtime-control.sh --apply`，部署新版 Web 及其控制 socket 挂载；之后使用独立运维凭证操作和查询状态。完整安装、生效与失败处理见 [操作手册第 3.3 节](OPERATIONS.md#33-网页重新加载-runtime)。

脚本先校验 JSON 引用，然后在当前运行镜像中验证候选配置的完整 schema 和**所有声明模型的凭据存在性**。缺少某个模型凭据会停止；应补齐凭据，或在候选配置中移除不再提供的模型。可选环境文件也参与校验。校验不调用上游模型，不证明 Key 有效或上游没有限流。

验证通过且无活动任务后备份原文件，按当前容器挂载位置替换配置，从实际 Compose 读取全部 Runtime 并重建，逐台复查生效配置。失败自动恢复配置并重建 Runtime；不重建镜像，不重启 Router/Web。密钥上传临时文件在成功后删除；失败时可能保留在 root 私有临时目录，应在排查后清理。

上述云端写操作使用同一服务器锁，避免脚本之间并发修改。每次成功后会打印：

```text
Applied cloud/llm/topology. Rollback: bash /opt/agentloop/backups/.../rollback.sh
```

回滚命令在服务器执行。回滚后仍需检查各服务就绪和代表性新任务。

## 调整云端 Runtime 数量和并发（不构建镜像）

先发布包含拓扑生成器的代码版本。数量保存于服务器 `.env` 的 `RUNTIME_COUNT`（默认 2，范围 1–256），并发保存于 `MAX_CONCURRENT_RUNS`（默认每台 20）。本机执行：

```bash
S="$PWD/apps/agentloop-multi-runtime/deploy/production"
bash "$S/configure-cloud.sh" --runtime-count 4 --max-concurrent-runs 8 --dry-run
bash "$S/configure-cloud.sh" --runtime-count 4 --max-concurrent-runs 8 --apply
```

只传其中一个参数时保留另一个。也可以在服务器编辑 `.env` 后运行新版本 `deploy/centos7/deploy.sh up`。部署自动生成匹配的 Compose 和 Router 清单，复用当前镜像，检查空闲、备份、切换并逐台探测；缩容保留卷，失败恢复旧拓扑。先暂停新任务入口，成功后按完整手册执行新 Run 验收。每个 Runtime 仍只有一个 Node 服务进程，并发参数控制 Run 数量。
