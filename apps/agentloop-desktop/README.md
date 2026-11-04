# AgentLoop Desktop（开发预览）

Desktop 是标准 `@zhujun/agentloop-local-runtime` 的独立宿主，不依赖 Multi Runtime 的 Router、配对或内部模块。前端沿用 Multi Runtime 的展示效果；包括开发态在内均使用独立 [Account Service](../agentloop-account-service/README.md) 注册、登录，不回退为开发身份。支持源码开发预览和独立原生托盘包；界面统一在 Google Chrome 中运行。

## 启动

仓库依赖已安装，要求 Node.js 26+ 和本机 Python 3。在仓库根目录执行：

```sh
cd /Users/zhujun/coding/agentloop
npm run build:desktop
npm run start:desktop
```

修改代码后需要完全重启开发实例时，在仓库根目录执行 `npm run restart:desktop`。它先停止 8796 端口上的旧 Desktop，最多等待 30 秒确认退出，再构建共享 Local Runtime 并执行 `start:desktop`（包含账号服务重启）。若旧进程因活动任务拒绝退出，命令会停止，不会复用旧实例；先结束或取消任务后重试。此重启命令使用 Bash 和 lsof，适用于 macOS/Linux 开发环境。

开发入口会将 Kernel 已安装的 `jszip`、`pptxgenjs`、`docx` 模块目录传入工具 `NODE_PATH`，并解析当前 `python3` 的真实安装路径（可用 `RUNTIME_PYTHON` 显式指定解释器），避免账号目录中的 Skill 找不到仓库依赖或命中 pyenv shim。Python 的第三方依赖须安装在该解释器环境中；用户 site-packages 不会继承。沙箱仅获得这些工具安装目录的只读权限，工作区写入与账号隔离保持不变；不会在 Run 中联网补装依赖。安装包使用包内依赖，与开发机路径无关。

旧版本升级到账号隔离后，共享模型配置和凭据仍保留在旧数据目录，不会自动分发给登录账号。本机操作人确认归属后，可先停止 Desktop，再运行 `npm run restore:desktop-models -- --data-dir <开发数据目录绝对路径> --account-id <目标账号ID>`，将其恢复到一个已经初始化且尚未保存模型配置的账号。该操作使用原配置校验逻辑，将凭据重新加密到目标账号；不覆盖目标已有配置，也不删除旧数据。恢复后执行 `npm run restart:desktop`。

首次检出需先安装依赖并构建共享包（可执行根目录 `npm run build`）；账号包单独构建为 `npm run build:identity`。本机联调无需手动启动账号服务：`npm run start:desktop` 会先安全重启管理器登记的 Account Service 并等待 `127.0.0.1:8795` 健康就绪，再启动 Desktop。根目录启动脚本将 Desktop 自动指向该地址；无需手工设置环境变量。账号服务默认持久化在 `apps/agentloop-account-service/data/accounts.db`。正式客户端应使用我们部署的 HTTPS 账号服务域名，上述 loopback 仅用于本机联调，不是已经上线的云服务。

只监听固定地址 `http://127.0.0.1:8796`，并在启动命令所在终端持续输出 HTTP 操作摘要和公共 Runtime 事件摘要（Run 短 ID、事件序号、规划、模型请求、工具执行、完成与失败原因）。不主动打印请求正文或完整模型输出；失败消息沿用 Kernel 摘要。使用 `Ctrl+C` 关闭服务；若端口被占用，启动会明确失败，不会静默改用随机端口。可用 `--no-open` 禁用自动打开，`--data-dir /absolute/path/to/new-directory` 指定独立目录：`npm run start:desktop -- --no-open --data-dir /absolute/path/to/new-directory`。重复启动相同目录只打开已有实例后退出，日志仍由原启动终端接收，不再次创建 Runtime。指定 Chrome 而非默认浏览器的启动策略尚未实现。

需要同时保存开发日志时，先在原终端 `Ctrl+C` 停止实例，再执行 `npm run start:desktop 2>&1 | tee /tmp/agentloop-desktop-dev.log`；另一个终端可用 `tail -f /tmp/agentloop-desktop-dev.log` 查看。修改公共 Runtime 后需先执行 `npm run build:local-runtime`，再重启 Desktop。

