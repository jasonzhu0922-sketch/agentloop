import type { Server } from "node:http";
export function runtimeConfigScript(apiUrl: string, agentUrl?: string, runtimeControl?: { basePath?: string; devMode?: boolean; devToken?: string }): string;
export function staticFilePath(pathname: string): string | undefined;
export function createWebServer(options?: { installerDirectory?: string; runtimeControlSocket?: string; webBasePath?: string }): Server;
