import { createServer, type Server } from "node:http";
import type { FileAttachmentBroker } from "../attachments/attachment-broker.ts";
import { assertUploadedSourceContent, type CommandOutputContent, type HumanLoopRequest, type HumanLoopResponse, type RecoveryDetail, type ToolArgumentsContent } from "@zhujun/agentloop";
import type { RuntimeDispatchEnvelope, RuntimeEndpoint, RuntimeModelSummary, RuntimeRunEvent, RuntimeRunStatus, SubmitConversationTask } from "../domain/contracts.ts";
import type { ProcessArtifact, ProcessArtifactPreview } from "@zhujun/agentloop";
import { IdentityError, type IdentityService, type Principal } from "../auth/identity-service.ts";
import { DeviceError, type DeviceRepository } from "../devices/device-service.ts";

interface AttachmentBroker {
  upload(input: Parameters<FileAttachmentBroker["upload"]>[0]): ReturnType<FileAttachmentBroker["upload"]>;
  resolveForTask(input: Parameters<FileAttachmentBroker["resolveForTask"]>[0]): ReturnType<FileAttachmentBroker["resolveForTask"]> | Promise<ReturnType<FileAttachmentBroker["resolveForTask"]>>;
  readForRuntime(id: string): ReturnType<FileAttachmentBroker["readForRuntime"]>;
}

interface LocalAgentControlPlane {
  agentControl<T>(input: { readonly tenantId: string; readonly ownerUserId: string; readonly deviceId: string; readonly method: string; readonly payload?: Record<string, unknown> }): Promise<T>;
}

interface RouterTaskApi {
  submit(task: SubmitConversationTask): Promise<{ readonly id: string; readonly tenantId: string; readonly ownerUserId: string }>;
  models?(tenantId?: string, ownerUserId?: string): Promise<readonly RuntimeModelSummary[]>;
  runtimes?(tenantId?: string, ownerUserId?: string): Promise<readonly { id: string; profile: string }[]>;
  conversations?(tenantId: string, ownerUserId: string, page: { readonly limit: number; readonly offset: number }): Promise<{
    readonly conversations: readonly {
      readonly id: string;
      readonly title: string;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly runCount: number;
      readonly lastStatus: string;
    }[];
    readonly hasMore: boolean;
    readonly nextOffset?: number;
  }>;
  conversation?(tenantId: string, ownerUserId: string, conversationId: string): Promise<{
    readonly turns: readonly {
      readonly clientMessageId: string;
      readonly input: string;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly attachments: readonly { readonly id: string; readonly originalName: string; readonly mediaType: string; readonly byteSize: number }[];
      readonly assignment?: {
        readonly id: string;
        readonly runtimeId: string;
        readonly status: string;
        readonly hasRun: boolean;
        readonly remoteRunId?: string;
        readonly errorCode?: string;
        readonly errorMessage?: string;
      };
    }[];
  } | undefined>;
  deleteConversation?(tenantId: string, ownerUserId: string, conversationId: string): Promise<void>;
  assignment(id: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly run?: RuntimeRunStatus } | undefined>;
  artifacts?(id: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly artifacts: readonly ProcessArtifact[] } | undefined>;
  readArtifact?(id: string, artifactId: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly artifact: ProcessArtifact; readonly content: Uint8Array } | undefined>;
  previewArtifact?(id: string, artifactId: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly preview: unknown } | undefined>;
  heartbeat?(input: { readonly runtimeId: string; readonly status: "ready" | "draining" | "offline"; readonly activeRunCount: number; readonly queuedRunCount: number; readonly maxConcurrentRuns?: number; readonly observedAt: number }): Promise<void>;
  cancel?(id: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly run: RuntimeRunStatus }>;
  events?(id: string, afterSeq: number): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly events: readonly RuntimeRunEvent[] } | undefined>;
  commandOutput?(id: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly output: CommandOutputContent } | undefined>;
  toolArguments?(id: string, toolCallId: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly arguments: ToolArgumentsContent } | undefined>;
  advanceRecovery?(id: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly recovery: RecoveryDetail } | undefined>;
  resumeRecovery?(id: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly run: RuntimeRunStatus } | undefined>;
  startFromCheckpoint?(id: string): Promise<{ readonly assignment: { readonly id: string; readonly tenantId: string; readonly ownerUserId: string }; readonly run: RuntimeRunStatus } | undefined>;
  currentHumanLoop?(id: string): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly request: HumanLoopRequest | undefined } | undefined>;
  respondHumanLoop?(id: string, requestId: string, input: { readonly value: unknown; readonly expectedRevision: number }): Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly response: HumanLoopResponse } | undefined>;
}

export interface LocalAgentRelease {
  readonly version: string;
  readonly protocolVersion: string;
  readonly platform: "darwin" | "windows" | "linux";
  readonly arch: "arm64" | "x64";
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly signature: string;
  readonly releaseNotes?: string;
  readonly launchUrl?: string;
}

