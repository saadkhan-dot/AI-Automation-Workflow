const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export function startExecutionPolling({ executionId, fetchStatus, onUpdate, onError, intervalMs = 1000, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false;
  let timer = null;

  const poll = async () => {
    try {
      const execution = await fetchStatus(executionId);
      if (stopped) return;
      onUpdate(execution);
      if (TERMINAL_STATUSES.has(execution.status)) return;
    } catch (error) {
      if (!stopped) onError(error);
    }
    if (!stopped) timer = schedule(poll, intervalMs);
  };

  void poll();
  return () => {
    stopped = true;
    if (timer !== null) cancel(timer);
  };
}
