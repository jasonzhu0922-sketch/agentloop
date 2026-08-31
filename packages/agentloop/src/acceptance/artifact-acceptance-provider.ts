import type {
  ArtifactAcceptanceCheck,
  ArtifactAcceptanceEvidence,
  ArtifactAcceptanceKind,
} from "./artifact-acceptance.ts";

export interface ArtifactAcceptanceProviderQuery {
  readonly artifact: ArtifactAcceptanceEvidence["artifact"];
  readonly profileId: Exclude<ArtifactAcceptanceKind, "auto">;
  readonly requestedChecks: readonly string[];
}

export interface ArtifactAcceptanceProviderRequest extends ArtifactAcceptanceProviderQuery {
  readonly workspaceRoot: string;
  readonly staticChecks: readonly ArtifactAcceptanceCheck[];
  readonly signal?: AbortSignal;
}

export interface ArtifactAcceptanceProviderResult {
  readonly providerId: string;
  readonly checks: readonly ArtifactAcceptanceCheck[];
  readonly diagnostics?: readonly string[];
  readonly artifacts?: readonly {
    readonly kind: string;
    readonly path: string;
    readonly sha256?: string;
    readonly bytes?: number;
  }[];
}

export interface ArtifactAcceptanceProvider {
  readonly id: string;
  supports(query: ArtifactAcceptanceProviderQuery): boolean;
  verify(request: ArtifactAcceptanceProviderRequest): Promise<ArtifactAcceptanceProviderResult>;
}
