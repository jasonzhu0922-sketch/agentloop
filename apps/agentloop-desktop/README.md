# AgentLoop Desktop（开发预览）

Desktop 是标准 `@zhujun/agentloop-local-runtime` 的独立宿主，不依赖 Multi Runtime 的 Router、配对或内部模块。前端沿用 Multi Runtime 的展示效果；包括开发态在内均使用独立 [Account Service](../agentloop-account-service/README.md) 注册、登录，不回退为开发身份。当前为源码开发预览，尚非已部署、已打包的发行版。

## 启动

仓库依赖已安装，要求 Node.js 26+。在仓库根目录执行：

```sh
cd /Users/zhujun/coding/agentloop
npm run build:desktop
npm run start:desktop
```

首次检出需先安装依赖并构建共享包（可执行根目录 `npm run build`）；账号包单独构建为 `npm run build:identity`。本机联调无需手动启动账号服务：`npm run start:desktop` 会先安全重启管理器登记的 Account Service 并等待 `127.0.0.1:8795` 健康就绪，再启动 Desktop。根目录启动脚本将 Desktop 自动指向该地址；无需手工设置环境变量。账号服务默认持久化在 `apps/agentloop-account-service/data/accounts.db`。正式客户端应使用我们部署的 HTTPS 账号服务域名，上述 loopback 仅用于本机联调，不是已经上线的云服务。

只监听固定地址 `http://127.0.0.1:8796`，并在启动命令所在终端持续输出安全的运行摘要（配置保存、Run 提交、取消和失败请求；不记录提示词、凭据、查询参数、响应内容或资源 ID）。使用 `Ctrl+C` 关闭服务；若端口被占用，启动会明确失败，不会静默改用随机端口。可用 `--no-open` 禁用自动打开，`--data-dir /absolute/path/to/new-directory` 指定独立目录：`npm run start:desktop -- --no-open --data-dir /absolute/path/to/new-directory`。重复启动相同目录只打开已有实例，不再次创建 Runtime。指定 Chrome 而非默认浏览器的启动策略尚未实现。

默认数据目录：

- macOS：`~/Library/Application Support/AgentLoop Desktop Development`
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
- 旧 `desktop-development` 身份数据保留原样，不自动归给第一个注册者；不会因为改成云登录而删除旧数据。迁移入口尚未实现。
- 模型配置与凭据属于设备级资源，同设备已登录账号共享。账号隔离不是操作系统用户隔离，也不意味着模型配置按账号独立。

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
- 首次任务建立对话后才能上传附件，单个最多 1 MiB；上传源由本机 API 保存，后续 Run 引用 source ID，不接受浏览器传入任意路径。
- 事件按持久化序号每 500ms 增量轮询，不是 SSE；界面诊断最多显示最近 200 条，不截断数据库历史。
- 待确认发送在首次请求前保存 requestId 与业务载荷到当前标签页 `sessionStorage`，刷新后相同输入重试复用 ID。不保存 Token、Session 或模型密钥。随机端口变化后的跨 origin 草稿恢复尚未实现。
- 对话流对齐 Multi Runtime：真实事件投影实时正文、进度、可折叠计划/工具轨迹、Skill 状态、来源、时间与复制；失败总结和取消不呈现成功交付。完成回复使用相同的共享安全 GFM 渲染器，支持标题、表格和代码块，原始 HTML 转义、危险 URL 拒绝；外部图片仍受本机 CSP 阻止。
- 最终产物内联下载，完成后的阶段产物默认折叠；点击历史回复可查看该轮自己的事件和产物。每轮完整重放持久化事件，诊断 200 条限制不影响计划投影。按 Run 保持 DOM、折叠、选择和内外层滚动位置，阅读历史时不强制回底部；输入框最多自动增高三行。未确认提交显示临时待确认状态，不制造 Run 或成功记录。
- 尚未移植 Human Loop 响应操作、恢复操作和内联产物预览；遇到待输入只显示能力未接入说明，不假装执行继续。文件只作下载，不作为同源活动 HTML 执行。UI 风格复用不代表所有 Multi Runtime 功能已接入。

## 本机能力设置

“本机能力 → 设置”由 Desktop 自己提供常规（含设备级 Memory）、模型、Skills、Connector、Runtime、MCP 页面。Multi Runtime 只作为交互和展示参考，Desktop 不导入它的 Router、Store、Installer 或内部类。

- **Skills**：上传 ZIP 或目录到设备级 Skill 库。导入器独立校验 ZIP 路径、CRC、压缩比、文件类型和大小；导入后不会自动启用，也不会上传账号服务。Runtime 页勾选 Skill 绑定，停止 Runtime 后保存，重新启动后才进入执行上下文。声明元数据可编辑，原始 Skill 文件保持不可变。
- **Runtime**：创建、重命名、停止、启动、排空、重启和删除独立 Runtime。Runtime 配置有版本号，过期页面不能覆盖新配置；活动 Run 或未退出的执行会阻止修改和关闭。默认 Runtime 不可删除。
- **MCP**：按 Runtime 配置 HTTP MCP 服务和工具策略，可使用无认证、Bearer、API Key Header、Basic、Query Parameter、Custom Headers。凭据只进独立本机密钥库；服务地址变更不会沿用旧凭据。探测只在内存中完成，不保存草稿。服务地址禁止 userinfo、查询参数和片段。
- **Connector**：Desktop 启动时由宿主批准并加载内置的飞书、126 邮箱和金山文档模块；网页不能提交任意代码路径。设置页管理当前账号的设备级连接、Scopes、启用状态和加密凭据；连接按账号隔离，并由全部 Runtime 共享。对话中必须逐项勾选本轮授权的连接，不能自动授予设备上的全部连接。
- **常规 / Memory**：设备级开关和沉淀模型仅接受本机模型目录；保存会在无活动任务时重新加载运行实例，失败则恢复原配置。不会显示无法由运行时持久化的占位控件。

