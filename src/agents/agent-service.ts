import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../storage/database.ts";
import type { SkillService } from "../skills/skill-service.ts";
import { badRequest, conflict, notFound } from "../shared/errors.ts";
import {
  optionalPositiveInteger,
  optionalString,
  requireString,
  requireStringArray,
} from "../shared/validation.ts";

export interface AgentDefinition {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly providerKey: string;
  readonly modelId: string;
  readonly maxSteps: number;
  readonly maxDepth: number;
  readonly skillIds: readonly string[];
  readonly childAgentIds: readonly string[];
  readonly toolNames: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentServiceOptions {
  /**
   * Optional server-owned Provider catalog. When configured, agent creation
   * rejects unknown keys before they can enter a persisted Agent definition.
   */
  readonly allowedProviderKeys?: readonly string[];
  readonly defaultProviderKey?: string;
}

interface AgentRow {
  id: string;
  owner_user_id: string;
  name: string;
  system_prompt: string;
  provider_key: string;
  model_id: string;
  max_steps: number;
  max_depth: number;
  created_at: number;
  updated_at: number;
}

export class AgentService {
  private readonly database: AppDatabase;
  private readonly skills: SkillService;
  private readonly allowedProviderKeys?: ReadonlySet<string>;
  private readonly defaultProviderKey: string;

  constructor(database: AppDatabase, skills: SkillService, options: AgentServiceOptions = {}) {
    this.database = database;
    this.skills = skills;
    if (options.allowedProviderKeys !== undefined) {
      if (options.allowedProviderKeys.length === 0) throw new TypeError("allowedProviderKeys must not be empty");
      this.allowedProviderKeys = new Set(options.allowedProviderKeys);
    }
    this.defaultProviderKey = options.defaultProviderKey ?? "openai-compatible";
    if (this.allowedProviderKeys !== undefined && !this.allowedProviderKeys.has(this.defaultProviderKey)) {
      throw new TypeError("defaultProviderKey must be in allowedProviderKeys");
    }
  }

  create(
    ownerUserId: string,
    input: {
      name: unknown;
      systemPrompt: unknown;
      providerKey?: unknown;
      modelId?: unknown;
      maxSteps?: unknown;
      maxDepth?: unknown;
      skillIds?: unknown;
      childAgentIds?: unknown;
      toolNames?: unknown;
    },
  ): AgentDefinition {
    const name = requireString(input.name, "name", { max: 100 });
    const systemPrompt = requireString(input.systemPrompt, "systemPrompt", { max: 100_000 });
    const providerKey = optionalString(input.providerKey, "providerKey", {
      max: 80,
      pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    }) ?? this.defaultProviderKey;
    if (this.allowedProviderKeys !== undefined && !this.allowedProviderKeys.has(providerKey)) {
      throw badRequest(`Provider "${providerKey}" is not configured for this server`);
    }
    const modelId = optionalString(input.modelId, "modelId", { max: 160 }) ?? "default";
    const maxSteps = optionalPositiveInteger(input.maxSteps, "maxSteps", 12, 100);
    const maxDepth = optionalPositiveInteger(input.maxDepth, "maxDepth", 2, 8);
    const skillIds = requireStringArray(input.skillIds, "skillIds");
    const childAgentIds = requireStringArray(input.childAgentIds, "childAgentIds");
    const toolNames = requireStringArray(input.toolNames, "toolNames");

    // Validate ownership before any binding is persisted. Foreign identifiers
    // look identical to missing identifiers at this boundary.
    this.skills.getMany(ownerUserId, skillIds);
    for (const childAgentId of childAgentIds) this.get(ownerUserId, childAgentId);

    const id = randomUUID();
    const now = Date.now();
    try {
      this.database.transaction(() => {
        this.database.raw
          .prepare(`
            INSERT INTO agents(
              id, owner_user_id, name, system_prompt, provider_key, model_id,
              max_steps, max_depth, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(id, ownerUserId, name, systemPrompt, providerKey, modelId, maxSteps, maxDepth, now, now);
        const bindSkill = this.database.raw.prepare(
          "INSERT INTO agent_skills(agent_id, skill_id) VALUES (?, ?)",
        );
        for (const skillId of skillIds) bindSkill.run(id, skillId);
        const bindChild = this.database.raw.prepare(
          "INSERT INTO agent_delegates(parent_agent_id, child_agent_id) VALUES (?, ?)",
        );
        for (const childAgentId of childAgentIds) bindChild.run(id, childAgentId);
        const bindTool = this.database.raw.prepare(
          "INSERT INTO agent_tools(agent_id, tool_name) VALUES (?, ?)",
        );
        for (const toolName of toolNames) bindTool.run(id, toolName);
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: agents.owner_user_id, agents.name")) {
        throw conflict(`An agent named "${name}" already exists`);
      }
      throw error;
    }
    return {
      id,
      ownerUserId,
      name,
      systemPrompt,
      providerKey,
      modelId,
      maxSteps,
      maxDepth,
      skillIds,
      childAgentIds,
      toolNames,
      createdAt: now,
      updatedAt: now,
    };
  }

  list(ownerUserId: string): AgentDefinition[] {
    const rows = this.database.raw
      .prepare(`
        SELECT id, owner_user_id, name, system_prompt, provider_key, model_id,
               max_steps, max_depth, created_at, updated_at
        FROM agents WHERE owner_user_id = ? ORDER BY name
      `)
      .all(ownerUserId) as unknown as AgentRow[];
    return rows.map((row) => this.hydrate(row));
  }

  get(ownerUserId: string, agentId: string): AgentDefinition {
    const row = this.database.raw
      .prepare(`
        SELECT id, owner_user_id, name, system_prompt, provider_key, model_id,
               max_steps, max_depth, created_at, updated_at
        FROM agents WHERE id = ? AND owner_user_id = ?
      `)
      .get(agentId, ownerUserId) as AgentRow | undefined;
    if (row === undefined) throw notFound("Agent");
    return this.hydrate(row);
  }

  private hydrate(row: AgentRow): AgentDefinition {
    const skillRows = this.database.raw
      .prepare("SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY skill_id")
      .all(row.id) as unknown as { skill_id: string }[];
    const childRows = this.database.raw
      .prepare("SELECT child_agent_id FROM agent_delegates WHERE parent_agent_id = ? ORDER BY child_agent_id")
      .all(row.id) as unknown as { child_agent_id: string }[];
    const toolRows = this.database.raw
      .prepare("SELECT tool_name FROM agent_tools WHERE agent_id = ? ORDER BY tool_name")
      .all(row.id) as unknown as { tool_name: string }[];
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      systemPrompt: row.system_prompt,
      providerKey: row.provider_key,
      modelId: row.model_id,
      maxSteps: row.max_steps,
      maxDepth: row.max_depth,
      skillIds: skillRows.map((item) => item.skill_id),
      childAgentIds: childRows.map((item) => item.child_agent_id),
      toolNames: toolRows.map((item) => item.tool_name),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
