import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeEvent,
  AgentSessionSpec,
} from "@loongboard/agent-runtime";

import { DSHRuntime } from "../src/index.js";

type PendingRun = {
  prompt: string;
  resolve: (result: {
    sessionId: string;
    finalResponse: string;
    events: unknown[];
    notifications: unknown[];
  }) => void;
  reject: (error: Error) => void;
};

type FakeHarnessHandle = {
  sessionCalls: Array<string | undefined>;
  pendingRuns: PendingRun[];
  close: () => void;
};

const fakeSdk = vi.hoisted(() => {
  const harnesses: FakeHarnessHandle[] = [];
  return {
    harnesses,
    reset(): void {
      harnesses.length = 0;
    },
  };
});

vi.mock("@deepseek-ai/dsh-sdk-client", () => {
  return {
    DeepSeekHarness: class {
      readonly handle: FakeHarnessHandle;

      constructor() {
        this.handle = {
          sessionCalls: [],
          pendingRuns: [],
          close: () => {
            for (const pending of this.handle.pendingRuns.splice(0)) {
              pending.reject(new Error("runtime process closed"));
            }
          },
        };
        fakeSdk.harnesses.push(this.handle);
      }

      session(sessionId?: string): {
        run: (
          prompt: string,
        ) => Promise<{
          sessionId: string;
          finalResponse: string;
          events: unknown[];
          notifications: unknown[];
        }>;
      } {
        this.handle.sessionCalls.push(sessionId);
        return {
          run: (prompt: string) =>
            new Promise((resolve, reject) => {
              this.handle.pendingRuns.push({
                prompt,
                resolve: resolve as PendingRun["resolve"],
                reject: reject as PendingRun["reject"],
              });
            }),
        };
      }

      close(): Promise<void> {
        this.handle.close();
        return Promise.resolve();
      }
    },
  };
});

function sessionSpec(): AgentSessionSpec {
  return {
    sessionId: "s1",
    workspacePath: "/tmp/loongboard-work",
    dshHomePath: "/tmp/loongboard-dsh",
    provider: "deepseek",
    model: "deepseek-v4",
  };
}

async function nextEvent(
  iterator: AsyncGenerator<AgentRuntimeEvent>,
): Promise<AgentRuntimeEvent> {
  const next = await iterator.next();
  expect(next.done).toBe(false);
  return next.value;
}

describe("DSHRuntime stop/resume", () => {
  beforeEach(() => {
    fakeSdk.reset();
  });

  it("mints a fresh runtime session after stop instead of reusing the stopped session id", async () => {
    const runtime = new DSHRuntime();

    // First completed turn records runtime session "rt-1" in the runtime map
    // the same way a controller would persist it in the database.
    const first = (async function* () {
      yield* runtime.run(sessionSpec(), "first");
    })();
    expect(await nextEvent(first)).toEqual({
      type: "status",
      status: "starting",
    });
    expect(await nextEvent(first)).toEqual({
      type: "status",
      status: "running",
    });
    const firstDrain = first.next();
    expect(fakeSdk.harnesses).toHaveLength(1);
    expect(fakeSdk.harnesses[0]?.sessionCalls).toEqual([undefined]);
    const firstRun = fakeSdk.harnesses[0]?.pendingRuns[0];
    expect(firstRun).toBeDefined();
    firstRun?.resolve({
      sessionId: "rt-1",
      finalResponse: "first answer",
      events: [],
      notifications: [],
    });
    expect(await firstDrain).toEqual({
      done: false,
      value: { type: "assistant.completed", markdown: "first answer" },
    });
    expect(await first.next()).toEqual({
      done: false,
      value: { type: "status", status: "idle" },
    });
    expect((await first.next()).done).toBe(true);
    expect(runtime.runtimeSessionId("s1")).toBe("rt-1");

    // Second turn is cancelled mid-flight: closing the harness must also
    // forget the interrupted runtime session id so the next turn cannot
    // hand a dead/stale DSH session id to a fresh process.
    const secondSpec: AgentSessionSpec = {
      ...sessionSpec(),
      runtimeSessionId: "rt-1",
    };
    const second = (async function* () {
      yield* runtime.run(secondSpec, "long turn");
    })();
    expect(await nextEvent(second)).toEqual({
      type: "status",
      status: "starting",
    });
    expect(await nextEvent(second)).toEqual({
      type: "status",
      status: "running",
    });
    const secondDrain = second.next();
    const stoppedHarness = fakeSdk.harnesses[0];
    expect(stoppedHarness?.sessionCalls).toEqual([undefined, "rt-1"]);
    expect(stoppedHarness?.pendingRuns.at(-1)?.prompt).toBe("long turn");
    await runtime.stop("s1");
    expect(await secondDrain).toEqual({
      done: false,
      value: { type: "error", message: "runtime process closed" },
    });
    expect(await second.next()).toEqual({
      done: false,
      value: { type: "status", status: "idle" },
    });
    expect((await second.next()).done).toBe(true);

    // A later turn has no persisted runtime session id (the controller clears
    // it on interruption). It must start a fresh DSH session, never the
    // stopped "rt-1" still cached by this runtime instance.
    const resumed = (async function* () {
      yield* runtime.run(sessionSpec(), "resumed");
    })();
    expect(await nextEvent(resumed)).toEqual({
      type: "status",
      status: "starting",
    });
    expect(await nextEvent(resumed)).toEqual({
      type: "status",
      status: "running",
    });
    const resumedDrain = resumed.next();
    expect(fakeSdk.harnesses).toHaveLength(2);
    expect(fakeSdk.harnesses[1]?.sessionCalls).toEqual([undefined]);
    const resumedRun = fakeSdk.harnesses[1]?.pendingRuns[0];
    expect(resumedRun).toBeDefined();
    resumedRun?.resolve({
      sessionId: "rt-2",
      finalResponse: "resumed answer",
      events: [],
      notifications: [],
    });
    expect(await resumedDrain).toEqual({
      done: false,
      value: { type: "assistant.completed", markdown: "resumed answer" },
    });
    expect(await resumed.next()).toEqual({
      done: false,
      value: { type: "status", status: "idle" },
    });
    expect((await resumed.next()).done).toBe(true);
    expect(runtime.runtimeSessionId("s1")).toBe("rt-2");
  });
});
