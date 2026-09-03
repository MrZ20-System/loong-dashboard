import { describe, expect, it } from "vitest";
import { mapNotification } from "../src/notification-mapper.js";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

/**
 * Recorded-fixture tests for the shape-driven notification mapping. The
 * pinned pre-release SDK does not enumerate notification method names, so
 * these fixtures are the recorded contract; live recordings captured during
 * the Stage 7 smoke extend this file only.
 */
describe("mapNotification", () => {
  it("maps a text delta", () => {
    const notification: HarnessNotification = {
      method: "agent.text.delta",
      params: { text: "hello " },
    };
    expect(mapNotification(notification)).toEqual([
      { type: "assistant.delta", text: "hello " },
    ]);
  });

  it("maps string and block content forms", () => {
    const block: HarnessNotification = {
      method: "session.event",
      params: { content: [{ text: "line one" }, { text: "line two" }] },
    };
    expect(mapNotification(block)).toEqual([
      { type: "assistant.delta", text: "line one\nline two" },
    ]);
    const direct: HarnessNotification = {
      method: "agent.message",
      params: { content: "direct" },
    };
    expect(mapNotification(direct)).toEqual([
      { type: "assistant.delta", text: "direct" },
    ]);
  });

  it("maps tool start and completion events", () => {
    const started: HarnessNotification = {
      method: "tool.call.started",
      params: { callId: "call_1", toolName: "bash", summary: "ls" },
    };
    expect(mapNotification(started)).toEqual([
      { type: "tool.started", callId: "call_1", name: "bash", summary: "ls" },
    ]);
    const completed: HarnessNotification = {
      method: "tool.call.completed",
      params: { callId: "call_1", toolName: "bash", isError: true },
    };
    expect(mapNotification(completed)).toEqual([
      { type: "tool.completed", callId: "call_1", name: "bash", isError: true },
    ]);
  });

  it("returns no events for unrelated notifications", () => {
    expect(mapNotification({ method: "session.idle", params: {} })).toEqual([]);
    expect(mapNotification({ method: "session.idle", params: { state: "idle" } })).toEqual([]);
  });

  it("maps nested session.event payloads (the wire shape the SDK emits)", () => {
    const chunk: HarnessNotification = {
      method: "session.event",
      params: {
        sessionId: "s1",
        event: { type: "assistant/chunk", turn: 1, step: 0, chunk: { text: "hello" } },
      },
    };
    expect(mapNotification(chunk)).toEqual([
      { type: "assistant.delta", text: "hello" },
    ]);

    const call: HarnessNotification = {
      method: "session.event",
      params: {
        event: { type: "tool/call", turn: 1, step: 0, callId: "call_9", name: "bash", arguments: "ls" },
      },
    };
    expect(mapNotification(call)).toEqual([
      { type: "tool.started", callId: "call_9", name: "bash", summary: "ls" },
    ]);

    const result: HarnessNotification = {
      method: "session.event",
      params: {
        event: { type: "tool/result", turn: 1, step: 0, callId: "call_9", error: { name: "E", code: "1" } },
      },
    };
    expect(mapNotification(result)).toEqual([
      { type: "tool.completed", callId: "call_9", name: "tool", isError: true },
    ]);
  });

  it("ignores session.status echoes (supervisor owns lifecycle)", () => {
    expect(
      mapNotification({ method: "session.status", params: { sessionId: "s1", status: "idle" } }),
    ).toEqual([]);
  });
});
