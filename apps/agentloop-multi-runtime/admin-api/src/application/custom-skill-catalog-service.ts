import { discoverSkillDirectory, type SkillAgentLoopMetadata, type SkillDirectoryEntry } from "@zhujun/agentloop";
import { ControlPlaneError } from "../../../control-plane/domain/index.ts";

export interface AdminSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly packageHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly agentLoop?: SkillAgentLoopMetadata;
}

export interface AdminSkillDetail extends AdminSkillSummary {
  readonly skillMd: string;
  /** Package-relative paths only; the source directory is never returned. */
  readonly files: readonly string[];
}

export interface AdminSkillPage {
  readonly items: readonly AdminSkillSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pageCount: number;
}

/** Read-only projection of configured custom Skill packages for Admin Web. */
export class CustomSkillCatalogApplicationService {
  private readonly directories: readonly string[];

  public constructor(directories: readonly string[]) {
    this.directories = [...new Set(directories.map((directory) => directory.trim()).filter((directory) => directory !== ""))];
  }

  public async list(page: number, pageSize: number): Promise<AdminSkillPage> {
    const entries = await this.discover();
    const total = entries.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(Math.max(page, 1), pageCount);
    const start = (normalizedPage - 1) * pageSize;
    return {
      items: entries.slice(start, start + pageSize).map((entry) => summary(entry)),
      page: normalizedPage,
      pageSize,
      total,
      pageCount,
    };
  }

  public async detail(name: string): Promise<AdminSkillDetail | undefined> {
    const entry = (await this.discover()).find((candidate) => candidate.inspection.name === name);
    if (entry === undefined) return undefined;
    const inspected = entry.inspection;
    return { ...summary(entry), skillMd: redactSkillInstructions(inspected.instructions), files: inspected.files };
  }

  private async discover(): Promise<readonly SkillDirectoryEntry[]> {
    const entries: SkillDirectoryEntry[] = [];
    for (const directory of this.directories) {
      try {
        entries.push(...await discoverSkillDirectory(directory));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ControlPlaneError("configuration_unavailable", `Custom Skill directory is unavailable: ${detail}`);
      }
    }
    entries.sort((left, right) => left.inspection.name.localeCompare(right.inspection.name, "en"));
    const names = new Set<string>();
    for (const entry of entries) {
      if (names.has(entry.inspection.name)) throw new Error(`Duplicate custom Skill name: ${entry.inspection.name}`);
      names.add(entry.inspection.name);
    }
    return entries;
  }
}

function summary(entry: SkillDirectoryEntry): AdminSkillSummary {
  const inspection = entry.inspection;
  return {
    name: inspection.name,
    description: inspection.description,
    ...(inspection.version === undefined ? {} : { version: inspection.version }),
    packageHash: inspection.packageHash,
    fileCount: inspection.fileCount,
    totalBytes: inspection.totalBytes,
    ...(inspection.agentLoop === undefined ? {} : { agentLoop: inspection.agentLoop }),
  };
}

/** Keep documentation useful without treating a custom Skill as a secret store. */
function redactSkillInstructions(source: string): string {
  return source
    .replace(/((?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)([^\s"',}`\]]+)(["']?)/giu, "$1[REDACTED]$3")
    .replace(/(authorization\s*[:=]\s*["']?bearer\s+)([^\s"',}`\]]+)/giu, "$1[REDACTED]");
}
