# 生产配置、容量与发布手册

适用对象：`deploy/centos7/compose.yaml` 定义的单机云端部署，以及本目录的生产操作脚本。文档按 2026-10-22 工作区实现核对；默认目标是 `root@47.101.178.145`、`/opt/agentloop`。实际地址、协议、挂载路径和运行版本以服务器配置为准，示例不代表已执行生产变更。

## 1. 先选操作

| 要改什么 | 修改入口 | 生效方式 | 是否构建镜像 |
| --- | --- | --- | --- |
| 模型列表、默认模型、上游模型名、URL、协议 | `llm-providers.json` | `update-cloud-llm.sh --config … --apply` 自动重建所有已部署 Runtime | 否 |
| 模型 API Key | 完整 `runtime.env`，配合同一份模型 JSON | 上述命令加 `--env-file …`，自动重建所有已部署 Runtime | 否 |
| 部署端口、共享并发上限、数据库连接池 | 服务器 `/opt/agentloop/.env` | Compose 重建受影响服务 | 否 |
| 新增环境变量的注入、不同 Runtime 的独立并发 | Compose 对应服务的 `environment` | 修改部署定义，再重建服务 | 仅改 Compose 不需要；走精确提交发布时会缓存构建 |
| 云端 Runtime 数量 / 每实例并发 | `/opt/agentloop/.env` 的 `RUNTIME_COUNT` / `MAX_CONCURRENT_RUNS` | `configure-cloud.sh` 或新版本 `deploy.sh up`，见第 6 节 | 否 |
| Web / Router / Runtime 代码 | 审阅后的 Git 提交 | `release-cloud.sh --ref … --apply` | 是，复用层缓存 |
| macOS 安装包 | 指定提交和新版本号 | `package-local-agent.sh`，下载清单另行发布 | 独立打包，不更新云端服务 |

**换 Key 后需要让 Runtime 重新加载。** `update-cloud-llm.sh --apply` 已包含此步骤，无需再手动重启。手工修改文件时执行 `up --force-recreate`；`docker restart` / `compose restart` 不会重新读取 `env_file`。当前模型目录在进程启动时加载，修改 JSON 也应重建 Runtime。重建会影响执行中任务，先暂停新任务入口并等待已有任务结束。

## 2. 文件职责、环境变量与生效规则

### 2.1 云端部署文件

以下为默认位置；`.env` 中的路径变量及容器实际挂载可能覆盖它们。

| 文件 / 目录 | 用途 | 谁读取 |
| --- | --- | --- |
| `/opt/agentloop/.env` | Compose 插值：镜像、端口、URL、身份令牌、数据库、容量、配置文件路径 | Docker Compose；只有显式映射的值进入服务 |
| `/opt/agentloop/secrets/runtime.env` | 模型、MCP 等 Runtime 环境变量；权限 `600` | 所有已部署 Runtime 的 `env_file`；不注入 Router / Web |
| `/opt/agentloop/config/llm-providers.json` | Provider / 模型定义；`apiKeyEnv` 引用变量名 | 只读挂载到 Runtime 的 `/run/config/llm-providers.json` |
| `/opt/agentloop/config/custom-skills/` | 部署维护的自定义 Skills | 只读挂载到各 Runtime |
| `/opt/agentloop/data/workspace/` | 云端任务共享文件；实际路径由 `RUNTIME_WORKSPACE_HOST_PATH` 指定 | 各 Runtime |
| `/opt/agentloop/releases/<SHA>/` | 不可变发布源码、镜像 manifest、构建记录 | 发布脚本 |
| `/opt/agentloop/backups/` | 配置 / 数据库备份及生成的回滚脚本 | 运维 |
| `/opt/agentloop/deployments/topology-*/` | 每次部署生成的 Compose、Router 节点 JSON 和模板来源 manifest | Router 挂载 `runtimes.json` 到 `/run/topology/runtimes.json`；旧目录用于回滚 |

仓库根 `.env`、应用开发 `.env`、用户设备的 Local Agent `.env` 都不是生产配置入口。应用发布不覆盖生产模型 JSON、密钥和自定义 Skills。

### 2.2 为什么写进 .env 可能不生效

`/opt/agentloop/.env` 用于解析 Compose，**不会整份注入容器**。`RUNTIME_COUNT` 是部署生成器的输入，默认 2，必须在该文件填写 1–256 的整数字面值；`MAX_CONCURRENT_RUNS` 默认 20，同样要求正整数字面值。二者不接受 shell 表达式或 `${…}` 引用，重复定义会拒绝。修改后执行第 6 节部署命令，自动同步 Compose 与 Router 清单。其他变量仍须有 Compose 映射才能进入相应服务。

