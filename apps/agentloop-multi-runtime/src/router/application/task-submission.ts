import type { FileAttachmentBroker } from "../attachments/attachment-broker.ts";
import type { ConversationAttachmentSnapshot, DataPolicy, ExecutionTarget, SubmitConversationTask } from "../../shared/contracts.ts";
import type { Principal } from "../identity/service.ts";

export interface RouterAttachmentBroker {
  upload(input: Parameters<FileAttachmentBroker["upload"]>[0]): ReturnType<FileAttachmentBroker["upload"]>;
  resolveForTask(input: Parameters<FileAttachmentBroker["resolveForTask"]>[0]): ReturnType<FileAttachmentBroker["resolveForTask"]> | Promise<ReturnType<FileAttachmentBroker["resolveForTask"]>>;
  readForRuntime(id: string): ReturnType<FileAttachmentBroker["readForRuntime"]>;
}

/** Authenticated task construction. Browser input becomes a Router-neutral dispatch contract here. */
export async function taskFromRequest(
  body: unknown, principal: Principal, attachments: RouterAttachmentBroker | undefined, requireV2 = false,
): Promise<SubmitConversationTask> {
  const value = record(body, "request body");
  if (requireV2 && value.schema !== "agentloop.task/v2") throw new TypeError("schema must be agentloop.task/v2");
  if (requireV2 && (value.executionTarget === undefined || value.dataPolicy === undefined)) throw new TypeError("agentloop.task/v2 requires executionTarget and dataPolicy");
  for (const field of ["tenantId", "ownerUserId", "userId"]) if (Object.hasOwn(value, field)) throw new TypeError(`${field} is derived from the authenticated session`);
  if (Object.hasOwn(value, "visibleDirectories")) throw new TypeError("visibleDirectories are disabled for the cloud multi-runtime application");
  if (Object.hasOwn(value, "conversationIntent")) throw new TypeError("conversationIntent is Runtime-owned and cannot be supplied by callers");
  if (Object.hasOwn(value, "resourceRefs")) throw new TypeError("resourceRefs are Router-owned; submit attachmentIds instead");
  const executionTarget = parseExecutionTarget(value.executionTarget ?? { kind: "cloud_pool" });
  const dataPolicy = parseDataPolicy(value.dataPolicy ?? { mode: "cloud" });
  if (executionTarget.kind === "cloud_pool" && dataPolicy.mode !== "cloud") throw conflict("cloud_data_policy_required: cloud execution requires dataPolicy.mode=cloud");
  if (executionTarget.kind === "local_device" && dataPolicy.mode === "cloud") throw conflict("local_data_policy_required: local execution requires dataPolicy.mode=local or strict_local");
  if (executionTarget.kind === "local_device" && dataPolicy.mode === "strict_local") throw conflict("strict_local_direct_required: strict local task content must use the loopback data plane");
  if (executionTarget.kind === "local_device" && value.requestedRuntimeId !== undefined) throw new TypeError("executionTarget.runtimeId is the sole Runtime selection for local execution");
  const identity = identityFromPrincipal(principal);
  const attachmentIds = value.attachmentIds === undefined ? [] : stringArray(value.attachmentIds, "attachmentIds");
  if (executionTarget.kind === "local_device" && attachmentIds.length > 0) throw conflict("cloud_data_transfer_required: local execution cannot consume cloud attachments without an explicit transfer");
  const localUploadedSourceIds = value.localUploadedSourceIds === undefined ? undefined : executionTarget.kind === "local_device"
    ? stringArray(value.localUploadedSourceIds, "localUploadedSourceIds") : invalid("localUploadedSourceIds require a local execution target");
  const messageAttachments = value.messageAttachments === undefined ? undefined : executionTarget.kind === "local_device"
    ? localMessageAttachments(value.messageAttachments, localUploadedSourceIds ?? []) : invalid("messageAttachments require a local execution target");
  if (attachmentIds.length > 0 && attachments === undefined) throw new TypeError("attachments are not configured");
  const conversationId = stringValue(value.conversationId, "conversationId");
  const resourceRefs = await (attachments?.resolveForTask({ ...identity, conversationId, attachmentIds }) ?? []);
  return {
    ...identity, conversationId, clientMessageId: stringValue(value.clientMessageId, "clientMessageId"), input: stringValue(value.input, "input"), executionTarget, dataPolicy,
    ...(value.localDirectoryScopeIds === undefined ? {} : { localDirectoryScopeIds: executionTarget.kind === "local_device" ? stringArray(value.localDirectoryScopeIds, "localDirectoryScopeIds") : invalid("localDirectoryScopeIds require a local execution target") }),
    ...(localUploadedSourceIds === undefined ? {} : { localUploadedSourceIds }), ...(messageAttachments === undefined ? {} : { messageAttachments }),
    ...(value.requestedRuntimeId === undefined ? {} : { requestedRuntimeId: stringValue(value.requestedRuntimeId, "requestedRuntimeId") }),
    ...(value.requestedProfile === undefined ? {} : { requestedProfile: value.requestedProfile as SubmitConversationTask["requestedProfile"] }),
    ...(value.requiredCapabilities === undefined ? {} : { requiredCapabilities: stringArray(value.requiredCapabilities, "requiredCapabilities") }),
    ...(value.requestedModelKey === undefined ? {} : { requestedModelKey: stringValue(value.requestedModelKey, "requestedModelKey") }),
    allowDangerousTools: value.allowDangerousTools !== false, resourceRefs,
  };
}

