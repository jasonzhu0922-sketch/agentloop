import type { Server } from "node:http";
export function runtimeConfigScript(apiUrl: string, agentUrl?: string): string;
export function staticFilePath(pathname: string): string | undefined;
export function createWebServer(options?: {
  installerDirectory?: string;
  runtimeControlSocket?: string;
  runtimeControlDevMode?: boolean;
  runtimeControlDevRoot?: string;
  runtimeControlDevSkillsRoot?: string;
  runtimeControlDevToken?: string;
  runtimeControlDevConfiguration?: string;
  runtimeControlDevEnvironment?: string;
  runtimeControlDevMcpConfiguration?: string;
}): Server;