export function createRouterHttpServer(router: RouterTaskApi, options: {
  readonly identity?: Pick<IdentityService, "register" | "login" | "authenticate" | "revoke">;
  readonly devices?: Pick<DeviceRepository, "issueRegistrationToken" | "registerAgent" | "heartbeat" | "list" | "revoke" | "issueLocalSession" | "authorizeLocalSession">;
  readonly attachments?: AttachmentBroker;
  readonly runtimeAttachmentToken?: string;
  readonly runtimeDispatchToken?: string;
  readonly webOrigin?: string;
  readonly localAgentReleases?: readonly LocalAgentRelease[];
  readonly localAgentControl?: LocalAgentControlPlane;
} = {}): Server {
  return createServer(async (request, response) => {
    try {
      setCors(response, request.headers.origin, options.webOrigin);
      if (request.method === "OPTIONS") return json(response, 204, undefined);
      const url = new URL(request.url ?? "/", "http://agentloop-router.local");
      if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "ok" });
      if (request.method === "POST" && (url.pathname === "/v1/auth/register" || url.pathname === "/v1/auth/login")) {
        if (options.identity === undefined) return json(response, 503, { error: "identity_not_configured" });
        const body = record(await readJson(request), "request body");
        const session = url.pathname.endsWith("register")
          ? await options.identity.register(body.email, body.password)
          : await options.identity.login(body.email, body.password);
        return json(response, url.pathname.endsWith("register") ? 201 : 200, sessionResponse(session));
      }
      if (request.method === "POST" && url.pathname === "/v1/device-agent/register") {
        if (options.devices === undefined) return json(response, 503, { error: "devices_not_configured" });
        const body = record(await readJson(request), "request body");
        const device = await options.devices.registerAgent({ registrationToken: body.registrationToken, displayName: body.displayName, publicKey: body.publicKey });
        return json(response, 201, { device: { id: device.id, displayName: device.displayName, status: device.status, lastSeenAt: device.lastSeenAt, createdAt: device.createdAt }, agentToken: device.agentToken });
      }
      if (request.method === "POST" && url.pathname === "/v1/device-agent/heartbeat") {
        if (options.devices === undefined) return json(response, 503, { error: "devices_not_configured" });
        const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
        return json(response, 200, { device: await options.devices.heartbeat(authorization?.replace(/^Bearer\s+/i, "")) });
      }
      if (request.method === "POST" && url.pathname === "/v1/device-agent/authorize-session") {
        if (options.devices === undefined) return json(response, 503, { error: "devices_not_configured" });
        const body = record(await readJson(request), "request body");
        const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
        return json(response, 200, { session: await options.devices.authorizeLocalSession(authorization?.replace(/^Bearer\s+/i, ""), body.sessionToken) });
      }
      const internalRequest = url.pathname.startsWith("/v1/internal/");
      let principal: Principal | undefined;
      if (!internalRequest) {
        if (options.identity === undefined) return json(response, 503, { error: "identity_not_configured" });
        principal = await options.identity.authenticate(request.headers.authorization);
        // Existing handlers consume these fields; overwrite untrusted values only after authentication.
        request.headers["x-tenant-id"] = principal.tenantId;
        request.headers["x-user-id"] = principal.userId;
      }
      if (request.method === "GET" && url.pathname === "/v1/auth/me") {
        return json(response, 200, { user: { id: principal!.userId, email: principal!.email }, tenant: { id: principal!.tenantId } });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return json(response, 200, { models: await router.models?.(principal!.tenantId, principal!.userId) ?? [] });
      }
      if (request.method === "GET" && url.pathname === "/v1/runtimes") {
        return json(response, 200, { runtimes: await router.runtimes?.(principal!.tenantId, principal!.userId) ?? [] });
      }
      if (request.method === "GET" && url.pathname === "/v1/local-agent/releases/latest") {
        const platform = url.searchParams.get("platform");
        const arch = url.searchParams.get("arch");
        const releases = (options.localAgentReleases ?? []).filter((release) =>
          (platform === null || release.platform === platform) && (arch === null || arch === "unknown" || release.arch === arch));
        if (releases.length === 0) return json(response, 404, { error: "local_agent_release_unavailable" });
        return json(response, 200, { protocolVersion: "1", releases });
      }
      if (request.method === "GET" && url.pathname === "/v1/devices") {
        if (options.devices === undefined) return json(response, 503, { error: "devices_not_configured" });
        return json(response, 200, { devices: await options.devices.list(principal!) });
      }
      const localAgentStatusMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/local-agent\/status$/);
      if (request.method === "GET" && localAgentStatusMatch !== null) {
        return json(response, 200, await localAgentControl(options, principal!, decodeURIComponent(localAgentStatusMatch[1]), "agent.status"));
      }
      const localAgentRuntimesMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/local-agent\/runtimes$/);
      if (request.method === "GET" && localAgentRuntimesMatch !== null) {
        return json(response, 200, await localAgentControl(options, principal!, decodeURIComponent(localAgentRuntimesMatch[1]), "agent.runtimes.list"));
      }
      if (request.method === "POST" && localAgentRuntimesMatch !== null) {
        const body = record(await readJson(request), "request body");
        return json(response, 201, await localAgentControl(options, principal!, decodeURIComponent(localAgentRuntimesMatch[1]), "agent.runtimes.create", { displayName: body.displayName }));
      }
      const localAgentRuntimeMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/local-agent\/runtimes\/([^/]+)$/);
      if (request.method === "PATCH" && localAgentRuntimeMatch !== null) {
        const body = record(await readJson(request), "request body");
        return json(response, 200, await localAgentControl(options, principal!, decodeURIComponent(localAgentRuntimeMatch[1]), "agent.runtimes.rename", { runtimeId: decodeURIComponent(localAgentRuntimeMatch[2]), displayName: body.displayName }));
      }
      if (request.method === "DELETE" && localAgentRuntimeMatch !== null) {
        return json(response, 200, await localAgentControl(options, principal!, decodeURIComponent(localAgentRuntimeMatch[1]), "agent.runtimes.remove", { runtimeId: decodeURIComponent(localAgentRuntimeMatch[2]) }));
      }
      const localAgentLifecycleMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/local-agent\/runtimes\/([^/]+)\/(drain|restart|stop|start)$/);
      if (request.method === "POST" && localAgentLifecycleMatch !== null) {
        return json(response, 200, await localAgentControl(options, principal!, decodeURIComponent(localAgentLifecycleMatch[1]), "agent.runtimes.lifecycle", { runtimeId: decodeURIComponent(localAgentLifecycleMatch[2]), action: localAgentLifecycleMatch[3] }));
      }
      const localAgentConfigMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/local-agent\/config$/);
      if (request.method === "GET" && localAgentConfigMatch !== null) {
        return json(response, 200, await localAgentControl(options, principal!, decodeURIComponent(localAgentConfigMatch[1]), "agent.config.get"));
      }
      const localAgentStoragePickMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/local-agent\/config\/shared-storage\/pick$/);
      if (request.method === "POST" && localAgentStoragePickMatch !== null) {
        return json(response, 200, await localAgentControl(options, principal!, decodeURIComponent(localAgentStoragePickMatch[1]), "agent.config.sharedStorage.pick"));
      }
      const localAgentUploadStoragePickMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/local-agent\/config\/upload-storage\/pick$/);
      if (request.method === "POST" && localAgentUploadStoragePickMatch !== null) {
        return json(response, 200, await localAgentControl(options, principal!, decodeURIComponent(localAgentUploadStoragePickMatch[1]), "agent.config.uploadStorage.pick"));
      }
      if (request.method === "POST" && url.pathname === "/v1/devices/registration-tokens") {
        if (options.devices === undefined) return json(response, 503, { error: "devices_not_configured" });
        return json(response, 201, await options.devices.issueRegistrationToken(principal!));
      }
      const localSessionMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/local-sessions$/);
      if (request.method === "POST" && localSessionMatch !== null) {
        if (options.devices === undefined) return json(response, 503, { error: "devices_not_configured" });
        return json(response, 201, await options.devices.issueLocalSession(principal!, decodeURIComponent(localSessionMatch[1])));
      }
      const revokeDeviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revokeDeviceMatch !== null) {
        if (options.devices === undefined) return json(response, 503, { error: "devices_not_configured" });
        await options.devices.revoke(principal!, decodeURIComponent(revokeDeviceMatch[1]));
        return json(response, 204, undefined);
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        await options.identity?.revoke(request.headers.authorization);
        return json(response, 204, undefined);
      }
      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        if (router.conversations === undefined) return json(response, 501, { error: "conversations_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        return json(response, 200, await router.conversations(identity.tenantId, identity.ownerUserId, {
          limit: pageInteger(url.searchParams.get("limit"), "limit", 30, 1, 100),
          offset: pageInteger(url.searchParams.get("offset"), "offset", 0, 0, 10_000),
        }));
      }
      const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
      if (request.method === "DELETE" && conversationMatch !== null) {
        if (router.deleteConversation === undefined) return json(response, 501, { error: "conversation_delete_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        await router.deleteConversation(identity.tenantId, identity.ownerUserId, decodeURIComponent(conversationMatch[1]));
        return json(response, 204, undefined);
      }
      if (request.method === "GET" && conversationMatch !== null) {
        if (router.conversation === undefined) return json(response, 501, { error: "conversation_detail_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const detail = await router.conversation(identity.tenantId, identity.ownerUserId, decodeURIComponent(conversationMatch[1]));
        return detail === undefined ? json(response, 404, { error: "conversation_not_found" }) : json(response, 200, detail);
      }
      if (request.method === "POST" && url.pathname === "/v1/attachments") {
        if (options.attachments === undefined) return json(response, 501, { error: "attachments_not_configured" });
        const body = await readJson(request);
        const identity = identityFromRequest(body, principal!);
        const value = record(body, "request body");
        const originalName = stringValue(value.originalName, "originalName");
        const content = base64(value.contentBase64, "contentBase64");
        await assertUploadedSourceContent({ originalName, content });
        return json(response, 201, {
          attachment: await options.attachments.upload({
            ...identity,
            conversationId: stringValue(value.conversationId, "conversationId"),
            originalName,
            mediaType: optionalString(value.mediaType) ?? "application/octet-stream",
            content,
          }),
        });
      }
      const attachmentMatch = url.pathname.match(/^\/v1\/internal\/attachments\/([^/]+)$/);
      if (request.method === "GET" && attachmentMatch !== null) {
        if (options.attachments === undefined) return json(response, 501, { error: "attachments_not_configured" });
        if (options.runtimeAttachmentToken === undefined || request.headers.authorization !== `Bearer ${options.runtimeAttachmentToken}`) {
          return json(response, 401, { error: "attachment_read_unauthorized" });
        }
        const result = await options.attachments.readForRuntime(decodeURIComponent(attachmentMatch[1]));
        response.statusCode = 200;
        response.setHeader("content-type", result.attachment.mediaType);
        response.setHeader("content-length", result.content.length);
        response.end(result.content);
        return;
      }
      const heartbeatMatch = url.pathname.match(/^\/v1\/internal\/runtimes\/([^/]+)\/heartbeat$/);
      if (request.method === "POST" && heartbeatMatch !== null) {
        if (router.heartbeat === undefined) return json(response, 501, { error: "heartbeats_not_configured" });
        if (options.runtimeDispatchToken === undefined || request.headers.authorization !== `Bearer ${options.runtimeDispatchToken}`) {
          return json(response, 401, { error: "runtime_heartbeat_unauthorized" });
        }
        const body = record(await readJson(request), "request body");
        await router.heartbeat({
          runtimeId: decodeURIComponent(heartbeatMatch[1]),
          status: runtimeStatus(body.status),
          activeRunCount: nonNegativeInteger(body.activeRunCount, "activeRunCount"),
          queuedRunCount: nonNegativeInteger(body.queuedRunCount, "queuedRunCount"),
          ...(body.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: positiveInteger(body.maxConcurrentRuns, "maxConcurrentRuns") }),
          observedAt: Date.now(),
        });
        return json(response, 204, undefined);
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const body = await readJson(request);
        const task = await taskFromRequest(body, principal!, options.attachments, false);
        return json(response, 202, { assignment: await router.submit(task) });
      }
      if (request.method === "POST" && url.pathname === "/v2/tasks") {
        const body = await readJson(request);
        const task = await taskFromRequest(body, principal!, options.attachments, true);
        return json(response, 202, { assignment: await router.submit(task) });
      }
      const recoveryAdvanceMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/recovery\/advance$/);
      if (request.method === "POST" && recoveryAdvanceMatch !== null) {
        if (router.advanceRecovery === undefined) return json(response, 501, { error: "recovery_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.advanceRecovery(decodeURIComponent(recoveryAdvanceMatch[1]));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) {
          return json(response, 404, { error: "assignment_not_found" });
        }
        return json(response, 200, { recovery: projection.recovery });
      }
      const recoveryResumeMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/recovery\/resume$/);
      if (request.method === "POST" && recoveryResumeMatch !== null) {
        if (router.resumeRecovery === undefined) return json(response, 501, { error: "recovery_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.resumeRecovery(decodeURIComponent(recoveryResumeMatch[1]));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) {
          return json(response, 404, { error: "assignment_not_found" });
        }
        return json(response, 200, { run: projection.run });
      }
      const checkpointStartMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/checkpoint\/start$/);
      if (request.method === "POST" && checkpointStartMatch !== null) {
        if (router.startFromCheckpoint === undefined) return json(response, 501, { error: "checkpoint_continuation_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.startFromCheckpoint(decodeURIComponent(checkpointStartMatch[1]));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) {
          return json(response, 404, { error: "assignment_not_found" });
        }
        return json(response, 202, { assignment: projection.assignment, run: projection.run });
      }
      const assignmentId = assignmentIdFromPath(url.pathname);
      if (request.method === "GET" && assignmentId !== undefined) {
        const id = assignmentId;
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.assignment(id);
        if (projection === undefined) return json(response, 404, { error: "assignment_not_found" });
        if (projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) {
          return json(response, 404, { error: "assignment_not_found" });
        }
        return json(response, 200, projection);
      }
      const artifactPreviewMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/artifacts\/([^/]+)\/preview$/);
      if (request.method === "GET" && artifactPreviewMatch !== null) {
        if (router.previewArtifact === undefined) return json(response, 501, { error: "artifacts_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.previewArtifact(decodeURIComponent(artifactPreviewMatch[1]), decodeURIComponent(artifactPreviewMatch[2]));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) return json(response, 404, { error: "assignment_not_found" });
        return json(response, 200, projection.preview);
      }
      const artifactContentMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/artifacts\/([^/]+)$/);
      if (request.method === "GET" && artifactContentMatch !== null) {
        if (router.readArtifact === undefined) return json(response, 501, { error: "artifacts_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.readArtifact(decodeURIComponent(artifactContentMatch[1]), decodeURIComponent(artifactContentMatch[2]));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) return json(response, 404, { error: "assignment_not_found" });
        response.statusCode = 200;
        response.setHeader("content-type", projection.artifact.mimeType);
        response.setHeader("content-length", projection.content.byteLength);
        response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(projection.artifact.name)}`);
        response.end(Buffer.from(projection.content));
        return;
      }
      const artifactListMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/artifacts$/);
      if (request.method === "GET" && artifactListMatch !== null) {
        if (router.artifacts === undefined) return json(response, 501, { error: "artifacts_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.artifacts(decodeURIComponent(artifactListMatch[1]));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) return json(response, 404, { error: "assignment_not_found" });
        return json(response, 200, { artifacts: projection.artifacts });
      }
      const cancelMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch !== null) {
        if (router.cancel === undefined) return json(response, 501, { error: "cancellation_not_configured" });
        const projection = await router.assignment(decodeURIComponent(cancelMatch[1]));
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) {
          return json(response, 404, { error: "assignment_not_found" });
        }
        return json(response, 200, await router.cancel(decodeURIComponent(cancelMatch[1])));
      }
      const humanLoopCurrentMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/human-loop\/current$/);
      if (request.method === "GET" && humanLoopCurrentMatch !== null) {
        if (router.currentHumanLoop === undefined) return json(response, 501, { error: "human_loop_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.currentHumanLoop(decodeURIComponent(humanLoopCurrentMatch[1]));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) return json(response, 404, { error: "assignment_not_found" });
        return json(response, 200, { request: projection.request });
      }
      const humanLoopRespondMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/human-loop\/([^/]+)\/respond$/);
      if (request.method === "POST" && humanLoopRespondMatch !== null) {
        if (router.respondHumanLoop === undefined) return json(response, 501, { error: "human_loop_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const body = record(await readJson(request), "request body");
        const projection = await router.respondHumanLoop(decodeURIComponent(humanLoopRespondMatch[1]), decodeURIComponent(humanLoopRespondMatch[2]), { value: body.value, expectedRevision: positiveInteger(body.expectedRevision, "expectedRevision") });
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) return json(response, 404, { error: "assignment_not_found" });
        return json(response, 200, { response: projection.response });
      }
      const eventsMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/events$/);
      const eventsStreamMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/events\/stream$/);
      const commandOutputMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/commands\/([^/]+)\/(stdout|stderr)$/);
      if (request.method === "GET" && commandOutputMatch !== null) {
        if (router.commandOutput === undefined) return json(response, 501, { error: "command_output_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.commandOutput(decodeURIComponent(commandOutputMatch[1]), decodeURIComponent(commandOutputMatch[2]), commandOutputMatch[3] as "stdout" | "stderr");
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) return json(response, 404, { error: "assignment_not_found" });
        return json(response, 200, { output: projection.output });
      }
      const toolArgumentsMatch = url.pathname.match(/^\/v1\/assignments\/([^/]+)\/tool-arguments\/([^/]+)$/);
      if (request.method === "GET" && toolArgumentsMatch !== null) {
        if (router.toolArguments === undefined) return json(response, 501, { error: "tool_arguments_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.toolArguments(decodeURIComponent(toolArgumentsMatch[1]), decodeURIComponent(toolArgumentsMatch[2]));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) return json(response, 404, { error: "assignment_not_found" });
        return json(response, 200, { arguments: projection.arguments });
      }
      if (request.method === "GET" && eventsStreamMatch !== null) {
        if (router.events === undefined) return json(response, 501, { error: "events_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const assignmentId = decodeURIComponent(eventsStreamMatch[1]);
        const initial = await router.events(assignmentId, Number(url.searchParams.get("afterSeq") ?? 0));
        if (initial === undefined || initial.assignment.tenantId !== identity.tenantId || initial.assignment.ownerUserId !== identity.ownerUserId) {
          return json(response, 404, { error: "assignment_not_found" });
        }
        return streamEvents(request, response, bindRouterEvents(router), assignmentId, initial.events,
          Number(url.searchParams.get("afterSeq") ?? 0), async (id) => (await router.assignment(id))?.run);
      }
      if (request.method === "GET" && eventsMatch !== null) {
        if (router.events === undefined) return json(response, 501, { error: "events_not_configured" });
        const identity = identityFromHeaders(request.headers["x-tenant-id"], request.headers["x-user-id"]);
        const projection = await router.events(decodeURIComponent(eventsMatch[1]), Number(url.searchParams.get("afterSeq") ?? 0));
        if (projection === undefined || projection.assignment.tenantId !== identity.tenantId || projection.assignment.ownerUserId !== identity.ownerUserId) {
          return json(response, 404, { error: "assignment_not_found" });
        }
        return json(response, 200, { events: projection.events });
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof IdentityError || error instanceof DeviceError ? error.status
        : (error as { statusCode?: number }).statusCode ?? (message.includes("capacity") || message.includes("device_unavailable") ? 409 : 400);
      return json(response, status, { error: message, ...(error instanceof IdentityError || error instanceof DeviceError ? { code: error.code } : {}) });
    }
  });
}

export class HttpRuntimeEndpoint implements RuntimeEndpoint {
  private readonly endpoint: string;
  private readonly authorization?: string;

  constructor(endpoint: string, authorization?: string) {
    this.endpoint = endpoint;
    this.authorization = authorization;
  }

  async dispatch(envelope: RuntimeDispatchEnvelope) {
    const response = await fetch(new URL("/v1/runtime-dispatches", `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
      },
      body: JSON.stringify(envelope),
    });
    const body = await response.json() as { remoteRunId?: string; error?: string };
    if (!response.ok || typeof body.remoteRunId !== "string") {
      throw new Error(body.error ?? `runtime dispatch failed with HTTP ${response.status}`);
    }
    return { remoteRunId: body.remoteRunId };
  }

  async getRun(remoteRunId: string): Promise<RuntimeRunStatus> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}`, `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as RuntimeRunStatus & { error?: string };
    if (!response.ok || typeof body.remoteRunId !== "string") throw new Error(body.error ?? `runtime status failed with HTTP ${response.status}`);
    return body;
  }

  async artifacts(remoteRunId: string) {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/artifacts`, `${this.endpoint.replace(/\/$/, "")}/`), { headers: this.authorization === undefined ? {} : { authorization: this.authorization } });
    const body = await response.json() as { artifacts?: ProcessArtifact[]; error?: string };
    if (!response.ok || !Array.isArray(body.artifacts)) throw new Error(body.error ?? `runtime artifacts failed with HTTP ${response.status}`);
    return body.artifacts;
  }

  async readArtifact(remoteRunId: string, artifactId: string) {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/artifacts/${encodeURIComponent(artifactId)}`, `${this.endpoint.replace(/\/$/, "")}/`), { headers: this.authorization === undefined ? {} : { authorization: this.authorization } });
    if (!response.ok) throw new Error((await response.text()) || `runtime artifact read failed with HTTP ${response.status}`);
    const artifact = (await this.artifacts(remoteRunId)).find((item) => item.id === artifactId);
    if (artifact === undefined) throw new Error("runtime artifact not found");
    return { artifact, content: new Uint8Array(await response.arrayBuffer()) };
  }

  async previewArtifact(remoteRunId: string, artifactId: string): Promise<ProcessArtifactPreview> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/artifacts/${encodeURIComponent(artifactId)}/preview`, `${this.endpoint.replace(/\/$/, "")}/`), { headers: this.authorization === undefined ? {} : { authorization: this.authorization } });
    const body = await response.json() as ProcessArtifactPreview & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `runtime artifact preview failed with HTTP ${response.status}`);
    return body;
  }

  async models(): Promise<readonly RuntimeModelSummary[]> {
    const response = await fetch(new URL("/v1/models", `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { models?: RuntimeModelSummary[]; error?: string };
    if (!response.ok || !Array.isArray(body.models)) throw new Error(body.error ?? `runtime model catalog failed with HTTP ${response.status}`);
    return body.models;
  }

  async cancelRun(remoteRunId: string): Promise<RuntimeRunStatus> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/cancel`, `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as RuntimeRunStatus & { error?: string };
    if (!response.ok || typeof body.remoteRunId !== "string") throw new Error(body.error ?? `runtime cancellation failed with HTTP ${response.status}`);
    return body;
  }

  async events(remoteRunId: string, afterSeq: number): Promise<readonly RuntimeRunEvent[]> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/events?afterSeq=${afterSeq}`, `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as { events?: RuntimeRunEvent[]; error?: string };
    if (!response.ok || !Array.isArray(body.events)) throw new Error(body.error ?? `runtime events failed with HTTP ${response.status}`);
    return body.events;
  }

  async commandOutput(remoteRunId: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<CommandOutputContent> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/commands/${encodeURIComponent(toolCallId)}/${stream}`, `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { output?: CommandOutputContent; error?: string };
    if (!response.ok || body.output === undefined) throw new Error(body.error ?? `runtime command output failed with HTTP ${response.status}`);
    return body.output;
  }

  async toolArguments(remoteRunId: string, toolCallId: string): Promise<ToolArgumentsContent> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/tool-arguments/${encodeURIComponent(toolCallId)}`, `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { arguments?: ToolArgumentsContent; error?: string };
    if (!response.ok || body.arguments === undefined) throw new Error(body.error ?? `runtime tool arguments failed with HTTP ${response.status}`);
    return body.arguments;
  }

  async advanceRecovery(remoteRunId: string): Promise<RecoveryDetail> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/recovery/advance`, `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { recovery?: RecoveryDetail; error?: string };
    if (!response.ok || body.recovery === undefined) throw new Error(body.error ?? `runtime recovery advance failed with HTTP ${response.status}`);
    return body.recovery;
  }

  async resumeRecovery(remoteRunId: string): Promise<RuntimeRunStatus> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/recovery/resume`, `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { run?: RuntimeRunStatus; error?: string };
    if (!response.ok || body.run === undefined) throw new Error(body.error ?? `runtime recovery resume failed with HTTP ${response.status}`);
    return body.run;
  }

  async startFromCheckpoint(remoteRunId: string): Promise<RuntimeRunStatus> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/checkpoint/start`, `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { run?: RuntimeRunStatus; error?: string };
    if (!response.ok || body.run === undefined) throw new Error(body.error ?? `runtime checkpoint start failed with HTTP ${response.status}`);
    return body.run;
  }

  async currentHumanLoop(remoteRunId: string) {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/human-loop/current`, `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { request?: import("@zhujun/agentloop").HumanLoopRequest; error?: string };
    if (!response.ok) throw new Error(body.error ?? `runtime Human-in-the-Loop query failed with HTTP ${response.status}`);
    return body.request;
  }

  async respondHumanLoop(remoteRunId: string, requestId: string, input: { readonly value: unknown; readonly expectedRevision: number }) {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/human-loop/${encodeURIComponent(requestId)}/respond`, `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST", headers: { "content-type": "application/json", ...(this.authorization === undefined ? {} : { authorization: this.authorization }) }, body: JSON.stringify(input),
    });
    const body = await response.json() as { response?: import("@zhujun/agentloop").HumanLoopResponse; error?: string };
    if (!response.ok || body.response === undefined) throw new Error(body.error ?? `runtime Human-in-the-Loop response failed with HTTP ${response.status}`);
    return body.response;
  }
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function taskFromRequest(
  body: unknown,
  principal: Principal,
  attachments: AttachmentBroker | undefined,
  requireV2 = false,
): Promise<SubmitConversationTask> {
  const value = record(body, "request body");
  if (requireV2 && value.schema !== "agentloop.task/v2") throw new TypeError("schema must be agentloop.task/v2");
  if (requireV2 && (value.executionTarget === undefined || value.dataPolicy === undefined)) {
    throw new TypeError("agentloop.task/v2 requires executionTarget and dataPolicy");
  }
  for (const field of ["tenantId", "ownerUserId", "userId"]) {
    if (Object.hasOwn(value, field)) throw new TypeError(`${field} is derived from the authenticated session`);
  }
  if (Object.hasOwn(value, "visibleDirectories")) {
    throw new TypeError("visibleDirectories are disabled for the cloud multi-runtime application");
  }
  if (Object.hasOwn(value, "conversationIntent")) {
    throw new TypeError("conversationIntent is Runtime-owned and cannot be supplied by callers");
  }
  if (Object.hasOwn(value, "resourceRefs")) throw new TypeError("resourceRefs are Router-owned; submit attachmentIds instead");
  const executionTarget = parseExecutionTarget(value.executionTarget ?? { kind: "cloud_pool" });
  const dataPolicy = parseDataPolicy(value.dataPolicy ?? { mode: "cloud" });
  if (executionTarget.kind === "cloud_pool" && dataPolicy.mode !== "cloud") {
    throw Object.assign(new Error("cloud_data_policy_required: cloud execution requires dataPolicy.mode=cloud"), { statusCode: 409 });
  }
  if (executionTarget.kind === "local_device" && dataPolicy.mode === "cloud") {
    throw Object.assign(new Error("local_data_policy_required: local execution requires dataPolicy.mode=local or strict_local"), { statusCode: 409 });
  }
  if (executionTarget.kind === "local_device" && dataPolicy.mode === "strict_local") {
    throw Object.assign(new Error("strict_local_direct_required: strict local task content must use the loopback data plane"), { statusCode: 409 });
  }
  if (executionTarget.kind === "local_device" && value.requestedRuntimeId !== undefined) {
    throw new TypeError("executionTarget.runtimeId is the sole Runtime selection for local execution");
  }
  const identity = identityFromPrincipal(principal);
  const attachmentIds = value.attachmentIds === undefined ? [] : stringArray(value.attachmentIds, "attachmentIds");
  if (executionTarget.kind === "local_device" && attachmentIds.length > 0) {
    throw Object.assign(new Error("cloud_data_transfer_required: local execution cannot consume cloud attachments without an explicit transfer"), { statusCode: 409 });
  }
  const localUploadedSourceIds = value.localUploadedSourceIds === undefined ? undefined : (
    executionTarget.kind === "local_device"
      ? stringArray(value.localUploadedSourceIds, "localUploadedSourceIds")
      : (() => { throw new TypeError("localUploadedSourceIds require a local execution target"); })()
  );
  if (attachmentIds.length > 0 && attachments === undefined) throw new TypeError("attachments are not configured");
  const conversationId = stringValue(value.conversationId, "conversationId");
  const resourceRefs = await (attachments?.resolveForTask({ ...identity, conversationId, attachmentIds }) ?? []);
  return {
    ...identity,
    conversationId,
    clientMessageId: stringValue(value.clientMessageId, "clientMessageId"),
    input: stringValue(value.input, "input"),
    executionTarget,
    dataPolicy,
    ...(value.localDirectoryScopeIds === undefined ? {} : {
      localDirectoryScopeIds: executionTarget.kind === "local_device"
        ? stringArray(value.localDirectoryScopeIds, "localDirectoryScopeIds")
        : (() => { throw new TypeError("localDirectoryScopeIds require a local execution target"); })(),
    }),
    ...(localUploadedSourceIds === undefined ? {} : { localUploadedSourceIds }),
    ...(value.requestedRuntimeId === undefined ? {} : { requestedRuntimeId: stringValue(value.requestedRuntimeId, "requestedRuntimeId") }),
    ...(value.requestedProfile === undefined ? {} : { requestedProfile: value.requestedProfile as SubmitConversationTask["requestedProfile"] }),
    ...(value.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: stringArray(value.requiredCapabilities, "requiredCapabilities") }),
    ...(value.requestedModelKey === undefined ? {} : { requestedModelKey: stringValue(value.requestedModelKey, "requestedModelKey") }),
    allowDangerousTools: value.allowDangerousTools !== false,
    resourceRefs,
  };
}