默认数据目录：

- macOS：`~/Library/Application Support/AgentLoop Desktop Development`

联网搜索默认关闭。开发版从 `apps/agentloop-desktop/.env` 读取配置；打包版从 Desktop 数据目录读取 `.env`。需要启用时，创建仅当前用户可读的文件，设置 `WEB_SEARCH_DISABLED=0`、`WEB_SEARCH_PROVIDER=bocha`、`WEB_SEARCH_ENDPOINT` 和 `WEB_SEARCH_API_KEY`；重启 Desktop 后生效。该设备级配置由本机账号共享，凭据不会通过设置接口返回，也不要提交到代码仓库。

同一文件可设置 `PLANNING_MAX_TURNS`（1–64，规划模型轮次）和 `STEP_MAX_TURNS`（1–256，每个执行步骤的模型轮次）。配置在重启 Desktop 后生效。
- Windows：`%LOCALAPPDATA%/AgentLoop Desktop Development`
- Linux 开发环境：`$XDG_DATA_HOME/agentloop-desktop-development`，未设置时使用 `~/.local/share`；不是本期安装包目标。

禁止指向已安装 Local Agent、其他应用或生产数据。非空且没有 Desktop 所有权标记的目录会被拒绝。

## 账号与本机数据

注册、登录、身份查询和凭据撤销由独立 Account Service 处理，密码规则沿用 Multi Runtime（12 至 256 位）。两者共享 `@zhujun/agentloop-identity` 协议与实现；Router 可设置 `IDENTITY_SERVICE_URL` 接入同一账号权威，而非让 Desktop 依赖 Router。已有 Router 账号数据库不会自动合并，需按账号服务文档明确迁移。

- 账号服务地址仅接受 HTTPS 或 HTTP loopback，禁止账号、密码、查询参数和片段；不沿用模型网关允许远程 HTTP 的策略。
- 密码只在认证请求内瞬时传递，不写本机磁盘。云端 Token 仅驻留 Desktop 进程内存，浏览器只得到本机 HttpOnly Session cookie 和 CSRF；不在 URL 或浏览器存储中保存云端 Token。
- 本机 Session 最长 4 小时且不超过云端有效期；普通业务请求每 60 秒重新校验身份，页面启动读取 `/api/session` 强制校验。云端拒绝则撤销本机 Session，故障则明确失败，不伪造离线认证。
- 退出先撤销本机 Session，再尝试云端撤销；远端结果未确认时页面明确提醒。退出不自动取消在途任务。进程重启或 Session 到期需重新登录，目前没有刷新凭据持久化。
- 对话、Run、事件、附件和产物以稳定的 issuer + tenantId + userId 派生本机 owner，不能由前端指定；同账号重新登录恢复历史，不同账号隔离。账号服务域名变更需作为身份迁移处理，不能随意切换。
- 每个账号使用 `accounts/<cloud_owner>/` 独立目录，内含 supervisor/runtime/memory 数据库、模型/MCP/Connector 独立 vault、上传的 Skills、诊断与 `storage/workspace`、`storage/uploads`。账号来自已验证的 Session，网页不能指定或切换 owner；同账号退出、重新登录与进程重启继续使用原目录。
- 首次登录按历史数据库中的 owner 迁移该账号的对话、Run、附件、工作区、Memory 和有归属的 Connector；快照过滤后执行外键检查和 VACUUM。迁移使用临时目录并原子发布，失败删除临时副本，原数据始终保留。旧 `desktop-development` 身份不自动归给任何云账号。
- 历史共享模型、MCP、自定义 Skill 库及对应密钥没有可验证的用户归属，保留在旧目录，不分配给第一个登录者。模型可由本机操作人明确恢复到指定账号；MCP 和上传的 Skills 需由当前账号配置。Runtime 仅保留有该账号历史的实例身份，不继承无归属的旧能力绑定。
- Runtime 管理和配置接口使用当前账号的管理器；对其他账号实例的查看、配置、重命名、启停、排空、重启与删除均返回 404。存储设置只接受当前账号 `storage/` 内的路径，并拒绝符号链接越界。账号隔离不等于操作系统用户隔离。