Runtime 的有效环境中，Compose `environment` 中的同名字段覆盖 `env_file`。因此 `MAX_CONCURRENT_RUNS`、数据库连接等已显式映射的字段应在部署 `.env` 或 Compose 中维护，不要试图通过 `runtime.env` 覆盖。未显式映射的 Runtime 环境设置，例如 `WEB_SEARCH_DISABLED`、`MCP_SERVERS_CONFIG_PATH`，可放进 `runtime.env`；路径指向的文件必须实际存在于容器内。

Router 未使用 Runtime 的 `env_file`。例如要调整 `RUNTIME_HEARTBEAT_TTL_MS`，须在 Compose 的 Router `environment` 中增加映射，再设置部署 `.env` 并重建 Router；只在 `.env` 增加名字不会生效。

模型和 MCP 的环境变量与 Skill 自行读取的文件也有区别：`mysql-steel-data`、`data-platform-query` 和 `enterprise-info` 分别固定读取各自 Skill 根目录的 `.env`。部署时在实际执行的 Skill 目录配置；云端自定义 Skills 只读挂载时，在宿主机对应 Skill 目录维护此文件。Compose 的 Runtime `env_file` 不提供这些 Skill 的配置。分发 ZIP 只提供 `.env.example`，不携带真实 `.env`，仍须验证真实工具调用。

不要 `source` dotenv 文件。Compose 支持单引号字面量，例如 `MY_LLM_API_KEY='REPLACE_WITH_REAL_KEY'`；保留已有格式，特殊字符以 Compose 解析结果为准。本机预览只检查 JSON 基本引用，完整环境解析和凭据存在性检查在 `--apply` 的服务器预检执行；最后仍以重建后的有效配置和新任务验收为准。

### 2.3 服务器 Compose 入口

在服务器 Bash 会话中定义。当前生产脚本要求只有一个 Compose 文件；若标签包含多个逗号分隔路径，应停下核对组合，不能把整个字符串当作一个路径。

```bash
ssh root@47.101.178.145
bash
set -euo pipefail
COMPOSE_FILE=$(docker inspect agentloop-router-1 \
  --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')
test -f "$COMPOSE_FILE"
dc() {
  docker compose --project-directory /opt/agentloop \
    --env-file /opt/agentloop/.env -f "$COMPOSE_FILE" "$@"
}
dc config -q
dc ps
```

`dc config -q` 静默校验；完整 `dc config` 或完整 `docker inspect` 可能输出凭据，不要复制到公开日志。下文的 `dc` 均指此函数。若切换新版 Compose，更新 `COMPOSE_FILE` 后再执行命令。

## 3. 更新模型配置与 Key

### 3.1 准备候选文件

在本机私有目录准备候选配置，基于生产完整文件编辑。下列命令适用于第 2 节的默认路径；如生产改过路径，先核实后替换。

```bash
# 本机执行；保留所有 Provider、模型和集成环境变量
umask 077
LLM_WORK=$(mktemp -d "${TMPDIR:-/tmp}/agentloop-llm-edit.XXXXXX")
scp root@47.101.178.145:/opt/agentloop/config/llm-providers.json "$LLM_WORK/"
scp root@47.101.178.145:/opt/agentloop/secrets/runtime.env "$LLM_WORK/"
chmod 600 "$LLM_WORK/llm-providers.json" "$LLM_WORK/runtime.env"
vi "$LLM_WORK/llm-providers.json"
vi "$LLM_WORK/runtime.env"
```

JSON 的最小关系如下；这是格式示例，不应整份覆盖已有配置。Key 放在 `runtime.env` 的 `EXAMPLE_LLM_API_KEY` 中，JSON 只引用变量名。

```json
{
  "defaultProvider": "example",
  "defaultModelKey": "production-chat",
  "providers": {
    "example": {
      "kind": "openai-compatible",
      "baseUrl": "https://YOUR_PROVIDER_HOST/v1",
      "apiKeyEnv": "EXAMPLE_LLM_API_KEY",
      "defaultModel": "YOUR_UPSTREAM_MODEL",
      "protocol": "chat-completions",
      "timeoutMs": 180000
    }
  },
  "models": {
    "production-chat": {
      "providerKey": "example",
      "providerModel": "YOUR_UPSTREAM_MODEL",
      "displayName": "生产对话模型"
    }
  }
}
```

