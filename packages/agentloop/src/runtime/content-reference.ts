/** A bounded working window is retained for one model turn, then summarized. */
export const CONTENT_REFERENCE_WINDOW_CHARACTERS = 12_000;

export interface ContentReference {
  readonly kind: "content_addressed";
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly characters: number;
  readonly format: "json" | "text";
}

export const CONTENT_REFERENCE_READ_INSTRUCTION =
  "Full content is stored at contentLocation, not lost. Read computer_read_file with path, expectedSha256, characterOffset (0-based), and characterLimit (up to 12000); follow nextCharacterOffset for more. For JSON, computer_read_json supports a profile and JSON Pointer array windows. Read only what the task requires; do not fetch or execute again solely to recover omitted content. A preview is not complete source coverage.";

/** Shape and counts are navigation metadata, never domain interpretation. */
export function contentStructure(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    const describe = (item: unknown): Record<string, unknown> => {
      if (Array.isArray(item)) return { type: "array", count: item.length };
      if (item !== null && typeof item === "object") {
        const keys = Object.keys(item);
        return { type: "object", keys: keys.slice(0, 40), omittedKeys: Math.max(0, keys.length - 40) };
      }
      return { type: item === null ? "null" : typeof item };
    };
    return {
      ...describe(value),
      ...(value !== null && typeof value === "object" && !Array.isArray(value) ? {
        properties: Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, describe(item)])),
      } : {}),
    };
  } catch {
    return { type: "text", characters: content.length };
  }
}
