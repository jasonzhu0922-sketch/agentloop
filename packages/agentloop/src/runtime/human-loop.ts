import { readRunEvents } from "../storage/run-event-store.ts";
import { randomUUID } from "node:crypto";
import { runtimePersistence, ascending, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import { appendRunEvent } from "../storage/repositories/run-event-sequencer.ts";
import { AppError, badRequest } from "../shared/errors.ts";
import { createDecisionCommit } from "./decision-ledger.ts";
import type { RuntimeHumanLoopAnswer } from "./user-authority.ts";

export type HumanLoopKind = "selection" | "input" | "confirmation" | "approval";
export type HumanLoopOrigin = "skill" | "tool" | "planner" | "assessor" | "recovery";
export type HumanLoopStatus = "open" | "answered" | "superseded" | "cancelled" | "expired";

export type HumanLoopResponseSchema =
  | { readonly type: "select"; readonly minSelections: number; readonly maxSelections: number; readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string; readonly evidenceRefs?: readonly string[]; readonly identityRefs?: readonly string[] }[] }
  | { readonly type: "form"; readonly fields: readonly { readonly id: string; readonly label: string; readonly valueType: "text" | "textarea" | "date" | "number" | "file_ref"; readonly required: boolean; readonly description?: string; readonly maxLength?: number }[] }
  | { readonly type: "confirm"; readonly acceptLabel: string; readonly rejectLabel: string; readonly requireReasonOnReject?: boolean };

export interface HumanLoopRequirement {
  readonly kind: HumanLoopKind;
  readonly title: string;
  readonly prompt: string;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  readonly responseSchema: HumanLoopResponseSchema;
  readonly resume: { readonly mode: "continue_step" | "replan_step" | "recovery_review" | "run_input"; readonly targetStepId?: string };
}

export interface HumanLoopRequest extends HumanLoopRequirement {
  readonly schema: "agentloop.humanLoopRequest/v1";
  readonly id: string;
  readonly runId: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly actionId?: string;
  readonly origin: HumanLoopOrigin;
  readonly status: HumanLoopStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly resolvedAt?: number;
}

export interface HumanLoopResponse {
  readonly schema: "agentloop.humanLoopResponse/v1";
  readonly id: string;
  readonly requestId: string;
  readonly runId: string;
  readonly requestRevision: number;
  readonly value: unknown;
  readonly actorUserId: string;
  readonly createdAt: number;
}

export class HumanLoopRepository {
  private readonly database: RuntimePersistence;

  constructor(database: RuntimePersistenceInput) {
    this.database = runtimePersistence(database);
  }

  async current(runId: string): Promise<HumanLoopRequest | undefined> {
    const row = (await this.database.records.find("human_loop_requests", { run_id: runId, status: "open" })).sort(ascending("created_at")).at(-1);
    return row === undefined ? undefined : requestFromRow(row);
  }

  async list(runId: string): Promise<HumanLoopRequest[]> {
    const rows = (await this.database.records.find("human_loop_requests", { run_id: runId })).sort(ascending("created_at", "id"));
    return rows.map(requestFromRow);
  }

  async create(input: HumanLoopRequirement & { runId: string; planId?: string; stepId?: string; actionId?: string; origin: HumanLoopOrigin }): Promise<HumanLoopRequest> {
    validateRequirement(input);
    const id = randomUUID();
    const now = Date.now();
    await this.database.transaction(async () => {
      const current = (await this.database.records.find("human_loop_requests", { run_id: input.runId, status: "open" }))[0];
      if (current !== undefined) throw new AppError("CONFLICT", "Run already has an unresolved Human-in-the-Loop request", 409);
      await this.database.records.insert("human_loop_requests", {
        id, run_id: input.runId, plan_id: input.planId ?? null, step_id: input.stepId ?? null, action_id: input.actionId ?? null,
        origin: input.origin, kind: input.kind, title: input.title, prompt: input.prompt, rationale: input.rationale,
        evidence_refs_json: JSON.stringify(input.evidenceRefs), response_schema_json: JSON.stringify(input.responseSchema),
        resume_json: JSON.stringify(input.resume), status: "open", revision: 1, created_at: now,
      });
      await appendEvent(this.database, input.runId, "human_loop.requested", { requestId: id, origin: input.origin, kind: input.kind, planId: input.planId, stepId: input.stepId, evidenceRefs: input.evidenceRefs }, now);
    });
    return (await this.require(id));
  }

