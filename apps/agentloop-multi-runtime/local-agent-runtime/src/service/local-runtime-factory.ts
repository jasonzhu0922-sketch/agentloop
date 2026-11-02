import { join } from "node:path";
import { createStepExecutionStrategyProfile, type ModelAdapter, type ModelInvocation, type ModelResponse, type ModelRetryReporter, type ModelStreamSink } from "@zhujun/agentloop";
import { LocalRuntimeFactory as SharedLocalRuntimeFactory, LocalRuntimeSupervisorError, type LocalRuntimeControl, type LocalRuntimeDefinition, type ResolvedLocalRuntimeConfiguration } from "@zhujun/agentloop-local-runtime/host";
import { registrationsFromEnvironment, environmentConnectorRuntime } from "@zhujun/agentloop-local-runtime/connectors";
import { loadPracticeProfileConfig, loadStepExecutionStrategyProfileConfig, webToolsOptionsFromEnvironment } from "../../../src/shared/config.ts";
import { consumeModelResponse } from "../../../src/shared/model-proxy.ts";
import type { LocalAgentOptions } from "../config/local-agent-options.ts";
import type { LocalModelConfigurationStore } from "../persistence/local-model-configuration-store.ts";
import type { LocalConnectorConfigurationStore } from "../persistence/local-connector-configuration-store.ts";
import { LocalAgentStateStore } from "../persistence/local-agent-state-store.ts";
export { RESTORED_RUN_ACTIVITY_WINDOW_MS, shouldRetainRestoredRunActivity, localRuntimeMcpStartupLogLines, redactMcpDiagnostic } from "@zhujun/agentloop-local-runtime/host";

export class CloudProxyModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 1_000_000, maxOutputTokens: 1_000_000 };
  readonly completeTimeoutMs = 30 * 60_000;
  readonly operationTimeoutMs = 30 * 60_000;
  readonly reasoningVisibility = "visible" as const;
  private readonly input: LocalAgentOptions;
  private readonly key: string;
  private readonly onRetry?: ModelRetryReporter;

  constructor(input: LocalAgentOptions, key: string, onRetry?: ModelRetryReporter) {
    this.input = input;
    this.key = key;
    this.onRetry = onRetry;
  }
  async complete(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
    return await this.streamComplete(invocation, async () => undefined, signal);
  }
  async streamComplete(invocation: ModelInvocation, sink: ModelStreamSink, signal?: AbortSignal): Promise<ModelResponse> {
    const state = await new LocalAgentStateStore(this.input.statePath).read();
    if (state.device === undefined || this.input.routerUrl === undefined) throw new LocalRuntimeSupervisorError(409, "cloud_model_device_not_registered");
    const response = await fetch(new URL("/v1/device-agent/model-completions", this.input.routerUrl), {
      method: "POST", headers: { authorization: `Bearer ${state.device.agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ modelKey: this.key, invocation }), signal,
    });
    return await consumeModelResponse(response, sink, this.onRetry);
  }
}

/** Router and deployment adapters for the shared local Runtime composition root. */
export class LocalRuntimeFactory {
  private readonly shared: SharedLocalRuntimeFactory;
  constructor(input: LocalAgentOptions, models?: LocalModelConfigurationStore, connectors?: LocalConnectorConfigurationStore) {
    this.shared = new SharedLocalRuntimeFactory({
      databasePath: input.databasePath,
      runtimeDataRoot: input.runtimeDataRoot,
      skillPackageStoreRoot: input.skillPackageStoreRoot,
      extensionBaseDirectory: input.appRoot,
      providerConfigPath: input.providerConfigPath,
      planningMaxTurns: input.planningMaxTurns,
      stepMaxTurns: input.stepMaxTurns,
      integrationEnvironment: input.integrationEnvironment,
      environment: input.environment,
      computerCommandEnvironment: input.computerCommandEnvironment,
      runEventLogSink: input.runEventLogSink,
      identity: { installationId: async () => (await new LocalAgentStateStore(input.statePath).read()).defaultRuntimeId },
      cloudModelFactory: (onRetry, modelKey) => new CloudProxyModel(input, modelKey!, onRetry),
      // Deployment config parsing stays with the existing Host. The shared
      // package receives Kernel policies, never a Multi Runtime config module.
      loadExecutionPolicy: async () => {
        const strategy = await loadStepExecutionStrategyProfileConfig(input.stepExecutionStrategyConfigPath);
        return {
          stepExecutionStrategy: createStepExecutionStrategyProfile(strategy.profile, strategy.projection),
          practiceProfileCatalog: await loadPracticeProfileConfig(input.practiceProfileConfigPath ?? join(input.appRoot, "config", "practice-profiles.json")),
        };
      },
    }, models, {
      resolve: async (runtimeId) => await connectors?.resolve(runtimeId) ?? {
        modules: registrationsFromEnvironment(), connections: [],
        runtime: environmentConnectorRuntime(undefined, input.integrationEnvironment),
      },
    });
    this.input = input;
  }
  private readonly input: LocalAgentOptions;
  async create(definition: LocalRuntimeDefinition, configuration: ResolvedLocalRuntimeConfiguration, sharedStorageRoot: string, uploadStorageRoot: string): Promise<LocalRuntimeControl> {
    // Search credentials may be Runtime-specific; do not snapshot them globally.
    return await this.shared.create(definition, configuration, sharedStorageRoot, uploadStorageRoot,
      webToolsOptionsFromEnvironment({ ...this.input.integrationEnvironment, ...configuration.integrationEnvironment }));
  }
  runtimeRootFor(definition: LocalRuntimeDefinition): string | undefined { return this.shared.runtimeRootFor(definition); }
  runtimeUploadRootFor(definition: LocalRuntimeDefinition, uploadStorageRoot: string): string { return this.shared.runtimeUploadRootFor(definition, uploadStorageRoot); }
}
