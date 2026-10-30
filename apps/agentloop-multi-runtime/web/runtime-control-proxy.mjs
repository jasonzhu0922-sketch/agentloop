import { request as httpRequest } from "node:http";

// Fixed host operation over a dedicated socket. Neither a Docker socket nor
// the host credential is exposed to the Web container or browser bundle.
export async function proxyRuntimeControl(request, response, socketPath, path = "/runtime-reload") {
  if (!["/runtime-reload", "/model-configuration", "/mcp-configuration", "/skill-configuration"].includes(path)) return reply(response, 404, "not_found");
  if (!["GET", "POST", "DELETE"].includes(request.method)) return reply(response, 405, "method_not_allowed");
  if (!socketPath) return reply(response, 503, "runtime_control_not_configured");
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return reply(response, 401, "operator_unauthorized");
  const acceptsBody = (path === "/model-configuration" && request.method === "POST") || (path === "/mcp-configuration" && request.method === "POST") || (path === "/skill-configuration" && ["POST", "DELETE"].includes(request.method));
  if (!acceptsBody && (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0)) return reply(response, 400, "body_not_allowed");
  const chunks = [];
  let size = 0;
  if (acceptsBody) {
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > (path === "/skill-configuration" ? 128 * 1024 * 1024 : 2 * 1024 * 1024)) return reply(response, 413, path === "/skill-configuration" ? "skill_package_too_large" : "configuration_too_large");
        chunks.push(chunk);
      }
    } catch { return reply(response, 400, "invalid_configuration_request"); }
  }
  const upstream = httpRequest({ socketPath, path, method: request.method,
    headers: { authorization, "content-type": "application/json", "content-length": String(size) } }, (result) => {
    response.writeHead(result.statusCode ?? 502, { "content-type": "application/json", "cache-control": "no-store" });
    result.pipe(response);
  });
  upstream.setTimeout(5000, () => upstream.destroy());
  upstream.once("error", () => {
    if (response.headersSent) response.destroy();
    else reply(response, 503, "runtime_control_unavailable");
  });
  upstream.end(Buffer.concat(chunks));
}

function reply(response, status, error) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error }));
}
