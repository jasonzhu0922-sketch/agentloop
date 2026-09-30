export interface AdminApiHealth {
  readonly status: "ok";
  readonly service: "agentloop-admin-api";
  readonly phase: "wp-1-release-core";
}

/** Transport-only health response. It has no database, Router, or Runtime dependency. */
export function adminApiHealth(): AdminApiHealth {
  return { status: "ok", service: "agentloop-admin-api", phase: "wp-1-release-core" };
}
