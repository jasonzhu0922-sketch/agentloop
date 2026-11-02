# AgentLoop Desktop（开发预览）

Desktop 是标准 `@zhujun/agentloop-local-runtime` 的独立宿主，不依赖 Multi Runtime 的 Router、配对或内部模块。前端沿用 Multi Runtime 的展示效果；目前只支持显式开发身份，不是可发行的账号登录版本。

## 启动

仓库依赖已安装，要求 Node.js 26+。在仓库根目录执行：

```sh
npm run build:desktop
npm run start:desktop -- --development
```

只监听 `127.0.0.1`，默认选择空闲端口并打开系统默认浏览器（建议 Chrome/Edge；失败时输出地址，服务保持可用）。可用 `--no-open` 禁用自动打开，`--data-dir /absolute/path/to/new-directory` 指定独立目录。重复启动相同目录只打开已有实例，不再次创建 Runtime。指定 Chrome 而非默认浏览器的启动策略尚未实现。

默认数据目录：

- macOS：`~/Library/Application Support/AgentLoop Desktop Development`
- Windows：`%LOCALAPPDATA%/AgentLoop Desktop Development`
- Linux 开发环境：`$XDG_DATA_HOME/agentloop-desktop-development`，未设置时使用 `~/.local/share`；不是本期安装包目标。

禁止指向已安装 Local Agent、其他应用或生产数据。非空且没有 Desktop 所有权标记的目录会被拒绝。

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

## 安全与生命周期

独立目录先通过排他的 `.desktop-instance.lock` 获得所有权，再打开数据库。`.desktop-data.json` 保存开发模式和稳定 installation ID。正常退出只移除自己持有的锁，不删除数据；损坏、未知、失联或遗留锁不会按 PID/时间自动接管。手工恢复前必须确认原进程已退出且无其他数据库写入者；本批尚无自动崩溃恢复工具。

本机 API 校验精确 Host、Origin 和 Fetch Metadata，不开放 CORS。开发身份仅由宿主固定注入，不接受前端 owner。Session 使用每实例随机命名的 HttpOnly、SameSite=Strict cookie；写请求另需 JSON、同源及 CSRF。普通 HTTP loopback 的 cookie 不设 Secure；Chrome/Edge 目标矩阵仍待独立验收。

该 loopback 安全模型不隔离同一用户下的恶意本机进程、扩展或设备管理员。部署时不能把开发身份当真实用户认证。`POST /api/dev/session` 不等于 Fake Auth / PKCE / CloudAuthPort。

模型凭据保存在独立的 `private/model-secrets` AES-256-GCM 文件 vault，不与 MCP/Connector vault 共用。当前主密钥是同目录的受限权限文件，**不是 macOS Keychain / Windows DPAPI**，不能抵御同用户恶意程序或完整目录被盗。丢失主密钥时明确失败，不重新生成后覆盖旧密文。新配置提交后旧凭据清理失败会告警，不回滚到可能已删除的旧凭据；该告警仅在当前进程保留，尚无自动孤儿清理/恢复工具。

活动 HTTP 调用或 Run 阻止关闭；数据库已取消但执行协程尚未退出也不释放资源。使用 Ctrl+C / SIGTERM 关闭，若被活动任务拒绝，先等待或在页面取消，再次退出。没有 Web shutdown 接口。

## 验证与未完成事项

```sh
npm run typecheck --workspace agentloop-desktop
npm run test:desktop
npm run test:local-runtime
```

当前 Desktop 27 项、共享 Runtime 37 项、共享产物/Markdown 10 项通过，另有 Desktop 构建和严格 typecheck。覆盖真实 Kernel + 确定性模型、临时 SQLite、双进程单实例、重试/重启、事件游标、附件绑定、取消后 unwind、损坏数据保护、Session/CSRF 和静态资源边界。对话增量覆盖累积流文本、内部正文排除、重复/乱序批次、超过 200 事件后的历史计划、失败总结/取消、终态等待清理、产物分组、Markdown/XSS 和参考快照一致性。模型设置覆盖真实 loopback HTTP 的 Responses/Chat Completions → Kernel 测试、配置重开、版本冲突、活动执行拒绝修改、SQLite 提交失败回滚、主密钥丢失与提交后清理失败；扫描测试持久化文件和公开响应，不允许出现明文测试密钥。HTTP 域名/局域网配置测试使用合成凭据并禁止对外请求，不证明远程网关或真实模型可用。产物下载测试使用显式持久化文件/工具回执 fixture，不证明真实模型生成产物或最终交付。

`web/reference/` 为 Multi Runtime 纯展示函数的显式快照，有一致性测试，不引用其 Router、账户或传输代码。`web/conversation.css` 为对话样式快照；Markdown 从共享包通过 esbuild 在开发宿主启动时生成静态模块，不是运行时加载另一应用。发行版预构建打包仍待实现。手工对话验收可运行 `node apps/agentloop-desktop/tests/fixtures/conversation-preview.ts`（仓库根目录），仅创建独立临时目录并使用明确标记的确定性模型，绝不接入用户凭据或真实网关。

浏览器验收使用临时独立目录与本机 HTTP 协议夹具，完成设置保存、脱敏重读、空白 Key 保留、无效参数拒绝、未保存关闭保护及 Run 完成；约 388 CSS 像素宽度下检查弹窗无横向溢出。没有读取用户已有 Agent 数据，也没有真实第三方模型凭据/兼容性验收。真实云端认证、Keychain、Connector 设置/动态发现入口、完整 UI 语义、安装包签名与 macOS/Windows 安装验收仍未完成。静态资源启动时缓存，修改页面后需要重启 Desktop。
