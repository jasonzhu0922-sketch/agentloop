import type { ControlPlaneErrorCode } from "../contracts/index.ts";

export class ControlPlaneError extends Error {
  public readonly code: ControlPlaneErrorCode;

  public constructor(code: ControlPlaneErrorCode, message: string) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
  }
}
