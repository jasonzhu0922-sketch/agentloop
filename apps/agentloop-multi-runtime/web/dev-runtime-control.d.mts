export interface DevRuntimeControl {
  readonly handle: (request: any, response: any, path: string) => Promise<void>;
}

export function createDevRuntimeControl(options?: {
  readonly root?: string;
  readonly skillsRoot?: string;
  readonly token?: string;
  readonly configurationPath?: string;
  readonly mcpConfigurationPath?: string;
}): DevRuntimeControl;
