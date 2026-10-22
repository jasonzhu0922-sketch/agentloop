export function executionLocationLabel(location: unknown): string;

export function executionProvenanceParts(message: unknown, models?: readonly { readonly key?: string; readonly displayName?: string }[]): readonly {
  readonly kind: "location" | "runtime" | "model";
  readonly label: string;
}[];
