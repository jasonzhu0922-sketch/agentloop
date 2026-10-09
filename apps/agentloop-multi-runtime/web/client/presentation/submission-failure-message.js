/** Translate stable API failure codes at the browser boundary without exposing internal routing details. */
export function submissionFailureMessage(error) {
  if (error?.code === "runtime_capacity_exhausted" || error?.message === "runtime_capacity_exhausted") {
    return "当前本机 Runtime 任务过多，请稍候再试";
  }
  return `提交失败：${error instanceof Error ? error.message : String(error)}`;
}
