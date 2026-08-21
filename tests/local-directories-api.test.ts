import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AuthService } from "../src/auth/auth-service.ts";
import { BatchService } from "../src/batch/batch-service.ts";
import { createAgentLoopServer } from "../src/http/server.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

const execFileAsync = promisify(execFile);

test("local directory picker lists visible child directories without conceptual roots or hidden entries", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-local-directories-"));
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-picker-"));
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const runs = new RunService({
    database,
    skills,
    workspaceRoot: workspace,
    modelFactory: () => { throw new Error("model is not used"); },
  });
  const server = createAgentLoopServer({ auth, skills, runs, batches: new BatchService(database, runs) });
  try {
    await fs.mkdir(join(root, "Documents"));
    await fs.mkdir(join(root, ".Secrets"));
    await fs.mkdir(join(root, "FinderHidden"));
    await fs.writeFile(join(root, "notes.txt"), "not a directory");
    if (process.platform === "darwin") {
      await execFileAsync("chflags", ["hidden", join(root, "FinderHidden")]);
    }

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registered = await postJson<{ token: string }>(baseUrl, "/v1/auth/register", undefined, {
      email: "directory-picker@example.com",
      password: "directory picker secure password",
    });

    const listing = await getJson<{
      currentPath: string;
      parentPath?: string;
      roots?: unknown;
      entries: readonly { name: string; path: string }[];
    }>(baseUrl, `/v1/local-directories?path=${encodeURIComponent(root)}`, registered.token);

    assert.equal(listing.currentPath, await fs.realpath(root));
    assert.equal("roots" in listing, false);
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      process.platform === "darwin" ? ["Documents"] : ["Documents", "FinderHidden"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function postJson<T>(
  baseUrl: string,
  path: string,
  token: string | undefined,
  body: unknown,
): Promise<T> {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as T;
}

async function getJson<T>(baseUrl: string, path: string, token: string): Promise<T> {
  const response = await fetch(baseUrl + path, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as T;
}