function identityFromRequest(_body: unknown, principal: Principal): { readonly tenantId: string; readonly ownerUserId: string } {
  const value = record(_body, "request body");
  for (const field of ["tenantId", "ownerUserId", "userId"]) {
    if (Object.hasOwn(value, field)) throw new TypeError(`${field} is derived from the authenticated session`);
  }
  return identityFromPrincipal(principal);
}

function identityFromPrincipal(principal: Principal): { readonly tenantId: string; readonly ownerUserId: string } {
  return {
    tenantId: principal.tenantId,
    ownerUserId: principal.userId,
  };
}

async function localAgentControl<T>(options: { readonly localAgentControl?: LocalAgentControlPlane }, principal: Principal, deviceId: string, method: string, payload?: Record<string, unknown>): Promise<T> {
  if (options.localAgentControl === undefined) throw new Error("local_agent_control_not_configured");
  return await options.localAgentControl.agentControl<T>({
    tenantId: principal.tenantId,
    ownerUserId: principal.userId,
    deviceId,
    method,
    ...(payload === undefined ? {} : { payload }),
  });
}

function parseExecutionTarget(value: unknown): import("../domain/contracts.ts").ExecutionTarget {
  const target = record(value, "executionTarget");
  if (target.kind === "cloud_pool") {
    if (target.profile !== undefined && target.profile !== "general" && target.profile !== "artifact") throw new TypeError("executionTarget.profile is invalid");
    if (target.region !== undefined) stringValue(target.region, "executionTarget.region");
    return { kind: "cloud_pool", ...(target.profile === undefined ? {} : { profile: target.profile }), ...(target.region === undefined ? {} : { region: target.region as string }) };
  }
  if (target.kind === "local_device") return {
    kind: "local_device",
    deviceId: stringValue(target.deviceId, "executionTarget.deviceId"),
    runtimeId: stringValue(target.runtimeId, "executionTarget.runtimeId"),
  };
  throw new TypeError("executionTarget.kind must be cloud_pool or local_device");
}