| 字段 | 含义 / 修改影响 |
| --- | --- |
| `models` 的键，例如 `production-chat` | Web 提交的 `requestedModelKey`；不是上游模型名。已有调用方仍可能引用旧键，改名或删除前须核对 |
| `providerKey` | 指向 `providers` 中的条目 |
| `providerModel` | 实际发送给上游的模型标识，区分大小写的上游应原样填写 |
| `baseUrl` | 上游 API 基础地址，不是单次 `/chat/completions` 或 `/responses` 完整路径 |
| `apiKeyEnv` | 保存 Key 的环境变量名；更换变量名时同步 env 文件 |
| `defaultModelKey` / `defaultProvider` | 默认模型 / Provider 引用；不会强制覆盖显式选择的模型 |
| `displayName` | UI 显示名称，不改变实际模型 |
| `protocol` | 按上游选择 `chat-completions` 或 `responses`；模型条目可覆盖 Provider 设置 |
| `timeoutMs`、`maxAttempts`、`retryDelayMs` | 请求超时和重试参数，不是 Run 并发或进程数量 |

思考模式、上下文窗口和输出长度等高级字段见仓库 `config/llm-providers.example.json` 与内核 `LlmProviderRegistry` 配置定义；参数必须符合上游能力。不要只改显示名称就认为已切换模型。云端 Host 要求显式模型选择，不能仅依赖改默认值来迁移所有已有调用。

### 3.2 预览、应用和回滚

本机仓库根目录执行：

```bash
cd /Users/zhujun/coding/agentloop
S="$PWD/apps/agentloop-multi-runtime/deploy/production"

# 仅改模型列表 / 地址；不替换密钥文件
bash "$S/update-cloud-llm.sh" --config "$LLM_WORK/llm-providers.json" --dry-run
bash "$S/update-cloud-llm.sh" --config "$LLM_WORK/llm-providers.json" --apply
```

若要更换 API Key，使用下面这一组，**不要再执行上一组的 apply**：

```bash
# --env-file 必须是包含其他仍在使用变量的完整文件
bash "$S/update-cloud-llm.sh" \
  --config "$LLM_WORK/llm-providers.json" --env-file "$LLM_WORK/runtime.env" --dry-run
bash "$S/update-cloud-llm.sh" \
  --config "$LLM_WORK/llm-providers.json" --env-file "$LLM_WORK/runtime.env" --apply
```

仅换 Key 时，也提供未改动的完整 JSON。脚本没有“只合并一个 Key”的参数；`--env-file` 是完整替换，漏掉其他模型、MCP 或集成变量会丢失配置。

`--dry-run` 不连接服务器，不验证 Key 是否有效。`--apply` 在当前运行镜像里检查完整 schema 和所有声明模型的凭据存在性；缺失则在替换前停止。随后检查 PostgreSQL 非终态 Run、备份文件、替换配置，执行：

```bash
# 脚本自动执行，手工改文件时也使用相同的重建方式
mapfile -t RUNTIME_SERVICES < <(dc config --services | sed -n '/^runtime-general-[0-9][0-9]*$/p')
test "${#RUNTIME_SERVICES[@]}" -gt 0
dc up -d --no-deps --no-build --force-recreate "${RUNTIME_SERVICES[@]}"
```

脚本等待所有已部署 Runtime 各自就绪并复查有效模型配置；失败会恢复文件并重建 Runtime。它不构建镜像、不重建 Router / Web，也不调用上游验证 Key。成功后刷新 Web、重新选择目标模型并按第 9 节运行新任务。

成功输出包含 `Rollback: bash /opt/agentloop/backups/.../rollback.sh`，在服务器执行该完整命令恢复。候选目录包含密钥，完成后按本地密钥文件管理方式处理；失败上传可能留在服务器 root 私有临时目录，排查后清理。

### 3.3 网页重新加载 Runtime

生产 `/cloud-models` 页提供「读取生产配置」「保存并应用到生产」「重新加载 Runtime」和「查看状态」。先输入运维凭证，读取生产配置或导入 JSON，再编辑并点击「保存并应用到生产」：页面会提交当前 JSON，服务器校验、备份、写入文件并重建全部云端 Runtime，最后逐个核对运行中的 `/v1/models` 与配置一致。所有节点通过才报告成功，并显示已应用的模型数量和名称。返回工作区或重新聚焦已打开的工作区后，会重新读取模型下拉列表。

Key 留空时保留服务器已有值；填写的值只合并到对应 Provider 引用的环境变量，其他模型、Skill 和 MCP 变量保留。读取生产配置不会返回 API Key。不导入 `runtime.env` 时保留完整服务器环境文件；显式导入则表示完整替换，须保留其他仍使用的变量。JSON 的 `defaultProvider`、`defaultModelKey` 和各模型 `providerKey` 必须引用实际存在的条目。

