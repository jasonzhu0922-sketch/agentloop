import type { Server } from "node:http";
export function runtimeConfigScript(apiUrl: string, agentUrl?: string): string;
export function staticFilePath(pathname: string): string | undefined;
export function createWebServer(options?: { installerDirectory?: string }): Server;