function parseDataPolicy(value: unknown): import("../domain/contracts.ts").DataPolicy {
  const policy = record(value, "dataPolicy");
  if (policy.mode === "cloud" || policy.mode === "local" || policy.mode === "strict_local") return { mode: policy.mode };
  throw new TypeError("dataPolicy.mode must be cloud, local, or strict_local");
}

function sessionResponse(session: import("../auth/identity-service.ts").IdentitySession) {
  return { token: session.token, expiresAt: session.expiresAt, user: { id: session.principal.userId, email: session.principal.email }, tenant: { id: session.principal.tenantId } };
}

function identityFromHeaders(tenantHeader: string | string[] | undefined, userHeader: string | string[] | undefined): { readonly tenantId: string; readonly ownerUserId: string } {
  return {
    tenantId: stringValue(headerString(tenantHeader), "x-tenant-id"),
    ownerUserId: stringValue(headerString(userHeader), "x-user-id"),
  };
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, "mediaType");
}

function base64(value: unknown, field: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new TypeError(`${field} must be base64`);
  }
  return Buffer.from(value, "base64");
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function pageInteger(value: string | null, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function runtimeStatus(value: unknown): "ready" | "draining" | "offline" {
  if (value === "ready" || value === "draining" || value === "offline") return value;
  throw new TypeError("status must be ready, draining, or offline");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(body === undefined ? "" : JSON.stringify(body));
}

function setCors(response: import("node:http").ServerResponse, origin: string | undefined, allowedOrigin: string | undefined): void {
  if (origin !== undefined && webOriginMatches(origin, allowedOrigin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-headers", "content-type, authorization");
    response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  }
}

/** Permit only the explicitly configured development origins, never a reflected wildcard. */
export function webOriginMatches(origin: string, configuredOrigins: string | undefined): boolean {
  return configuredOrigins?.split(",").map((item) => item.trim()).includes(origin) ?? false;
}

/** A plain assignment endpoint has exactly one path segment after `assignments`. */
export function assignmentIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/v1\/assignments\/([^/]+)$/);
  return match === null ? undefined : decodeURIComponent(match[1]);
}

