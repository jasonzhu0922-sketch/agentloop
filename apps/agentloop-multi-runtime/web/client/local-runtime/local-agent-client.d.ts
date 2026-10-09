export interface LocalAgentSession {
  ensureValid(): Promise<void>;
  token(): string;
  refresh(): Promise<unknown>;
}
export interface LocalAgentClient {
  health(init?: RequestInit): Promise<Response>;
  register(registrationToken: string): Promise<Response>;
  request(path: string, init?: RequestInit): Promise<Response>;
}
export function createLocalAgentClient(input: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  session: LocalAgentSession;
}): LocalAgentClient;
