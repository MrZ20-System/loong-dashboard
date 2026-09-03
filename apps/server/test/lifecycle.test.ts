import { describe, expect, it } from "vitest";

import { installSignalHandlers, type SignalLifecycle } from "../src/lifecycle.js";

describe("server signal lifecycle", () => {
  it("closes once when SIGINT and SIGTERM arrive together", async () => {
    const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
    const processLike: SignalLifecycle = {
      exitCode: 0,
      once(signal, listener) {
        listeners.set(signal, listener);
      },
    };
    let closeCalls = 0;
    let release!: () => void;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });

    const shutdown = installSignalHandlers(
      async () => {
        closeCalls += 1;
        await closing;
      },
      processLike,
    );

    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();
    await Promise.resolve();
    expect(closeCalls).toBe(1);

    release();
    await Promise.all([shutdown(), shutdown()]);
    expect(closeCalls).toBe(1);
    expect(processLike.exitCode).toBe(0);
  });
});