当前实现与 Multi Runtime 已有四个账号接口同等能力，**不是 OAuth/PKCE**。邮箱验证、找回密码、PKCE、刷新 Token、安全存储与正式云端部署仍待完成，不能称生产账号体系已经就绪。

## 模型

默认模型目录为空，不提供隐式云端模型或假模型回退。在侧栏“本机能力 → 设置”（窄屏右上角“模型设置”）中添加 Provider，填写服务地址、独立 API Key 密码框和模型 JSON，然后保存并在对话中显式选择模型。保存只验证配置，不调用模型、不代表服务可连接。

Provider JSON 只填写连接元数据，不放 API Key：

```json
{"key":"my-provider","displayName":"我的模型服务","baseUrl":"https://your-provider.example/v1"}
```

模型列表示例（将上游名称与容量改为服务实际支持的值）：

```json
[{"key":"my-model","displayName":"我的模型","providerModel":"actual-upstream-model","protocol":"chat-completions","contextWindowTokens":128000,"maxOutputTokens":8192}]
```

也支持 `responses` 协议及共享 Runtime 已支持的模型调用参数；不同服务的协议、工具调用和参数兼容性需单独验证。API Key 保存后不会回显，不写入配置 JSON、浏览器存储或 URL。相同 Provider ID 和服务地址下留空可保留已存凭据；更换地址必须重新填写。活动 Run、执行尚未退出或业务调用占用时拒绝修改，多标签页过期版本拒绝覆盖；未保存更改需保存或放弃后才能关闭。

配置由公共 Runtime 持久化并直接供已有 Factory 使用，Desktop 没有第二份模型执行实现。配置保存后无需重建 Runtime，显式选择的后续任务使用新目录。

开发期仍可同时提供以下三个环境变量，启动后在页面显式选择 `local:configured`。该显式宿主注入优先于持久化目录，设置页面只读；移除这些变量并重启后恢复本机可编辑配置：

| 环境变量 | 内容 |
| --- | --- |
| `AGENTLOOP_DESKTOP_MODEL_BASE_URL` | OpenAI-compatible API 基础地址 |
| `AGENTLOOP_DESKTOP_MODEL` | 上游模型名称 |
| `AGENTLOOP_DESKTOP_MODEL_API_KEY` | 本机进程环境中的凭据，不要写入仓库 |

Desktop 模型基础地址支持 HTTP 或 HTTPS，包括域名和局域网地址（例如 `http://aigw.baocloud.cn/v1`）；不接受 userinfo、query、fragment 或其他协议。HTTP 会明文传输 API Key 和推理内容，可能被网络中间人读取或篡改，请优先使用 HTTPS，仅在可信网络中使用 HTTP。这个模型出站策略不改变 Desktop 只监听 loopback 的入站策略。上述环境变量适配固定上下文 128000 / 最大输出 8192 tokens，需先核对目标模型支持情况。调用远程模型时，推理内容会离开本机发送到所选服务；“本机保存”不代表模型推理离线。不要把真实 API Key 粘贴到聊天、日志或仓库中。

## 界面和业务闭环

