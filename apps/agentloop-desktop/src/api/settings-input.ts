import type { LocalRuntimeConfigurationInput, LocalRuntimeMcpServerInput, SkillImportFile } from "@zhujun/agentloop-local-runtime";
import { HttpError } from "../security/loopback.ts";

export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new HttpError(400, "settings_input_invalid");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 200, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, "settings_input_invalid");
}
function strings(value: unknown, max = 100) {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, "settings_input_invalid");
  for (const v of value) string(v);
}
export function mcpInput(value: unknown): LocalRuntimeMcpServerInput {
  const s = record(value, ["id", "displayName", "key", "transport", "url", "protocolVersion", "timeoutMs", "auth", "toolAllowlist", "toolBlocklist", "trust", "aliases", "capabilities"]);
  string(s.id, 200, true); string(s.displayName, 100); string(s.key); string(s.url, 4096); string(s.protocolVersion, 100, true);
  if (s.transport !== "http" || (s.timeoutMs !== undefined && (!Number.isSafeInteger(s.timeoutMs) || Number(s.timeoutMs) < 100 || Number(s.timeoutMs) > 60_000))) throw new HttpError(400, "mcp_configuration_invalid");
  let endpoint: URL; try { endpoint = new URL(s.url as string); } catch { throw new HttpError(400, "mcp_configuration_invalid"); }
  // URLs are public metadata: credentials belong only in the auth input.
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new HttpError(400, "mcp_url_must_not_contain_credentials_or_query");
  for (const k of ["toolAllowlist", "toolBlocklist", "aliases"]) if (s[k] !== undefined) strings(s[k]);
  if (s.trust !== undefined && !["trusted", "untrusted"].includes(s.trust as string)) throw new HttpError(400, "mcp_configuration_invalid");
  if (s.capabilities !== undefined && (!Array.isArray(s.capabilities) || s.capabilities.length > 30)) throw new HttpError(400, "mcp_configuration_invalid");
  const a = record(s.auth, ["kind", "token", "value", "password", "headerName", "username", "parameterName", "headers", "headerNames"]);
  const authFields: Record<string, string[]> = { none: [], bearer: ["token"], api_key_header: ["headerName", "value"], basic: ["username", "password"], query_parameter: ["parameterName", "value"], custom_headers: ["headers", "headerNames"] };
  if (typeof a.kind !== "string" || !Object.hasOwn(authFields, a.kind)) throw new HttpError(400, "mcp_configuration_invalid");
  record(a, ["kind", ...authFields[a.kind]!]);
  for (const k of ["token", "value", "password"]) string(a[k], 16000, true);
  for (const k of ["headerName", "parameterName"]) if (a.kind === (k === "headerName" ? "api_key_header" : "query_parameter")) {
    string(a[k]); if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(a[k] as string)) throw new HttpError(400, "mcp_configuration_invalid");
  }
  if (a.kind === "basic") string(a.username);
  if (a.kind === "custom_headers") {
    if (a.headerNames !== undefined) strings(a.headerNames, 20);
    if (a.headers !== undefined) {
      const h = a.headers;
      if (!h || typeof h !== "object" || Array.isArray(h) || Object.keys(h).length > 20) throw new HttpError(400, "mcp_configuration_invalid");
      for (const [k, v] of Object.entries(h)) { if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(k)) throw new HttpError(400, "mcp_configuration_invalid"); string(v, 16000); }
    }
  }
  return s as unknown as LocalRuntimeMcpServerInput;
}
export function configurationInput(value: unknown): LocalRuntimeConfigurationInput {
  const c = record(value, ["skillPackageIds", "mcpServers"]);
  if (!Array.isArray(c.skillPackageIds) || c.skillPackageIds.length > 200) throw new HttpError(400, "settings_input_invalid");
  for (const id of c.skillPackageIds) string(id);
  if (!Array.isArray(c.mcpServers) || c.mcpServers.length > 30) throw new HttpError(400, "settings_input_invalid");
  return { skillPackageIds: c.skillPackageIds as string[], mcpServers: c.mcpServers.map(mcpInput) };
}
function base64(value: unknown, max: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || value.length % 4 !== 0) throw new HttpError(400, "skill_content_invalid");
  const content = Buffer.from(value, "base64");
  if (content.length > max || content.toString("base64") !== value) throw new HttpError(400, "skill_content_invalid");
  return content;
}
export function skillImportInput(body: Record<string, unknown>): { files: SkillImportFile[] } | { zip: Buffer } {
  record(body, ["files", "zipBase64"]);
  if (body.zipBase64 !== undefined) { if (body.files !== undefined) throw new HttpError(400, "settings_input_invalid"); return { zip: base64(body.zipBase64, 16 * 1024 * 1024) }; }
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > 1000) throw new HttpError(400, "settings_input_invalid");
  let total = 0;
  const files = body.files.map(file => { const f = record(file, ["path", "contentBase64"]); string(f.path, 1000); const content = base64(f.contentBase64, 8 * 1024 * 1024); total += content.length; return { path: f.path as string, content }; });
  if (total > 32 * 1024 * 1024) throw new HttpError(413, "body_too_large");
  return { files };
}
