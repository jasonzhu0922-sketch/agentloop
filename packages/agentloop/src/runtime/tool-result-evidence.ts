const RUNTIME_EVIDENCE_SCHEMAS = new Set([
  "agentloop.artifactAcceptance/v1",
  "agentloop.artifactReceipt/v1",
  "agentloop.sourceSummary/v1",
  "agentloop.toolEvidenceReceipt/v1",
]);

export interface RuntimeEvidenceKindArrays {
  readonly satisfied: readonly string[];
  readonly caveated: readonly string[];
  readonly failed: readonly string[];
}

export function runtimeEvidenceRecordsFromToolResult(result: string): readonly Record<string, unknown>[] {
  const parsed = parseJsonRecord(result);
  if (parsed === undefined) return [];
  const records: Record<string, unknown>[] = [parsed];
  const stdout = stringValue(parsed.stdout);
  if (stdout !== undefined) {
    const stdoutRecord = parseJsonRecord(stdout);
    if (stdoutRecord !== undefined && hasRuntimeEvidenceSchema(stdoutRecord)) {
      records.push(stdoutRecord);
    }
  }
  return records;
}

export function runtimeEvidenceKindArrays(record: Record<string, unknown> | undefined): RuntimeEvidenceKindArrays {
  const evidenceKinds = recordValue(record?.evidenceKinds);
  // Source receipts commonly carry durable references and caveats as their
  // structured fields. They are semantic evidence in their own right; a
  // producer must not have to duplicate them in a parallel kind list merely
  // for Runtime assessment to observe them.
  const hasSourceReferences = hasObservableSourceReference(record?.sourceRefs);
  const hasCaveats = stringArrayValue(record?.caveats).length > 0;
  return {
    satisfied: uniqueStrings([
      ...stringArrayValue(evidenceKinds?.satisfied),
      ...stringArrayValue(record?.satisfiedEvidenceKinds),
      ...(hasSourceReferences ? ["source_urls"] : []),
    ]),
    caveated: uniqueStrings([
      ...stringArrayValue(evidenceKinds?.caveated),
      ...stringArrayValue(record?.caveatedEvidenceKinds),
      ...(hasCaveats ? ["explicit_caveats"] : []),
    ]),
    failed: uniqueStrings([
      ...stringArrayValue(evidenceKinds?.failed),
      ...stringArrayValue(record?.failedEvidenceKinds),
    ]),
  };
}

function hasObservableSourceReference(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (stringValue(item) !== undefined) return true;
    const reference = recordValue(item);
    return reference !== undefined && ["uri", "url", "serverKey", "toolName", "receiptId"]
      .some((field) => stringValue(reference[field]) !== undefined);
  });
}

export function canonicalArtifactAcceptanceVerdict(record: Record<string, unknown> | undefined): string | undefined {
  const verdict = stringValue(record?.verdict);
  if (verdict === undefined) return undefined;
  const normalized = verdict.trim().toLowerCase();
  if (normalized === "pass" || normalized === "passed" || normalized === "accepted" || normalized === "accept") {
    return "accepted";
  }
  if (normalized === "caveated" || normalized === "warning" || normalized === "warn") {
    return "caveated";
  }
  if (normalized === "fail" || normalized === "failed" || normalized === "rejected" || normalized === "reject") {
    return "rejected";
  }
  return verdict;
}

export function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return parseJsonRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return recordValue(value);
}

function hasRuntimeEvidenceSchema(record: Record<string, unknown>): boolean {
  return RUNTIME_EVIDENCE_SCHEMAS.has(stringValue(record.schema) ?? "");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
