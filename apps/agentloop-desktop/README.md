# AgentLoop Desktop

agentloop-desktop 是一个本机单机应用入口：

- 启动后自动打开 Chrome；
- Web 页面和 HTTP API 只监听 loopback；
- Local Agent 由本应用托管或连接到外部 Local Agent；
- 多 Runtime 的创建、启停、配置和本地 Run 由 Local Agent 提供；
- 对话、Run、文件和产物留在本机；
- 云端只作为后续账号、设备和 Token 服务接入点。

## 启动

从仓库根目录执行：

~~~bash
npm run start --workspace agentloop-desktop
~~~

默认打开 http://127.0.0.1:5176/，并启动 apps/agentloop-multi-runtime/local-agent-runtime/src/main.ts，Local Agent 默认监听 127.0.0.1:8790。

## 配置

| 变量 | 作用 |
|---|---|
| AGENTLOOP_DESKTOP_PORT | Desktop Web/API 端口，默认 5176 |
| AGENTLOOP_DESKTOP_OPEN_BROWSER=0 | 禁止自动打开浏览器 |
| AGENTLOOP_DESKTOP_MANAGE_LOCAL_AGENT=0 | 使用外部 Local Agent |
| AGENTLOOP_LOCAL_AGENT_ENTRY | 指定 Local Agent 入口 |
| LOCAL_AGENT_URL | Local Agent 地址，默认 http://127.0.0.1:8790 |
| AGENTLOOP_DESKTOP_DATA_ROOT | 本机数据根目录 |
| AGENTLOOP_DESKTOP_LOCAL_SESSION | 开发联调时注入的 Local Agent Session |
| AGENTLOOP_CLOUD_AUTH_URL | 云端账号服务地址（当前仅暴露配置状态） |

Desktop App 不保存云端账号密码，也不把本机文件路径、Skill、Connector 凭据发送到云端。账号登录、Token 签发和设备注册会在后续 CloudAuthPort 接入中完成。
