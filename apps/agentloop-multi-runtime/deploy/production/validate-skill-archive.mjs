#!/usr/bin/env node
/*
 * Production's transport wrapper around the canonical Skill archive audit.
 * The caller receives a normalized ZIP containing only audited entries, so
 * extraction never needs to reimplement the acceptance rules in Python.
 */
import JSZip from "jszip";
import { validateSkillArchive } from "../../web/skill-archive-validator.mjs";

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const content = Buffer.concat(chunks);
  const audited = await validateSkillArchive(content, {
    originalName: process.env.SKILL_ARCHIVE_NAME ?? "custom-skills.zip",
  });
  const normalized = new JSZip();
  for (const entry of audited.entries) normalized.file(entry.path, entry.data);
  process.stdout.write(await normalized.generateAsync({ type: "nodebuffer", compression: "STORE" }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "skill_upload_invalid"}\n`);
  process.exitCode = 1;
}
