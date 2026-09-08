import { describe, expect, it } from "vitest";
import { DshNotificationMapper } from "../src/notification-mapper.js";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

/**
 * Contract tests for the pinned SDK's real `session.event` wire shape:
 * params.event carries { type, seq, time, data } and the V1 event data is
 * nested under `data` (dsh-session SessionEventMap).
 */
function sessionEvent(
  type: string,
  data: Record<string, unknown>,
): HarnessNotification {
  return {
    method: "session.event",
    params: {
      sessionId: "s1",
      event: { type, seq: 1, time: 1_700_000_000_000, data },
    },
  };
}

function toolResultMessage(
  callId: string,
  isError?: boolean,
): Record<string, unknown> {
  return {
    id: "m1",
    role: "user",
    content: [
      {
        type: "tool-result",
        toolCallId: callId,
        content: [{ type: "text", text: "done" }],
        ...(isError === undefined ? {} : { isError }),
      },
    ],
    source: { kind: "tool", callId },
  };
}

describe("DshNotificationMapper", () => {
  it("maps only text-delta assistant chunks", () => {
    const mapper = new DshNotificationMapper();
    expect(
      mapper.map(
        sessionEvent("assistant/chunk", {
          turn: 1,
          step: 0,
          chunk: { type: "text-delta", index: 0, text: "hello " },
        }),
      ),
    ).toEqual([{ type: "assistant.delta", text: "hello " }]);
  });

  it("ignores every non-text-delta chunk type", () => {
    const mapper = new DshNotificationMapper();
    const chunks = [
      { type: "reasoning-delta", index: 0, text: "thinking" },
      { type: "tool-call-delta", index: 0, id: "call_1", name: "bash", argumentsDelta: "ls" },
      { type: "block-start", index: 0, blockType: "text" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "finish", reason: "stop" },
    ];
    for (const chunk of chunks) {
      expect(
        mapper.map(sessionEvent("assistant/chunk", { turn: 1, step: 0, chunk })),
      ).toEqual([]);
    }
    expect(
      mapper.map(
        sessionEvent("assistant/chunk", {
          turn: 1,
          step: 0,
          chunk: { type: "text-delta", index: 0, text: "" },
        }),
      ),
    ).toEqual([]);
  });

  it("emits nothing for assistant/message", () => {
    const mapper = new DshNotificationMapper();
    expect(
      mapper.map(
        sessionEvent("assistant/message", {
          turn: 1,
          step: 0,
          message: {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "final" }],
            source: { kind: "model", provider: "deepseek", model: "x" },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("maps tool/call to tool.started with the raw arguments as summary", () => {
    const mapper = new DshNotificationMapper();
    expect(
      mapper.map(
        sessionEvent("tool/call", {
          turn: 1,
          step: 0,
          callId: "call_1",
          name: "bash",
          arguments: "ls -la",
        }),
      ),
    ).toEqual([
      { type: "tool.started", callId: "call_1", name: "bash", summary: "ls -la" },
    ]);
  });

  it("recovers the tool name for tool/result from the run's tool/call", () => {
    const mapper = new DshNotificationMapper();
    mapper.map(
      sessionEvent("tool/call", {
        turn: 1,
        step: 0,
        callId: "call_1",
        name: "bash",
        arguments: "ls",
      }),
    );
    expect(
      mapper.map(
        sessionEvent("tool/result", {
          turn: 1,
          step: 0,
          message: toolResultMessage("call_1"),
        }),
      ),
    ).toEqual([
      { type: "tool.completed", callId: "call_1", name: "bash", isError: false },
    ]);
  });

  it("flags tool errors from event.error or the tool-result block", () => {
    const fromEventError = new DshNotificationMapper();
    fromEventError.map(
      sessionEvent("tool/call", {
        callId: "call_1",
        name: "bash",
        arguments: "ls",
      }),
    );
    expect(
      fromEventError.map(
        sessionEvent("tool/result", {
          message: toolResultMessage("call_1"),
          error: { name: "E", code: "1" },
        }),
      ),
    ).toEqual([
      { type: "tool.completed", callId: "call_1", name: "bash", isError: true },
    ]);

    const fromBlock = new DshNotificationMapper();
    fromBlock.map(
      sessionEvent("tool/call", {
        callId: "call_2",
        name: "bash",
        arguments: "ls",
      }),
    );
    expect(
      fromBlock.map(
        sessionEvent("tool/result", {
          message: toolResultMessage("call_2", true),
        }),
      ),
    ).toEqual([
      { type: "tool.completed", callId: "call_2", name: "bash", isError: true },
    ]);
  });

  it("keeps tool names per mapper instance (one instance per run)", () => {
    const firstRun = new DshNotificationMapper();
    firstRun.map(
      sessionEvent("tool/call", {
        callId: "call_1",
        name: "bash",
        arguments: "ls",
      }),
    );
    const secondRun = new DshNotificationMapper();
    expect(
      secondRun.map(
        sessionEvent("tool/result", {
          message: toolResultMessage("call_1"),
        }),
      ),
    ).toEqual([
      { type: "tool.completed", callId: "call_1", name: "tool", isError: false },
    ]);
  });

  it("ignores non-session.event methods and unknown event types", () => {
    const mapper = new DshNotificationMapper();
    expect(
      mapper.map({
        method: "agent.text.delta",
        params: { text: "guess" },
      }),
    ).toEqual([]);
    expect(
      mapper.map({
        method: "session.status",
        params: { status: "idle" },
      }),
    ).toEqual([]);
    expect(mapper.map(sessionEvent("turn/start", { turn: 1 }))).toEqual([]);
    expect(
      mapper.map(sessionEvent("assistant/chunk", { chunk: "not-an-object" })),
    ).toEqual([]);
    expect(
      mapper.map({
        method: "session.event",
        params: { event: { type: "assistant/chunk" } },
      }),
    ).toEqual([]);
  });
});
