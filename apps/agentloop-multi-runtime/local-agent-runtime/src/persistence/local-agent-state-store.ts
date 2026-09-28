import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LocalAgentState {
  readonly deviceIdentity: { readonly publicKey: string; readonly privateKey: string };
  readonly defaultRuntimeId: string;
  readonly sharedStorageRoot?: string;
  readonly uploadStorageRoot?: string;
  readonly device?: { readonly id: string; readonly agentToken: string; readonly displayName: string };
}

/** Device-private state. This file is never exposed through Router or HTTP responses. */
export class LocalAgentStateStore {
  private readonly statePath: string;

  constructor(statePath: string) { this.statePath = statePath; }

  async read(): Promise<LocalAgentState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Omit<LocalAgentState, "defaultRuntimeId"> & { defaultRuntimeId?: string; runtimeId?: string };
      if (parsed.defaultRuntimeId !== undefined) return parsed as LocalAgentState;
      const migrated: LocalAgentState = { ...parsed, defaultRuntimeId: parsed.runtimeId ?? `local_runtime_${randomUUID()}` };
      await this.write(migrated);
      return migrated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const pair = generateKeyPairSync("ed25519");
      const state: LocalAgentState = {
        defaultRuntimeId: `local_runtime_${randomUUID()}`,
        deviceIdentity: {
          publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
          privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        },
      };
      await this.write(state);
      return state;
    }
  }

  async write(state: LocalAgentState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const pending = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(pending, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await chmod(pending, 0o600);
    await rename(pending, this.statePath);
    await chmod(this.statePath, 0o600);
  }
}
