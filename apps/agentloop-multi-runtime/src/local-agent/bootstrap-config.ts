import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LocalAgentBootstrapConfig {
  readonly schema: "agentloop.localAgentBootstrap/v1";
  readonly routerUrl?: string;
  readonly webOrigin?: string;
}

export async function readLocalAgentBootstrapConfig(path: string): Promise<LocalAgentBootstrapConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("local_agent_bootstrap_invalid");
    const config = value as Record<string, unknown>;
    return {
      schema: "agentloop.localAgentBootstrap/v1",
      ...(config.routerUrl === undefined ? {} : { routerUrl: routerUrl(config.routerUrl) }),
      ...(config.webOrigin === undefined ? {} : { webOrigin: webOrigin(config.webOrigin) }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: "agentloop.localAgentBootstrap/v1" };
    throw error;
  }
}

export async function writeLocalAgentBootstrapConfig(path: string, input: { readonly routerUrl: string; readonly webOrigin?: string }): Promise<LocalAgentBootstrapConfig> {
  const config: LocalAgentBootstrapConfig = {
    schema: "agentloop.localAgentBootstrap/v1",
    routerUrl: routerUrl(input.routerUrl),
    ...(input.webOrigin === undefined ? {} : { webOrigin: webOrigin(input.webOrigin) }),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.${randomUUID()}.tmp`;
  await writeFile(pending, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(pending, 0o600);
  await rename(pending, path);
  await chmod(path, 0o600);
  return config;
}

function routerUrl(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("local_agent_router_url_invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("local_agent_router_url_invalid");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new TypeError("local_agent_router_url_invalid");
  return url.toString();
}

function webOrigin(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("local_agent_web_origin_invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("local_agent_web_origin_invalid");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new TypeError("local_agent_web_origin_invalid");
  return url.origin;
}
