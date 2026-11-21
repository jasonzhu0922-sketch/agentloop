type StartupError = Error & {
  code?: string;
  syscall?: string;
  address?: string;
  port?: number;
};

function asStartupError(error: unknown): StartupError | undefined {
  return error instanceof Error ? error as StartupError : undefined;
}

function endpointFromUrl(stateUrl: string | undefined): string | undefined {
  if (!stateUrl) return undefined;
  try {
    const parsed = new URL(stateUrl);
    return `${parsed.hostname}:${parsed.port || "4000"}`;
  } catch {
    return undefined;
  }
}

function redactMessage(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/giu, "<url>");
}

/** Turn low-level startup failures into an actionable, credential-free message. */
export function describeStartupError(error: unknown, stateUrl?: string): string {
  const detail = asStartupError(error);
  const message = error instanceof Error ? error.message : String(error);
  const code = detail?.code;
  const isConnectFailure = detail?.syscall === "connect" || /^connect\s/i.test(message);
  const endpoint = detail?.address
    ? `${detail.address}${detail.port ? `:${detail.port}` : ""}`
    : endpointFromUrl(stateUrl) ?? "configured TiDB";

  if (code === "DATA_AGENT_HOST_ACTIVE") {
    return `${redactMessage(message)}。请确认没有另一个 data-agent 进程使用同一 TiDB Runtime；如果刚刚异常退出，请等待租约自动过期后重试。`;
  }

  if (isConnectFailure && code === "EPERM") {
    return `TiDB 连接被当前进程拒绝（EPERM）：${endpoint}。请在允许 Node 出站网络的终端运行，或检查本机网络安全策略。`;
  }
  if (isConnectFailure && code === "EACCES") {
    return `TiDB 连接没有权限（EACCES）：${endpoint}。请检查本机防火墙、VPN 或网络安全策略。`;
  }
  if (isConnectFailure && code === "ECONNREFUSED") {
    return `TiDB 拒绝连接（ECONNREFUSED）：${endpoint}。请确认 TiDB 正在监听该地址和端口。`;
  }
  if (isConnectFailure && (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH")) {
    return `无法到达 TiDB（${code}）：${endpoint}。请检查内网路由、VPN 和防火墙。`;
  }
  if (isConnectFailure && (code === "ENOTFOUND" || code === "EAI_AGAIN")) {
    return `无法解析 TiDB 地址（${code}）：${endpoint}。请检查主机名和 DNS。`;
  }
  return `启动阶段异常${code ? `（${code}）` : ""}：${redactMessage(message)}`;
}

