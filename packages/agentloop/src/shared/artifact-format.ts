import { extname } from "node:path";

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
  return extension.length > 1 ? canonicalArtifactFormatFamily(extension) : undefined;
}

export function isWordDocumentPath(path: string): boolean {
  return artifactFormatFamilyForPath(path) === "word";
}