「重新加载 Runtime」用于已通过其他方式修改服务器文件的情况，只读取服务器上的配置；它不提交浏览器草稿。操作前暂停新任务并等待已有任务结束。凭证仅保留在当前页面输入框，不写入浏览器存储。

首次启用需要发布包含此功能的 Web 代码，并在 Docker 宿主机安装控制服务。在新版本源码目录执行一次：

```bash
sudo bash apps/agentloop-multi-runtime/deploy/production/install-runtime-control.sh --apply
```

该步骤安装 `agentloop-runtime-control.service`，不重启应用服务。服务只监听 `/run/agentloop-control/control.sock`，不开放网络端口。新 Compose 模板已为 Web 配置这个目录的只读挂载和 `RUNTIME_CONTROL_SOCKET`；当前已部署的不可变 Compose 须通过正常部署流程更新后重建 Web 一次。不要向 Web 挂载 Docker socket。后续页面操作只重建 Runtime。

运维凭证位于宿主机 `/opt/agentloop/runtime-control/operator-token`，仅 root 可读；由管理员通过私有终端读取并粘贴到页面的「运维凭证」输入框。不要把它填写到模型 API Key 或 JSON 中。安装脚本再次运行会保留已有凭证。控制服务代码升级须重新执行安装脚本；发布容器镜像不会自动替换宿主机服务。

按钮复用当前生产操作锁，读取正在部署的 Compose 中的全部 Runtime；逐个用 Compose 实际解析的环境及新挂载文件校验完整模型 schema 和凭据存在性。配置无效、有未结束任务、其他部署占锁或镜像选择变化时停止。随后强制重建 Runtime，逐个检查就绪及有效模型配置，全部通过才报告成功。校验不调用上游，仍需新建真实任务验证模型可用。

操作状态保存在 `/opt/agentloop/control/runtime-reload.json`。刷新页面后重新填写凭证，点击「查看状态」可继续跟踪；控制服务中断时记录为结果未确认，不报告成功。「保存并应用到生产」复用模型配置发布的备份与失败回滚流程，配置校验不通过或仍有未结束任务时不会替换文件。Runtime 就绪但实际模型列表不匹配也会触发回滚。「重新加载 Runtime」不会替换文件，因此无法恢复操作者在操作前手动覆盖的配置。服务日志：

```bash
systemctl status agentloop-runtime-control.service
journalctl -u agentloop-runtime-control.service --since '10 minutes ago'
```

未结束任务检查并不提供原子流量排空；操作期间须保持新任务入口暂停。

## 4. 修改部署 env、端口和数据库

先暂停新任务并确认现有任务结束。在服务器备份并编辑，配置备份也包含秘密：

```bash
CONFIG_BACKUP=/opt/agentloop/backups/env-$(date +%Y%m%d%H%M%S)
install -d -m 700 "$CONFIG_BACKUP"
cp -p /opt/agentloop/.env "$CONFIG_BACKUP/deployment.env"
cp -p "$COMPOSE_FILE" "$CONFIG_BACKUP/compose.yaml"
vi /opt/agentloop/.env
chmod 600 /opt/agentloop/.env
dc config -q
```

| 部署 `.env` 参数 | 当前 Compose 默认 / 作用 | 重建对象 |
| --- | --- | --- |
| `RUNTIME_COUNT` | `2`，生成 1–256 个独立云端 Runtime；见第 6 节 | Router 与 Runtime 拓扑 |
| `MAX_CONCURRENT_RUNS` | `20`，每个云端 Runtime 的 Run 准入上限 | 所有已部署 Runtime |
| `PLANNING_MAX_TURNS` | `4`，规划阶段模型轮次上限；代码范围 1–64 | 所有已部署 Runtime |
| `STEP_MAX_TURNS` | `32`，每个执行步骤的模型轮次上限；代码范围 1–256 | 所有已部署 Runtime |
| `HEARTBEAT_INTERVAL_MS` | `1000`，Runtime 上报心跳间隔 | 所有已部署 Runtime |
| `AGENTLOOP_LOG_COLOR` | `never`，服务日志着色 | 所有已部署 Runtime |
| `AGENTLOOP_ROUTER_STATE_POOL_SIZE` | Router 自身数据库连接池上限；不填写时用驱动默认 | Router |
| `AGENTLOOP_RUNTIME_STATE_POOL_SIZE` | 每个 Runtime 自身数据库连接池上限 | 所有已部署 Runtime |
| `AGENTLOOP_ROUTER_STATE_DRIVER` / `…DATABASE_URL` | Router 独立数据库驱动和连接串 | Router；目标库切换需单独迁移 |
| `AGENTLOOP_RUNTIME_STATE_DRIVER` / `…DATABASE_URL` | 云端 Runtime 共享状态库驱动和连接串 | 所有已部署 Runtime；目标库切换需单独迁移 |
| `WEB_BIND_ADDRESS` / `WEB_PORT` | `0.0.0.0:3001` 映射到 Web 容器 `5174` | Web |
| `ROUTER_BIND_ADDRESS` / `ROUTER_PORT` | `0.0.0.0:5001` 映射到 Router 容器 `8788` | Router |
| `PUBLIC_WEB_ORIGIN` | 浏览器入口，映射为 Router 的 `WEB_ORIGIN` | Router |
| `PUBLIC_ROUTER_URL` | 提供给 Local Agent 的外部 Router 地址 | Web；同步用户设备和安装包入口 |
| `RUNTIME_ENV_FILE` / `LLM_PROVIDER_CONFIG_FILE` | 宿主机环境文件 / 模型 JSON 的绝对路径 | 所有已部署 Runtime |

