import { contentStructure } from "./content-reference.ts";
import { parseRuntimeResultRef } from "./runtime-result.ts";

export function isCommandResult(value: unknown): value is Record<string, unknown> & { stdout: string; stderr: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "exitCode" in value && "stdout" in value && typeof value.stdout === "string"
    && "stderr" in value && typeof value.stderr === "string";
}

/** A view of an already committed command Result; never a replacement payload. */
export function projectCommandResult(value: unknown): Record<string, unknown> | undefined {
  if (!isCommandResult(value)) return undefined;
  const result = value;
  if (result.schema === "agentloop.contextCommandResult/v1") return undefined;
  const resultRef = parseRuntimeResultRef(result.resultRef);
  if (resultRef === undefined) return undefined;
  let stdout: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) stdout = parsed as Record<string, unknown>;
  } catch { /* Plain command output is still exactly readable through the Result. */ }
  return {
    schema: "agentloop.contextCommandResult/v1",
    resultRef,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    fileChanges: result.fileChanges,
    fileChangesTruncated: result.fileChangesTruncated,
    outputBindings: result.outputBindings,
    executionReceipt: result.executionReceipt,
    evidenceReceipt: result.evidenceReceipt,
    computationReceipt: result.computationReceipt,
    computationEvidenceError: result.computationEvidenceError,
    computationEvidenceFailure: result.computationEvidenceFailure,
    computationObservation: result.computationObservation,
    workflowEvidenceReceipt: result.workflowEvidenceReceipt,
    // Only the executor may promote Skill-root control signals. Raw stdout is content.
    controlSignals: result.controlSignals,
    sourceSchema: stdout?.schema,
    deliveryCandidate: stdout?.deliveryCandidate,
    delivery_markdown: stdout?.delivery_markdown,
    assessmentProjection: stdout?.assessmentProjection,
    assessment_summary: stdout?.assessment_summary,
    decisionClaim: stdout?.decisionClaim,
    streams: ["stdout", "stderr"].map((name) => {
      const content = result[name] as string;
      return { pointer: `/${name}`, characters: content.length, summary: contentStructure(content) };
    }),
    stdout: result.stdout.slice(0, 800),
    stderr: result.stderr.slice(0, 800),
    instruction: "This is a model-visible view of the same committed Runtime Result. Read exact command output with read_result using this resultRef.resultId and pointer /stdout or /stderr. These pointers select strings: use characterOffset and characterLimit (up to 12000), then nextCharacterOffset for larger streams. Do not reopen a file or rerun the command to recover omitted output. Previews and structural summaries are not the complete result.",
  };
}
