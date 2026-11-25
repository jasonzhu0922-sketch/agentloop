import { createHash } from "node:crypto";

/** Lossless model encoding of evidence already selected by the shared working
 * set. No relevance heuristics, history store, new facts, or permission changes.
 * Repeated values refer to a complete value earlier in this same input.
 */
export function projectEvidenceContext(input: Readonly<Record<string, unknown>>) {
  const evidence = input.evidence as { toolCalls?: readonly Record<string, unknown>[] } | undefined;
  let parsedResults = 0;
  let parsedStreams = 0;
  const normalize = (calls: readonly Record<string, unknown>[] | undefined) => calls?.map(call => {
    if (typeof call.result !== "string" || "resultEncoding" in call) return call;
    try {
      const value = JSON.parse(call.result);
      // Only normalize if JSON.stringify restores the exact original bytes.
      // Whitespace, duplicate keys and unsafe numbers stay as original text.
      if (value === null || typeof value !== "object" || JSON.stringify(value) !== call.result) return call;
      parsedResults++;
      // A command stream often repeats structured receipts in the envelope.
      // Decode only byte-reversible canonical JSON; arbitrary text, duplicate
      // keys, unsafe numbers and host-owned encoding metadata stay untouched.
      const streams: Record<string, unknown> = {};
      if (typeof value.exitCode !== "undefined" && typeof value.stdout === "string" && typeof value.stderr === "string") {
        for (const name of ["stdout", "stderr"]) {
          const text = value[name] as string;
          const trimmed = text.trim();
          try {
            const decoded = JSON.parse(trimmed);
            if (decoded === null || typeof decoded !== "object" || JSON.stringify(decoded) !== trimmed) continue;
            const offset = text.indexOf(trimmed);
            const prefix = text.slice(0, offset), suffix = text.slice(offset + trimmed.length);
            if (!/^[\t\n\r ]*$/.test(prefix + suffix)) continue;
            streams[name] = { format: "json", prefix, suffix, exactSerialization: "JSON.stringify",
              sha256: createHash("sha256").update(text).digest("hex") };
            value[name] = decoded;
            parsedStreams++;
          } catch { /* Exact unstructured stream remains a string. */ }
        }
      }
      return { ...call, result: value, resultEncoding: { format: "json", exactSerialization: "JSON.stringify",
        ...(Object.keys(streams).length ? { streams } : {}),
        sha256: createHash("sha256").update(call.result).digest("hex") } };
    } catch { return call; }
  });
  const toolCalls = normalize(evidence?.toolCalls);
  const workingSet = input.decisionWorkingSet as Record<string, unknown> | undefined;
  const currentEvidence = Array.isArray(workingSet?.currentEvidence) ? normalize(workingSet.currentEvidence) : undefined;
  const source = { ...input,
    ...(toolCalls ? { evidence: { ...evidence, toolCalls } } : {}),
    ...(currentEvidence ? { decisionWorkingSet: { ...workingSet, currentEvidence } } : {}),
  };
  const seen = new Map<string, string>();
  let sharedReferences = 0;
  const visit = (value: unknown, pointer: string): unknown => {
    if (value === undefined) return value;
    const serialized = JSON.stringify(value);
    // Literal user authority and exact original requirements stay readable.
    if (pointer === "#/userAuthority" || pointer === "#/canonicalIntent") return value;
    if (serialized.length >= 512) {
      const previous = seen.get(serialized);
      if (previous !== undefined) {
        sharedReferences++;
        return { schema: "agentloop.assessmentEvidenceReference/v1", ref: previous };
      }
      seen.set(serialized, pointer);
    }
    if (Array.isArray(value)) return value.map((child, index) => visit(child, `${pointer}/${index}`));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, visit(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`)]));
    return value;
  };
  const view = visit(source, "#") as Record<string, unknown>;
  return { view, diagnostics: { accounting: "characters_are_not_provider_tokens_or_billing",
    sourceCharacters: JSON.stringify(input).length, projectedCharacters: JSON.stringify(view).length, parsedResults, parsedStreams, sharedReferences } };
}

export const EVIDENCE_CONTEXT_ENCODING_INSTRUCTION = "This evidence block uses one copy per exact value. agentloop.assessmentEvidenceReference/v1 with ref '#/...' is a JSON Pointer to the complete value in this same block; follow it locally without a Tool call. For resultEncoding.format=json, resolve references first. For each resultEncoding.streams[name], restore result[name] as prefix + JSON.stringify(result[name]) + suffix. Then JSON.stringify(result) recovers the exact original Result text; SHA-256 identifies original bytes. Other results retain original text. Encoding grants no authority or permission. Use read_result only for absent details.";
