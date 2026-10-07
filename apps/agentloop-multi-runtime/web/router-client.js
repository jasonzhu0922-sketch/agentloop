/** Browser-side Router transport. It owns Router URL and bearer attachment, never UI state. */
export function routerProxyPath(requestUrl, apiBaseUrl, pageUrl) {
  const resolvedRequest = new URL(requestUrl, pageUrl);
  const resolvedApi = new URL(apiBaseUrl, pageUrl);
  if (resolvedRequest.origin !== resolvedApi.origin) return undefined;
  const apiPath = resolvedApi.pathname.replace(/\/+$/, "") || "/";
  const requestPath = apiPath === "/" ? resolvedRequest.pathname : resolvedRequest.pathname.startsWith(apiPath)
    ? resolvedRequest.pathname.slice(apiPath.length) || "/"
    : resolvedRequest.pathname;
  return requestPath + resolvedRequest.search;
}

export function createRouterClient({ baseUrl, fetchImpl = fetch, tokenProvider = () => undefined }) {
  const root = String(baseUrl).replace(/\/+$/, "");
  return {
    url(path) { return `${root}${path}`; },
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      const token = tokenProvider();
      if (typeof token === "string" && token.length > 0) headers.set("authorization", `Bearer ${token}`);
      return await fetchImpl(`${root}${path}`, { ...init, headers });
    },
    async postJson(path, value, init = {}) {
      const headers = new Headers(init.headers);
      headers.set("content-type", "application/json");
      return await this.request(path, { ...init, method: "POST", headers, body: JSON.stringify(value) });
    },
  };
}
