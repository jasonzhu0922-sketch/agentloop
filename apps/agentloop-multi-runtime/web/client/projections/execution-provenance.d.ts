export function executionLocationLabel(location: unknown): string;

export function executionProvenanceParts(message: unknown): readonly {
  readonly kind: "location" | "runtime" | "model";
  readonly label: string;
}[];
