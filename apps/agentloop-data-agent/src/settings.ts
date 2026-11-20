import { execFile } from "node:child_process";
import { AppError } from "@zhujun/agentloop";
import { ModelSettings } from "./model-settings.ts";

export class SettingsService {
  readonly models: ModelSettings;
  private readonly options: { python: string; script: string; skillRoot: string };
  constructor(models: ModelSettings, options: { python: string; script: string; skillRoot: string }) {
    this.models = models; this.options = options;
  }
  async catalog(action: string, input: Record<string, unknown> = {}): Promise<any> {
    const { python, script, skillRoot } = this.options;
    const result = await new Promise<string>((accept, reject) => {
      const child = execFile(python, [script, skillRoot, action], { timeout: 45_000, maxBuffer: 8_000_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }, (error, stdout) => {
        if (error) reject(new AppError("INTERNAL_ERROR", "目录服务不可用，请检查服务端数据库连接", 503));
        else accept(stdout);
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(JSON.stringify(input));
    });
    let response;
    try { response = JSON.parse(result); } catch { throw new AppError("INTERNAL_ERROR", "目录服务返回无效", 503); }
    if (response.error) throw new AppError(response.status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", response.error, response.status ?? 400);
    return response;
  }
}
