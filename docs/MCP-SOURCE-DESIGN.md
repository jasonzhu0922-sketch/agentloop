# MCP ToolSource 设计

> 目标：把 MCP 当作一种可插拔的 ToolSource，而不是把协议逻辑塞进内核 Tool。
> 范围：App 侧注册文件、鉴权扩展、启动注入、失败语义、与内核的边界。

## 1. 设计目标

1. App 通过注册文件声明一个或多个 MCP server。
2. App 启动时自动读取固定注册文件 `apps/agentloop-app/config/mcp-servers.json`，构建 MCP 连接与鉴权。
3. 每个 MCP server 物化成一组 `RuntimeTool`，注入 `RunService.tools`。
4. 内核不认识 MCP 协议，只认识 `RuntimeTool`。
5. 鉴权保持可扩展，后续可接 bearer、API key、OAuth2、query param、custom provider。

## 2. 核心边界

```ts
interface ToolSource {
  materialize(): Promise<readonly RuntimeTool[]>;
  refresh?(): Promise<void>;
}

interface McpServerRegistration {
  key: string;
  transport: "http";
  url?: string;
  headers?: Record<string, string>;
  auth?: McpAuthConfig;
  trust?: "trusted" | "untrusted";
  timeoutMs?: number;
  toolAllowlist?: readonly string[];
  toolBlocklist?: readonly string[];
}

type McpAuthConfig =
  | { kind: "none" }
  | { kind: "bearer"; tokenEnv: string; audience?: string; scopes?: readonly string[] }
  | { kind: "headers"; headers: Record<string, string> }
  | { kind: "query"; name: string; secretEnv: string }
  | { kind: "oauth2"; clientIdEnv: string; scopes?: readonly string[]; audience?: string }
  | { kind: "custom"; provider: string; config: unknown };
```

约束：
- `ToolSource` 只负责产出工具，不负责规划、授权、Admission。
- `McpAuthConfig` 只描述“如何取凭据、如何注入”，不绑定某个 IdP。
- `custom` 预留给 App 自定义实现，避免以后再改 schema。

## 3. 注册文件

建议 App 使用固定文件 `apps/agentloop-app/config/mcp-servers.json`。

```json
{
  "defaultTrust": "untrusted",
  "servers": [
    {
      "key": "amap-maps",
      "transport": "http",
      "url": "https://mcp.amap.com/mcp?key=YOUR_KEY",
      "auth": {
        "kind": "query",
        "name": "key",
        "secretEnv": "AMAP_MCP_KEY"
      },
      "trust": "trusted",
      "timeoutMs": 15000
    }
  ]
}
```

语义：
- `key` 是命名空间前缀，最终工具名形如 `mcp_<key>_<toolName>`。
- `trust` 默认 `untrusted`，未显式授权时按危险工具处理。
- `toolAllowlist` / `toolBlocklist` 作为后续扩展点，可用于按 server 限制暴露工具。
- 当前 v1 先实现 HTTP transport；stdio 可作为后续扩展再补。

## 4. App 启动流程

1. `apps/agentloop-app/src/main.ts` 启动时自动读取 `apps/agentloop-app/config/mcp-servers.json`。
2. App 构建 `McpRegistry` 或 `McpSourceManager`。
3. 启动时建立 MCP 连接，执行 `tools/list`。
4. 将每个 MCP tool 包装成 `RuntimeTool`。
5. 把包装后的工具拼进 `RunService({ tools: [...] })`。
6. 调用时由 `McpAuthProvider` 注入 headers / query 参数。
7. server 失联时，只让该 server 的工具缺席，不让整个 Run 失败。

## 5. 官方样例映射

高德开放平台已经提供了一个成熟的 MCP Server 示例。它的文档给出的注册形态是 `mcpServers` 下配置一个 `url`，并在地址里携带 key，适合映射成我们的注册文件样式。

映射关系：

- 高德官方 `mcpServers` 条目
- 我们的 `McpServerRegistration`
- 高德的 key / token
- 我们的 `auth.kind: "query"` 或 `auth.kind: "headers"`，取决于服务端要求

这类 server 说明了一个重要事实：MCP server 的注册信息本身就可以由 App 管理，协议侧只负责暴露工具，不要求内核理解供应商身份体系。

参考：
- 高德 MCP Server 概述: https://developer.amap.com/api/mcp-server/summary
- 高德 MCP+通义灵码案例: https://developer.amap.com/api/mcp-server/application-case/tourism-planning

## 6. 失败语义

- 鉴权失败：该 server 失效，记录明确错误。
- 连接失败：该 server 工具本轮缺席。
- `tools/list` 失败：同上，按 source 级降级。
- 单工具调用失败：只返回对应 tool 的错误，不影响其他 tool。

## 7. 内核接入原则

内核只接受已经物化好的 `RuntimeTool[]`。
不新增 MCP 专用 Planner 分支。
不把协议状态写进 Run 记录。
不把某个 MCP server 的实现细节传播到模型提示词里。

## 8. 动态注册演进

当前实现先采用固定文件自动发现，控制面是 `apps/agentloop-app/config/mcp-servers.json`。后续要做动态注册时，不改变内核接口，只把这个文件控制面升级成 App 侧注册中心：

1. App 提供 MCP server 的增删改查 API。
2. 注册中心持久化同一份 `McpServerRegistration` schema。
3. `McpSourceManager` 监听配置变更，重新执行 `tools/list` 并刷新工具目录。
4. `RunService` 仍然只接收物化后的 `RuntimeTool[]` 或 App 刷新后的 tool catalog。
5. 鉴权实现仍留在 App 侧，支持从 env、KMS、用户授权、组织级凭据或自定义 provider 取值。

也就是说，动态注册只替换 App 侧 control plane，不把 MCP 协议状态下沉到 kernel。
