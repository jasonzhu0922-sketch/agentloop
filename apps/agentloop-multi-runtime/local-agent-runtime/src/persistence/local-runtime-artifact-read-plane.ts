import { join, dirname, relative, resolve, sep } from "node:path";
import {
  AppDatabase,
  CanonicalRunStateRepository,
  notFound,
  RunRepository,
  RuntimeArtifactQueryService,
  RuntimeEventQueryService,
  RuntimeWorkspaceService,
  type ArtifactQueryRun,
  type ProcessArtifact,
  type ProcessArtifactPreview,
} from "@zhujun/agentloop";
import type { LocalRuntimeDefinition } from "../service/runtime-supervisor.ts";

/**
 * Read-only data plane for completed Runtime history.
 *
 * Runtime execution controls are deliberately closed when a Runtime is
 * stopped. Its SQLite database and workspace are durable device data, though,
 * so artifact reads must not require a live Supervisor instance or MCP/model
 * catalog. Each operation opens the owning Runtime database independently and
 * closes it after the bounded read.
 */
export class LocalRuntimeArtifactReadPlane {
  private readonly databasePath: string;
  private readonly runtimeDataRoot: string;
  private readonly workspaceRoot: () => string;

  constructor(input: {
    readonly databasePath: string;
    readonly runtimeDataRoot?: string;
    readonly workspaceRoot: () => string;
  }) {
    this.databasePath = input.databasePath;
    this.runtimeDataRoot = resolve(input.runtimeDataRoot ?? join(dirname(input.databasePath), "runtimes"));
    this.workspaceRoot = input.workspaceRoot;
  }

  async list(runtime: LocalRuntimeDefinition, runId: string, actorUserId?: string): Promise<readonly ProcessArtifact[]> {
    return await this.withQuery(runtime, runId, actorUserId, async (query, ownerUserId) => await query.list(ownerUserId, runId));
  }

  async read(runtime: LocalRuntimeDefinition, runId: string, artifactId: string, actorUserId?: string): Promise<{ readonly artifact: ProcessArtifact; readonly content: Buffer }> {
    return await this.withQuery(runtime, runId, actorUserId, async (query, ownerUserId) => await query.read(ownerUserId, runId, artifactId));
  }

  async preview(runtime: LocalRuntimeDefinition, runId: string, artifactId: string, actorUserId?: string): Promise<ProcessArtifactPreview> {
    return await this.withQuery(runtime, runId, actorUserId, async (query, ownerUserId) => await query.preview(ownerUserId, runId, artifactId));
  }

  private async withQuery<T>(runtime: LocalRuntimeDefinition, runId: string, actorUserId: string | undefined, operation: (query: RuntimeArtifactQueryService, ownerUserId: string) => Promise<T>): Promise<T> {
    const database = new AppDatabase(this.databasePathFor(runtime));
    try {
      const runs = new RunRepository(database);
      const run = async (actorUserId: string, runId: string): Promise<ArtifactQueryRun> => {
        const row = await runs.getByOwner(runId, actorUserId);
        if (row === undefined) throw notFound("Run");
        return {
          id: row.id,
          ownerUserId: row.owner_user_id,
          ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
          createdAt: row.created_at,
        };
      };
      const events = new RuntimeEventQueryService({
        runs,
        authorizeRun: async (actorUserId, runId) => { await run(actorUserId, runId); },
      });
      const canonical = new CanonicalRunStateRepository(database);
      const query = new RuntimeArtifactQueryService({
        run,
        events: (actorUserId: string, runId: string) => events.list(actorUserId, runId),
        canonicalState: (runId: string) => canonical.getOptional(runId),
        workspaceRoot: (run: ArtifactQueryRun) => new RuntimeWorkspaceService(this.workspaceRoot(), { ownerScoped: true }).forRun(run),
      });
      const row = await database.prepare("SELECT owner_user_id FROM runs WHERE id = ?").get(runId) as { owner_user_id?: string } | undefined;
      // The operation itself performs the owner-scoped lookup. This second
      // query only supplies the authenticated local owner to the public query
      // service without exposing a cross-owner actor parameter at this layer.
      if (row?.owner_user_id === undefined) throw notFound("Run");
      return await operation(query, actorUserId ?? row.owner_user_id);
    } finally {
      await database.close();
    }
  }

  private databasePathFor(runtime: LocalRuntimeDefinition): string {
    if (runtime.isDefault) return this.databasePath;
    const runtimeRoot = resolve(this.runtimeDataRoot, runtime.storageKey);
    const suffix = relative(this.runtimeDataRoot, runtimeRoot);
    if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new Error("runtime_storage_key_outside_data_root");
    return join(runtimeRoot, "agentloop.db");
  }
}
