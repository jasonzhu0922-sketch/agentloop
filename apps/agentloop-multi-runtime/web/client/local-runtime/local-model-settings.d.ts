export function createLocalModelSettings(options: {
  getElement(id: string): HTMLElement;
  request(path: string, init?: RequestInit): Promise<Response>;
  onSaved(): Promise<void>;
  notify(message: string, kind: "success" | "error" | "warning"): void;
  confirm?(message: string): boolean;
}): { load(): Promise<void>; canClose(): boolean };