- 复用 Multi Runtime 的侧边会话栏、玄武图标、蓝色主题、消息布局和底部输入框；展示快照位于 `web/multi-runtime.css`，不在启动时读取另一 App 的文件。
- 本机历史、显式模型选择、新任务、取消、附件与产物下载。`⌘/Ctrl + Enter` 发送，Enter 换行；支持主题切换、窄屏会话导航和产物/事件面板。
- Desktop 宿主提交任务时固定开放文件写入和命令工具，支持 HTML 等文件产物生成；浏览器不传入或覆盖该宿主策略，执行仍使用公共 Runtime，并由宿主强制启用操作系统命令沙箱。
- 首次任务建立对话后才能上传附件，单个最多 1 MiB；上传源由本机 API 保存，后续 Run 引用 source ID，不接受浏览器传入任意路径。
- 事件按持久化序号每 500ms 增量轮询，不是 SSE；界面诊断最多显示最近 200 条，不截断数据库历史。
- 待确认发送在首次请求前保存 requestId 与业务载荷到当前标签页 `sessionStorage`，刷新后相同输入重试复用 ID。不保存 Token、Session 或模型密钥。随机端口变化后的跨 origin 草稿恢复尚未实现。
- 对话流对齐 Multi Runtime：真实事件投影实时正文、进度、可折叠计划/工具轨迹、Skill 状态、来源、时间与复制；失败总结和取消不呈现成功交付。完成回复使用相同的共享安全 GFM 渲染器，支持标题、表格和代码块，原始 HTML 转义、危险 URL 拒绝；外部图片仍受本机 CSP 阻止。
- 最终产物内联下载，完成后的阶段产物默认折叠；点击历史回复可查看该轮自己的事件和产物。每轮完整重放持久化事件，诊断 200 条限制不影响计划投影。按 Run 保持 DOM、折叠、选择和内外层滚动位置，阅读历史时不强制回底部；输入框最多自动增高三行。未确认提交显示临时待确认状态，不制造 Run 或成功记录。
- 尚未移植 Human Loop 响应操作、恢复操作和内联产物预览；遇到待输入只显示能力未接入说明，不假装执行继续。文件只作下载，不作为同源活动 HTML 执行。UI 风格复用不代表所有 Multi Runtime 功能已接入。

## 本机能力设置

“本机能力 → 设置”由 Desktop 自己提供常规（含当前账号 Memory）、模型、Skills、Connector、Runtime、MCP 页面。Multi Runtime 只作为交互和展示参考，Desktop 不导入它的 Router、Store、Installer 或内部类。

- **Skills**：上传 ZIP 或目录到当前账号 Skill 库。导入器独立校验 ZIP 路径、CRC、压缩比、文件类型和大小；导入后不会自动启用，也不会上传账号服务。Runtime 页勾选 Skill 绑定，停止 Runtime 后保存，重新启动后才进入执行上下文。声明元数据可编辑，原始 Skill 文件保持不可变。
- **Runtime**：创建、重命名、停止、启动、排空、重启和删除独立 Runtime。Runtime 配置有版本号，过期页面不能覆盖新配置；活动 Run 或未退出的执行会阻止修改和关闭。默认 Runtime 不可删除。
- **MCP**：按 Runtime 配置 HTTP MCP 服务和工具策略，可使用无认证、Bearer、API Key Header、Basic、Query Parameter、Custom Headers。凭据只进独立本机密钥库；服务地址变更不会沿用旧凭据。探测只在内存中完成，不保存草稿。服务地址禁止 userinfo、查询参数和片段。
- **Connector**：Desktop 启动时由宿主批准并加载内置的飞书、126 邮箱和金山文档模块；网页不能提交任意代码路径。设置页管理当前账号的本机连接、Scopes、启用状态和加密凭据；连接按账号隔离，并由当前账号的 Runtime 共享。对话中必须逐项勾选本轮授权的连接，不能自动授予设备上的全部连接。
- **常规 / Memory**：当前账号开关和沉淀模型仅接受本机模型目录；保存会在无活动任务时重新加载运行实例，失败则恢复原配置。不会显示无法由运行时持久化的占位控件。

Desktop 的内置 Connector 由启动宿主决定：开发模式解析工作区源码，安装包应在 Desktop 旁携带对应的 `connectors/*.mjs` bundle。可以通过 `AGENTLOOP_DESKTOP_CONNECTOR_MODULES_JSON` 再注册额外的宿主批准模块：

```sh
export AGENTLOOP_DESKTOP_CONNECTOR_MODULES_JSON='[{"modulePath":"/absolute/path/to/connector.mjs"}]'
```

模块必须实现公开 `@zhujun/agentloop-connector-sdk` 协议。Desktop 不接受网页提供的模块路径，也不声称已经完成 Feishu/WPS 等平台 OAuth；平台模块自行实现其连接协议。