角色专用数据库设置优先于 `AGENTLOOP_STATE_*` 通用设置，建议显式维护 Router 和 Runtime 各自参数。容器连接宿主机 PostgreSQL 使用 `host.docker.internal`，不能使用容器自己的 `127.0.0.1`。密码在 URL 中按需编码。改连接串不是迁移数据；先完成备份和迁移，不能切到空库后就认为原数据已迁移。Local Agent 始终使用设备 SQLite。

按实际修改选一条执行，例如：

```bash
# Runtime 池大小等已映射设置变化；修改数量或共享并发应使用第 6 节
mapfile -t RUNTIME_SERVICES < <(dc config --services | sed -n '/^runtime-general-[0-9][0-9]*$/p')
test "${#RUNTIME_SERVICES[@]}" -gt 0
dc up -d --no-deps --no-build --force-recreate "${RUNTIME_SERVICES[@]}"
# 仅 Router 配置变化
dc up -d --no-deps --no-build --force-recreate router
# 仅 Web 配置变化
dc up -d --no-deps --no-build --force-recreate web
```

只执行受影响的命令。`RUNTIME_COUNT` / `MAX_CONCURRENT_RUNS` 应使用第 6 节生成新拓扑，保证 Router 清单一致。不要编辑生成的 Compose；新增环境映射修改源码模板并随代码发布。端口变化还要同步 Nginx、云安全组、宿主机规则及客户端 URL。TLS 终止在代理时，宿主机内部探测协议与公网协议可能不同；不能因为修改 `PUBLIC_ROUTER_URL=https://…` 就认为该端口已经启用 TLS。

恢复本节配置时，把 `CONFIG_BACKUP` 指向实际目录，恢复 `.env`；若也改了当前 Compose，恢复它，再对相同服务执行 `config -q` 和 `up --force-recreate`，并重复验收。不要在日常发布时重新生成共享的 Dispatch / Attachment Token。

## 5. Runtime 数量、进程数量和并发不是同一参数

| 概念 | 当前实现 | 配置方式 |
| --- | --- | --- |
| 云端 Runtime 实例数 | 默认 2 个独立容器，可配置 1–256 | 部署 `.env` 的 `RUNTIME_COUNT`；第 6 节 |
| 每个 Runtime 的服务进程数 | 一个 Node Runtime Host 服务进程；`npm` / shell 启动父进程不算额外执行实例 | 没有 `WORKER_COUNT`、PM2 / cluster 数量开关；需要更多服务实例时增加独立 Runtime |
| 每 Runtime 的 Run 并发上限 | 当前 Compose 默认 `20` | `MAX_CONCURRENT_RUNS`，正整数；增大不创建更多 Node 进程 |
| 单次 Run 的模型调用 / 工具执行 | 由执行路径和工具决定 | 不能用规划轮次、步骤轮次当作同时运行的进程数 |
| 工具子进程 | 按任务启动 Python、Shell、浏览器等；stdio MCP 也可启动进程 | 随工作负载变化，没有统一“固定 N 个工具进程”配置 |
| 数据库连接数 | 每个 Router / Runtime 各自持有池 | `AGENTLOOP_*_STATE_POOL_SIZE`，不是服务进程数或 Run 并发 |

两个健康 Runtime、每个上限 20，名义 Run 容量合计 40；这是准入上限，不是吞吐或可同时启动 40 个浏览器的承诺。上游 RPM / TPM、CPU、内存、工作区 I/O、数据库连接和同一会话串行约束都会限制实际吞吐。

例如设置 `RUNTIME_COUNT=4`、`MAX_CONCURRENT_RUNS=8` 并应用，得到 4 个独立 Host，每个最多 8 个 Run。生成器同时将 8 写入 Router 的节点种子，Host 心跳上报实际并发上限，两处保持一致。它不会在每个容器里启动 8 个 Node 服务进程。

