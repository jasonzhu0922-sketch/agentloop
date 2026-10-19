export interface ModelOption {
  key?: string;
  displayName?: string;
}

export declare function modelSelectionStatus(models: ModelOption[] | undefined, selectedKey: string): string;
