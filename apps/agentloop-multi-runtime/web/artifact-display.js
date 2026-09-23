const EXECUTION_LOG_SUFFIXES = ["stdout.txt", "stderr.txt"];

/**
 * Execution stream captures are evidence, not user-facing artifacts. Keep this
 * classification in the Web projection; the Runtime artifact record remains
 * complete for diagnostics and explicit artifact access.
 */
export function isExecutionLogArtifact(artifact) {
  return [artifact?.name, artifact?.path]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().split(/[\\/]/).at(-1)?.toLowerCase() || "")
    .some((filename) => EXECUTION_LOG_SUFFIXES.some((suffix) => filename.endsWith(suffix)));
}

export function isFinalDeliveryArtifact(artifact) {
  return artifact?.role === "final" && !isExecutionLogArtifact(artifact);
}