  async respond(input: { requestId: string; runId: string; actorUserId: string; expectedRevision: number; value: unknown }): Promise<HumanLoopResponse> {
    const id = randomUUID(); const now = Date.now(); let request: HumanLoopRequest | undefined;
    await this.database.transaction(async () => {
      request = await this.require(input.requestId);
      if (request.runId !== input.runId || request.status !== "open" || request.revision !== input.expectedRevision) throw new AppError("CONFLICT", "Human-in-the-Loop request changed before response", 409);
      validateResponse(request.responseSchema, input.value);
      const updated = await this.database.records.update("human_loop_requests", { id: input.requestId, status: "open", revision: input.expectedRevision }, row => ({ status: "answered" as const, revision: row.revision + 1, resolved_at: now }));
      if (updated !== 1) throw new AppError("CONFLICT", "Human-in-the-Loop request changed before response", 409);
      await this.database.records.insert("human_loop_responses", { id, request_id: input.requestId, run_id: input.runId,
        request_revision: input.expectedRevision, response_json: JSON.stringify(input.value), actor_user_id: input.actorUserId, created_at: now });
      await appendEvent(this.database, input.runId, "human_loop.answered", { requestId: input.requestId, requestRevision: input.expectedRevision, value: input.value }, now);
      if (request.responseSchema.type === "select" && Array.isArray(input.value) && input.value.length > 0) {
        const byId = new Map(request.responseSchema.options.map((option) => [option.id, option] as const));
        const selectedOptions = input.value.flatMap((id) => {
          const option = byId.get(typeof id === "string" ? id : "");
          return option === undefined ? [] : [{
            id: option.id,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
            ...(option.identityRefs === undefined ? {} : { identityRefs: option.identityRefs }),
          }];
        });
        const commit = createDecisionCommit({
          requestId: request.id,
          requestRevision: input.expectedRevision,
          ...(request.planId === undefined ? {} : { planId: request.planId }),
          ...(request.stepId === undefined ? {} : { stepId: request.stepId }),
          selectedOptions,
        });
        await appendEvent(this.database, input.runId, "decision.committed", { commit }, now);
      }
    });
    return { schema: "agentloop.humanLoopResponse/v1", id, requestId: input.requestId, runId: input.runId, requestRevision: input.expectedRevision, value: input.value, actorUserId: input.actorUserId, createdAt: now };
  }

  async hasOpen(runId: string): Promise<boolean> { return (await this.current(runId)) !== undefined; }

  /** Use the accepted response and original request, never assistant/tool paraphrases. */
  async answers(runId: string): Promise<RuntimeHumanLoopAnswer[]> {
    const requests = await this.database.records.find("human_loop_requests", { run_id: runId });
    const responses = (await this.database.records.find("human_loop_responses", { run_id: runId })).sort(ascending("created_at", "id"));
    const rows = responses.flatMap(response => {
      const request = requests.find(request => request.id === response.request_id);
      return request ? [{ ...request, response_id: response.id, request_revision: response.request_revision,
        response_json: response.response_json, answered_at: response.created_at }] : [];
    });
    const events = await readRunEvents(this.database, runId, "human_loop.answered");
    const answerOrder = new Map(events.map(event => {
      const data = JSON.parse(event.payload_json) as { requestId: string; requestRevision: number };
      return [`${data.requestId}:${data.requestRevision}`, event.seq] as const;
    }));
    return rows.map(row => {
      const request = requestFromRow(row);
      const value: unknown = JSON.parse(row.response_json);
      const schema = request.responseSchema;
      const eventSeq = answerOrder.get(`${request.id}:${row.request_revision}`);
      if (eventSeq === undefined) throw new AppError("CONFLICT", "Accepted Human-in-the-Loop answer lost its event reference", 409);
      return {
        responseId: row.response_id, requestId: request.id, requestRevision: row.request_revision, createdAt: row.answered_at, eventSeq,
        ...(request.planId === undefined ? {} : { planId: request.planId }),
        ...(request.stepId === undefined ? {} : { stepId: request.stepId }),
        question: { kind: request.kind, title: request.title, prompt: request.prompt, responseType: schema.type,
          ...(schema.type === "form" ? { fields: schema.fields } : {}),
          ...(schema.type === "confirm" ? { acceptLabel: schema.acceptLabel, rejectLabel: schema.rejectLabel } : {}),
        },
        value,
        ...(schema.type === "select" && Array.isArray(value) ? {
          selectedOptions: value.flatMap(id => {
            const option = schema.options.find(option => option.id === id);
            return option === undefined ? [] : [{ id: option.id, label: option.label,
              ...(option.description === undefined ? {} : { description: option.description }),
              ...(option.identityRefs === undefined ? {} : { identityRefs: option.identityRefs }),
            }];
          }),
        } : {}),
      };
    }).sort((left, right) => left.eventSeq - right.eventSeq);
  }
  private async require(id: string): Promise<HumanLoopRequest> { const row = (await this.database.records.find("human_loop_requests", { id }))[0]; if (row === undefined) throw new AppError("NOT_FOUND", "Human-in-the-Loop request not found", 404); return requestFromRow(row); }
}

