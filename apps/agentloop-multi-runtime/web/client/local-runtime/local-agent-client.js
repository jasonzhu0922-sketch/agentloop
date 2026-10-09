/** Loopback Local Agent transport. The caller owns device selection; this client owns session retry. */
export function createLocalAgentClient({ baseUrl, fetchImpl = fetch, session }) {
  const root = String(baseUrl).replace(/\/+$/, "");
  return {
    async health(init = {}) { return await fetchImpl(`${root}/healthz`, { ...init, cache: "no-store" }); },
    async register(registrationToken) {
      return await fetchImpl(`${root}/v1/device-registration`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registrationToken }),
      });
    },
    async request(path, init = {}) {
      await session.ensureValid();
      const send = async () => {
        const headers = new Headers(init.headers);
        headers.set("x-local-session", session.token());
        return await fetchImpl(`${root}${path}`, { ...init, headers });
      };
      let response = await send();
      if (response.status !== 401) return response;
      const body = await response.clone().json().catch(() => ({}));
      if (body.error !== "local_session_invalid" && body.error !== "local_session_required") return response;
      await session.refresh();
      response = await send();
      return response;
    },
  };
}
