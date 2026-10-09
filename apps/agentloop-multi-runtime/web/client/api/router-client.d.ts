export function routerProxyPath(requestUrl: string, apiBaseUrl: string, pageUrl: string): string | undefined;
export interface RouterClient {
  url(path: string): string;
  request(path: string, init?: RequestInit): Promise<Response>;
  postJson(path: string, value: unknown, init?: RequestInit): Promise<Response>;
}
export function createRouterClient(input: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: () => string | undefined;
}): RouterClient;
