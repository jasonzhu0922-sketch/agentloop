import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeConfigurationSnapshot, RuntimeTarget } from "../../../control-plane/contracts/index.ts";
import { parseRuntimeConfigurationSnapshot } from "../../../control-plane/contracts/index.ts";

/** Device-only public snapshot cache. It is never exposed through Local Agent HTTP or Router RPC. */
export class LocalSnapshotCache {
  private readonly path: string;
  public constructor(path: string) { this.path = path; }
  async get(target: RuntimeTarget, now: () => number = Date.now): Promise<RuntimeConfigurationSnapshot | undefined> {
    try {
      const snapshot = parseRuntimeConfigurationSnapshot(JSON.parse(await readFile(this.path, "utf8")));
      return sameTarget(snapshot.target, target) && snapshot.validUntil > now() ? snapshot : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async put(snapshot: RuntimeConfigurationSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const pending = `${this.path}.tmp`;
    await writeFile(pending, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    await chmod(pending, 0o600); await rename(pending, this.path); await chmod(this.path, 0o600);
  }
}
function sameTarget(left: RuntimeTarget, right: RuntimeTarget): boolean { return left.plane === right.plane && left.scopeId === right.scopeId && left.runtimeId === right.runtimeId && left.runtimeClass === right.runtimeClass && left.deviceId === right.deviceId; }
