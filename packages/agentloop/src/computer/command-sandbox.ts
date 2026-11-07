import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { AppError } from "../shared/errors.ts";

export interface CommandSandboxPolicy {
  readonly mode: "required";
  /** Trusted runtime/library trees, never account data or configuration roots. */
  readonly readOnlyRoots?: readonly string[];
}
export interface SandboxedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly backend: "macos-seatbelt" | "linux-bubblewrap";
}
function unavailable(): never {
  throw new AppError("TOOL_POLICY_DENIED", "command_sandbox_unavailable", 503);
}
function quote(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f]/u.test(path)) throw new TypeError("sandbox_path_invalid");
  return JSON.stringify(path);
}
async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}
async function privateDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError("FORBIDDEN", "sandbox_directory_invalid", 403);
  return realpath(path);
}

/** OS restrictions are inherited by scripts and all of their descendants. */
export async function sandboxCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly workspaceRoot: string;
  readonly readOnlyRoots: readonly string[];
  readonly policy: CommandSandboxPolicy;
  readonly platform?: NodeJS.Platform;
}): Promise<SandboxedCommand> {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") unavailable();
  const root = await realpath(input.workspaceRoot);
  const scratch = await privateDirectory(root, ".agentloop-sandbox");
  const home = await privateDirectory(scratch, "home");
  const temporary = await privateDirectory(scratch, "tmp");
  const readOnlyRoots = await Promise.all([...new Set([
    ...input.readOnlyRoots, ...(input.policy.readOnlyRoots ?? []), dirname(process.execPath),
  ])].map(path => realpath(path)));
  const environment = { HOME: home, TMPDIR: `${temporary}/`, TMP: temporary, TEMP: temporary,
    XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config"), AGENTLOOP_WORKSPACE_ROOT: root };
  if (platform === "darwin") {
    if (!await executable("/usr/bin/sandbox-exec")) unavailable();
    const systemRoots = ["/System", "/usr/lib", "/usr/bin", "/usr/share", "/bin", "/sbin", "/Library/Apple", "/Library/Fonts", "/private/var/db/dyld", "/opt/homebrew/Cellar", "/opt/homebrew/opt", "/opt/homebrew/bin", "/opt/homebrew/lib", "/opt/homebrew/share", "/usr/local/lib", "/usr/local/bin"];
    const ancestors = new Set<string>();
    for (let path of [root, ...systemRoots, ...readOnlyRoots]) {
      while (path !== "/") { path = dirname(path); ancestors.add(path); }
    }
    const profile = [
      "(version 1)", "(deny default)", "(allow process-exec process-fork)", "(allow sysctl-read)",
      // Permit outbound connections and the system resolver without granting global IPC.
      '(allow network-outbound)',
      '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.mDNSResponder"))',
      // The resolver traverses these system symlinks when reading its configuration.
      '(allow file-read-metadata (literal "/etc") (literal "/var"))',
      '(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf"))',
      '(allow file-write* (literal "/dev/null"))',
      // Homebrew Node links OpenSSL, which reads its public startup config.
      // Do not grant the surrounding etc tree (it may contain credentials).
      '(allow file-read* (literal "/opt/homebrew/etc/openssl@3/openssl.cnf") (literal "/usr/local/etc/openssl@3/openssl.cnf"))',
      // Homebrew OpenSSL resolves cert.pem through ca-certificates; both the
      // symlink and its public trust bundle must be readable for HTTPS checks.
      '(allow file-read-metadata (literal "/opt/homebrew/etc") (literal "/opt/homebrew/etc/openssl@3") (literal "/opt/homebrew/etc/ca-certificates") (literal "/usr/local/etc") (literal "/usr/local/etc/openssl@3") (literal "/usr/local/etc/ca-certificates"))',
      '(allow file-read* (literal "/opt/homebrew/etc/openssl@3/cert.pem") (literal "/opt/homebrew/etc/ca-certificates/cert.pem") (literal "/usr/local/etc/openssl@3/cert.pem") (literal "/usr/local/etc/ca-certificates/cert.pem") (literal "/private/etc/ssl/cert.pem"))',
      ...[...ancestors].map(path => `(allow file-read-metadata (literal ${quote(path)}))`),
      ...systemRoots.map(path => `(allow file-read* (subpath ${quote(path)}))`),
      ...readOnlyRoots.map(path => `(allow file-read* (subpath ${quote(path)}))`),
      `(allow file-read* file-write* (subpath ${quote(root)}))`,
    ].join("\n");
    return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, input.command, ...input.args], environment, backend: "macos-seatbelt" };
  }
  const bwrap = (await Promise.all(["/usr/bin/bwrap", "/bin/bwrap"].map(async path => await executable(path) ? path : undefined))).find(Boolean);
  if (!bwrap) unavailable();
  const systemRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/alternatives", "/etc/fonts", "/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/ssl/certs"];
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--share-net", "--proc", "/proc", "--dev", "/dev"];
  for (const path of [...new Set([...systemRoots, ...readOnlyRoots])]) {
    try { await access(path); args.push("--ro-bind", path, path); } catch { /* Optional OS layout. */ }
  }
  args.push("--bind", root, root, "--chdir", root, "--", input.command, ...input.args);
  return { command: bwrap, args, environment, backend: "linux-bubblewrap" };
}