export function identityFromRequest(body: unknown, principal: Principal): { readonly tenantId: string; readonly ownerUserId: string } {
  const value = record(body, "request body");
  for (const field of ["tenantId", "ownerUserId", "userId"]) if (Object.hasOwn(value, field)) throw new TypeError(`${field} is derived from the authenticated session`);
  return identityFromPrincipal(principal);
}

function identityFromPrincipal(principal: Principal) { return { tenantId: principal.tenantId, ownerUserId: principal.userId }; }
function localMessageAttachments(value: unknown, ids: readonly string[]): readonly ConversationAttachmentSnapshot[] {
  if (!Array.isArray(value)) throw new TypeError("messageAttachments must be an array");
  const expected = new Set(ids);
  const attachments = value.map((item) => { const attachment = record(item, "message attachment"); const byteSize = attachment.byteSize; if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize < 0) throw new TypeError("message attachment byteSize must be a non-negative integer"); return { id: stringValue(attachment.id, "message attachment id"), originalName: stringValue(attachment.originalName, "message attachment originalName"), mediaType: stringValue(attachment.mediaType, "message attachment mediaType"), byteSize }; });
  const actual = new Set(attachments.map((attachment) => attachment.id));
  if (actual.size !== attachments.length || actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) throw new TypeError("messageAttachments must exactly describe localUploadedSourceIds");
  return attachments;
}
function parseExecutionTarget(value: unknown): ExecutionTarget { const target = record(value, "executionTarget"); if (target.kind === "cloud_pool") { if (target.profile !== undefined && target.profile !== "general" && target.profile !== "artifact") throw new TypeError("executionTarget.profile is invalid"); if (target.region !== undefined) stringValue(target.region, "executionTarget.region"); return { kind: "cloud_pool", ...(target.profile === undefined ? {} : { profile: target.profile }), ...(target.region === undefined ? {} : { region: target.region as string }) }; } if (target.kind === "local_device") return { kind: "local_device", deviceId: stringValue(target.deviceId, "executionTarget.deviceId"), runtimeId: stringValue(target.runtimeId, "executionTarget.runtimeId") }; throw new TypeError("executionTarget.kind must be cloud_pool or local_device"); }
function parseDataPolicy(value: unknown): DataPolicy { const policy = record(value, "dataPolicy"); if (policy.mode === "cloud" || policy.mode === "local" || policy.mode === "strict_local") return { mode: policy.mode }; throw new TypeError("dataPolicy.mode must be cloud, local, or strict_local"); }
function record(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`); return value as Record<string, unknown>; }
function stringValue(value: unknown, field: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 200_000) throw new TypeError(`${field} must be a non-empty string`); return value; }
function stringArray(value: unknown, field: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new TypeError(`${field} must be a string array`); return value as string[]; }
function conflict(message: string): Error { return Object.assign(new Error(message), { statusCode: 409 }); }
function invalid(message: string): never { throw new TypeError(message); }