当前部署入口统一设置所有 Runtime 的并发，不提供逐节点的不同配额参数。不要手工修改生成文件；下一次部署会重新生成。

数据库预算按进程池累加。例如 Router 池 5、3 个 Runtime 各 10，应用主状态连接池上限合计约 35；这不包括管理端、扩展观察器或其他应用，应另留余量。提高 Run 并发不意味着必须等比例提高数据库池。用 `docker stats --no-stream`、上游限流记录和新任务延迟观察变化，再决定是否继续增容。

## 6. 调整云端 Runtime 数量

### 6.1 首次升级和支持范围

旧版本的生产 Compose 固定两台。先将包含本功能的源码提交并使用 `release-cloud.sh --ref <该提交> --apply` 发布一次；发布会从新版本模板按服务器 `.env` 生成拓扑，缺少 `RUNTIME_COUNT` 时默认 2。独立扩缩容命令使用**正在服务的版本**的模板与镜像；旧版本没有生成器时会在切换前停止，不能仅上传新客户端就扩容。

支持同一 Docker 主机上的 1–256 个独立 Runtime；此上限是配置校验范围，不是单机容量承诺。每台使用稳定的 `RUNTIME_ID=general-01`、`general-02` …，独立私有 data 卷，共享既有状态库和工作区。容器端口为 `8790 + 序号`，不发布到宿主机。不要使用 `docker compose --scale`，那会复制相同身份而不是创建独立节点。

扩缩容前暂停新任务入口并等待现有任务结束。生产操作以 PostgreSQL 非终态 Run 计数拒绝忙时切换；检查并不会阻止之后的新提交，须由运维保持入口暂停。该过程会重建 Router，不承诺零停机或自动迁移正在执行的 Run。

### 6.2 本机远程操作：推荐

本机仓库根目录执行，先预览再应用。以下变更同时设置数量和每实例并发；只给一个参数时保留另一个现值：

```bash
S="$PWD/apps/agentloop-multi-runtime/deploy/production"
bash "$S/configure-cloud.sh" --runtime-count 4 --max-concurrent-runs 8 --dry-run
bash "$S/configure-cloud.sh" --runtime-count 4 --max-concurrent-runs 8 --apply

# 缩为一台，保留每台并发设置
bash "$S/configure-cloud.sh" --runtime-count 1 --dry-run
bash "$S/configure-cloud.sh" --runtime-count 1 --apply
```

预览只校验参数，不连接服务器。应用时使用同一发布锁，创建候选 env，生成并校验部署文件，确认无活动任务，然后备份、切换和逐容器就绪检查；不构建镜像、不删除命名卷。失败恢复原 `.env`、实际旧 Runtime 数量与旧拓扑，并清除新增的 orphan 容器。

### 6.3 在服务器直接配置

如果在服务器维护 `.env`，先备份，再把下列两个条目改为所需值，避免重复定义：

```dotenv
RUNTIME_COUNT=4
MAX_CONCURRENT_RUNS=8
```

从本次发布的 `deploy/centos7/deploy.sh` 执行：

```bash
# 用实际发布源码目录替换 <SHA>
D=/opt/agentloop/releases/<SHA>/source/apps/agentloop-multi-runtime/deploy/centos7
bash "$D/deploy.sh" validate  # 生成候选拓扑，校验但不启动；打印路径
bash "$D/deploy.sh" up        # 生成、备份并应用；现有 PostgreSQL 部署使用统一锁/空闲检查
bash "$D/deploy.sh" health
```

源码 `compose.yaml` 是模板，不能直接 `docker compose -f` 启动。`validate` 不修改当前服务；`health` / `logs` 从 Router 标签读取正在运行的 Compose，不会把尚未应用的数量当作已经部署。首次安装的 `init` 默认生成 `RUNTIME_COUNT=2`，之后的 `up` 同样会渲染拓扑；生产备份/空闲检查流程要求现有 PostgreSQL 部署，SQLite 初始安装不提供同等扩缩容保护。

每次生成独立的 `deployments/topology-*/compose.yaml`、`runtimes.json`、`topology.json`。生成文件保留 `${…}` 引用，不保存插值后的密钥；不要手工修改它们。`topology.json` 记录模板来源，供后续无构建扩缩容、代码发布和回滚使用。旧目录和旧发布源码须保留到回滚窗口结束。

### 6.4 验证、缩容和回滚

重新执行第 2.3 节以刷新 `COMPOSE_FILE`，然后核对：

