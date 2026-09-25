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
  if (normalized === "md") return "markdown";
  if (normalized === "htm") return "html";
  if (normalized === "jpeg") return "jpg";
  return normalized;
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
