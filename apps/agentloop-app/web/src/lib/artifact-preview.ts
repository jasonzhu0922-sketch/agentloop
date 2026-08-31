import type { ProcessArtifact } from "./types";

export type ArtifactPreviewMode = "html" | "image" | "pdf" | "structured";

export function artifactMimeBase(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function artifactExtension(nameOrPath: string): string {
  const clean = nameOrPath.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot < 0 ? "" : clean.slice(dot + 1).toLowerCase();
}

export function artifactPreviewMode(artifact: ProcessArtifact): ArtifactPreviewMode {
  const mimeBase = artifactMimeBase(artifact.mimeType);
  const extension = artifactExtension(artifact.name || artifact.path);
  if (mimeBase === "text/html" || extension === "html" || extension === "htm") return "html";
  if (mimeBase.startsWith("image/")) return "image";
  if (mimeBase === "application/pdf" || extension === "pdf") return "pdf";
  return "structured";
}

export function usesBlobPreview(artifact: ProcessArtifact): boolean {
  return artifactPreviewMode(artifact) !== "structured";
}

export function prioritizedArtifacts(
  artifacts: readonly ProcessArtifact[],
  text = "",
): ProcessArtifact[] {
  const lowerText = text.toLowerCase();
  return [...artifacts].sort((left, right) =>
    artifactPriority(left, lowerText) - artifactPriority(right, lowerText)
    || left.path.localeCompare(right.path, "en")
  );
}

function artifactPriority(artifact: ProcessArtifact, lowerText: string): number {
  const path = artifact.path.toLowerCase();
  const name = artifact.name.toLowerCase();
  if (lowerText.includes(path)) return 0;
  if (lowerText.includes(name)) return 1;
  const extension = artifactExtension(artifact.name || artifact.path);
  if (extension === "md" || extension === "markdown") return 2;
  if (extension === "html" || extension === "htm" || extension === "pdf") return 3;
  if (extension === "docx" || extension === "xlsx" || extension === "pptx") return 4;
  if (artifact.previewable) return 5;
  return 6;
}
