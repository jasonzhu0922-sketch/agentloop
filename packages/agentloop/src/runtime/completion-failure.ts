import { AppError } from "../shared/errors.ts";

/** A reporting opportunity, not a terminal decision. The Run owner decides
 * whether to repair/revise first or to materialize this report before failing. */
export class CompletionFailure extends AppError {
  private readonly createReport: () => Promise<string>;
  private reportPromise?: Promise<string>;

  constructor(error: AppError, createReport: () => Promise<string>) {
    super(error.code, error.message, error.status, error.details);
    this.createReport = createReport;
  }

  report(): Promise<string> {
    return this.reportPromise ??= this.createReport();
  }
}

export async function partialOutputForFailure(error: AppError): Promise<string | undefined> {
  if (error instanceof CompletionFailure) return error.report();
  return typeof error.details?.partialOutput === "string" ? error.details.partialOutput : undefined;
}
