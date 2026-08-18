import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AgentService } from "../src/agents/agent-service.ts";
import { AuthService } from "../src/auth/auth-service.ts";
import { BatchService } from "../src/batch/batch-service.ts";
import { CONSOLE_JS } from "../src/http/console.ts";
import { createAgentLoopServer } from "../src/http/server.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { LlmProviderRegistry } from "../src/runtime/provider-registry.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("registration stores only password and session digests", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const result = await auth.register("Owner@Example.com", "correct horse battery staple");
    assert.equal(result.user.email, "owner@example.com");
    assert.equal(auth.authenticate(result.token).id, result.user.id);

    const userRow = database.raw.prepare("SELECT password_hash FROM users WHERE id = ?").get(result.user.id) as {
      password_hash: string;
    };
    const sessionRow = database.raw.prepare("SELECT token_hash FROM auth_sessions WHERE user_id = ?").get(result.user.id) as {
      token_hash: string;
    };
    assert.match(userRow.password_hash, /^scrypt\$/);
    assert.notEqual(userRow.password_hash, "correct horse battery staple");
    assert.notEqual(sessionRow.token_hash, result.token);

    await assert.rejects(
      () => auth.login("owner@example.com", "incorrect password"),
      (error: unknown) => hasErrorCode(error, "UNAUTHENTICATED"),
    );
    const second = await auth.login("owner@example.com", "correct horse battery staple");
    assert.equal(second.user.id, result.user.id);
    auth.revoke(second.token);
    assert.throws(
      () => auth.authenticate(second.token),
      (error: unknown) => hasErrorCode(error, "UNAUTHENTICATED"),
    );
  } finally {
    database.close();
  }
});

test("private skill ownership is enforced at query and agent-binding boundaries", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("owner@example.com", "owner secure password");
    const stranger = await auth.register("stranger@example.com", "stranger secure password");
    const skill = skills.create(owner.user.id, {
      name: "private-research",
      description: "Internal research procedure",
      instructions: "Never reveal this private body outside the owning account.",
    });
    assert.equal(skill.contentHash.length, 64);

    assert.deepEqual(skills.list(stranger.user.id), []);
    assert.throws(
      () => skills.get(stranger.user.id, skill.id),
      (error: unknown) => hasErrorCode(error, "NOT_FOUND"),
    );
    assert.throws(
      () => agents.create(stranger.user.id, {
        name: "stolen-agent",
        systemPrompt: "Try to bind a foreign skill",
        skillIds: [skill.id],
      }),
      (error: unknown) => hasErrorCode(error, "NOT_FOUND"),
    );

    const agent = agents.create(owner.user.id, {
      name: "researcher",
      systemPrompt: "Use approved private research skills.",
      skillIds: [skill.id],
    });
    assert.deepEqual(agent.skillIds, [skill.id]);
  } finally {
    database.close();
  }
});

