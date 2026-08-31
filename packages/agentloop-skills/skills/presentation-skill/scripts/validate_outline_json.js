#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const outlinePath = parseOutlinePath(process.argv.slice(2));

try {
  const resolved = path.resolve(outlinePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("outline root must be a JSON object");
  }
  if (!Array.isArray(parsed.slides) || parsed.slides.length === 0) {
    throw new Error("outline must contain a non-empty slides array");
  }
  process.stdout.write(JSON.stringify({ valid: true, outline: resolved, slideCount: parsed.slides.length }) + "\n");
} catch (error) {
  process.stderr.write(`outline validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseOutlinePath(args) {
  if (args.length === 2 && args[0] === "--outline" && args[1].trim().length > 0) return args[1];
  process.stderr.write("Usage: node scripts/validate_outline_json.js --outline <path/to/outline.json>\n");
  process.exit(2);
}
