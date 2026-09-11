export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CANCELLED"
  | "RUN_LIMIT_EXCEEDED"
  | "PLANNING_ERROR"
  | "PLAN_NOT_ADMITTED"
  | "STEP_NOT_COMPLETED"
  | "HUMAN_LOOP_REQUIRED"
  | "HUMAN_LOOP_INVALID"
  | "ASSESSMENT_ERROR"
  | "SKILL_PACKAGE_INVALID"
  | "SKILL_PACKAGE_MUTATED"
  | "TOOL_POLICY_DENIED"
  | "TOOL_EXECUTION_ERROR"
  | "MODEL_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: Readonly<Record<string, unknown>>): AppError {
  return new AppError("BAD_REQUEST", message, 400, details);
}

export function unauthenticated(message = "Authentication required"): AppError {
  return new AppError("UNAUTHENTICATED", message, 401);
}

export function forbidden(message = "Operation is not allowed"): AppError {
  return new AppError("FORBIDDEN", message, 403);
}

export function notFound(resource: string): AppError {
  return new AppError("NOT_FOUND", `${resource} not found`, 404);
}

export function conflict(message: string): AppError {
  return new AppError("CONFLICT", message, 409);
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL_ERROR", "Internal server error", 500);
}
