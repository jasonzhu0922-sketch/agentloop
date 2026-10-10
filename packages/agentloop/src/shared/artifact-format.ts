import { extname } from "node:path";

const SOURCE_EXTENSIONS = new Set([
  "bash", "c", "cc", "cpp", "cjs", "cs", "cts", "go", "h", "hpp", "java",
  "js", "jsx", "kt", "kts", "mjs", "mts", "php", "ps1", "py", "rb", "rs",
  "sh", "swift", "ts", "tsx", "vue", "zsh",
]);

/**
 * Canonical semantic family for artifact formats that are physically
 * different but satisfy the same user-facing document contract.
 */
export function canonicalArtifactFormatFamily(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\./u, "");
  if (normalized === "doc" || normalized === "docx" || normalized === "word") return "word";
  if (normalized === "excel") return "xlsx";
  if (normalized === "md") return "markdown";
  if (normalized === "htm") return "html";
  if (normalized === "jpeg") return "jpg";
  return normalized;
}

const SEMANTIC_ARTIFACT_FAMILIES = new Set([
  "none",
  "document",
  "presentation",
  "spreadsheet",
  "image",
  "audio",
  "code",
]);

/**
 * A semantic family is a valid delivery-category constraint, but it is never
 * a physical filename format. Keeping this conversion in the shared format
 * boundary makes typed Runtime callers resilient to a model or legacy Plan
 * that puts a family label in the `format` field.
 */
export function semanticArtifactFamily(value: string): string | undefined {
  const canonical = canonicalArtifactFormatFamily(value);
  return SEMANTIC_ARTIFACT_FAMILIES.has(canonical) ? canonical : undefined;
}

export function isConcreteArtifactFormat(value: string): boolean {
  return semanticArtifactFamily(value) === undefined;
}

export function artifactFormatFamilyForPath(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  if (extension.length <= 1) return undefined;
  const family = canonicalArtifactFormatFamily(extension);
  return SOURCE_EXTENSIONS.has(family) ? "code" : family;
}

export function isSourceArtifactPath(path: string): boolean {
  return artifactFormatFamilyForPath(path) === "code";
}

export function isWordDocumentPath(path: string): boolean {
  return artifactFormatFamilyForPath(path) === "word";
}
