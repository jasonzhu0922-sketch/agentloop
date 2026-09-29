import { promises as fs, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AppError, forbidden } from "../shared/errors.ts";
import { ownerWorkspaceSegment } from "./owner-workspace.ts";

/**
 * Server-owned workspace layout and directory safety for Runtime execution.
 * It intentionally has no knowledge of Plans, tools, events, or outcomes.
 */
export class RuntimeWorkspaceService {
  private readonly workspaceRoot: string;
  private readonly ownerScoped: boolean;

  constructor(workspaceRoot: string, options: { readonly ownerScoped: boolean }) {
    this.workspaceRoot = realpathSync(workspaceRoot);
    this.ownerScoped = options.ownerScoped;
  }

  forRun(run: { readonly ownerUserId: string; readonly conversationId?: string }): string {
    return run.conversationId === undefined
      ? this.forOwner(run.ownerUserId)
      : this.forConversation(run.ownerUserId, run.conversationId);
  }

  forOwner(ownerUserId: string): string {
    if (!this.ownerScoped) return this.workspaceRoot;
    const target = resolve(this.workspaceRoot, "users", ownerWorkspaceSegment(ownerUserId));
    this.assertInsideServerWorkspace(target);
    return target;
  }

  forConversation(ownerUserId: string, conversationId: string): string {
    if (!isSafeWorkspaceSegment(conversationId)) {
      throw new AppError("BAD_REQUEST", "Invalid conversation workspace id", 400);
    }
    const target = resolve(this.forOwner(ownerUserId), "conversations", conversationId);
    this.assertInsideServerWorkspace(target);
    return target;
  }

  async ensureOwnerWorkspace(ownerUserId: string): Promise<string> {
    const root = this.forOwner(ownerUserId);
    if (!this.ownerScoped) return root;
    await this.ensureManagedDirectory(resolve(this.workspaceRoot, "users"));
    await this.ensureManagedDirectory(root);
    return await fs.realpath(root);
  }

  async ensureConversationWorkspace(ownerUserId: string, conversationId: string): Promise<string> {
    const root = await this.ensureOwnerWorkspace(ownerUserId);
    const parent = resolve(root, "conversations");
    const target = this.forConversation(ownerUserId, conversationId);
    await this.ensureManagedDirectory(parent);
    await this.ensureManagedDirectory(target);
    return await fs.realpath(target);
  }

  private async ensureManagedDirectory(directory: string): Promise<void> {
    this.assertInsideServerWorkspace(directory);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink()) throw forbidden("Conversation workspace directories cannot be symbolic links");
    if (!stat.isDirectory()) throw new AppError("CONFLICT", "Conversation workspace path is not a directory", 409);
    this.assertInsideServerWorkspace(await fs.realpath(directory));
  }

  private assertInsideServerWorkspace(path: string): void {
    const offset = relative(this.workspaceRoot, path);
    if (offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
    throw forbidden("Conversation workspace escapes the configured workspace root");
  }
}

function isSafeWorkspaceSegment(value: string): boolean {
  return value.length > 0
    && !value.includes("\0")
    && !value.includes("/")
    && !value.includes("\\")
    && value !== "."
    && value !== "..";
}
