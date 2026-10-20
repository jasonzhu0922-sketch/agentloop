import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, AddressInfo } from "node:net";
import test from "node:test";
import { createRouterHttpServer } from "../src/router/api/router-api.ts";
import { IdentityError } from "../src/router/identity/service.ts";
import { localAgentReleaseSource, orderedLocalAgentReleases, parseLocalAgentReleases } from "../src/router/releases/local-agent-releases.ts";
import { createWebServer, staticFilePath } from "../web/server.mjs";
import { detectInstallerDevice, installerGroups, recommendedInstaller, safeInstallerUrl } from "../web/client/local-runtime/release-selection.js";

const release = {
  platform: "darwin", arch: "arm64", version: "1.2.0", protocolVersion: "1", fileName: "AgentLoop-macos-arm64.pkg",
  size: 1234, publishedAt: "2026-10-20T09:00:00Z", downloadUrl: "/downloads/local-agent/release-1/AgentLoop-macos-arm64.pkg",
  sha256: "a".repeat(64), signature: "ad-hoc app; unsigned installer",
};
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: import("node:http").Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

test("device hints recommend exact 64-bit matches without guessing Safari Intel or mobile Mac", async () => {
  const safari = await detectInstallerDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 });
  assert.deepEqual(safari, { platform: "darwin", arch: "unknown" });
  const ipad = await detectInstallerDevice({ userAgent: "Macintosh", maxTouchPoints: 5 });
  assert.equal(ipad.platform, "unsupported");
  for (const [platform, architecture, bitness, expected] of [["macOS", "arm", "64", "arm64"], ["Windows", "x86", "64", "x64"], ["Windows", "x86", "32", "unknown"]]) {
    const device = await detectInstallerDevice({ userAgentData: { platform, async getHighEntropyValues() { return { architecture, bitness }; } } });
    assert.equal(device.arch, expected);
  }
  const declined = await detectInstallerDevice({ userAgent: "Windows", userAgentData: { async getHighEntropyValues() { throw new Error("denied"); } } });
  assert.equal(declined.arch, "unknown");
  assert.equal(recommendedInstaller({ ...release, isLatest: true }, safari), false);
  assert.equal(recommendedInstaller({ ...release, isLatest: true }, { platform: "darwin", arch: "arm64" }), true);
  assert.equal(recommendedInstaller({ ...release, isLatest: false }, { platform: "darwin", arch: "arm64" }), false);
});

test("release catalog validates installer metadata, chooses latest deterministically and keeps history", () => {
  const old = { ...release, version: "1.1.0", publishedAt: "2026-10-19T09:00:00Z" };
  const releases = orderedLocalAgentReleases(parseLocalAgentReleases(JSON.stringify([old, release])));
  assert.equal(releases[0].version, "1.2.0"); assert.equal(releases[0].isLatest, true); assert.equal(releases[1].isLatest, false);
  assert.equal(installerGroups(releases)[0].history.length, 1);
  assert.equal(installerGroups(releases).find(item => item.platform === "windows")?.current, undefined);
  assert.equal(installerGroups(releases, { platform: "windows", arch: "x64" }).length, 1);
  for (const change of [{ downloadUrl: "http://other.example/agent.pkg" }, { downloadUrl: "javascript:alert(1)" }, { downloadUrl: "/downloads/local-agent/../secrets.pkg" }, { downloadUrl: "/downloads/local-agent/%2e%2e/secrets.pkg" }, { sha256: "missing" }, { fileName: "source.zip" }, { size: 0 }, { publishedAt: "yesterday" }]) {
    assert.throws(() => parseLocalAgentReleases(JSON.stringify([{ ...release, ...change }])));
  }
  assert.throws(() => parseLocalAgentReleases(JSON.stringify([release, release])), /Duplicate/);
  assert.throws(() => parseLocalAgentReleases(JSON.stringify([{ ...release, platform: "linux" }])), /platform/);
  assert.equal(safeInstallerUrl("javascript:alert(1)", "http://localhost:3001"), undefined);
  assert.equal(safeInstallerUrl(release.downloadUrl, "http://localhost:3001"), `http://localhost:3001${release.downloadUrl}`);
  assert.equal(safeInstallerUrl("https://cdn.example/agent.pkg", "http://localhost:3001"), "https://cdn.example/agent.pkg");
});

