import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError } from "@zhujun/agentloop";
import { createLocalRuntimeManager, EncryptedLocalRuntimeSecretStore, type LocalRuntimeManager, type LocalRuntimeManagerOptions } from "@zhujun/agentloop-local-runtime";
import { migrateLegacyAccount, type AccountMigration } from "./legacy-account-migration.ts";

export function accountDataDirectory(root: string, owner: string): string {
  if (!/^cloud_[a-f0-9]{64}$/.test(owner)) throw new TypeError("desktop_account_id_invalid");
  return join(root, "accounts", owner);
}
function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function directory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("desktop_account_directory_invalid");
}

export async function desktopRuntimeEnvironment(dataDirectory: string): Promise<Pick<LocalRuntimeManagerOptions, "webSearch" | "planningMaxTurns" | "stepMaxTurns">> {
  let content: string;
  try { content = await readFile(join(dataDirectory, ".env"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const env = parseEnv(content);
  const limit = (name: string, max: number): number | undefined => {
    const value = env[name];
    if (value === undefined || value === "") return undefined;
    if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`desktop_${name.toLowerCase()}_invalid`);
    return Number(value);
  };
  const planningMaxTurns = limit("PLANNING_MAX_TURNS", 64), stepMaxTurns = limit("STEP_MAX_TURNS", 256);
  let webSearch: LocalRuntimeManagerOptions["webSearch"];
  if (env.WEB_SEARCH_DISABLED === "0") {
    const provider = env.WEB_SEARCH_PROVIDER;
    if (provider !== undefined && provider !== "bocha" && provider !== "baidu" && provider !== "bing") throw new Error("desktop_web_search_provider_invalid");
    webSearch = { ...(provider === undefined ? {} : { searchProvider: provider }),
      ...(env.WEB_SEARCH_ENDPOINT ? { searchEndpoint: env.WEB_SEARCH_ENDPOINT } : {}),
      ...(env.WEB_SEARCH_API_KEY ? { searchApiKey: env.WEB_SEARCH_API_KEY } : {}) };
  }
  return { ...(webSearch === undefined ? {} : { webSearch }), ...(planningMaxTurns === undefined ? {} : { planningMaxTurns }), ...(stepMaxTurns === undefined ? {} : { stepMaxTurns }) };
}

type Options = Pick<LocalRuntimeManagerOptions, "models" | "identity" | "bundledSkillDirectories" | "connectorModules" | "computerCommandEnvironment" | "runEventLogSink"> & {
  readonly dataDirectory: string;
  readonly runtimeEnvironmentDirectory?: string;
  readonly defaultRuntimeId: string;
};

/** The authenticated account chooses the entire manager, not just a SQL
 * filter. Configuration, Runtime lifecycle, vaults and diagnostics all follow
 * this same boundary; the renderer cannot select another account namespace. */
export class DesktopAccountManagers {
  private readonly managers = new Map<string, Promise<LocalRuntimeManager>>();
  private readonly migrations = new Map<string, AccountMigration>();
  private readonly grantWrites = new Map<string, Promise<void>>();
  private closed = false;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  async ready(): Promise<void> {
    await directory(join(this.options.dataDirectory, "accounts"));
    // Detect damaged legacy data before publishing a healthy host. No legacy
    // Runtime is started and no account is inferred from the first login.
    const legacy = join(this.options.dataDirectory, "supervisor.db");
    if (await exists(legacy)) {
      const db = new DatabaseSync(legacy, { readOnly: true });
      try { db.prepare("SELECT name FROM sqlite_master LIMIT 1").get(); } finally { db.close(); }
    }
  }

  forOwner(owner: string): Promise<LocalRuntimeManager> {
    if (this.closed) return Promise.reject(new AppError("CONFLICT", "local_runtime_closed", 409));
    let promise = this.managers.get(owner);
    if (!promise) {
      promise = this.open(owner).catch(error => { this.managers.delete(owner); throw error; });
      this.managers.set(owner, promise);
    }
    return promise;
  }
  migration(owner: string): AccountMigration | undefined { return this.migrations.get(owner); }

  async grantSelectedStorage(owner: string, selected: string, kind: "workspace" | "uploads"): Promise<string> {
    const account = accountDataDirectory(this.options.dataDirectory, owner);
    const base = await realpath(selected);
    const data = await realpath(this.options.dataDirectory);
    const components = base.split(sep);
    if (!(await lstat(base)).isDirectory() || dirname(base) === base || inside(data, base) || components.includes(".agentloop-desktop") || components.some((part, i) => part === "accounts" && /^cloud_[a-f0-9]{64}$/.test(components[i + 1] ?? ""))) {
      throw new AppError("FORBIDDEN", "account_storage_outside_scope", 403);
    }
    const shared = join(base, ".agentloop-desktop"), owned = join(shared, owner), target = join(owned, kind);
    for (const path of [shared, owned, target]) await directory(path);
    if (await realpath(target) !== target) throw new AppError("FORBIDDEN", "account_storage_outside_scope", 403);
    const grantsPath = join(account, "storage-grants.json");
    const write = (this.grantWrites.get(owner) ?? Promise.resolve()).catch(() => {}).then(async () => {
      let grants: string[] = [];
      try { const value: unknown = JSON.parse(await readFile(grantsPath, "utf8")); if (!Array.isArray(value) || value.some(p => typeof p !== "string")) throw new Error(); grants = value; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!grants.includes(target)) {
        const temporary = `${grantsPath}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify([...grants, target]), { mode: 0o600, flag: "wx" });
        try { await rename(temporary, grantsPath); } finally { await rm(temporary, { force: true }); }
      }
    });
    this.grantWrites.set(owner, write);
    try { await write; } finally { if (this.grantWrites.get(owner) === write) this.grantWrites.delete(owner); }
    return target;
  }

  private async open(owner: string): Promise<LocalRuntimeManager> {
    const root = accountDataDirectory(this.options.dataDirectory, owner);
    if (!await exists(root)) {
      const staging = join(this.options.dataDirectory, "accounts", `.pending-${owner}-${randomUUID()}`);
      await directory(staging);
      try {
        const migration = await migrateLegacyAccount(this.options.dataDirectory, staging, root, owner);
        await writeFile(join(staging, "account.json"), JSON.stringify({ version: 1, ownerUserId: owner, migration }), { mode: 0o600, flag: "wx" });
        await rename(staging, root);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw new AppError("CONFLICT", "account_data_migration_failed", 409);
      }
    }
    await directory(root);
    const marker = JSON.parse(await readFile(join(root, "account.json"), "utf8"));
    if (marker.version !== 1 || marker.ownerUserId !== owner) throw new Error("desktop_account_marker_invalid");
    this.migrations.set(owner, marker.migration);
    await directory(join(root, "storage"));
    const boundary = await realpath(join(root, "storage"));
    const authorizeStorage = async (input: { workspaceRoot: string; uploadStorageRoot: string }) => {
      let grants: string[] = [];
      try { const value: unknown = JSON.parse(await readFile(join(root, "storage-grants.json"), "utf8")); if (!Array.isArray(value) || value.some(p => typeof p !== "string")) throw new Error(); grants = value; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const value of [input.workspaceRoot, input.uploadStorageRoot]) {
        if (!isAbsolute(value) || (!inside(boundary, resolve(value)) && !grants.includes(resolve(value)))) throw new AppError("FORBIDDEN", "account_storage_outside_scope", 403);
        let path = resolve(value), suffix: string[] = [];
        while (!await exists(path)) { suffix.unshift(path.slice(dirname(path).length + 1)); path = dirname(path); }
        const canonical = resolve(await realpath(path), ...suffix);
        if (!inside(boundary, canonical) && !(grants.includes(resolve(value)) && canonical === resolve(value))) throw new AppError("FORBIDDEN", "account_storage_outside_scope", 403);
      }
    };
    const env = this.options.computerCommandEnvironment;
    // Only host-provided tool installation directories are extra read grants.
    // The process environment and account roots are never blanket grants.
    const python = env?.RUNTIME_PYTHON && isAbsolute(env.RUNTIME_PYTHON) ? await realpath(env.RUNTIME_PYTHON) : undefined;
    const pythonRoot = python ? (dirname(python).endsWith(`${sep}bin`) ? dirname(dirname(python)) : dirname(python)) : undefined;
    const candidates = [...(env?.NODE_PATH?.split(delimiter) ?? []), pythonRoot].filter((path): path is string => Boolean(path) && isAbsolute(path!));
    const readOnlyRoots: string[] = [];
    const dataBoundary = await realpath(this.options.dataDirectory);
    for (const path of candidates) if (await exists(path)) {
      const canonical = await realpath(path);
      // An interpreter at /bin may resolve to /usr/bin. Canonicalize first,
      // and never turn a tool prefix into a grant for / or account storage.
      if (dirname(canonical) === canonical || inside(canonical, dataBoundary) || inside(dataBoundary, canonical)) {
        throw new Error("desktop_tool_directory_invalid");
      }
      readOnlyRoots.push(canonical);
    }
    const manager = await createLocalRuntimeManager({ ...this.options, dataDirectory: root,
      ...await desktopRuntimeEnvironment(this.options.runtimeEnvironmentDirectory ?? this.options.dataDirectory),
      workspaceRoot: join(boundary, "workspace"), uploadStorageRoot: join(boundary, "uploads"), authorizeStorage,
      modelSecrets: new EncryptedLocalRuntimeSecretStore(join(root, "private", "model-secrets")),
      secrets: new EncryptedLocalRuntimeSecretStore(join(root, "private", "mcp-secrets")),
      connectorSecrets: new EncryptedLocalRuntimeSecretStore(join(root, "private", "connector-secrets")),
      computerCommandSandbox: { mode: "required", readOnlyRoots },
      sharedMcpCatalog: true,
    });
    try { await authorizeStorage(await manager.deviceStorageConfiguration()); }
    catch (error) { await manager.close(); throw error; }
    return manager;
  }

  async close(): Promise<void> {
    // The HTTP host fences new requests before calling this. Preflight every
    // account first so an active Run never leaves another account half closed.
    const managers = await Promise.all(this.managers.values());
    await Promise.all(managers.map(manager => manager.assertIdle()));
    this.closed = true;
    await Promise.all(managers.map(manager => manager.close()));
  }
}
