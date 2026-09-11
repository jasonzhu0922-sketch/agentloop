// Public API surface of the AgentLoop kernel ("@zhujun/agentloop").
// The kernel is a headless library: identity is an opaque `userId` string and
// persistence goes through injectable stores. HTTP serving and authentication
// belong to the embedding application (see apps/agentloop-app for the
// reference implementation).
export { BatchService } from "./batch/batch-service.ts";
export type { BatchItemRecord, BatchRecord } from "./batch/batch-service.ts";
export { ComputerExecutor } from "./computer/computer-executor.ts";
export type { ComputerDriver, ComputerSnapshot } from "./computer/computer-driver.ts";
export { ArtifactAcceptanceService } from "./acceptance/artifact-acceptance.ts";
export type {
  ArtifactAcceptanceCheck,
  ArtifactAcceptanceEvidence,
  ArtifactAcceptanceInput,
  ArtifactAcceptanceKind,
} from "./acceptance/artifact-acceptance.ts";
export type {
  ArtifactAcceptanceProvider,
  ArtifactAcceptanceProviderQuery,
  ArtifactAcceptanceProviderRequest,
  ArtifactAcceptanceProviderResult,
} from "./acceptance/artifact-acceptance-provider.ts";
export { createPlaywrightArtifactAcceptanceProvider } from "./acceptance/playwright-artifact-acceptance-provider.ts";
export type { PlaywrightArtifactAcceptanceProviderOptions } from "./acceptance/playwright-artifact-acceptance-provider.ts";
export { collectRenderEnvironmentEvidence } from "./acceptance/render-environment.ts";
export type {
  BinaryProbe,
  FontResolutionEvidence,
  RenderCredibility,
  RenderEnvironmentEvidence,
} from "./acceptance/render-environment.ts";
export { classifyRenderEnvironmentCredibility } from "./acceptance/render-environment.ts";
export {
  assertNoDuplicateTools,
  composeRunTools,
  createArtifactConverterTools,
  createComputerTools,
  createCoreTools,
  createHumanLoopTool,
  createSkillLoader,
  createSourceTools,
  createVisibleDirectoryTools,
  createWebTools,
  DANGEROUS_COMPUTER_TOOL_NAMES,
  SKILL_LOADER_TOOL_NAME,
  HUMAN_LOOP_TOOL_NAME,
  skillExecutionCwd,
  ToolRegistry,
  VISIBLE_DIRECTORY_TOOL_NAMES,
} from "./tools/index.ts";
export type {
  ComposeRunToolsOptions,
  ConvertArtifactInput,
  CoreToolsOptions,
  MaterializedTools,
  PreparedToolCall,
  RuntimeTool,
  ToolSourceCapability,
  ToolSourceDescriptor,
  ToolExecutionContext,
  WebToolsOptions,
} from "./tools/index.ts";
export { runAgentLoop } from "./runtime/agent-loop.ts";
export { createCapabilityGrant } from "./runtime/capability-grant.ts";
export type * from "./runtime/contracts.ts";
export {
  createStepExecutionStrategyProfile,
  DefaultLoopStepPolicy,
  DefaultPromptProjectionPolicy,
  DefaultStepExecutionStrategy,
  DefaultToolExposurePolicy,
  FullCatalogToolExposurePolicy,
} from "./runtime/step-execution-strategy.ts";
export type {
  DeprioritizedToolGroup,
  LoopStepFrame,
  LoopStepPolicy,
  PromptProjectionDecision,
  PromptProjectionPolicy,
  StepExecutionDecision,
  StepExecutionInput,
  StepExecutionPolicyTrace,
  StepExecutionStrategy,
  ToolCatalogDecision,
  ToolExposurePolicy,
} from "./runtime/step-execution-strategy.ts";
export { OpenAICompatibleModel } from "./runtime/models.ts";
export { LlmProviderRegistry } from "./runtime/provider-registry.ts";
export type { LlmModelSummary, LlmProviderSummary } from "./runtime/provider-registry.ts";
export { RunEventHub } from "./runtime/run-event-hub.ts";
export type { LiveRunEvent } from "./runtime/run-event-hub.ts";
export { collectProcessArtifacts, artifactId, previewProcessArtifact } from "./runtime/process-artifacts.ts";
export type {
  ProcessArtifact,
  ProcessArtifactPreview,
  ProcessArtifactRole,
  PptxPreviewElement,
  PptxPreviewTextRun,
} from "./runtime/process-artifacts.ts";
export { RuntimeActionRepository } from "./runtime/runtime-action-repository.ts";
export type {
  ReplayPolicy,
  RuntimeActionKind,
  RuntimeActionRecord,
  RuntimeActionState,
} from "./runtime/runtime-action-repository.ts";
export { HumanLoopRepository } from "./runtime/human-loop.ts";
export type {
  HumanLoopKind,
  HumanLoopOrigin,
  HumanLoopRequest,
  HumanLoopRequirement,
  HumanLoopResponse,
  HumanLoopResponseSchema,
  HumanLoopStatus,
} from "./runtime/human-loop.ts";
export { RunService } from "./runtime/run-service.ts";
export type {
  AssessorFactory,
  HostRunProjection,
  ModelFactory,
  PlannerFactory,
  PlanRevisionAssessorFactory,
  RecoveryDetail,
  RecoveryPlannerFactory,
  RunRecord,
  StoredRunEvent,
} from "./runtime/run-service.ts";
export { ModelPlanRevisionAssessor, ModelRecoveryPlanner } from "./runtime/recovery-planning.ts";
export type { RecoveryDecisionKind, RecoveryDecisionProposal, RecoveryPlanner } from "./runtime/recovery-planning.ts";
export { RecoveryRepository } from "./runtime/recovery-repository.ts";
export type { PlanRevisionAssessmentRecord, RecoveryDecisionRecord, RecoveryUserResponse, RunRecoveryState } from "./runtime/recovery-repository.ts";
export { reconstructRecoveryTranscript } from "./runtime/recovery-transcript.ts";
export type { RecoveryTranscript } from "./runtime/recovery-transcript.ts";
export { SkillService } from "./skills/skill-service.ts";
export type {
  DiscoveredSkillSummary,
  PrivateSkill,
  SkillPackageSource,
  SkillDirectorySyncResult,
  SkillServiceOptions,
  SkillSourceKind,
  SkillSummary,
  SkillVisibilityContext,
} from "./skills/skill-service.ts";
export { discoverSkillDirectory } from "./skills/skill-directory.ts";
export type { SkillDirectoryEntry } from "./skills/skill-directory.ts";
export { inspectSkillPackage } from "./skills/skill-package.ts";
export type { SkillPackageInspection } from "./skills/skill-package.ts";
export {
  SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES,
  SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES,
  SKILL_AGENT_LOOP_METADATA_FIELDS,
  SKILL_AGENT_LOOP_PRODUCED_EVIDENCE_KIND_VALUES,
  SKILL_AGENT_LOOP_QA_KIND_VALUES,
  SKILL_AGENT_LOOP_ROLE_VALUES,
  SKILL_AGENT_LOOP_SOURCE_KIND_VALUES,
} from "./skills/agentloop-metadata.ts";
export type {
  SkillAgentLoopArtifactKind,
  SkillAgentLoopExecutionProfile,
  SkillAgentLoopProducedEvidenceKind,
  SkillAgentLoopMetadata,
  SkillAgentLoopQaKind,
  SkillAgentLoopRole,
  SkillAgentLoopSourceKind,
} from "./skills/agentloop-metadata.ts";
export { AppDatabase } from "./storage/database.ts";
export { SqliteConnection } from "./storage/sqlite-connection.ts";
export { PgConnection, translatePlaceholders } from "./storage/pg-connection.ts";
export type { SqlConnection, SqlDialect, SqlRunResult, SqlStatement, SqlValue } from "./storage/connection.ts";
export type {
  DiscoveredSkillSnapshot,
  SkillDiscoveryPersistence,
  SkillInsertRecord,
  SkillPackageMetadataUpdate,
  SkillRecord,
  SkillStore,
} from "./storage/stores/skill-store.ts";
export { SqliteSkillStore } from "./storage/stores/sqlite-skill-store.ts";
export { BatchRepository } from "./storage/repositories/batch-repository.ts";
export { RunOutcomeRepository } from "./storage/repositories/outcome-repository.ts";
export { RunRepository } from "./storage/repositories/run-repository.ts";
export { SkillRepository } from "./storage/repositories/skill-repository.ts";
export { sourceSummary, SourceRepository } from "./storage/repositories/source-repository.ts";
export type { SourceChunkRow, SourceRow } from "./storage/repositories/source-repository.ts";
export { admitPlan } from "./planning/admission.ts";
export { ModelPlanner } from "./planning/planner.ts";
export { ModelStepAssessor, ProfiledRuleStepAssessor, RuleBasedStepAssessor } from "./planning/assessor.ts";
export { DependencyScheduler } from "./planning/scheduler.ts";
export { PlanRepository } from "./planning/plan-repository.ts";
export type * from "./planning/contracts.ts";
export type * from "./planning/extensions.ts";
export {
  AppError,
  asAppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthenticated,
} from "./shared/errors.ts";
export type { ErrorCode } from "./shared/errors.ts";
export {
  optionalPositiveInteger,
  optionalString,
  requireRecord,
  requireString,
  requireStringArray,
} from "./shared/validation.ts";