test("public catalog updates without restart; invalid publication fails visibly and business API stays authenticated", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-catalog-"));
  const manifest = join(root, "releases.json");
  await writeFile(manifest, JSON.stringify([release]));
  const source = localAgentReleaseSource({ LOCAL_AGENT_RELEASES_FILE: manifest });
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  const server = createRouterHttpServer({ async submit() { throw new Error("unused"); }, async assignment() { return undefined; } }, { localAgentReleaseSource: source, identity: { register: unused, login: unused, revoke: unused, async authenticate() { throw new IdentityError(401, "unauthorized", "Login required"); } } });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/v1/local-agent/releases`);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).releases[0].isLatest, true);
    await writeFile(manifest, "[]");
    assert.deepEqual((await (await fetch(`${base}/v1/local-agent/releases`)).json()).releases, []);
    await writeFile(manifest, "broken JSON");
    assert.equal((await fetch(`${base}/v1/local-agent/releases`)).status, 503);
    assert.equal((await fetch(`${base}/v1/devices`)).status, 401);
    assert.throws(() => localAgentReleaseSource({ LOCAL_AGENT_RELEASES_FILE: manifest, LOCAL_AGENT_RELEASES_JSON: "[]" }), /only one/);
  } finally { await close(server); await rm(root, { recursive: true, force: true }); }
});

test("Web serves versioned installers with HEAD/range support and confines files to its download mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-installers-"));
  await mkdir(join(root, "release-1"));
  await writeFile(join(root, "release-1", "agent.pkg"), "0123456789");
  await writeFile(join(root, "release-1", "credentials.json"), "never serve");
  const outside = await mkdtemp(join(tmpdir(), "agentloop-outside-"));
  await writeFile(join(outside, "secret.pkg"), "never serve");
  await symlink(join(outside, "secret.pkg"), join(root, "release-1", "escape.pkg"));
  const server = createWebServer({ installerDirectory: root });
  try {
    const base = await listen(server);
    const url = `${base}/downloads/local-agent/release-1/agent.pkg`;
    const response = await fetch(url); assert.equal(await response.text(), "0123456789");
    assert.match(response.headers.get("content-disposition")!, /attachment; filename="agent.pkg"/);
    assert.match(response.headers.get("cache-control")!, /immutable/);
    const head = await fetch(url, { method: "HEAD" }); assert.equal(head.headers.get("content-length"), "10"); assert.equal(await head.text(), "");
    const range = await fetch(url, { headers: { range: "bytes=2-5" } }); assert.equal(range.status, 206); assert.equal(await range.text(), "2345");
    assert.equal((await fetch(url, { headers: { range: "bytes=90-100" } })).status, 416);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    for (const file of ["escape.pkg", "credentials.json", "missing.msi", "%2e%2e%2fsecret.pkg"]) assert.equal((await fetch(`${base}/downloads/local-agent/release-1/${file}`)).status, 404);
    assert.equal((await fetch(`${base}/downloads`)).status, 200);
    assert.equal(staticFilePath("/downloads/")?.endsWith("/pages/downloads.html"), true);
    assert.equal(staticFilePath("/%2e%2e/package.json"), undefined);
    assert.match(await readFile(staticFilePath("/downloads")!, "utf8"), /installer-grid/);
  } finally { await close(server); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("publisher appends immutable versions, rejects replacement and refuses archive files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-publisher-"));
  try {
    const first = join(root, "first.pkg");
    const replacement = join(root, "replacement.pkg");
    const archive = join(root, "source.zip");
    await writeFile(first, Buffer.concat([Buffer.from("xar!"), Buffer.from("first installer payload")]));
    await writeFile(replacement, Buffer.concat([Buffer.from("xar!"), Buffer.from("replacement payload")]));
    await writeFile(archive, "not an installer");
    const publish = (installer: string, version: string, releaseId: string) => spawnSync(process.execPath, [
      "scripts/publish-local-agent.mjs", "--root", join(root, "distribution"), "--installer", installer,
      "--platform", "darwin", "--arch", "arm64", "--version", version, "--release-id", releaseId,
      "--signature", "test fixture", "--published-at", "2026-10-20T09:00:00Z",
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(publish(first, "1.0.0", "release-1").status, 0);
    assert.equal(publish(replacement, "1.0.0", "release-1").status, 1);
    assert.equal(publish(archive, "1.1.0", "release-zip").status, 1);
    assert.equal(publish(replacement, "1.1.0", "release-2").status, 0);
    const catalog = parseLocalAgentReleases(await readFile(join(root, "distribution/catalog/releases.json"), "utf8"));
    assert.deepEqual(catalog.map(item => item.version).sort(), ["1.0.0", "1.1.0"]);
    assert.equal((await readFile(join(root, "distribution/installers/release-1/first.pkg"))).toString(), "xar!first installer payload");
    assert.equal((await readFile(join(root, "distribution/installers/release-1/replacement.pkg")).catch(() => Buffer.alloc(0))).length, 0);
    assert.equal((await readdir(join(root, "distribution/catalog"))).some(name => name.startsWith("releases-backup-")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
