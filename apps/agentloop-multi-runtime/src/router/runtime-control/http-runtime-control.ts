import type { RuntimeArtifact, RuntimeArtifactPreview, RuntimeCommandOutput, RuntimeControlPort, RuntimeDispatchEnvelope, RuntimeHumanLoopRequest, RuntimeHumanLoopResponse, RuntimeModelSummary, RuntimeRecoveryDetail, RuntimeRunEvent, RuntimeRunStatus, RuntimeToolArguments } from "../../shared/contracts.ts";
import { RuntimeDispatchOutcomeUnknownError } from "../ports/control-plane-contracts.ts";
import type { ModelInvocation, ModelResponse } from "@zhujun/agentloop";
import type { ModelRetryReporter, ModelStreamSink } from "@zhujun/agentloop";
import { consumeModelResponse } from "../../shared/model-proxy.ts";

export class HttpRuntimeControl implements RuntimeControlPort {
  private readonly endpoint: string;
  private readonly authorization?: string;

  constructor(endpoint: string, authorization?: string) {
    this.endpoint = endpoint;
    this.authorization = authorization;
  }

  async dispatch(envelope: RuntimeDispatchEnvelope) {
    const dispatchUrl = new URL("/v1/runtime-dispatches", `${this.endpoint.replace(/\/$/, "")}/`);
    let response: Response;
    try {
      response = await fetch(dispatchUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
        },
        body: JSON.stringify(envelope),
      });
    } catch {
      throw new RuntimeDispatchOutcomeUnknownError("runtime_dispatch_ack_lost");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `runtime dispatch failed with HTTP ${response.status}`);
    }
    let body: { remoteRunId?: string; error?: string };
    try {
      body = await response.json() as { remoteRunId?: string; error?: string };
    } catch {
      throw new RuntimeDispatchOutcomeUnknownError("runtime_dispatch_ack_lost");
    }
    if (typeof body.remoteRunId !== "string") {
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
    const body = await response.json() as { artifacts?: RuntimeArtifact[]; error?: string };
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

  async previewArtifact(remoteRunId: string, artifactId: string): Promise<RuntimeArtifactPreview> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/artifacts/${encodeURIComponent(artifactId)}/preview`, `${this.endpoint.replace(/\/$/, "")}/`), { headers: this.authorization === undefined ? {} : { authorization: this.authorization } });
    const body = await response.json() as { error?: string };
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

  async completeModel(modelKey: string, invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
    return await this.completeModelStream(modelKey, invocation, async () => undefined, undefined, signal);
  }

  async completeModelStream(modelKey: string, invocation: ModelInvocation, sink: ModelStreamSink, onRetry?: ModelRetryReporter, signal?: AbortSignal): Promise<ModelResponse> {
    const response = await fetch(new URL("/v1/model-completions", `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.authorization === undefined ? {} : { authorization: this.authorization }) },
      body: JSON.stringify({ modelKey, invocation }),
      signal,
    });
    if (!response.ok) throw new Error(`model_proxy_failed:${response.status}`);
    return await consumeModelResponse(response, sink, onRetry);
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

  async latestEvent(remoteRunId: string): Promise<RuntimeRunEvent | undefined> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/events/latest`, `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as { event?: RuntimeRunEvent; error?: string };
    if (!response.ok) throw new Error(body.error ?? `runtime latest event failed with HTTP ${response.status}`);
    return body.event;
  }

  async commandOutput(remoteRunId: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<RuntimeCommandOutput> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/commands/${encodeURIComponent(toolCallId)}/${stream}`, `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { output?: RuntimeCommandOutput; error?: string };
    if (!response.ok || body.output === undefined) throw new Error(body.error ?? `runtime command output failed with HTTP ${response.status}`);
    return body.output;
  }

  async toolArguments(remoteRunId: string, toolCallId: string): Promise<RuntimeToolArguments> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/tool-arguments/${encodeURIComponent(toolCallId)}`, `${this.endpoint.replace(/\/$/, "")}/`), {
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { arguments?: RuntimeToolArguments; error?: string };
    if (!response.ok || body.arguments === undefined) throw new Error(body.error ?? `runtime tool arguments failed with HTTP ${response.status}`);
    return body.arguments;
  }

  async advanceRecovery(remoteRunId: string): Promise<RuntimeRecoveryDetail> {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/recovery/advance`, `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: this.authorization === undefined ? {} : { authorization: this.authorization },
    });
    const body = await response.json() as { recovery?: RuntimeRecoveryDetail; error?: string };
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
    const body = await response.json() as { request?: RuntimeHumanLoopRequest; error?: string };
    if (!response.ok) throw new Error(body.error ?? `runtime Human-in-the-Loop query failed with HTTP ${response.status}`);
    return body.request;
  }

  async respondHumanLoop(remoteRunId: string, requestId: string, input: { readonly value: unknown; readonly expectedRevision: number }) {
    const response = await fetch(new URL(`/v1/runtime-runs/${encodeURIComponent(remoteRunId)}/human-loop/${encodeURIComponent(requestId)}/respond`, `${this.endpoint.replace(/\/$/, "")}/`), {
      method: "POST", headers: { "content-type": "application/json", ...(this.authorization === undefined ? {} : { authorization: this.authorization }) }, body: JSON.stringify(input),
    });
    const body = await response.json() as { response?: RuntimeHumanLoopResponse; error?: string };
    if (!response.ok || body.response === undefined) throw new Error(body.error ?? `runtime Human-in-the-Loop response failed with HTTP ${response.status}`);
    return body.response;
  }
}
