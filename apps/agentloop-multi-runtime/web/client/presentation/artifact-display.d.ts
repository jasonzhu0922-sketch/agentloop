import type { RuntimeArtifact } from "../../../src/shared/contracts.ts";

export interface DisplayArtifact {
  readonly role?: string;
  readonly name?: string;
  readonly path?: string;
  readonly verification?: Partial<NonNullable<RuntimeArtifact["verification"]>>;
}

export function isExecutionLogArtifact(artifact: DisplayArtifact | undefined | null): boolean;
export function isFinalDeliveryArtifact(artifact: DisplayArtifact | undefined | null): boolean;
export function artifactVerificationLabel(artifact: DisplayArtifact | undefined | null): string;
