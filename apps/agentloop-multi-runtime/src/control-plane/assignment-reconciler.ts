/** Browser-independent projection upkeep; unrelated to Runtime execution/recovery scheduling. */
export function startAssignmentReconciler(router: { reconcileAssignments(): Promise<void> }, options: {
  intervalMs?: number;
  onError?: (error: unknown) => void;
} = {}): () => Promise<void> {
  let stopped = false;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    pending = router.reconcileAssignments().catch((error) => { options.onError?.(error); }).finally(() => {
      if (!stopped) { timer = setTimeout(tick, options.intervalMs ?? 5_000); timer.unref(); }
    });
  };
  tick();
  return async () => { stopped = true; clearTimeout(timer); await pending; };
}
