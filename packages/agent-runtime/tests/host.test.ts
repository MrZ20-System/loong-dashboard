import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeHost,
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentSessionSpec,
} from "../src/index.js";

const spec = (sessionId: string): AgentSessionSpec => ({
  sessionId,
  workspacePath: "/work/a",
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  reasoningEffort: "high",
  dshHomePath: "/home/" + sessionId,
});

function recordedRuntime(events: AgentRuntimeEvent[] = []): AgentRuntime & {
  stopMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
  stopCalls: number;
} {
  const stopMock = vi.fn(async () => undefined);
  const closeMock = vi.fn(async () => undefined);
  let stopCalls = 0;
  return {
    async *run(inputSpec: AgentSessionSpec, prompt: string): AsyncIterable<AgentRuntimeEvent> {
      void inputSpec;
      void prompt;
      for (const event of events) yield event;
    },
    stop: async () => {
      stopCalls += 1;
      return stopMock();
    },
    close: closeMock,
    stopMock,
    closeMock,
    get stopCalls() {
      return stopCalls;
    },
  } as unknown as AgentRuntime & {
    stopMock: ReturnType<typeof vi.fn>;
    closeMock: ReturnType<typeof vi.fn>;
    stopCalls: number;
  };
}

describe("AgentRuntimeHost", () => {
  it("creates one runtime per session and reuses it", async () => {
    const factory = vi.fn((sessionSpec: AgentSessionSpec) => recordedRuntime());
    const host = new AgentRuntimeHost(factory);
    const first = host.ensure(spec("s1"));
    const second = host.ensure(spec("s1"));
    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
    host.ensure(spec("s2"));
    expect(factory).toHaveBeenCalledTimes(2);
    await host.close();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("stops an idle runtime process after the configured idle window", async () => {
    const created = recordedRuntime();
    const factory = vi.fn(() => created);
    const host = new AgentRuntimeHost(factory, 20);
    host.ensure(spec("s1"));
    host.beginRun("s1");
    host.endRun("s1");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(created.stopCalls).toBe(1);
    expect(created.closeMock).not.toHaveBeenCalled();
    await host.close();
  });

  it("stops a running session without closing it permanently", async () => {
    const created = recordedRuntime();
    const host = new AgentRuntimeHost(() => created, 0);
    host.ensure(spec("s1"));
    host.beginRun("s1");
    await host.stop("s1");
    expect(created.stopCalls).toBe(1);
    expect(created.closeMock).not.toHaveBeenCalled();
    // A later run on the same session reuses the runtime (process restart is
    // the runtime's own concern); the host stays session-stable.
    expect(host.ensure(spec("s1"))).toBe(created);
    await host.close();
  });

  it("stops every runtime on close and clears active state", async () => {
    const a = recordedRuntime();
    const b = recordedRuntime();
    const host = new AgentRuntimeHost((sessionSpec) => sessionSpec.sessionId === "a" ? a : b);
    host.ensure(spec("a"));
    host.ensure(spec("b"));
    host.beginRun("a");
    expect(host.activeCount()).toBe(1);
    await host.close();
    expect(a.closeMock).toHaveBeenCalled();
    expect(b.closeMock).toHaveBeenCalled();
    expect(host.activeCount()).toBe(0);
  });

  it("updates idle retention without arming a timer for an active turn", async () => {
    const created = recordedRuntime();
    const host = new AgentRuntimeHost(() => created, 60_000);
    host.ensure(spec("s1"));
    host.beginRun("s1");
    host.updateIdleCloseMs(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created.stopCalls).toBe(0);

    host.endRun("s1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created.stopCalls).toBe(1);
    await host.close();
  });
});
