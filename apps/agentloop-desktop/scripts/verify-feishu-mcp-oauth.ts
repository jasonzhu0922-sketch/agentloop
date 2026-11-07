import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOAuth } from "../../../packages/agentloop-local-runtime/src/mcp/mcp-oauth.ts";
import { EncryptedLocalRuntimeSecretStore } from "../../../packages/agentloop-local-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { loadMcpToolsFromConfig } from "../../../packages/agentloop/src/mcp/mcp-loader.ts";

// Diagnostic host only: tokens stay in a temporary encrypted local vault.
// No app secret, pasted token, or provider-specific tool schema is used.
const origin = "http://127.0.0.1:19174";
const oauth = new McpOAuth("https://mcp.feishu.cn/mcp");
const secrets = new EncryptedLocalRuntimeSecretStore(join(await mkdtemp(join(tmpdir(), "agentloop-mcp-oauth-")), "secrets"));
const attempt = await oauth.start("local-verification", `${origin}/oauth/callback`, [
  "mcp-tool:common:get-user", "mcp-tool:docs:search-doc", "mcp-tool:docs:fetch-doc", "offline_access",
]);
let status = "awaiting_authorization";
const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  if (request.headers.host !== new URL(origin).host) { response.writeHead(403); response.end(); return; }
  const url = new URL(request.url!, origin);
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  if (url.pathname === "/status") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status })); return; }
  if (url.pathname === "/oauth/callback") {
    try {
      const grant = await oauth.complete("local-verification", url);
      await secrets.write({ grant: JSON.stringify(grant) });
      const integration = await loadMcpToolsFromConfig({ servers: [{ key: "feishu-oauth-verification", displayName: "飞书",
        transport: "http", url: grant.resource, headers: { authorization: `Bearer ${grant.accessToken}` } }] });
      if (integration.failedServers.length || !integration.tools.length) throw new Error("mcp_discovery_failed");
      status = `authorized_tools_${integration.tools.length}`;
      console.log(JSON.stringify({ status, tools: integration.tools.map(tool => ({ name: tool.source?.toolName, inputSchema: tool.inputSchema })) }));
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<h1>飞书授权成功</h1><p>已通过通用 MCP 链路发现 ${integration.tools.length} 个工具。凭证已加密保存在本机测试目录。</p>`);
    } catch (error) {
      status = "authorization_or_discovery_failed";
      console.error(error instanceof Error ? error.message : status);
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); response.end("验证未完成，请查看本机诊断摘要。");
    }
    return;
  }
  if (url.pathname !== "/") { response.writeHead(404); response.end(); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<html lang="zh"><meta charset="utf-8"><title>AgentLoop 飞书 OAuth 验证</title><style>body{font:18px system-ui;max-width:720px;margin:80px auto;padding:24px}a{display:inline-block;padding:14px;background:#2468ef;color:white;border-radius:8px}</style><h1>绑定飞书 · 官方 MCP OAuth</h1><p>登录飞书后，仅申请查看本人基本信息、搜索和读取文档，以及保持连接。没有创建或修改文档权限。</p><p>凭证只在本机保存，不显示在页面或聊天中。</p><a href="${attempt.authorizationUrl.replaceAll("&", "&amp;")}">前往飞书登录并授权</a></html>`);
});
server.listen(19174, "127.0.0.1", () => console.log(`Feishu MCP OAuth verification: ${origin}`));
// The authorization state is intentionally short lived; restarting creates a
// fresh PKCE attempt. Do not leave an expired callback listener behind.
setTimeout(() => server.close(), 600_000).unref();
