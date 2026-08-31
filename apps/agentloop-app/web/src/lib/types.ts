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

export type SourceStatus =
  | "uploaded"
  | "ready"
  | "unsupported"
  | "oversized"
  | "unreadable"
  | "extract_failed"
  | "deleted";

export interface SourceSummary {
  readonly id: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly extension: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly status: SourceStatus;
  readonly summary?: string;
  readonly chunkCount: number;
  readonly truncated: boolean;
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

export interface ConversationListPage {
  readonly conversations: readonly ConversationSummary[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
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
  readonly sources?: readonly SourceSummary[];
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface CommandOutputContent {
  readonly toolCallId: string;
  readonly stream: "stdout" | "stderr";
  readonly content: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
}

export interface ToolArgumentsReference {
  readonly schema?: "agentloop.toolArgumentsReference/v1";
  readonly path: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
  readonly previewCharacters?: number;
}

export interface ToolArgumentsContent {
  readonly toolCallId: string;
  readonly arguments: unknown;
  readonly content: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
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
  readonly recommendedToolNames?: readonly string[];
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
  readonly runId?: string;
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sourceTool: "computer_write_file" | "computer_run_command" | "materialize_paginated_html";
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
    readonly kind: "pptx";
    readonly name: string;
    readonly slideCount: number;
    readonly width: number;
    readonly height: number;
    readonly slides: readonly {
      readonly index: number;
      readonly background?: string;
      readonly title?: string;
      readonly paragraphs: readonly string[];
      readonly elements: readonly PptxPreviewElement[];
    }[];
    readonly truncated: boolean;
  }
  | {
    readonly kind: "binary";
    readonly name: string;
    readonly mimeType: string;
  };

export type PptxPreviewElement =
  | {
    readonly kind: "shape";
    readonly preset?: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly fill: string;
    readonly opacity?: number;
    readonly stroke?: string;
    readonly strokeWidth?: number;
  }
  | {
    readonly kind: "text";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly text: string;
    readonly fontSize?: number;
    readonly color?: string;
    readonly fill?: string;
    readonly lines?: readonly (readonly PptxPreviewTextRun[])[];
  };

export interface PptxPreviewTextRun {
  readonly text: string;
  readonly fontSize?: number;
  readonly color?: string;
}

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