```bash
dc config --services
dc ps
docker exec agentloop-router-1 node --input-type=module -e '
  import fs from "node:fs";
  const c=JSON.parse(fs.readFileSync(process.env.RUNTIME_CONFIG_PATH,"utf8"));
  console.log(c.runtimes.map(({id,endpoint,maxConcurrentRuns})=>({id,endpoint,maxConcurrentRuns})))
'
```

再到 Runtime 列表 / `GET /v1/runtimes` 核对目标节点的有效心跳，并按第 9 节运行真实任务。模型配置更新和代码发布始终从当前部署 Compose 读取全部 Runtime 名单；即使 `.env` 已编辑为另一个尚未应用的数量，也不会漏更新正在运行的节点。

缩容保留连续的前 N 个身份，通过 `--remove-orphans` 停止并移除多余容器，保留其私有卷、共享工作区和历史数据。Router 重建后只接受新清单；数据库 seed 为 upsert，历史节点记录可能仍显示，须以有效心跳判断是否在线。再次扩容同一 ID 会复用原卷。

成功后打印可复制的 `bash /opt/agentloop/backups/topology-…/rollback.sh`。回滚恢复旧 env 和旧 Compose，再通过 `--remove-orphans` 恢复旧容器名单；若 `.env` 在执行前已被手工改过数量，备份会将 `RUNTIME_COUNT` 校正为先前实际部署数。手动回滚也须暂停入口、确认无执行中任务，再检查服务和新 Run。无需删除数据卷，也不回滚数据库。

增加第二台宿主机需另行部署共享 PostgreSQL / TiDB、可达节点地址和共享文件存储，不属于此命令范围；不要跨机器共享 SQLite。

## 7. 服务进程与端口冲突的排查

每个云端 Runtime 容器只有一个 Node 服务监听自己的 `PORT`。检查进程时可执行 `docker top agentloop-runtime-general-01-1`，数量包含 npm 父进程及任务子进程；不要把每一行当成一个 Runtime。

不同容器有独立网络空间，可以复用相同容器端口；当前模板为可读性使用 `8791`、`8792`。没有 `ports` 映射的 Runtime 不占用宿主机同号端口。当前常见宿主机冲突是 Web `3001`、Router `5001` 已被其他进程或代理占用。

```bash
# 服务器：只读排查，不停止未知进程
ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker top agentloop-runtime-general-01-1
dc logs --since 10m --tail 100 router runtime-general-01 runtime-general-02
```

若 Nginx 占用对外 `3001/5001`，应用容器应发布到代理配置匹配的另一组宿主机地址 / 端口，再由代理转发；不要让两者同时绑定同一个 IP:port。先查现有 Nginx 和 Compose，不要盲目杀进程或统一改掉公开 URL。

Node 的 `EADDRINUSE` 则核对是宿主机进程启动重复，还是容器内重复监听。直接在同一宿主机启动多个非容器 Host 时必须使用不同 `PORT`、不同 `RUNTIME_ID` 并同步 Router 端点。调整 `MAX_CONCURRENT_RUNS` 不会解决监听端口冲突。

## 8. 云端代码发布与 macOS 独立打包

本机仓库根目录执行，`S` 沿用第 3 节：

```bash
# 精确已提交版本；未提交的代码和文档均不进入 git archive
bash "$S/release-cloud.sh" --ref HEAD --dry-run
bash "$S/release-cloud.sh" --ref HEAD --apply

# 单独打包；替换为本次尚未发布的新版本号
bash "$S/package-local-agent.sh" --ref HEAD --version 0.1.4
```

生产发布复用上一版 manifest 中固定摘要的 Node 镜像和 BuildKit 缓存，备份两个 PostgreSQL 库后切换；“增量”指镜像层复用，不是差分源码包或零停机。首次部署、非当前 PostgreSQL 两库布局不适用；当前脚本动态覆盖全部已部署 Runtime。构建 / 服务就绪检查成功仍需第 9 节的新 Run 验收。

macOS 脚本要求 Apple Silicon、Node 26+、Xcode 命令行工具、Python 3 及依赖网络访问；在临时构建副本中修改版本。产物默认在 `release/local-agent/<版本>-<SHA前12位>/`，包含 PKG 和构建 manifest。

打包默认内置 Router `https://47.101.178.145:5001`、Web `https://47.101.178.145:3001`；必须与实际 TLS 入口一致，必要时用 `--router-url` / `--web-origin` 覆盖。这个脚本只打包，不更新服务器下载目录或 releases catalog；正式下载发布沿用 `scripts/publish-local-agent.mjs` 的不可变版本流程。原生安装、覆盖升级、配对和真实本机 Run 需要独立验收，App 签名检查不等于 PKG 已签名 / 公证。

