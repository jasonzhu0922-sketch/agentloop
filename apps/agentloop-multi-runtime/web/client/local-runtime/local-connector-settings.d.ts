export interface LocalConnectorSettingsOptions {
  readonly getElement: (id: string) => HTMLElement;
  readonly getRuntimeId: () => string;
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  readonly onSaved?: () => Promise<void>;
  readonly notify: (message: string, tone?: string) => void;
}

export interface LocalConnectorSettingsController {
  load(): Promise<void>;
  canClose(): boolean;
}

export function createLocalConnectorSettings(options: LocalConnectorSettingsOptions): LocalConnectorSettingsController;
