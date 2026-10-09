export interface DisplayArtifact {
  readonly role?: string;
  readonly name?: string;
  readonly path?: string;
}

export function isExecutionLogArtifact(artifact: DisplayArtifact | undefined | null): boolean;
export function isFinalDeliveryArtifact(artifact: DisplayArtifact | undefined | null): boolean;
