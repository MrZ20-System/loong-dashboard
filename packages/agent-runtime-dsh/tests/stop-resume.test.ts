import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, AgentSessionSpec } from "@loongboard/agent-runtime";

import { DSHRuntime } from "../src/index.js";
import {
  FakeNativeDshTransport,
  requestFor,
} from "./fake-native-transport.js";

function sessionSpec(overrides: Partial<AgentSessionSpec> = {}): AgentSessionSpec {
  return {
    sessionId: "s1",
    workspacePath: "/tmp/loongboard-work",
    dshHomePath: "/tmp/loongboard-dsh",
    provider: "deepseek",
    model: "deepseek-v4",
    ...overrides,
  };
}

function journalEvent(type: string, data: Record<string, unknown>, seq: number): unknown {
  return {
    type: "event",
    event: { type, seq, time: 1_700_000_000_000 + seq, data },
  };
}

function hostIdle(sessionId: string): unknown {
  return {
    type: "emit",
    event: "api-session/status",
    args: [sessionId, false],
  };
}

async function nextEvent(
  iterator: AsyncGenerator<AgentRuntimeEvent>,
): Promise<AgentRuntimeEvent> {
  const next = await iterator.next();
  expect(next.done).toBe(false);
  return next.value;
}

async function completeTurn(
  iterator: AsyncGenerator<AgentRuntimeEvent>,
  transport: FakeNativeDshTransport,
  sessionId: string,
  text: string,
): Promise<void> {
  const completion = iterator.next();
  transport.pushJournal(
    journalEvent(
      "assistant/message",
      { message: { content: [{ type: "text", text }] } },
      2,
    ),
  );
  transport.pushJournal(journalEvent("turn/end", {}, 3));
  transport.pushHost(hostIdle(sessionId));
  expect(await completion).toEqual({
    done: false,
    value: { type: "assistant.completed", markdown: text },
  });
  expect(await iterator.next()).toEqual({
    done: false,
    value: { type: "status", status: "idle" },
  });
  expect((await iterator.next()).done).toBe(true);
}

describe("DSHRuntime opaque session resume", () => {
  it("passes the persisted opaque id to a new native transport after process stop", async () => {
    const firstTransport = new FakeNativeDshTransport("opaque-session-1");
    const secondTransport = new FakeNativeDshTransport("opaque-session-1");
    const transports = [firstTransport, secondTransport];
    const runtime = new DSHRuntime({
      transportFactory: () => {
        const transport = transports.shift();
        if (transport === undefined) throw new Error("unexpected third transport");
        return transport;
      },
    });

    try {
      const first = runtime.run(sessionSpec(), "first");
      expect(await nextEvent(first)).toEqual({ type: "status", status: "starting" });
      expect(await nextEvent(first)).toEqual({ type: "status", status: "running" });
      await completeTurn(first, firstTransport, "opaque-session-1", "first answer");
      expect(runtime.runtimeSessionId("s1")).toBe("opaque-session-1");

      await runtime.stop("s1");
      expect(firstTransport.closed).toBe(true);
      expect(runtime.runtimeSessionId("s1")).toBeNull();

      const resumed = runtime.run(
        sessionSpec({ runtimeSessionId: "opaque-session-1" }),
        "resumed",
      );
      expect(await nextEvent(resumed)).toEqual({ type: "status", status: "starting" });
      expect(await nextEvent(resumed)).toEqual({ type: "status", status: "running" });
      expect(requestFor(secondTransport, "session/create")?.args).toEqual({
        request: { cwd: "/tmp/loongboard-work", sessionId: "opaque-session-1" },
      });
      await completeTurn(resumed, secondTransport, "opaque-session-1", "resumed answer");
    } finally {
      await runtime.close();
    }
  });

  it("closes pending follow streams when the runtime is stopped", async () => {
    const transport = new FakeNativeDshTransport("opaque-session-1");
    const runtime = new DSHRuntime({ transportFactory: () => transport });
    const iterator = runtime.run(sessionSpec(), "long turn");

    try {
      expect(await nextEvent(iterator)).toEqual({ type: "status", status: "starting" });
      expect(await nextEvent(iterator)).toEqual({ type: "status", status: "running" });

      const pending = iterator.next();
      await runtime.stop("s1");
      expect(transport.closed).toBe(true);
      const interrupted = await pending;
      expect(interrupted.done).toBe(false);
      expect(interrupted.value).toMatchObject({ type: "error" });
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
