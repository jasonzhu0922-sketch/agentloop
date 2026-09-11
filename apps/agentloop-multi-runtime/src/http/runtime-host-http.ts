import { createServer, type Server } from "node:http";
import { assertRuntimeDispatchEnvelope, type AgentLoopRuntimeHost } from "../runtime/runtime-host.ts";
import type { RuntimeModelSummary } from "../domain/contracts.ts";

/** Private Router-to-Host transport. It is not exposed as a browser API. */
export function createRuntimeHostHttpServer(host: AgentLoopRuntimeHost, options: { readonly dispatchToken?: string; readonly models?: readonly RuntimeModelSummary[] } = {}): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") return json(response, 200, { status: "ok" });
      if (request.method === "GET" && request.url === "/v1/models") return json(response, 200, { models: options.models ?? [] });
      const runMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch !== undefined && runMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
          return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        }
        return json(response, 200, await host.getRun(decodeURIComponent(runMatch[1])));
      }
      const humanLoopCurrentMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/human-loop\/current$/);
      if (request.method === "GET" && humanLoopCurrentMatch !== undefined && humanLoopCurrentMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        return json(response, 200, { request: await host.currentHumanLoop(decodeURIComponent(humanLoopCurrentMatch[1])) });
      }
      const humanLoopRespondMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/human-loop\/([^/]+)\/respond$/);
      if (request.method === "POST" && humanLoopRespondMatch !== undefined && humanLoopRespondMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        const body = readRecord(await readJson(request));
        if (typeof body.expectedRevision !== "number") throw new TypeError("expectedRevision must be a number");
        return json(response, 200, { response: await host.respondHumanLoop(decodeURIComponent(humanLoopRespondMatch[1]), decodeURIComponent(humanLoopRespondMatch[2]), { value: body.value, expectedRevision: body.expectedRevision }) });
      }
      const artifactPreviewMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/artifacts\/([^/]+)\/preview$/);
      if (request.method === "GET" && artifactPreviewMatch !== undefined && artifactPreviewMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
          return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        }
        return json(response, 200, await host.previewArtifact(decodeURIComponent(artifactPreviewMatch[1]), decodeURIComponent(artifactPreviewMatch[2])));
      }
      const artifactContentMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/artifacts\/([^/]+)$/);
      if (request.method === "GET" && artifactContentMatch !== undefined && artifactContentMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
          return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        }
        const result = await host.readArtifact(decodeURIComponent(artifactContentMatch[1]), decodeURIComponent(artifactContentMatch[2]));
        response.statusCode = 200;
        response.setHeader("content-type", result.artifact.mimeType);
        response.setHeader("content-length", result.content.byteLength);
        response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.artifact.name)}`);
        response.end(Buffer.from(result.content));
        return;
      }
      const artifactListMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/artifacts$/);
      if (request.method === "GET" && artifactListMatch !== undefined && artifactListMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
          return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        }
        return json(response, 200, { artifacts: await host.artifacts(decodeURIComponent(artifactListMatch[1])) });
      }
      const cancelMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch !== undefined && cancelMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
          return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        }
        return json(response, 200, await host.cancelRun(decodeURIComponent(cancelMatch[1])));
      }
      const eventsMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/events(?:\?afterSeq=(\d+))?$/);
      if (request.method === "GET" && eventsMatch !== undefined && eventsMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
          return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        }
        return json(response, 200, { events: await host.events(decodeURIComponent(eventsMatch[1]), Number(eventsMatch[2] ?? 0)) });
      }
      const recoveryAdvanceMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/recovery\/advance$/);
      if (request.method === "POST" && recoveryAdvanceMatch !== undefined && recoveryAdvanceMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
          return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        }
        return json(response, 200, { recovery: await host.advanceRecovery(decodeURIComponent(recoveryAdvanceMatch[1])) });
      }
      const recoveryResumeMatch = request.url?.match(/^\/v1\/runtime-runs\/([^/]+)\/recovery\/resume$/);
      if (request.method === "POST" && recoveryResumeMatch !== undefined && recoveryResumeMatch !== null) {
        if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
          return json(response, 401, { error: "runtime_dispatch_unauthorized" });
        }
        return json(response, 200, { run: await host.resumeRecovery(decodeURIComponent(recoveryResumeMatch[1])) });
      }
      if (request.method !== "POST" || request.url !== "/v1/runtime-dispatches") return json(response, 404, { error: "not_found" });
      if (options.dispatchToken !== undefined && request.headers.authorization !== `Bearer ${options.dispatchToken}`) {
        return json(response, 401, { error: "runtime_dispatch_unauthorized" });
      }
      const envelope = await readJson(request);
      assertRuntimeDispatchEnvelope(envelope);
      const result = await host.dispatch(envelope);
      return json(response, 202, result);
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function readRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("request body must be an object"); return value as Record<string, unknown>; }

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
