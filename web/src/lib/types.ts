export interface User {
  readonly id: string;
  readonly email: string;
}

export interface ProviderSummary {
  readonly key: string;
  readonly kind: string;
  readonly defaultModel?: string;
}

export interface ModelSummary {
  readonly key: string;
  readonly displayName: string;
  readonly providerKey: string;
  readonly providerModel: string;
  readonly kind: string;
}

export interface ToolSummary {
  readonly name: string;
  readonly description?: string;
}

export interface LocalDirectoryListing {
  readonly currentPath: string;
  readonly parentPath?: string;
  readonly entries: readonly LocalDirectoryEntry[];
}

export interface LocalDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly visibleDirectories: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly runCount: number;
  readonly lastStatus: RunStatus | null;
}

export interface RunRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly conversationId?: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly allowDangerousTools: boolean;
  readonly modelKey?: string;
  readonly status: RunStatus;
  readonly input: string;
  readonly output?: string;
  readonly errorCode?: string;
  readonly createdAt: number;
  readonly finishedAt?: number;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface PlanStep {
  readonly id: string;
  readonly kind?: "leaf" | "milestone";
  readonly parentId?: string;
  readonly objective: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly refinementState?: "not_refinable" | "pending_facts" | "ready_to_refine" | "refining" | "refined";
  readonly dependencies?: readonly string[];
  readonly requiredFacts?: readonly { readonly id: string; readonly description: string; readonly evidenceKinds: readonly string[] }[];
  readonly requiredToolNames?: readonly string[];
  readonly successCriteria?: readonly { readonly id: string; readonly description: string }[];
  readonly output?: string;
}

export interface PlanDetail {
  readonly state: "pending" | "approved" | string;
  readonly plan: {
    readonly id: string;
    readonly runId: string;
    readonly version: number;
    readonly status: string;
    readonly goal: string;
    readonly steps: readonly PlanStep[];
  };
  readonly assessments: readonly {
    readonly stepId: string;
    readonly assessmentProfile?: "deterministic" | "lookup_lite" | "source_grounded" | "risk_sensitive";
    readonly assessmentMethod?: "rule" | "model";
    readonly approved: boolean;
    readonly feedback?: string;
  }[];
}

export interface ProcessArtifact {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sourceTool: "computer_write_file" | "computer_run_command";
  readonly previewable: boolean;
}

export type ArtifactPreview =
  | {
    readonly kind: "text";
    readonly name: string;
    readonly mimeType: string;
    readonly text: string;
    readonly truncated: boolean;
  }
  | {
    readonly kind: "docx";
    readonly name: string;
    readonly paragraphs: readonly string[];
    readonly truncated: boolean;
  }
  | {
    readonly kind: "xlsx";
    readonly name: string;
    readonly sheets: readonly {
      readonly name: string;
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
    }[];
  }
  | {
    readonly kind: "binary";
    readonly name: string;
    readonly mimeType: string;
  };

export interface ConversationDetail {
  readonly conversation: ConversationSummary;
  readonly runs: readonly RunRecord[];
}

export interface RunDetail {
  readonly run: RunRecord;
  readonly detail: PlanDetail;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly ProcessArtifact[];
}
