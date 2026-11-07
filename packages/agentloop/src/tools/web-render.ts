import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { chromium, type Route } from "playwright-core";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(address, prefix, "ipv6");

const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_REQUESTS = 100;

export async function renderWebPage(url: string, options: { timeoutMs: number; allowPrivateTargets: boolean }): Promise<{ url: string; html: string; incomplete: boolean }> {
  // An unreachable proxy prevents browser networking that is not intercepted by route.
  const browser = await chromium.launch({ channel: "chrome", headless: true,
    proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
    args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  let total = 0;
  let requests = 0;
  let incomplete = false;
  try {
    await context.routeWebSocket("**/*", socket => { socket.close(); incomplete = true; });
    await context.route("**/*", async (route: Route) => {
      try {
        if (++requests > MAX_REQUESTS || total >= MAX_TOTAL_BYTES) throw new Error("render request limit exceeded");
        const request = route.request();
        if (request.method() !== "GET" && request.method() !== "HEAD") throw new Error("render allows only GET and HEAD requests");
        const resource = await fetchResource(request.url(), request.method(), options);
        if (resource.status >= 400) incomplete = true;
        total += resource.body.length;
        if (total > MAX_TOTAL_BYTES) throw new Error("render response size limit exceeded");
        await route.fulfill(resource);
      } catch {
        incomplete = true;
        await route.abort().catch(() => undefined);
      }
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    if (!response || !response.ok()) throw new Error(`browser navigation failed${response ? `: HTTP ${response.status()}` : ""}`);
    await page.waitForLoadState("networkidle", { timeout: Math.min(options.timeoutMs, 5000) }).catch(() => { incomplete = true; });
    const html = await page.content();
    if (Buffer.byteLength(html) > MAX_RESOURCE_BYTES) throw new Error("rendered page exceeds size limit");
    return { url: page.url(), html, incomplete };
  } finally {
    await browser.close();
  }
}

async function fetchResource(raw: string, method: string, options: { timeoutMs: number; allowPrivateTargets: boolean }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(raw);
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) throw new Error("invalid resource URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || (!options.allowPrivateTargets && addresses.some(({ address, family }) => blocked.check(address, family === 4 ? "ipv4" : "ipv6")))) throw new Error("resource address is not public");
  const selected = addresses[0]!;
  return await new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method, headers: { "accept-encoding": "identity", "user-agent": "Mozilla/5.0 (compatible; AgentLoop/1.0)" },
      lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
      signal: AbortSignal.timeout(options.timeoutMs),
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESOURCE_BYTES) req.destroy(new Error("resource exceeds size limit"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !["transfer-encoding", "connection", "content-length", "set-cookie"].includes(name)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
