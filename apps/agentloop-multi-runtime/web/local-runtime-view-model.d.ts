export interface LocalRuntimeViewModel {
  paired: boolean;
  runtimeReady: boolean;
  hasReadyRuntime: boolean;
  runtimePickerHidden: boolean;
  runtimeDisabled: boolean;
  directoryScopeDisabled: boolean;
  runtimeManagerHidden: boolean;
  uploadDisabled: boolean;
}

export function localRuntimeViewModel(input: {
  agentStatus: string;
  device?: unknown;
  localSessionToken?: string;
  runtimes?: Array<{ id: string; status: string }>;
  runtimeId?: string;
  localExecution: boolean;
}): LocalRuntimeViewModel;

export function localRuntimeOptions(values: unknown[], escapeHtml: (value: unknown) => string, runtimeStatusLabel: (status: string) => string): string;
export function localRuntimeListMarkup(values: unknown[], selectedRuntimeId: string, escapeHtml: (value: unknown) => string, runtimeStatusLabel: (status: string) => string): string;