Desktop 的内置 Connector 由启动宿主决定：开发模式解析工作区源码，安装包应在 Desktop 旁携带对应的 `connectors/*.mjs` bundle。可以通过 `AGENTLOOP_DESKTOP_CONNECTOR_MODULES_JSON` 再注册额外的宿主批准模块：

```sh
export AGENTLOOP_DESKTOP_CONNECTOR_MODULES_JSON='[{"modulePath":"/absolute/path/to/connector.mjs"}]'
```

模块必须实现公开 `@zhujun/agentloop-connector-sdk` 协议。Desktop 不接受网页提供的模块路径，也不声称已经完成 Feishu/WPS 等平台 OAuth；平台模块自行实现其连接协议。

## 安全与生命周期

独立目录先通过排他的 `.desktop-instance.lock` 获得所有权，再打开数据库。`.desktop-data.json` 保存开发模式和稳定 installation ID。正常退出只移除自己持有的锁，不删除数据；损坏、未知、失联或遗留锁不会按 PID/时间自动接管。手工恢复前必须确认原进程已退出且无其他数据库写入者；本批尚无自动崩溃恢复工具。

本机 API 校验精确 Host、Origin 和 Fetch Metadata，不开放 CORS。身份只来源于账号服务，不接受前端 owner。Session 使用每实例随机命名的 HttpOnly、SameSite=Strict cookie；写请求另需 JSON、同源及 CSRF。普通 HTTP loopback 的 cookie 不设 Secure；Chrome/Edge 目标矩阵仍待独立验收。

该 loopback 安全模型不隔离同一用户下的恶意本机进程、扩展或设备管理员。`POST /api/dev/session` 已移除并固定返回 404，Fake Auth 只允许测试夹具显式注入，不是启动选项。

模型凭据保存在独立的 `private/model-secrets` AES-256-GCM 文件 vault，不与 MCP/Connector vault 共用。当前主密钥是同目录的受限权限文件，**不是 macOS Keychain / Windows DPAPI**，不能抵御同用户恶意程序或完整目录被盗。丢失主密钥时明确失败，不重新生成后覆盖旧密文。新配置提交后旧凭据清理失败会告警，不回滚到可能已删除的旧凭据；该告警仅在当前进程保留，尚无自动孤儿清理/恢复工具。

活动 HTTP 调用或 Run 阻止关闭；数据库已取消但执行协程尚未退出也不释放资源。使用 Ctrl+C / SIGTERM 关闭，若被活动任务拒绝，先等待或在页面取消，再次退出。没有 Web shutdown 接口。

## 验证与未完成事项

```sh
npm run typecheck --workspace agentloop-desktop
npm run test:desktop
npm run test:local-runtime
```

当前 Desktop 27 项、共享 Runtime 38 项、共享产物/Markdown 10 项通过，另有 Desktop 构建和严格 typecheck。覆盖真实 Kernel + 确定性模型、临时 SQLite、双进程单实例、重试/重启、事件游标、附件绑定、取消后 unwind、损坏数据保护、Session/CSRF 和静态资源边界。对话增量覆盖累积流文本、内部正文排除、重复/乱序批次、超过 200 事件后的历史计划、失败总结/取消、终态等待清理、产物分组、Markdown/XSS 和参考快照一致性。模型设置覆盖真实 loopback HTTP 的 Responses/Chat Completions → Kernel 测试、配置重开、版本冲突、活动执行拒绝修改、SQLite 提交失败回滚、主密钥丢失与提交后清理失败；扫描测试持久化文件和公开响应，不允许出现明文测试密钥。HTTP 域名/局域网配置测试使用合成凭据并禁止对外请求，不证明远程网关或真实模型可用。产物下载测试使用显式持久化文件/工具回执 fixture，不证明真实模型生成产物或最终交付。

`web/reference/` 为 Multi Runtime 纯展示函数的显式快照，有一致性测试，不引用其 Router、账户或传输代码。`web/conversation.css` 为对话样式快照；Markdown 从共享包通过 esbuild 在开发宿主启动时生成静态模块，不是运行时加载另一应用。发行版预构建打包仍待实现。手工对话验收可运行 `node apps/agentloop-desktop/tests/fixtures/conversation-preview.ts`（仓库根目录），仅创建独立临时目录并使用明确标记的确定性模型，绝不接入用户凭据或真实网关。

账号增量验收：Desktop 30/30、账号服务与客户端 4/4，新增 Router HTTP 共享账号集成 1/1；共享 Identity、账号服务与 Desktop 构建及 Desktop 严格 typecheck 通过。测试覆盖云端撤销、账号隔离、重启恢复、密码/Token 不落本机盘、缺失认证配置不回退、云端故障和身份变更。旧 Multi Runtime 仍为 397/410，13 个遗留失败无新增，不能称仓库全绿。上段 27 项为账号接入前状态。

浏览器账号验收使用全新临时目录、独立真实 HTTP 账号服务和确定性模型，通过注册、错误密码拒绝、正确登录、本机 Run 完成、退出与再次登录后恢复历史；不是云端部署或第三方真实模型验收。前批模型配置浏览器验收通过保存、脱敏重读、空白 Key 保留、无效参数拒绝、未保存关闭保护及约 388 CSS 像素窄屏布局。没有读取用户已有 Agent 数据。正式云部署、PKCE/refresh、Keychain、平台 Connector OAuth、安装包签名与 macOS/Windows 安装验收仍未完成。当前 Connector 设置和动态发现入口已实现，但尚未提供平台特定模块。静态资源启动时缓存，修改页面后需要重启 Desktop。
