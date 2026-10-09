/** Coalesces high-frequency transport events into browser-friendly UI work. */
export function createCoalescedUpdater({ render, persist, requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, setTimer = setTimeout, clearTimer = clearTimeout, persistDelayMs = 250 }) {
  let frameId;
  let persistenceTimer;

  function request() {
    if (frameId === undefined) {
      frameId = requestFrame(() => {
        frameId = undefined;
        render();
      });
    }
    if (persistenceTimer === undefined) {
      persistenceTimer = setTimer(() => {
        persistenceTimer = undefined;
        persist();
      }, persistDelayMs);
    }
  }

  function flush() {
    if (frameId !== undefined) {
      cancelFrame(frameId);
      frameId = undefined;
    }
    if (persistenceTimer !== undefined) {
      clearTimer(persistenceTimer);
      persistenceTimer = undefined;
    }
    persist();
    render();
  }

  return { request, flush };
}