test("HTTP login and private skill APIs form a runnable vertical slice", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const agents = new AgentService(database, skills);
  const runs = new RunService({
    database,
    skills,
    agents,
    modelFactory: () => {
      throw new Error("Model is not used by this API-only test");
    },
  });
  const batches = new BatchService(database, agents, runs);
  const providers = LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify({
      defaultProvider: "test-provider",
      providers: {
        "test-provider": {
          kind: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          apiKeyEnv: "TEST_PROVIDER_API_KEY",
          defaultModel: "test-model",
        },
      },
    }),
    TEST_PROVIDER_API_KEY: "test-secret",
  });
  const server = createAgentLoopServer({ auth, skills, agents, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const consolePage = await fetch(`${baseUrl}/`);
    assert.equal(consolePage.status, 200);
    assert.match(await consolePage.text(), /DeepSeek Harness/);
    assert.match(consolePage.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    const registration = await fetch(`${baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "api@example.com",
        password: "api password is secure",
      }),
    });
    assert.equal(registration.status, 201);
    const authBody = await registration.json() as { token: string };

    const created = await fetch(`${baseUrl}/v1/skills`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authBody.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "api-private-skill",
        description: "Created through the authenticated API",
        instructions: "Private body",
      }),
    });
    assert.equal(created.status, 201);

    const anonymousList = await fetch(`${baseUrl}/v1/skills`);
    assert.equal(anonymousList.status, 401);
    const ownedList = await fetch(`${baseUrl}/v1/skills`, {
      headers: { authorization: `Bearer ${authBody.token}` },
    });
    assert.equal(ownedList.status, 200);
    const listBody = await ownedList.json() as { skills: Array<{ name: string; instructions?: string }> };
    assert.equal(listBody.skills[0].name, "api-private-skill");
    assert.equal(listBody.skills[0].instructions, undefined);

    const providerCatalog = await fetch(`${baseUrl}/v1/providers`, {
      headers: { authorization: `Bearer ${authBody.token}` },
    });
    assert.equal(providerCatalog.status, 200);
    assert.deepEqual(await providerCatalog.json(), {
      defaultProviderKey: "test-provider",
      providers: [{ key: "test-provider", kind: "openai-compatible", defaultModel: "test-model" }],
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

test("HTTP async Run start returns a trackable running Run before model completion", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const agents = new AgentService(database, skills);
  const release = deferred<void>();
  const runs = new RunService({
    database,
    skills,
    agents,
    modelFactory: () => new DeferredRunModel(release.promise),
  });
  const batches = new BatchService(database, agents, runs);
  const server = createAgentLoopServer({ auth, skills, agents, runs, batches });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const owner = await auth.register("async-run@example.com", "async run secure password");
    const agent = agents.create(owner.user.id, {
      name: "async-tracker",
      systemPrompt: "Produce a trackable answer.",
      skillIds: [],
      childAgentIds: [],
      toolNames: [],
    });

    const started = await fetch(`${baseUrl}/v1/runs/async`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: agent.id,
        input: "Return an async tracked result.",
        allowDangerousTools: false,
      }),
    });
    assert.equal(started.status, 202);
    const startedBody = await started.json() as { run: { id: string; status: string } };
    assert.equal(startedBody.run.status, "running");

    const eventsBefore = await fetch(`${baseUrl}/v1/runs/${startedBody.run.id}/events`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(eventsBefore.status, 200);
    const eventsBeforeBody = await eventsBefore.json() as { events: Array<{ type: string }> };
    assert.equal(eventsBeforeBody.events[0].type, "run.started");

    const planBefore = await fetch(`${baseUrl}/v1/runs/${startedBody.run.id}/plan`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(planBefore.status, 200);
    const planBeforeBody = await planBefore.json() as { state: string; plan: { status: string; steps: unknown[] } };
    assert.equal(planBeforeBody.state, "pending");
    assert.equal(planBeforeBody.plan.status, "pending");
    assert.deepEqual(planBeforeBody.plan.steps, []);

    release.resolve();
    const completed = await pollRunStatus(baseUrl, owner.token, startedBody.run.id, "completed");
    assert.equal(completed.run.output, "async tracked output");

    const actions = await fetch(`${baseUrl}/v1/runs/${startedBody.run.id}/actions`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(actions.status, 200);
    const actionsBody = await actions.json() as { actions: Array<{ kind: string; state: string }> };
    assert.ok(actionsBody.actions.some((action) => action.kind === "planning" && action.state === "succeeded"));
    assert.ok(actionsBody.actions.some((action) => action.kind === "assessment" && action.state === "succeeded"));

    const planAfter = await fetch(`${baseUrl}/v1/runs/${startedBody.run.id}/plan`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(planAfter.status, 200);
    const planAfterBody = await planAfter.json() as { state: string; plan: { steps: unknown[] } };
    assert.equal(planAfterBody.state, "available");
    assert.equal(planAfterBody.plan.steps.length, 1);
  } finally {
    release.resolve();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

test("Recovery APIs expose only the owner state and advance a structured planner decision", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const agents = new AgentService(database, skills);
  const owner = await auth.register("recovery-api-owner@example.com", "recovery api owner secure password");
  const stranger = await auth.register("recovery-api-stranger@example.com", "recovery api stranger secure password");
  const agent = agents.create(owner.user.id, { name: "recovery-api-agent", systemPrompt: "Recover.", providerKey: "scenario" });
  const runId = "recovery-api-run";
  database.raw.prepare(`
    INSERT INTO runs(id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, ?, NULL, 0, 0, 'running', ?, ?)
  `).run(runId, owner.user.id, agent.id, "confirm delivery", Date.now());
  const actions = new RuntimeActionRepository(database);
  const action = actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
  database.raw.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
  actions.reconcileRunningRuns();
  const runs = new RunService({
    database,
    skills,
    agents,
    modelFactory: () => new DeferredRunModel(Promise.resolve()),
    recoveryPlannerFactory: () => ({
      decide: async () => ({
        actionId: action.id,
        expectedActionRevision: 2,
        decision: "ask_user",
        rationale: "The unsafe external effect is unknown.",
        evidenceRefs: [],
        question: "Was delivery confirmed?",
      }),
    }),
  });
  const batches = new BatchService(database, agents, runs);
  const server = createAgentLoopServer({ auth, skills, agents, runs, batches });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const pending = await fetch(`${baseUrl}/v1/runs/${runId}/recovery`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(pending.status, 200);
    const pendingBody = await pending.json() as { state?: { state: string }; decisions: unknown[] };
    assert.equal(pendingBody.state?.state, "waiting_recovery");
    assert.deepEqual(pendingBody.decisions, []);

    const hidden = await fetch(`${baseUrl}/v1/runs/${runId}/recovery`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(hidden.status, 404);

    const advanced = await fetch(`${baseUrl}/v1/runs/${runId}/recovery/advance`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(advanced.status, 200);
    const advancedBody = await advanced.json() as { state?: { state: string; question?: string }; decisions: Array<{ state: string }> };
    assert.equal(advancedBody.state?.state, "waiting_user");
    assert.equal(advancedBody.state?.question, "Was delivery confirmed?");
    assert.equal(advancedBody.decisions[0]?.state, "admitted");

    const answered = await fetch(`${baseUrl}/v1/runs/${runId}/recovery/respond`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ response: "Delivery was not confirmed." }),
    });
    assert.equal(answered.status, 200);
    const answeredBody = await answered.json() as {
      state?: { state: string };
      userResponses: Array<{ response: string }>;
    };
    assert.equal(answeredBody.state?.state, "waiting_recovery");
    assert.equal(answeredBody.userResponses[0]?.response, "Delivery was not confirmed.");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

test("browser console auth form submits the clicked login or register mode", () => {
  assert.match(CONSOLE_JS, /function authMode\(submitter\)/);
  assert.match(CONSOLE_JS, /const mode=authMode\(event\.submitter\)/);
  assert.match(CONSOLE_JS, /\/v1\/auth\/'\+mode/);
  assert.doesNotMatch(CONSOLE_JS, /\/v1\/auth\/'\+data\.get\('mode'\)/);
  assert.match(CONSOLE_JS, /minlength="12"/);
  assert.match(CONSOLE_JS, /\/v1\/runs\/async/);
  assert.match(CONSOLE_JS, /function pollRun\(runId\)/);
});

class DeferredRunModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 32_000, maxOutputTokens: 2_048 } as const;
  private readonly release: Promise<void>;

  constructor(release: Promise<void>) {
    this.release = release;
  }

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    const toolNames = request.tools.map((tool) => tool.name);
    if (toolNames.includes("submit_plan")) {
      await this.release;
      return toolResponse("async-plan", "submit_plan", {
        goal: "Produce a trackable async result",
        selectedSkillIds: [],
        steps: [{
          id: "answer",
          objective: "Produce the async result",
          dependencies: [],
          skillIds: [],
          requiredToolNames: [],
          successCriteria: [{ id: "answer-ready", description: "The async result is present" }],
        }],
      });
    }
    if (toolNames.includes("submit_assessment")) {
      return toolResponse("async-assessment", "submit_assessment", {
        criteria: [{
          criterionId: "answer-ready",
          satisfied: true,
          rationale: "The candidate contains the async tracked output.",
          evidenceRefs: ["candidateOutput"],
        }],
        skills: [],
        feedback: "",
      });
    }
    await this.release;
    return {
      content: "async tracked output",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function pollRunStatus(
  baseUrl: string,
  token: string,
  runId: string,
  expected: string,
): Promise<{ run: { status: string; output?: string } }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { run: { status: string; output?: string } };
    if (body.run.status === expected) return body;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for Run ${runId} to reach ${expected}`);
}

function toolResponse(id: string, name: string, argumentsValue: unknown): ModelResponse {
  return {
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{ id, name, arguments: argumentsValue }],
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code: unknown }).code === code;
}
