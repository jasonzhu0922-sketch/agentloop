import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { RuntimeEvent } from "./contracts.ts";

/** Private diagnostic bodies, external to the model working set and delivery. */
export class ContextCompactionStore {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) { this.workspaceRoot = workspaceRoot; }

  project(event: RuntimeEvent): Readonly<Record<string, unknown>> {
    if (event.type !== "context.compaction.model.requested" && event.type !== "context.compaction.model.completed") return event.data;
    if (!("diagnostic" in event.data)) return event.data;
    const { diagnostic, ...data } = event.data;
    const content = JSON.stringify({ schema: "agentloop.contextCompactionDiagnostic/v1", ...data, diagnostic });
    const sha256 = createHash("sha256").update(content).digest("hex");
    const directory = resolve(this.workspaceRoot, ".agentloop", "diagnostics", "context-compactions", sha256.slice(0, 2));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${sha256}.json`);
    const pending = `${path}.${randomUUID()}.pending`;
    try {
      writeFileSync(pending, content, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
      renameSync(pending, path);
    } catch (error) {
      try { unlinkSync(pending); } catch { /* Preserve the original persistence error. */ }
      throw error;
    }
    return {
      ...data,
      diagnosticRef: {
        schema: "agentloop.contextCompactionDiagnosticRef/v1",
        path: relative(this.workspaceRoot, path),
        sha256,
        bytes: Buffer.byteLength(content),
        characters: content.length,
      },
    };
  }
}