## 安全与生命周期

独立目录先通过排他的 `.desktop-instance.lock` 获得所有权，再打开数据库。`.desktop-data.json` 保存开发模式和稳定 installation ID。正常退出只移除自己持有的锁，不删除数据；损坏、未知、失联或遗留锁不会按 PID/时间自动接管。手工恢复前必须确认原进程已退出且无其他数据库写入者；本批尚无自动崩溃恢复工具。

本机 API 校验精确 Host、Origin 和 Fetch Metadata，不开放 CORS。身份只来源于账号服务，不接受前端 owner。Session 使用每实例随机命名的 HttpOnly、SameSite=Strict cookie；写请求另需 JSON、同源及 CSRF。普通 HTTP loopback 的 cookie 不设 Secure；Chrome/Edge 目标矩阵仍待独立验收。

该 loopback 安全模型不隔离同一用户下的恶意本机进程、扩展或设备管理员。`POST /api/dev/session` 已移除并固定返回 404，Fake Auth 只允许测试夹具显式注入，不是启动选项。

模型凭据保存在当前账号目录下独立的 `private/model-secrets` AES-256-GCM 文件 vault，不与 MCP/Connector vault 共用。当前主密钥是同目录的受限权限文件，**不是 macOS Keychain / Windows DPAPI**，不能抵御同用户恶意程序或完整目录被盗。丢失主密钥时明确失败，不重新生成后覆盖旧密文。新配置提交后旧凭据清理失败会告警，不回滚到可能已删除的旧凭据；该告警仅在当前进程保留，尚无自动孤儿清理/恢复工具。

命令沙箱由 Desktop 宿主强制设置，不能由网页或模型关闭：macOS 使用系统 Seatbelt（`sandbox-exec`），Linux 使用 bubblewrap 的独立命名空间。命令及子进程只能读写当前对话工作区；系统运行库和授权 Skill/工具目录只读，HOME/TMP/XDG 指向工作区内的私有目录。命令不开放网络或全局 IPC，不能读取其他账号目录、数据库、vault 或宿主 home。内置 Connector/MCP 仍通过各自的宿主授权协议访问网络。可信搜索进程使用相同沙箱。

macOS 已使用真实 Node/Python 验证文件生成、只读 Skill 执行、跨账号读写/符号链接/子进程逃逸拒绝和 loopback 网络拒绝。Linux 后端尚未在本次 macOS 环境实测；Windows 尚无原生命令沙箱。缺少可用后端时命令以 `command_sandbox_unavailable` 明确拒绝，不回退到无约束执行；文件工具仍可在工作区生成产物。

活动 HTTP 调用或 Run 阻止关闭；数据库已取消但执行协程尚未退出也不释放资源。使用 Ctrl+C / SIGTERM 关闭，若被活动任务拒绝，先等待或在页面取消，再次退出。没有 Web shutdown 接口。

## 验证与未完成事项

```sh
npm run typecheck --workspace agentloop-desktop
npm run test:desktop
npm run test:local-runtime
```

账号隔离与命令沙箱补齐后，Desktop 65/65、共享 Runtime 40/40、Kernel 标准套件 265/265 通过，构建、Desktop typecheck 与 diff 检查通过。覆盖双账号配置/vault/Runtime 隔离、重新登录与重启、迁移失败原子性、子 Runtime 历史、多账号关闭拒绝，以及真实 macOS 命令边界。额外 Computer 工具套件仍有 3 项既有失败，已在修改前的 executor 临时副本中复现，不代表仓库全量测试通过。

