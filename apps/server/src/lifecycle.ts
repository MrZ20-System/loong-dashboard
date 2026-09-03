/** Minimal process surface used by the signal lifecycle helper and its tests. */
export interface SignalLifecycle {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exitCode?: NodeJS.Process["exitCode"];
}

export type ShutdownHandler = () => Promise<void>;

/**
 * Return an idempotent shutdown operation. Concurrent signals share the same
 * close promise, so the application close hook can only run once.
 */
export function createShutdownHandler(close: () => Promise<void>): ShutdownHandler {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= Promise.resolve().then(close);
    return closePromise;
  };
}

/** Register the two supported termination signals against one shutdown. */
export function installSignalHandlers(
  close: () => Promise<void>,
  processLike: SignalLifecycle = process,
): ShutdownHandler {
  const shutdown = createShutdownHandler(close);
  const onSignal = (): void => {
    void shutdown().catch((error: unknown) => {
      processLike.exitCode = 1;
      console.error("Failed to close server", error);
    });
  };
  processLike.once("SIGINT", onSignal);
  processLike.once("SIGTERM", onSignal);
  return shutdown;
}
