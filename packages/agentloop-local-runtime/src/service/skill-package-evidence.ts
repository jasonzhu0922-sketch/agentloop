import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { SkillPackageInspection } from "@zhujun/agentloop";

export interface SkillEvidenceDocument {
  readonly path: string;
  readonly kind: "instructions" | "reference" | "script" | "dependencies" | "manifest";
  readonly content: string;
  readonly sha256: string;
  readonly lineCount: number;
  readonly truncated: boolean;
}
export interface SkillPackageEvidence {
  readonly documents: readonly SkillEvidenceDocument[];
  readonly omitted: readonly { readonly path: string; readonly reason: "private" | "budget" | "unreadable" | "binary" }[];
}
const MAX_DOCUMENTS = 24, MAX_CHARACTERS = 150_000, MAX_FILE_CHARACTERS = 28_000;
const PRIVATE = /(?:^|\/)(?:\.env(?:\..*)?|credentials?[^/]*|secrets?[^/]*|tokens?[^/]*|id_rsa|id_ed25519)(?:$|\/)|\.(?:pem|key|p12|pfx)$/iu;
const TEXT = /\.(?:md|txt|rst|json|toml|ya?ml|py|[cm]?js|ts|sh|bash|ps1|sql)$/iu;
const DEPENDENCY = /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|package\.json|environment\.ya?ml)$/iu;
const kind = (path: string): SkillEvidenceDocument["kind"] => DEPENDENCY.test(path) ? "dependencies"
  : path === "agentloop.executors.json" || path === "agentloop.skill.json" ? "manifest"
  : /\.(?:py|[cm]?js|ts|sh|bash|ps1|sql)$/iu.test(path) ? "script" : "reference";

/** Read package text as evidence, never execute it or follow external links. */
export async function collectSkillPackageEvidence(inspection: SkillPackageInspection): Promise<SkillPackageEvidence> {
  const documents: SkillEvidenceDocument[] = [], omitted: SkillPackageEvidence["omitted"][number][] = [];
  const files = new Set(inspection.files), seen = new Set<string>();
  let remaining = MAX_CHARACTERS;
  const add = (path: string, content: string, category: SkillEvidenceDocument["kind"]) => {
    const clipped = content.slice(0, Math.min(remaining, path === "SKILL.md" ? 80_000 : MAX_FILE_CHARACTERS));
    documents.push({ path, kind: category, content: clipped, sha256: createHash("sha256").update(clipped).digest("hex"),
      lineCount: clipped.split(/\r?\n/u).length, truncated: clipped.length < content.length });
    remaining -= clipped.length;
  };
  add("SKILL.md", inspection.instructions, "instructions"); seen.add("SKILL.md");
  const queue = inspection.files.filter(path => !path.includes("/") && (DEPENDENCY.test(path) || /^(?:README\.md|agentloop\.(?:skill|executors)\.json)$/iu.test(path)));
  const references = (document: SkillEvidenceDocument) => {
    // Package paths mentioned in prose/backticks and markdown links are both
    // common. Resolve relative to the referring file, then require membership
    // in the inspected package. There is no network fetch or directory crawl.
    for (const path of files) if (path !== "SKILL.md" && (TEXT.test(path) || PRIVATE.test(path)) && document.content.includes(path)) queue.push(path);
    for (const match of document.content.matchAll(/\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu)) {
      const target = match[1]!.split("#")[0]!;
      if (!target || /^(?:[a-z]+:|\/)/iu.test(target)) continue;
      let decoded: string; try { decoded = decodeURIComponent(target); } catch { continue; }
      const path = relative(inspection.root, resolve(inspection.root, dirname(document.path), decoded)).split(sep).join("/");
      if (files.has(path) && (TEXT.test(path) || PRIVATE.test(path))) queue.push(path);
    }
  };
  references(documents[0]!);
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!; if (seen.has(path)) continue; seen.add(path);
    if (PRIVATE.test(path)) { omitted.push({ path, reason: "private" }); continue; }
    if (documents.length >= MAX_DOCUMENTS || remaining <= 0) { omitted.push({ path, reason: "budget" }); continue; }
    try {
      const root = await realpath(inspection.root), target = await realpath(resolve(root, path));
      if (!target.startsWith(root + sep)) throw new Error("outside package");
      const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat(); if (!stat.isFile()) throw new Error("not a file");
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_CHARACTERS * 4));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        if (bytes.includes(0)) { omitted.push({ path, reason: "binary" }); continue; }
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: bytesRead < stat.size });
        add(path, content, kind(path));
        if (bytesRead < stat.size) documents[documents.length - 1] = { ...documents.at(-1)!, truncated: true };
        references(documents.at(-1)!);
      } finally { await file.close(); }
    } catch { omitted.push({ path, reason: "unreadable" }); }
  }
  return { documents, omitted };
}

export function evidenceLocations(value: unknown, evidence: SkillPackageEvidence): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => {
    if (typeof item !== "string") return false;
    const match = /^(.*?)(?::([1-9][0-9]*)(?:-([1-9][0-9]*))?)?$/u.exec(item);
    const document = evidence.documents.find(doc => doc.path === match?.[1]);
    return document !== undefined && (!match?.[2] || (Number(match[2]) <= Number(match[3] ?? match[2]) && Number(match[3] ?? match[2]) <= document.lineCount));
  }))].slice(0, 24);
}

export function detectedPythonRequirementFiles(evidence: SkillPackageEvidence): string[] {
  return evidence.documents.filter(doc => doc.path === "requirements.txt").map(doc => doc.path);
}
