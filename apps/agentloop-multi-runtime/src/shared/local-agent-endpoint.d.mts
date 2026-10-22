type Environment = Readonly<Record<string, string | undefined>>;
export const DEVELOPMENT_LOCAL_AGENT_PORT: number;
export const PACKAGED_LOCAL_AGENT_PORT: number;
export function localAgentPort(packaged?: boolean, environment?: Environment): number;
export function localAgentUrl(environment?: Environment): string;
