export function mountRuntimeReload(options: {
  document: Pick<Document, "getElementById">;
  fetch: (url: string, options: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<Record<string, unknown>> }>;
  confirm: (message: string) => boolean;
  setTimeout: (handler: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}): void;