当前 Desktop 27 项、共享 Runtime 38 项、共享产物/Markdown 10 项通过，另有 Desktop 构建和严格 typecheck。覆盖真实 Kernel + 确定性模型、临时 SQLite、双进程单实例、重试/重启、事件游标、附件绑定、取消后 unwind、损坏数据保护、Session/CSRF 和静态资源边界。对话增量覆盖累积流文本、内部正文排除、重复/乱序批次、超过 200 事件后的历史计划、失败总结/取消、终态等待清理、产物分组、Markdown/XSS 和参考快照一致性。模型设置覆盖真实 loopback HTTP 的 Responses/Chat Completions → Kernel 测试、配置重开、版本冲突、活动执行拒绝修改、SQLite 提交失败回滚、主密钥丢失与提交后清理失败；扫描测试持久化文件和公开响应，不允许出现明文测试密钥。HTTP 域名/局域网配置测试使用合成凭据并禁止对外请求，不证明远程网关或真实模型可用。产物下载测试使用显式持久化文件/工具回执 fixture，不证明真实模型生成产物或最终交付。

`web/reference/` 为 Multi Runtime 纯展示函数的显式快照，有一致性测试，不引用其 Router、账户或传输代码。`web/conversation.css` 为对话样式快照；Markdown 从共享包通过 esbuild 在开发宿主启动时生成静态模块，不是运行时加载另一应用。托盘包在构建时预生成 Markdown 资源，安装后不需要 esbuild 或源码仓库。手工对话验收可运行 `node apps/agentloop-desktop/tests/fixtures/conversation-preview.ts`（仓库根目录），仅创建独立临时目录并使用明确标记的确定性模型，绝不接入用户凭据或真实网关。

账号增量验收：Desktop 30/30、账号服务与客户端 4/4，新增 Router HTTP 共享账号集成 1/1；共享 Identity、账号服务与 Desktop 构建及 Desktop 严格 typecheck 通过。测试覆盖云端撤销、账号隔离、重启恢复、密码/Token 不落本机盘、缺失认证配置不回退、云端故障和身份变更。旧 Multi Runtime 仍为 397/410，13 个遗留失败无新增，不能称仓库全绿。上段 27 项为账号接入前状态。

浏览器账号验收使用全新临时目录、独立真实 HTTP 账号服务和确定性模型，通过注册、错误密码拒绝、正确登录、本机 Run 完成、退出与再次登录后恢复历史；不是云端部署或第三方真实模型验收。前批模型配置浏览器验收通过保存、脱敏重读、空白 Key 保留、无效参数拒绝、未保存关闭保护及约 388 CSS 像素窄屏布局。没有读取用户已有 Agent 数据。正式云部署、PKCE/refresh、Keychain、平台 Connector OAuth、安装包签名与 macOS/Windows 安装验收仍未完成。当前 Connector 设置和动态发现入口已实现，但尚未提供平台特定模块。静态资源启动时缓存，修改页面后需要重启 Desktop。


## 原生托盘打包（macOS / Windows）

Desktop 是 **macOS 菜单栏 / Windows 系统托盘应用**，由原生托盘管理本地 Node 服务，使用 Google Chrome 打开本地界面。没有内嵌浏览器。托盘支持启动服务、打开 Chrome、查看日志和退出；退出前会等待本地资源关闭，活动 Run 未结束时拒绝退出。

```sh
# 本机 macOS（Apple Silicon 或 Intel，要求与目标架构一致）
# 与 Local Agent 一样，指定带 pip 的可重定位 Python 3.12 发行目录，不能使用 venv
AGENTLOOP_PACKAGED_PYTHON_ROOT=/path/to/python-3.12-standalone npm run package:desktop:mac:local

# Windows 原生主机（Node 26、.NET 8 SDK、PowerShell）
# 在 PowerShell 中先设置 $env:AGENTLOOP_PACKAGED_PYTHON_ROOT = "C:\build\python-3.12"
npm run package:desktop:win:local

# 正式服务地址须显式给出 HTTPS 地址
npm run package:desktop:mac -- --account-service https://accounts.example.com
npm run package:desktop:win -- --account-service https://accounts.example.com
```

