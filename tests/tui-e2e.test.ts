import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentService } from "../src/agents/agent-service.ts";
import { AuthService } from "../src/auth/auth-service.ts";
import { BatchService } from "../src/batch/batch-service.ts";
import { createAgentLoopServer } from "../src/http/server.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { LlmProviderRegistry } from "../src/runtime/provider-registry.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { removeSkillPackage } from "../src/skills/skill-package.ts";
import { AppDatabase } from "../src/storage/database.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_DIRECTORY = resolve(ROOT, "skills");

test("TUI process registers, creates an Agent, executes a Run, and displays committed evidence", async () => {
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const providers = testProviders();
  const agents = new AgentService(database, skills, {
    allowedProviderKeys: providers.keys(),
    defaultProviderKey: providers.defaultProviderKey,
  });
  const runs = new RunService({
    database,
    skills,
    agents,
    modelFactory: () => new TuiE2eModel(),
  });
  const batches = new BatchService(database, agents, runs);
  const server = createAgentLoopServer({ auth, skills, agents, runs, batches, providers });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const stdout = await runTuiProcess(`http://127.0.0.1:${address.port}`);

    assert.match(stdout, /欢迎，tui-e2e@example\.com。/);
    assert.match(stdout, /已创建 Agent tui-e2e-agent/);
    assert.match(stdout, /状态: completed/);
    assert.match(stdout, /TUI E2E produced canonical evidence/);
    assert.match(stdout, /run\.completed/);

    const run = database.raw.prepare("SELECT status, output, error_code FROM runs").get() as {
      status: string;
      output: string | null;
      error_code: string | null;
    };
    assert.equal(run.status, "completed");
    assert.equal(run.output, "TUI E2E produced canonical evidence");
    assert.equal(run.error_code, null);
    assert.equal((database.raw.prepare("SELECT status FROM plans").get() as { status: string }).status, "completed");
    assert.equal(
      (database.raw.prepare("SELECT approved FROM skill_compliance_assessments").get() as { approved: number }).approved,
      1,
    );
    assert.equal(
      (database.raw.prepare("SELECT reason_code FROM run_outcomes").get() as { reason_code: string }).reason_code,
      "plan_assessed_and_completed",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});

test("TUI quick Skill runner selects a discovered Package without creating a Skill", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-tui-quick-skill-"));
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const credentials = { email: "tui-quick-skill@example.com", password: "tui quick skill secure password" };
    const registered = await auth.register(credentials.email, credentials.password);
    const skills = new SkillService(database, {
      packageStoreRoot: join(workspace, ".agentloop", "skill-packages"),
      skillDirectory: SKILL_DIRECTORY,
    });
    await skills.refreshSkillDirectory();
    const available = await skills.listAvailable(registered.user.id);
    const frontend = available.find((skill) => skill.name === "frontend-design");
    assert.notEqual(frontend, undefined);
    const providers = testProviders();
    const agents = new AgentService(database, skills, {
      allowedProviderKeys: providers.keys(),
      defaultProviderKey: providers.defaultProviderKey,
    });
    const runs = new RunService({
      database,
      skills,
      agents,
      workspaceRoot: workspace,
      modelFactory: () => new TuiQuickSkillE2eModel(frontend!.id),
    });
    const batches = new BatchService(database, agents, runs);
    const server = createAgentLoopServer({ auth, skills, agents, runs, batches, providers });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const frontendIndex = available.findIndex((skill) => skill.id === frontend!.id) + 1;
      const stdout = await runTuiQuickSkillProcess(`http://127.0.0.1:${address.port}`, credentials, frontendIndex);

      assert.match(stdout, /选择已有 Skill/);
      assert.match(stdout, /已创建并绑定 frontend-design 的测试 Agent；未创建新的 Skill。/);
      const failedEvents = database.raw.prepare("SELECT type, payload_json FROM run_events ORDER BY seq").all() as Array<{
        type: string;
        payload_json: string;
      }>;
      const storedRun = database.raw.prepare("SELECT status, output, error_code FROM runs").get() as {
        status: string;
        output: string | null;
        error_code: string | null;
      };
      assert.equal(
        storedRun.status,
        "completed",
        `Quick runner failed with ${storedRun.error_code ?? "no error code"}: ${JSON.stringify(failedEvents)}`,
      );
      assert.match(stdout, /状态: completed/);
      assert.match(stdout, /TUI quick runner used the existing frontend-design Package/);
      assert.equal(
        (database.raw.prepare("SELECT COUNT(*) AS count FROM skills WHERE owner_user_id = ?").get(registered.user.id) as { count: number }).count,
        available.length,
      );
      const agent = database.raw.prepare(`
        SELECT agents.name, agent_skills.skill_id
        FROM agents JOIN agent_skills ON agent_skills.agent_id = agents.id
      `).get() as {
        name: string;
        skill_id: string;
      };
      assert.equal(agent.name, "TUI Skill Runner: frontend-design");
      assert.equal(agent.skill_id, frontend!.id);
      assert.equal(storedRun.output, "TUI quick runner used the existing frontend-design Package.");
      assert.equal(
        (database.raw.prepare("SELECT approved FROM skill_compliance_assessments").get() as { approved: number }).approved,
        1,
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    database.close();
    await removeSkillPackage(workspace).catch(() => undefined);
  }
});

