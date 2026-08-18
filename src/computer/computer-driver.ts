export interface ComputerPoint {
  readonly x: number;
  readonly y: number;
}

export interface ComputerSnapshot {
  readonly mimeType: "image/png" | "image/jpeg";
  readonly dataBase64: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Plugin boundary for real desktop/browser control. The core runtime never
 * pretends shell scripts are a portable GUI driver: a deployment must provide
 * an OS/browser-specific implementation and grant its tools explicitly.
 */
export interface ComputerDriver {
  snapshot(signal?: AbortSignal): Promise<ComputerSnapshot>;
  click(point: ComputerPoint, signal?: AbortSignal): Promise<void>;
  typeText(text: string, signal?: AbortSignal): Promise<void>;
  pressKey(key: string, signal?: AbortSignal): Promise<void>;
  navigate(url: string, signal?: AbortSignal): Promise<void>;
}
