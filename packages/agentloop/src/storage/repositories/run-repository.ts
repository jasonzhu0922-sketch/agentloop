import { readRunEvents } from "../run-event-store.ts";
import { runtimePersistence, ascending, type RuntimePersistence, type RuntimePersistenceInput } from "../runtime-records.ts";
import { appendRunEvent } from "./run-event-sequencer.ts";
import { AppError, notFound } from "../../shared/errors.ts";
import type { VisibleDirectoryGrant } from "../../runtime/contracts.ts";

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunRow {
  id: string;
  owner_user_id: string;
  conversation_id: string | null;
  parent_run_id: string | null;
  depth: number;
  allow_dangerous_tools: number;
  model_key: string | null;
  status: RunStatus;
  input: string;
  output: string | null;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface RunEventRow {
  seq: number;
  type: string;
  payload_json: string;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  title: string;
  visible_directories_json: string;
  created_at: number;
  updated_at: number;
}

export interface ConversationSummaryRow extends ConversationRow {
  run_count: number;
}

export class RunRepository {
  private readonly state: RuntimePersistence;
  constructor(connection: RuntimePersistenceInput) { this.state = runtimePersistence(connection); }
  async get(runId: string): Promise<RunRow | undefined> { return (await this.state.records.find("runs", { id: runId }))[0] as RunRow | undefined; }
  async getByOwner(runId: string, ownerUserId: string): Promise<RunRow | undefined> {
    return (await this.state.records.find("runs", { id: runId, owner_user_id: ownerUserId }))[0] as RunRow | undefined;
  }
  async listByOwner(ownerUserId: string, limit: number): Promise<RunRow[]> {
    return (await this.state.records.find("runs", { owner_user_id: ownerUserId, parent_run_id: null })).sort(ascending("created_at")).reverse().slice(0, limit) as RunRow[];
  }
  async insertRun(input: { id: string; ownerUserId: string; conversationId?: string; parentRunId?: string; depth?: number; allowDangerousTools: boolean; modelKey?: string; input: string; createdAt: number }): Promise<void> {
    await this.state.records.insert("runs", { id: input.id, owner_user_id: input.ownerUserId, conversation_id: input.conversationId ?? null,
      parent_run_id: input.parentRunId ?? null, depth: input.depth ?? 0, allow_dangerous_tools: input.allowDangerousTools ? 1 : 0,
      model_key: input.modelKey ?? null, status: "running", input: input.input, created_at: input.createdAt });
  }
  async bindRunVisibleDirectories(input: { runId: string; visibleDirectories: readonly VisibleDirectoryGrant[] }): Promise<void> {
    for (const [position, directory] of input.visibleDirectories.entries()) await this.state.records.insert("run_visible_directories", {
      run_id: input.runId, directory_id: directory.id, name: directory.name, path: directory.path, position,
    });
  }
  async visibleDirectoriesForRun(runId: string): Promise<VisibleDirectoryGrant[]> {
    return (await this.state.records.find("run_visible_directories", { run_id: runId })).sort(ascending("position")).map(row => ({ id: row.directory_id, name: row.name, path: row.path }));
  }
  async listConversationSummaries(ownerUserId: string, page?: { readonly limit: number; readonly offset: number }): Promise<ConversationSummaryRow[]> {
    return await this.state.transaction(async () => {
      let conversations = (await this.state.records.find("conversations", { owner_user_id: ownerUserId })).sort(ascending("updated_at")).reverse();
      if (page) conversations = conversations.slice(page.offset, page.offset + page.limit);
      return await Promise.all(conversations.map(async conversation => ({ ...conversation,
        run_count: (await this.state.records.find("runs", { conversation_id: conversation.id, parent_run_id: null })).length,
      })));
    });
  }
  async lastTopLevelStatus(conversationId: string): Promise<{ status: RunStatus } | undefined> {
    const row = (await this.topLevelRunsInConversation(conversationId)).at(-1); return row ? { status: row.status } : undefined;
  }
  async findConversation(ownerUserId: string, conversationId: string): Promise<ConversationRow | undefined> {
    return (await this.state.records.find("conversations", { id: conversationId, owner_user_id: ownerUserId }))[0];
  }
  async topLevelRunsInConversation(conversationId: string): Promise<RunRow[]> {
    return (await this.state.records.find("runs", { conversation_id: conversationId, parent_run_id: null })).sort(ascending("created_at")) as RunRow[];
  }
  async touchConversation(conversationId: string, now: number): Promise<void> {
    await this.state.records.update("conversations", { id: conversationId }, () => ({ updated_at: now }));
  }
  async setConversationVisibleDirectories(ownerUserId: string, conversationId: string, visibleDirectories: readonly string[], now: number): Promise<ConversationRow> {
    return await this.state.transaction(async () => {
      if (await this.state.records.update("conversations", { id: conversationId, owner_user_id: ownerUserId }, () => ({ visible_directories_json: JSON.stringify([...visibleDirectories]), updated_at: now })) !== 1) throw notFound("Conversation");
      return (await this.findConversation(ownerUserId, conversationId))!;
    });
  }
  async insertConversation(input: { id: string; ownerUserId: string; title: string; createdAt: number }): Promise<void> {
    await this.state.records.insert("conversations", { id: input.id, owner_user_id: input.ownerUserId, title: input.title, visible_directories_json: "[]", created_at: input.createdAt, updated_at: input.createdAt });
  }
  async ensureConversation(input: { id: string; ownerUserId: string; title: string; now: number }): Promise<void> {
    await this.state.transaction(async () => {
      const existing = (await this.state.records.find("conversations", { id: input.id }))[0];
      if (existing) {
        if (existing.owner_user_id !== input.ownerUserId) throw notFound("Conversation");
        await this.touchConversation(input.id, input.now);
      } else await this.insertConversation({ ...input, createdAt: input.now });
    });
  }
  async deleteConversation(ownerUserId: string, conversationId: string): Promise<void> {
    await this.state.transaction(async () => {
      if (!(await this.findConversation(ownerUserId, conversationId))) throw notFound("Conversation");
      const tree = new Map<string, RunRow>();
      const visit = async (row: RunRow) => {
        if (tree.has(row.id)) return; tree.set(row.id, row);
        for (const child of await this.state.records.find("runs", { parent_run_id: row.id, owner_user_id: ownerUserId })) await visit(child as RunRow);
      };
      for (const row of await this.state.records.find("runs", { conversation_id: conversationId, owner_user_id: ownerUserId })) await visit(row as RunRow);
      for (const row of tree.values()) {
        if (row.status !== "running") continue;
        const actions = await this.state.records.find("runtime_actions", { run_id: row.id });
        const recovery = (await this.state.records.find("run_recovery_states", { run_id: row.id }))[0];
        if (actions.some(action => action.state === "dispatched") || !actions.some(action => action.id === recovery?.action_id && action.state === "recovery_required"))
          throw new AppError("CONFLICT", "Cannot delete a conversation while one of its runs is active", 409);
      }
      for (const row of tree.values()) {
        await this.state.records.remove("run_recovery_states", { run_id: row.id });
        await this.state.records.remove("run_sources", { run_id: row.id });
      }
      for (const source of await this.state.records.find("sources", { conversation_id: conversationId, owner_user_id: ownerUserId })) {
        await this.state.records.remove("source_chunks", { source_id: source.id });
        await this.state.records.remove("sources", { id: source.id });
      }
      for (const row of [...tree.values()].reverse()) {
        const sequence = (await this.state.records.find("run_event_sequences", { run_id: row.id }))[0];
        const latest = await this.latestEventByRun(row.id);
        await this.state.records.insert("runtime_deletions", { run_id: row.id, last_seq: Math.max(sequence?.next_seq ?? 1, (latest?.seq ?? 0) + 1), deleted_at: Date.now() });
        await this.state.records.remove("runs", { id: row.id });
      }
      await this.state.records.remove("conversations", { id: conversationId, owner_user_id: ownerUserId });
    });
  }
  async conversationTranscript(conversationId: string): Promise<Array<{ input: string; output: string | null }>> {
    return (await this.topLevelRunsInConversation(conversationId)).map(row => ({ input: row.input, output: row.output }));
  }
  async eventsByRun(runId: string): Promise<RunEventRow[]> { return await readRunEvents(this.state, runId); }
  async eventsByRunAfter(runId: string, afterSeq: number): Promise<RunEventRow[]> {
    if (!this.state.eventPage) return (await this.eventsByRun(runId)).filter(row => row.seq > afterSeq);
    const rows: RunEventRow[] = [];
    for (;;) {
      const page = await this.state.eventPage(runId, afterSeq, 500);
      rows.push(...page);
      if (page.length < 500) return rows;
      afterSeq = page.at(-1)!.seq;
    }
  }
  async latestEventByRun(runId: string): Promise<RunEventRow | undefined> { return this.state.eventPage ? (await this.state.eventPage(runId, 0, 1, true))[0] : (await this.eventsByRun(runId)).at(-1); }
  async appendEvent(runId: string, input: { type: string; data: Readonly<Record<string, unknown>>; createdAt: number }): Promise<number> {
    return await appendRunEvent(this.state, runId, input);
  }
}