/**
 * Project Router events through a closure rather than extracting the method.
 * Persistent router methods use `this` to reach their durable stores.
 */
export function bindRouterEvents(router: Pick<RouterTaskApi, "events">): (assignmentId: string, afterSeq: number) => Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly events: readonly RuntimeRunEvent[] } | undefined> {
  if (router.events === undefined) throw new TypeError("events_not_configured");
  return (assignmentId, afterSeq) => router.events!(assignmentId, afterSeq);
}

export function streamEvents(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  events: (assignmentId: string, afterSeq: number) => Promise<{ readonly assignment: { readonly tenantId: string; readonly ownerUserId: string }; readonly events: readonly RuntimeRunEvent[] } | undefined>,
  assignmentId: string,
  initialEvents: readonly RuntimeRunEvent[],
  afterSeq = 0,
  readRun?: (assignmentId: string) => Promise<RuntimeRunStatus | undefined>,
): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders();
  let cursor = afterSeq;
  let closed = false;
  let polling = false;
  let lastStatusCheck = 0;
  const emit = (events: readonly RuntimeRunEvent[]) => {
    for (const event of events) {
      if (event.seq <= cursor) continue;
      cursor = Math.max(cursor, event.seq);
      response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  emit(initialEvents);
  const timer = setInterval(() => {
    if (closed || polling) return;
    polling = true;
    void events(assignmentId, cursor)
      .then(async (projection) => {
        if (closed) return;
        if (projection === undefined) {
          response.write("event: stream.error\ndata: {\"error\":\"assignment_not_found\"}\n\n");
          response.end();
          return;
        }
        emit(projection.events);
        if (projection.events.length === 0 && readRun !== undefined && Date.now() - lastStatusCheck >= 5_000) {
          lastStatusCheck = Date.now();
          const run = await readRun(assignmentId);
          if (closed) return;
          if (run !== undefined && ["completed", "failed", "cancelled"].includes(run.status)) {
            // Snapshot is explicitly not a fabricated durable event or sequence.
            response.write(`event: run.snapshot\ndata: ${JSON.stringify({ run })}\n\n`);
            response.end();
            return;
          }
        }
        response.write(": keepalive\n\n");
      })
      .catch((error) => {
        if (!closed) response.write(`event: stream.error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`);
      }).finally(() => { polling = false; });
  }, 1_000);
  // An HTTP GET request is complete as soon as its headers have been read;
  // `request.close` therefore does not describe the lifetime of this SSE
  // response.  Closing the poller there leaves the browser with only the
  // initial events (often just `run.started`).  The response owns the stream,
  // so release it only when that connection actually closes.
  response.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
}
