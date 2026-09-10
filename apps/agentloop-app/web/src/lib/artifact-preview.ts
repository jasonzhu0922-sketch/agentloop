import type { ProcessArtifact } from "./types";
export {
  artifactExtension,
  artifactMimeBase,
  artifactPreviewMode,
  usesBlobPreview,
} from "@zhujun/agentloop-artifact-preview";
import { artifactExtension } from "@zhujun/agentloop-artifact-preview";

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
  if (artifact.role === "final") return 2;
  const extension = artifactExtension(artifact.name || artifact.path);
  if (extension === "md" || extension === "markdown") return 3;
  if (extension === "html" || extension === "htm" || extension === "pdf") return 4;
  if (extension === "docx" || extension === "xlsx" || extension === "pptx") return 5;
  if (artifact.previewable) return 6;
  return 7;
}