- macOS 需 Xcode Command Line Tools，默认输出 `.app` 和 `.pkg`，支持 macOS 14 及以上。PKG 固定安装到 `/Applications/AgentLoop Desktop Local.app`（正式 channel 为 `AgentLoop Desktop.app`），禁用 bundle relocation。应用使用 ad-hoc 签名；PKG 未签名、未做 Developer ID 公证。
- Windows 输出含自包含 .NET 托盘与 Node 的便携 ZIP，解压后双击 `AgentLoop Desktop.exe`；目标机器不需要安装 Node、Python 或 .NET。当前提供原生 Windows 构建脚本；须在 Windows 上构建并验收。
- 安装并保留 Google Chrome。首次启动自动打开界面，关闭 Chrome 标签页不会停止托盘服务。此版本不注册开机启动。
- `--channel local` 固定连接 `http://127.0.0.1:8795`，也可传 `--account-service` 指定本地服务。账号服务独立运行，使用 `npm run restart:accounts` 启动仓库中的本地服务；客户端不会把账号数据库装进包内。
- 默认 channel 为 `production`，必须指定 HTTPS 账号地址；local / production 使用不同的应用标识及数据目录。开发预览仍使用原来的 Development 目录和端口 8796，托盘包分配空闲 loopback 端口，避免与其冲突。
- macOS 数据位于 `~/Library/Application Support/AgentLoop Desktop Local/runtime-data`；Windows 位于 `%LOCALAPPDATA%\AgentLoop Desktop Local\runtime-data`。正式包去掉 ` Local`。日志位于同级 `logs`。
- 构建输出位于 `release/<channel>-<mac|win>-<arch>/`，macOS 可显式选择 `--target dmg`、`--target zip` 或 `--target dir`；Windows 默认仍为 ZIP。PKG 升级先请求目标安装路径下的后端正常退出，再停止托盘；若任务仍在运行且后端拒绝退出，会中止安装，不强杀任务。只管理同一 channel 的安装路径，不操作 Local Agent、源码预览或其他 channel，也不修改用户数据。安装后以当前登录用户启动托盘；没有登录用户或安装到其他卷时不自动启动。后置脚本只确认托盘与后端进程已启动，不代表真实登录或模型 Run 验收。通过 DMG/ZIP 或构建产物目录启动的其他副本须先手动退出，以免占用同一 channel 的单实例锁。
- macOS 与 Windows 默认强制包含官方 Node 26.0.0、可重定位 Python 3.12、生产 Node 依赖、内置 Skill、三个 Connector 和预构建界面。Python 复用 Local Agent 的 `preparePackagedPythonRuntime` 和 `requirements.local-agent.txt`，包含 markitdown 0.1.7、pandas、openpyxl、pypdf、reportlab、Pillow 等同一套依赖基线；构建时没有 Python 输入即失败，不会生成缺 Python 的精简包。包内不含模型密钥、账号数据、自定义 Skill 或开发配置。LibreOffice、Poppler、Tesseract 可执行程序、FFmpeg 等外部工具与 Local Agent 一样不属于此默认依赖包。
- `desktop-config.json` 记录账号地址、源码提交、工作区是否含未提交改动、Node 校验和、Python 版本与依赖基线校验和及构建时间；`runtime-python/packages.json` 记录实际 Python 包版本。工具执行使用宿主传入的包内 PATH / NODE_PATH / Python 配置，已禁用用户 site-packages，并隔离继承的 PYTHONHOME、PYTHONPATH。打包使用当前工作区，包含尚未提交的源代码修改。

验证示例（不注册测试账号、不配置真实模型）：

```sh
npm run test:packaging --workspace agentloop-desktop
node apps/agentloop-desktop/scripts/smoke-package.mjs "apps/agentloop-desktop/release/local-mac-arm64/AgentLoop Desktop Local.app/Contents/Resources" --probe-account-service
```

烟测将整个 Resources 复制到仓库外的临时目录，移除宿主 Node/Python 搜索路径，并注入错误的宿主 Python 配置。它通过真实 ComputerExecutor 调用随包 python / python3 / node，执行 Python 模块导入、XLSX/PDF/DOCX/PPTX 生成和 markitdown 转换，然后使用独立临时数据启动后端，检查预构建静态资源、账号服务配置、未登录隔离、真实账号服务对无效凭据的拒绝、退出和重启。它不等价于真实账号登录或真实模型 Run 验收。
