import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseLocalAgentReleases } from "../src/router/releases/local-agent-releases.ts";

const { values } = parseArgs({ options: {
  root: { type: "string" }, installer: { type: "string" }, platform: { type: "string" }, arch: { type: "string" },
  version: { type: "string" }, "release-id": { type: "string" }, signature: { type: "string" },
  "protocol-version": { type: "string", default: "1" }, "published-at": { type: "string" }, notes: { type: "string" },
} });
for (const name of ["root", "installer", "platform", "arch", "version", "release-id", "signature"]) {
  if (!values[name]) throw new Error(`--${name} is required`);
}
if (!/^[a-zA-Z0-9_-]+$/.test(values["release-id"])) throw new Error("Invalid --release-id");
const bytes = await readFile(resolve(values.installer));
const magic = values.platform === "darwin" ? Buffer.from("xar!") : Buffer.from("d0cf11e0a1b11ae1", "hex");
if (!bytes.subarray(0, magic.length).equals(magic)) throw new Error("Expected a real macOS PKG or Windows MSI installer");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const fileName = basename(values.installer);
const release = {
  version: values.version, protocolVersion: values["protocol-version"], platform: values.platform, arch: values.arch,
  fileName, size: bytes.length, sha256, signature: values.signature,
  publishedAt: values["published-at"] || new Date().toISOString(),
  downloadUrl: `/downloads/local-agent/${values["release-id"]}/${fileName}`,
  ...(values.notes ? { releaseNotes: values.notes } : {}),
};
parseLocalAgentReleases(JSON.stringify([release]));
const root = resolve(values.root);
const catalogDirectory = join(root, "catalog");
const manifest = join(catalogDirectory, "releases.json");
let catalog = [];
try { catalog = [...parseLocalAgentReleases(await readFile(manifest, "utf8"))]; }
catch (error) { if (error.code !== "ENOENT") throw error; }
const previous = catalog.find(item => item.platform === release.platform && item.arch === release.arch && item.version === release.version && item.protocolVersion === release.protocolVersion);
if (previous && JSON.stringify(previous) !== JSON.stringify(parseLocalAgentReleases(JSON.stringify([release]))[0])) throw new Error("This version is already published. Publish a new version instead of replacing it.");
const destination = join(root, "installers", values["release-id"]);
await mkdir(destination, { recursive: true });
await mkdir(catalogDirectory, { recursive: true });
try { await copyFile(resolve(values.installer), join(destination, fileName), constants.COPYFILE_EXCL); }
catch (error) {
  if (error.code !== "EEXIST" || createHash("sha256").update(await readFile(join(destination, fileName))).digest("hex") !== sha256) throw error;
}
const copied = createHash("sha256").update(await readFile(join(destination, fileName))).digest("hex");
if (copied !== sha256) throw new Error("Copied installer checksum mismatch; catalog was not updated");
if (!previous) catalog.push(release);
const temporary = join(catalogDirectory, `.releases-${randomUUID()}.json`);
try { await copyFile(manifest, join(catalogDirectory, `releases-backup-${Date.now()}-${randomUUID()}.json`), constants.COPYFILE_EXCL); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await writeFile(temporary, JSON.stringify(catalog, null, 2) + "\n", { flag: "wx", mode: 0o644 });
await rename(temporary, manifest);
console.log(JSON.stringify({ manifest, release }, null, 2));
