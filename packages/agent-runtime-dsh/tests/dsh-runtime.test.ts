import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeEvent,
  AgentSessionSpec,
} from "@loongboard/agent-runtime";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

import { DSHRuntime } from "../src/index.js";

type PendingRun = {
  prompt: string;
  onNotification:
    | ((notification: HarnessNotification) => void)
    | undefined;
  resolve: (result: {
    sessionId: string;
    finalResponse: string;
    events: unknown[];
    notifications: unknown[];
  }) => void;
  reject: (error: Error) => void;
};

const fakeSdk = vi.hoisted(() => {
  const pendingRuns: PendingRun[] = [];
  return {
    pendingRuns,
    reset(): void {
      pendingRuns.length = 0;
    },
  };
});

vi.mock("@deepseek-ai/dsh-sdk-client", () => {
  return {
    DeepSeekHarness: class {
      constructor(_options?: unknown) {}

      session(): {
        run: (
          prompt: string,
          options?: {
            onNotification?: (notification: HarnessNotification) => void;
          },
        ) => Promise<unknown>;
      } {
        return {
          run: (prompt, options) =>
            new Promise((resolve, reject) => {
              fakeSdk.pendingRuns.push({
                prompt,
                onNotification: options?.onNotification,
                resolve: resolve as PendingRun["resolve"],
                reject: reject as PendingRun["reject"],
              });
            }),
        };
      }

      close(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

function spec(): AgentSessionSpec {
  return {
    sessionId: "s1",
    workspacePath: "/tmp/loongboard-work",
    dshHomePath: "/tmp/loongboard-dsh",
    provider: "deepseek",
    model: "deepseek-v4",
  };
}

function textDelta(text: string): HarnessNotification {
  return {
    method: "session.event",
    params: {
      sessionId: "s1",
      event: {
        type: "assistant/chunk",
        seq: 1,
        time: 1_700_000_000_000,
        data: {
          turn: 1,
          step: 0,
          chunk: { type: "text-delta", index: 0, text },
        },
      },
    },
  };
}

async function nextEvent(
  iterator: AsyncGenerator<AgentRuntimeEvent>,
): Promise<AgentRuntimeEvent> {
  const next = await iterator.next();
  expect(next.done).toBe(false);
  return next.value;
}

/** Expose next() for manual stepping of the AsyncIterable runtime contract. */
function stepped(
  iterable: AsyncIterable<AgentRuntimeEvent>,
): AsyncGenerator<AgentRuntimeEvent> {
  return (async function* () {
    yield* iterable;
  })();
}

describe("DSHRuntime NotificationChannel behavior", () => {
  beforeEach(() => {
    fakeSdk.reset();
  });

  it("streams pushed notifications then the final response, and ends idle", async () => {
    const runtime = new DSHRuntime();
    const iterator = stepped(runtime.run(spec(), "hello"));
    try {
      expect(await nextEvent(iterator)).toEqual({
        type: "status",
        status: "starting",
      });
      expect(await nextEvent(iterator)).toEqual({
        type: "status",
        status: "running",
      });

      // Third step starts the drain loop and parks on take(); a notification
      // arriving then must wake the pending waiter.
      const waitingTake = iterator.next();
      expect(fakeSdk.pendingRuns).toHaveLength(1);
      const pending = fakeSdk.pendingRuns[0];
      expect(pending.prompt).toBe("hello");
      pending.onNotification?.(textDelta("hello "));
      expect(await waitingTake).toEqual({
        done: false,
        value: { type: "assistant.delta", text: "hello " },
      });

      // A notification pushed while the generator is yielding is queued and
      // served by the next take().
      pending.onNotification?.(textDelta("world"));
      expect(await iterator.next()).toEqual({
        done: false,
        value: { type: "assistant.delta", text: "world" },
      });

      pending.resolve({
        sessionId: "rt-1",
        finalResponse: "final answer",
        events: [],
        notifications: [],
      });
      expect(await iterator.next()).toEqual({
        done: false,
        value: {
          type: "assistant.completed",
          markdown: "final answer",
        },
      });
      // After close, a straggler notification must be ignored, not emitted.
      pending.onNotification?.(textDelta("too late"));
      expect(await iterator.next()).toEqual({
        done: false,
        value: { type: "status", status: "idle" },
      });
      expect((await iterator.next()).done).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("ends with error and idle when the run rejects without notifications", async () => {
    const runtime = new DSHRuntime();
    const iterator = stepped(runtime.run(spec(), "hello"));
    try {
      expect(await nextEvent(iterator)).toEqual({
        type: "status",
        status: "starting",
      });
      expect(await nextEvent(iterator)).toEqual({
        type: "status",
        status: "running",
      });

      // Park on take() with the channel open, then reject with no
      // notifications: close() must wake the waiter with undefined so the
      // iterator terminates instead of hanging.
      const errorNext = iterator.next();
      expect(fakeSdk.pendingRuns).toHaveLength(1);
      const pending = fakeSdk.pendingRuns[0];
      pending.reject(new Error("transport lost"));

      expect(await errorNext).toEqual({
        done: false,
        value: { type: "error", message: "transport lost" },
      });
      expect(await iterator.next()).toEqual({
        done: false,
        value: { type: "status", status: "idle" },
      });
      expect((await iterator.next()).done).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
