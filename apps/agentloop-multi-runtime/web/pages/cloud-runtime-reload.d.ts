export function mountRuntimeReload(options: {
  document: Pick<Document, "getElementById">;
  fetch: (url: string, options: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<Record<string, unknown>> }>;
  confirm: (message: string) => boolean;
  setTimeout: (handler: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  configurationInput?: () => { configuration: { models: Record<string, unknown> }; credentialUpdates?: Record<string, string>; environment?: string };
  onConfiguration?: (configuration: Record<string, unknown>) => void;
}): void;
