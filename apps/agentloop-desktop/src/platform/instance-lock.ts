import { randomUUID } from "node:crypto";
import { open, readFile, realpath, mkdir, lstat, unlink, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";

export interface InstanceMetadata { version: 1; instanceId: string; pid: number; origin?: string }
export interface InstanceLock {
  readonly dataDirectory: string;
  readonly instanceId: string;
  readonly installationId: string;
  publish(origin: string): Promise<void>;
  release(): Promise<void>;
}
export type InstanceClaim = { existing: false; lock: InstanceLock } | { existing: true; origin: string };
export function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("desktop_instance_metadata_invalid");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value !== url.origin) throw new Error("desktop_instance_metadata_invalid");
  return url.origin;
}
/** A PID that cannot be signalled is intentionally treated as unknown: only
 * ESRCH proves that the process which created a lock no longer exists. */
function processIsAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** Exclusive creation precedes all DB access. Unknown locks are never stolen:
 * only an unreachable published origin paired with a conclusively dead PID is
 * recovered, and that evidence is retained beside the new lock.
 */
export async function claimInstance(dataDirectory: string, mode: "development" | "packaged" = "development"): Promise<InstanceClaim> {
  if (!isAbsolute(dataDirectory)) throw new Error("desktop_data_directory_must_be_absolute");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(dataDirectory);
  const path = join(directory, ".desktop-instance.lock");
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > 4096) throw new Error("invalid_lock");
        const metadata = JSON.parse(await readFile(path, "utf8")) as InstanceMetadata;
        if (metadata.version !== 1 || typeof metadata.instanceId !== "string" || !Number.isSafeInteger(metadata.pid)) throw new Error("invalid_lock");
        if (metadata.origin !== undefined) {
          const origin = loopbackOrigin(metadata.origin);
          try {
            const response = await fetch(`${origin}/__desktop/instance`, { signal: AbortSignal.timeout(500), redirect: "error" });
            const identity = await response.json() as { instanceId: string; ready: boolean };
            if (response.ok && identity.ready && identity.instanceId === metadata.instanceId) return { existing: true, origin };
          } catch { /* A dead PID below is required before recovery. */ }
          if (processIsAbsent(metadata.pid)) {
            try {
              await rename(path, `${path}.recovered-${new Date().toISOString().replace(/[:.]/g, "-")}`);
              file = await open(path, "wx", 0o600);
              break;
            } catch { /* A concurrent creator or an unknown filesystem state is not recoverable. */ }
          }
        }
      } catch { /* Startup publication may be partial; bounded retry, no takeover. */ }
      await setTimeout(50);
    }
    if (!file) throw new Error("desktop_instance_unavailable");
  }
  const stat = await file.stat();
  const metadata: InstanceMetadata = { version: 1, instanceId: randomUUID(), pid: process.pid };
  let released = false;
  async function persist() {
    const content = Buffer.from(JSON.stringify(metadata));
    await file!.truncate(0); await file!.write(content, 0, content.length, 0); await file!.sync();
  }
  async function release() {
    if (released) return;
    const current = await lstat(path);
    if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("desktop_lock_ownership_lost");
    await unlink(path); await file!.close(); released = true;
  }
  let installationId: string;
  try {
    await persist();
    const markerPath = join(directory, ".desktop-data.json");
    const entries = await readdir(directory);
    if (!entries.includes(".desktop-data.json")) {
      if (entries.some(entry => entry !== ".desktop-instance.lock")) throw new Error("desktop_data_directory_not_empty");
      installationId = randomUUID();
      await writeFile(markerPath, JSON.stringify({ schema: "agentloop.desktop.data/v1", mode, installationId }), { flag: "wx", mode: 0o600 });
    } else {
      const markerStat = await lstat(markerPath);
      if (!markerStat.isFile() || markerStat.size > 4096) throw new Error("desktop_data_marker_invalid");
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
      if (marker.schema !== "agentloop.desktop.data/v1" || marker.mode !== mode || typeof marker.installationId !== "string" || !/^[a-f0-9-]{36}$/.test(marker.installationId)) throw new Error("desktop_data_marker_invalid");
      installationId = marker.installationId;
    }
  } catch (error) { await release(); throw error; }
  return { existing: false, lock: { dataDirectory: directory, instanceId: metadata.instanceId, installationId,
    publish: async origin => { metadata.origin = loopbackOrigin(origin); await persist(); }, release } };
}