test("TUI never echoes a password in a real POSIX terminal", { skip: process.platform === "win32" }, async () => {
  const server = createServer((request, response) => {
    if (request.url === "/healthz") return sendJson(response, 200, { status: "ok" });
    if (request.url === "/v1/auth/login") {
      return sendJson(response, 401, {
        error: { code: "UNAUTHENTICATED", message: "Invalid email or password", traceId: "tty-password-test" },
      });
    }
    return sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route", traceId: "tty-password-test" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await runPosixTerminalPasswordTest(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

class TuiE2eModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 32_000, maxOutputTokens: 2_048 } as const;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    const toolNames = request.tools.map((tool) => tool.name);
    if (toolNames.includes("submit_plan")) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "tui-e2e-plan",
          name: "submit_plan",
          arguments: {
            goal: "Produce a verifiable terminal result",
            selectedSkillIds: [],
            steps: [{
              id: "answer",
              objective: "Produce the requested result",
              dependencies: [],
              skillIds: [],
              requiredToolNames: [],
              successCriteria: [{ id: "result-ready", description: "The requested result is present" }],
            }],
          },
        }],
      };
    }
    if (toolNames.includes("submit_assessment")) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "tui-e2e-assessment",
          name: "submit_assessment",
          arguments: {
            criteria: [{
              criterionId: "result-ready",
              satisfied: true,
              rationale: "The candidate output contains the requested result",
              evidenceRefs: ["candidateOutput"],
            }],
            skills: [],
            feedback: "",
          },
        }],
      };
    }
    assert.deepEqual(toolNames, []);
    return {
      content: "TUI E2E produced canonical evidence",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class TuiQuickSkillE2eModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 32_000, maxOutputTokens: 2_048 } as const;
  private readonly skillId: string;
  private planningCalls = 0;
  private executionCalls = 0;

  constructor(skillId: string) {
    this.skillId = skillId;
  }

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.systemPrompt.includes("planning phase of a plan-first agent runtime")) {
      this.planningCalls += 1;
      if (this.planningCalls === 1) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill", "submit_plan"]);
        return toolResponse("quick-plan-load", "load_skill", { name: "frontend-design" });
      }
      assert.equal(this.planningCalls, 2);
      assert.match(request.messages.map((message) => message.content).join("\n"), /<skill_content [^>]*name="frontend-design"/);
      return toolResponse("quick-plan-submit", "submit_plan", {
        goal: "Quickly validate the discovered frontend-design Package",
        selectedSkillIds: [this.skillId],
        steps: [{
          id: "validate-skill",
          objective: "Load the bound Package and provide its evidence-backed validation result",
          dependencies: [],
          skillIds: [this.skillId],
          requiredToolNames: [],
          successCriteria: [{ id: "existing-package-used", description: "The selected existing Package was loaded and used" }],
        }],
      });
    }
    if (request.systemPrompt.includes("independent completion assessor in a plan-first agent runtime")) {
      return toolResponse("quick-assessment", "submit_assessment", {
        criteria: [{
          criterionId: "existing-package-used",
          satisfied: true,
          rationale: "The candidate names the existing package after an exact load_skill activation.",
          evidenceRefs: ["candidateOutput", "load_skill"],
        }],
        skills: [{
          skillId: this.skillId,
          followed: true,
          rationale: "The runtime loaded the exact bound frontend-design Package before the final candidate.",
          evidenceRefs: ["load_skill", "candidateOutput"],
        }],
        feedback: "",
      });
    }
    this.executionCalls += 1;
    if (this.executionCalls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill"]);
      return toolResponse("quick-step-load", "load_skill", { name: "frontend-design" });
    }
    assert.equal(this.executionCalls, 2);
    assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill"]);
    assert.match(request.messages.map((message) => message.content).join("\n"), /<skill_content [^>]*name="frontend-design"/);
    return {
      content: "TUI quick runner used the existing frontend-design Package.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

function testProviders(): LlmProviderRegistry {
  return LlmProviderRegistry.fromEnvironment({
    LLM_PROVIDERS_JSON: JSON.stringify({
      defaultProvider: "tui-e2e-provider",
      providers: {
        "tui-e2e-provider": {
          kind: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          apiKeyEnv: "TUI_E2E_PROVIDER_API_KEY",
          defaultModel: "tui-e2e-model",
        },
      },
    }),
    TUI_E2E_PROVIDER_API_KEY: "test-secret",
  });
}

async function runTuiProcess(url: string): Promise<string> {
  const child = spawn(process.execPath, ["src/tui.ts", "--url", url], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let cursor = 0;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("close", (code, signal) => { exit = { code, signal }; });

  const enterAfter = async (prompt: string, line: string): Promise<void> => {
    const timeoutAt = Date.now() + 5_000;
    while (!stdout.slice(cursor).includes(prompt)) {
      if (exit !== undefined) throw new Error(`TUI exited before prompt ${JSON.stringify(prompt)}:\n${stdout}\n${stderr}`);
      if (Date.now() >= timeoutAt) throw new Error(`Timed out waiting for prompt ${JSON.stringify(prompt)}:\n${stdout}\n${stderr}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    cursor = stdout.length;
    child.stdin.write(`${line}\n`);
  };

  await enterAfter("选择: ", "2");
  await enterAfter("邮箱: ", "tui-e2e@example.com");
  await enterAfter("密码: ", "tui e2e password");
  await enterAfter("再次输入密码: ", "tui e2e password");
  await enterAfter("选择: ", "7");
  await enterAfter("Agent 名称: ", "tui-e2e-agent");
  await enterAfter("  > ", "Use the approved Plan-first flow.");
  await enterAfter("  > ", ".");
  await enterAfter("选择序号: ", "1");
  await enterAfter("模型 ID（留空使用 Provider 默认模型）: ", "");
  await enterAfter("选择: ", "");
  await enterAfter("选择: ", "1");
  await enterAfter("选择序号: ", "1");
  await enterAfter("  > ", "Return a verifiable terminal result.");
  await enterAfter("  > ", ".");
  await enterAfter("选择: ", "q");
  child.stdin.end();

  const timeoutAt = Date.now() + 15_000;
  while (exit === undefined) {
    if (Date.now() >= timeoutAt) {
      child.kill("SIGTERM");
      throw new Error(`TUI E2E process did not exit within 15 seconds:\n${stdout}\n${stderr}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const text = stdout;
  const result = exit;
  assert.equal(result.code, 0, `TUI stderr:\n${stderr}\nTUI stdout:\n${text}`);
  assert.equal(result.signal, null);
  return text;
}

async function runTuiQuickSkillProcess(
  url: string,
  credentials: { readonly email: string; readonly password: string },
  skillIndex: number,
): Promise<string> {
  const child = spawn(process.execPath, ["src/tui.ts", "--url", url], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let cursor = 0;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("close", (code, signal) => { exit = { code, signal }; });

  const enterAfter = async (prompt: string, line: string): Promise<void> => {
    const timeoutAt = Date.now() + 5_000;
    while (!stdout.slice(cursor).includes(prompt)) {
      if (exit !== undefined) throw new Error(`TUI exited before prompt ${JSON.stringify(prompt)}:\n${stdout}\n${stderr}`);
      if (Date.now() >= timeoutAt) throw new Error(`Timed out waiting for prompt ${JSON.stringify(prompt)}:\n${stdout}\n${stderr}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    cursor = stdout.length;
    child.stdin.write(`${line}\n`);
  };

  await enterAfter("选择: ", "1");
  await enterAfter("邮箱: ", credentials.email);
  await enterAfter("密码: ", credentials.password);
  await enterAfter("选择: ", "2");
  await enterAfter("选择序号: ", String(skillIndex));
  await enterAfter("  > ", "Validate this existing Skill without creating a new Skill.");
  await enterAfter("  > ", ".");
  await enterAfter("[y/N]: ", "y");
  await enterAfter("选择: ", "q");
  child.stdin.end();

  const timeoutAt = Date.now() + 15_000;
  while (exit === undefined) {
    if (Date.now() >= timeoutAt) {
      child.kill("SIGTERM");
      throw new Error(`TUI quick Skill runner did not exit within 15 seconds:\n${stdout}\n${stderr}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(exit.code, 0, `TUI stderr:\n${stderr}\nTUI stdout:\n${stdout}`);
  assert.equal(exit.signal, null);
  return stdout;
}

async function runPosixTerminalPasswordTest(url: string): Promise<void> {
  const python = String.raw`
import os
import pty
import select
import sys
import time

node, root, url = sys.argv[1:]
secret = "tty-password-must-not-echo"
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    os.execvpe(node, [node, "src/tui.ts", "--url", url], env)

captured = bytearray()
def until(marker, start=0):
    deadline = time.time() + 8
    marker = marker.encode()
    while marker not in captured[start:]:
        if time.time() >= deadline:
            raise RuntimeError("timed out waiting for TUI prompt")
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            captured.extend(os.read(fd, 4096))

until("选择: ")
os.write(fd, b"1\r")
until("邮箱: ")
os.write(fd, b"tty-password-test@example.com\r")
until("密码: ")
time.sleep(0.1)
os.write(fd, secret.encode() + b"\r")
start = len(captured)
until("Invalid email or password", start)
until("选择: ", start)
os.write(fd, b"q\r")
deadline = time.time() + 8
while True:
    done, _ = os.waitpid(pid, os.WNOHANG)
    if done:
        break
    if time.time() >= deadline:
        os.kill(pid, 15)
        raise RuntimeError("TUI did not exit")
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            captured.extend(os.read(fd, 4096))
        except OSError:
            pass

transcript = captured.decode("utf-8", "replace")
if secret in transcript:
    raise RuntimeError("password appeared in terminal transcript")
if "*" * len(secret) not in transcript:
    raise RuntimeError("password was not masked")
`;
  const child = spawn("python3", ["-c", python, process.execPath, process.cwd(), url], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(
    result.code,
    0,
    `POSIX password test failed:\n${Buffer.concat(stderr).toString("utf8")}\n${Buffer.concat(stdout).toString("utf8")}`,
  );
  assert.equal(result.signal, null);
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function toolResponse(id: string, name: string, argumentsValue: unknown): ModelResponse {
  return {
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{ id, name, arguments: argumentsValue }],
  };
}
