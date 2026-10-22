export const DEVELOPMENT_LOCAL_AGENT_PORT = 8790;
export const PACKAGED_LOCAL_AGENT_PORT = 18790;

export function localAgentPort(packaged = false, environment = process.env) {
  const port = Number(environment.LOCAL_AGENT_PORT ?? (packaged ? PACKAGED_LOCAL_AGENT_PORT : DEVELOPMENT_LOCAL_AGENT_PORT));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LOCAL_AGENT_PORT must be a positive integer no greater than 65535");
  }
  return port;
}

// The URL is resolved on the Web server: browsers must never probe both Agents
// and accidentally pair a production account with the development process.
export function localAgentUrl(environment = process.env) {
  return environment.LOCAL_AGENT_URL ?? `http://127.0.0.1:${localAgentPort(environment.NODE_ENV === "production", environment)}`;
}
