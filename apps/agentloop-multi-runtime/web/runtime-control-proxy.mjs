import { request as httpRequest } from "node:http";

// Fixed host operation over a dedicated socket. Neither a Docker socket nor
// the host credential is exposed to the Web container or browser bundle.
export function proxyRuntimeControl(request, response, socketPath) {
  if (!["GET", "POST"].includes(request.method)) return reply(response, 405, "method_not_allowed");
  if (!socketPath) return reply(response, 503, "runtime_control_not_configured");
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return reply(response, 401, "operator_unauthorized");
  if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) return reply(response, 400, "body_not_allowed");
  const upstream = httpRequest({ socketPath, path: "/runtime-reload", method: request.method,
    headers: { authorization, "content-length": "0" } }, (result) => {
    response.writeHead(result.statusCode ?? 502, { "content-type": "application/json", "cache-control": "no-store" });
    result.pipe(response);
  });
  upstream.setTimeout(5000, () => upstream.destroy());
  upstream.once("error", () => {
    if (response.headersSent) response.destroy();
    else reply(response, 503, "runtime_control_unavailable");
  });
  upstream.end();
}

function reply(response, status, error) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error }));
}