interface Row { id: string; run_id: string; plan_id: string | null; step_id: string | null; action_id: string | null; origin: HumanLoopOrigin; kind: HumanLoopKind; title: string; prompt: string; rationale: string; evidence_refs_json: string; response_schema_json: string; resume_json: string; status: HumanLoopStatus; revision: number; created_at: number; resolved_at: number | null; }
function requestFromRow(row: Row): HumanLoopRequest { return { schema: "agentloop.humanLoopRequest/v1", id: row.id, runId: row.run_id, ...(row.plan_id === null ? {} : { planId: row.plan_id }), ...(row.step_id === null ? {} : { stepId: row.step_id }), ...(row.action_id === null ? {} : { actionId: row.action_id }), origin: row.origin, kind: row.kind, title: row.title, prompt: row.prompt, rationale: row.rationale, evidenceRefs: JSON.parse(row.evidence_refs_json), responseSchema: JSON.parse(row.response_schema_json), resume: JSON.parse(row.resume_json), status: row.status, revision: row.revision, createdAt: row.created_at, ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }) }; }
/**
 * Returns a typed requirement only when it is safe to persist as a HIL
 * request. Runtime control-signal producers use this before a signal crosses
 * a compacted tool-result boundary.
 */
export function humanLoopRequirementFromUnknown(value: unknown): HumanLoopRequirement | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    validateRequirement(value as HumanLoopRequirement);
    return value as HumanLoopRequirement;
  } catch {
    return undefined;
  }
}

function validateRequirement(value: HumanLoopRequirement): void {
  if (!["selection", "input", "confirmation", "approval"].includes(value.kind)) throw badRequest("Invalid Human-in-the-Loop kind");
  for (const text of [value.title, value.prompt, value.rationale]) if (typeof text !== "string" || !text.trim() || text.length > 10_000) throw badRequest("Human-in-the-Loop text is invalid");
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 50 || value.evidenceRefs.some((x) => typeof x !== "string" || !x)) throw badRequest("Human-in-the-Loop evidenceRefs are invalid");
  const schema = value.responseSchema;
  if (!schema || !["select", "form", "confirm"].includes(schema.type)) throw badRequest("Human-in-the-Loop responseSchema is invalid");
  if (schema.type === "select" && (
    !Array.isArray(schema.options)
    || schema.options.length === 0
    || !Number.isInteger(schema.minSelections)
    || !Number.isInteger(schema.maxSelections)
    || schema.minSelections < 0
    || schema.maxSelections < schema.minSelections
    || schema.maxSelections > schema.options.length
    || schema.options.some((option) =>
      !option
      || typeof option.id !== "string"
      || !option.id
      || typeof option.label !== "string"
      || !option.label
      || (option.identityRefs !== undefined && (!Array.isArray(option.identityRefs)
        || option.identityRefs.some((ref) => typeof ref !== "string" || !ref)))
    )
  )) throw badRequest("Human-in-the-Loop select schema is invalid");
  if (schema.type === "form" && (!Array.isArray(schema.fields) || schema.fields.length === 0 || schema.fields.some((field) => !field || typeof field.id !== "string" || !field.id || typeof field.label !== "string" || !field.label || typeof field.required !== "boolean" || !["text", "textarea", "date", "number", "file_ref"].includes(field.valueType)))) throw badRequest("Human-in-the-Loop form schema is invalid");
  if (schema.type === "confirm" && (!schema.acceptLabel || !schema.rejectLabel)) throw badRequest("Human-in-the-Loop confirm schema is invalid");
  const resume = value.resume;
  if (!resume || !["continue_step", "replan_step", "recovery_review", "run_input"].includes(resume.mode) || (resume.targetStepId !== undefined && (typeof resume.targetStepId !== "string" || !resume.targetStepId))) throw badRequest("Human-in-the-Loop resume is invalid");
}
function validateResponse(schema: HumanLoopResponseSchema, value: unknown): void { if (schema.type === "select") { if (!Array.isArray(value) || value.length < schema.minSelections || value.length > schema.maxSelections || value.some((x) => typeof x !== "string") || new Set(value).size !== value.length || value.some((x) => !schema.options.some((option) => option.id === x))) throw badRequest("Human-in-the-Loop selection is invalid"); return; } if (schema.type === "confirm") { if (value === true) return; if (value && typeof value === "object" && !Array.isArray(value) && (value as { accepted?: unknown }).accepted === false) {
  const reason = (value as { reason?: unknown }).reason;
  if (schema.requireReasonOnReject && (typeof reason !== "string" || !reason.trim())) throw badRequest("Human-in-the-Loop rejection reason is required");
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 20_000)) throw badRequest("Human-in-the-Loop rejection reason is invalid");
  return;
} throw badRequest("Human-in-the-Loop confirmation is invalid"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("Human-in-the-Loop form is invalid"); const form = value as Record<string, unknown>; for (const field of schema.fields) { const answer = form[field.id]; if (field.required && (typeof answer !== "string" || !answer.trim())) throw badRequest(`Human-in-the-Loop field ${field.id} is required`); if (typeof answer === "string" && answer.length > (field.maxLength ?? 20_000)) throw badRequest(`Human-in-the-Loop field ${field.id} is too long`); } }
async function appendEvent(database: RuntimePersistenceInput, runId: string, type: string, payload: Record<string, unknown>, createdAt: number): Promise<void> {
  await appendRunEvent(database, runId, { type, data: payload, createdAt });
}