用户电脑的 Local Runtime 数量通过设备的 Runtime 管理功能创建 / 停止，设备 Supervisor 在 Agent 进程中管理独立实例，并非一个本机 Runtime 对应一个云端容器。设备启动环境 `LOCAL_RUNTIME_MAX_CONCURRENT_RUNS` 控制每个本机 Runtime 的准入上限，默认 10；不能在云端 `.env` 调整它，也不能用它设置服务进程数。云端模型更新不会更新设备 Key。安装版的配置根由 `LOCAL_AGENT_RUNTIME_CONFIG_ROOT` 或设备 data root 下的 `agent-loop-runtime` 决定，设备设置与重启操作应在对应设备完成。

## 9. 验证、验收与回滚记录

每次变更记录：时间、目标主机、完整提交 SHA / 镜像 ID、修改字段名、受影响服务、备份目录、回滚命令、健康检查和新任务证据；不要记录密钥值。

服务器先检查服务及有效的非敏感参数：

```bash
dc ps
docker stats --no-stream
mapfile -t RUNTIME_SERVICES < <(dc config --services | sed -n '/^runtime-general-[0-9][0-9]*$/p')
for service in "${RUNTIME_SERVICES[@]}"; do
  docker exec "$(dc ps -q "$service")" node -e '
    console.log({runtimeId:process.env.RUNTIME_ID,port:process.env.PORT,
      maxConcurrentRuns:process.env.MAX_CONCURRENT_RUNS,
      stateDriver:process.env.AGENTLOOP_RUNTIME_STATE_DRIVER,
      poolSize:process.env.AGENTLOOP_RUNTIME_STATE_POOL_SIZE});
    fetch(`http://127.0.0.1:${process.env.PORT}/healthz`)
      .then(r=>{if(!r.ok) process.exit(1)})
      .catch(()=>process.exit(1))
  '
done
```

上述循环按当前部署服务名单执行。使用实际端口和协议检查 Web 首页、Web `/api/healthz`、Router `/healthz`；分别检查宿主机与公网入口。有 TLS 代理时按现有证书和入口测试，不使用 `-k` 掩盖证书错误。

然后从 Web 发起一条新云端任务，显式选择刚更新的模型；记录 Assignment ID、Run ID、实际 Runtime ID、modelKey、执行事件和持久 Outcome，确认新 Key 对上游有效。检查所有目标 Runtime，而不是只让负载均衡随机命中一台。`/healthz` 成功、变量存在和流式出现文字都不能替代完整任务验收。

排障时，模型 `401/403` 核对上游地址、凭据和权限；`429` 核对上游 RPM / TPM 和并发；心跳失败核对静态 ID、端点和共享令牌；启动失败先看 schema / 配置 / 挂载错误。保留原始错误和 Run 证据，再决定回滚。

脚本生成的回滚在服务器执行，使用本次输出的确切备份路径；回滚后重新验证所有受影响服务和代表性新任务。LLM 回滚恢复 JSON 和完整 env；云端代码回滚恢复部署 `.env` 及旧 Compose 启动选择，不自动还原数据库。扩缩容回滚恢复原数量与匹配的 Router 清单；数据库迁移、Skills 和下载清单需单独恢复方案。两个独立数据库 dump 不是跨库原子快照，备份期间需暂停写入并保留配套文件数据。

不要把 `docker compose down -v`、数据库直接覆盖、`docker system prune` 或删除持久构建缓存加入日常发布。旧镜像、数据卷、配置与数据库备份至少保留到验收和回滚窗口结束。

## 10. 配置依据

后续维护文档时同步核对以下实现，避免把开发启动器参数当作生产功能：

- `deploy/centos7/compose.yaml`、`.env.example`、`runtime.env.example`：生产注入和挂载。
- `deploy/centos7/render-topology.py`、`runtime-host.yaml`：生产拓扑和节点清单生成；`config/llm-providers.example.json`：模型字段示例。
- `src/router/main.ts`、`src/router/persistence/control-plane-store.ts`：注册与心跳。
- `src/runtime-host/main.ts`、`src/runtime-host/service/runtime-host-service.ts`：服务进程、启动配置、准入与心跳。
- `src/shared/persistence/state-database.ts`：角色数据库与连接池。
- `deploy/production/server-operations.sh`：预检、当前部署服务发现、生效与回滚。
- `local-agent-runtime/src/main.ts`、`src/service/runtime-supervisor.ts`：设备端独立实例与并发。

本目录 [README](README.md) 保留独立脚本的快速命令；完整配置操作以本手册为入口。
