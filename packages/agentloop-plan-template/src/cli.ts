#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPlanTemplatePlugin, type PlanTemplatePluginOptions } from "./index.ts";
import type { PlanTemplate } from "./types.ts";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;
  const configPath = args.flags.config;
  if (configPath === undefined) {
    throw new Error("Missing --config <path>");
  }
  const invocationCwd = process.env.INIT_CWD ?? process.cwd();
  const absoluteConfigPath = resolve(invocationCwd, configPath);
  const options = JSON.parse(await fs.readFile(absoluteConfigPath, "utf8")) as PlanTemplatePluginOptions;
  const plugin = createPlanTemplatePlugin(options, { configDir: dirname(absoluteConfigPath) });
  try {
    await plugin.migrate();
    const management = plugin.managementApi();
    if (command === "mine") {
      writeJson(await management.runMiner());
      return;
    }
    if (command === "list") {
      writeJson(await management.listTemplates(parseStatusFilter(args.flags.status)));
      return;
    }
    if (command === "show") {
      const id = requireFlag(args.flags.id, "--id");
      writeJson(await management.getTemplate(id));
      return;
    }
    if (command === "approve") {
      const id = requireFlag(args.flags.id, "--id");
      writeJson(await management.approveTemplate(id));
      return;
    }
    if (command === "retire") {
      const id = requireFlag(args.flags.id, "--id");
      writeJson(await management.retireTemplate(id));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await plugin.close();
  }
}

function parseArgs(args: readonly string[]): {
  readonly command: string;
  readonly flags: Record<string, string | undefined>;
} {
  const command = args[0] ?? "mine";
  const flags: Record<string, string | undefined> = {};
  for (let index = 1; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags[key] = undefined;
      continue;
    }
    flags[key] = value;
    index += 1;
  }
  return { command, flags };
}

function parseStatusFilter(status: string | undefined): { readonly status?: PlanTemplate["status"] } | undefined {
  if (status === undefined) return undefined;
  if (status === "draft" || status === "candidate" || status === "active" || status === "retired") {
    return { status };
  }
  throw new Error("--status must be draft, candidate, active, or retired");
}

function requireFlag(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`Missing ${flag}`);
  return value;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
