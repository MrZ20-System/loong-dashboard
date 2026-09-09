import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, AgentSessionSpec } from "@loongboard/agent-runtime";

import { DSHRuntime } from "../src/index.js";
import {
  allRequestsFor,
  FakeNativeDshTransport,
  requestFor,
} from "./fake-native-transport.js";

function spec(overrides: Partial<AgentSessionSpec> = {}): AgentSessionSpec {
  return {
    sessionId: "s1",
    workspacePath: "/tmp/loongboard-work",
    dshHomePath: "/tmp/loongboard-dsh",
    provider: "deepseek",
    model: "deepseek-v4",
    ...overrides,
  };
}

function journalEvent(
  type: string,
  data: Record<string, unknown> = {},
  seq = 1,
): unknown {
  return {
    type: "event",
    event: { type, seq, time: 1_700_000_000_000 + seq, data },
  };
}

function hostStatus(sessionId: string, idle: boolean): unknown {
  return {
    type: "emit",
    event: "api-session/status",
    args: [sessionId, idle ? false : true],
  };
}

async function nextEvent(
  iterator: AsyncGenerator<AgentRuntimeEvent>,
): Promise<AgentRuntimeEvent> {
  const next = await iterator.next();
  expect(next.done).toBe(false);
  return next.value;
}

describe("DSHRuntime native transport lifecycle", () => {
  it("emits live deltas before completion and waits for the durable final event after idle", async () => {
    const transport = new FakeNativeDshTransport("runtime-session-1");
    const runtime = new DSHRuntime({ transportFactory: () => transport });
    const iterator = runtime.run(spec(), "hello");

    try {
      expect(await nextEvent(iterator)).toEqual({
        type: "status",
        status: "starting",
      });
      expect(await nextEvent(iterator)).toEqual({
        type: "status",
        status: "running",
      });
      // The turn remains live: a delta must be observable while no final
      // assistant message or turn/end event has arrived yet.
      const delta = iterator.next();
      transport.pushJournal(
        journalEvent("assistant/chunk", {
          chunk: { type: "text-delta", index: 0, text: "hello " },
        }),
      );
      expect(await delta).toEqual({
        done: false,
        value: { type: "assistant.delta", text: "hello " },
      });
      expect(requestFor(transport, "session/prompt")?.args).toMatchObject({
        request: {
          sessionId: "runtime-session-1",
          content: [{ type: "text", text: "hello" }],
        },
      });

      // DSH's host can report idle before the journal flushes its final
      // message. The runtime must keep waiting for that durable event.
      const completed = iterator.next();
      transport.pushHost(hostStatus("runtime-session-1", true));
      transport.pushJournal(
        journalEvent("assistant/message", {
          message: {
            content: [{ type: "text", text: "final answer" }],
          },
        }, 2),
      );
      transport.pushJournal(journalEvent("turn/end", {}, 3));
      expect(await completed).toEqual({
        done: false,
        value: { type: "assistant.completed", markdown: "final answer" },
      });
      expect(await iterator.next()).toEqual({
        done: false,
        value: { type: "status", status: "idle" },
      });
      expect((await iterator.next()).done).toBe(true);

      const promptRequests = allRequestsFor(transport, "session/prompt");
      expect(promptRequests).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("discovers models with provider-scoped reasoning and native commands", async () => {
    const transport = new FakeNativeDshTransport(
      "capability-session",
      {
        groups: [
          {
            id: "deepseek",
            name: "DeepSeek",
            models: [
              {
                id: "deepseek-v4",
                name: "DeepSeek V4",
                reasoning: {
                  efforts: [{ id: "off" }, { id: "high" }],
                },
              },
            ],
          },
          {
            id: "openai-compatible",
            name: "OpenAI Compatible",
            models: [
              {
                id: "gateway-1",
                name: "Gateway 1",
                reasoning: { efforts: [{ id: "low" }, { id: "max" }] },
              },
            ],
          },
        ],
      },
      [
        { name: "git/status", description: "Inspect repository status" },
        { name: "shell", description: "Run a shell command" },
      ],
      [
        {
          provider: "deepseek",
          displayName: "DeepSeek",
          settingsNs: "llm-deepseek",
          settingsPath: ["providers", "deepseek"],
        },
        {
          provider: "openai-compatible",
          displayName: "OpenAI Compatible",
          settingsNs: "llm-pi-ai",
          settingsPath: ["providers", "gateway-1"],
        },
      ],
    );
    const runtime = new DSHRuntime({ transportFactory: () => transport });

    try {
      await expect(runtime.discoverCapabilities(spec())).resolves.toEqual({
        runtimeKind: "dsh",
        version: "dsh-v0.1.2-alpha.5",
        profile: "web",
        connected: true,
        models: [
          {
            id: "deepseek-v4",
            label: "DeepSeek V4",
            provider: "deepseek",
            reasoningEfforts: ["off", "high"],
          },
          {
            id: "gateway-1",
            label: "Gateway 1",
            provider: "openai-compatible",
            reasoningEfforts: ["low", "max"],
          },
        ],
        providers: [
          { id: "deepseek", label: "DeepSeek" },
          { id: "openai-compatible", label: "OpenAI Compatible" },
        ],
        reasoning: ["off", "high", "low", "max"],
        commands: [
          { id: "git/status", description: "Inspect repository status" },
          { id: "shell", description: "Run a shell command" },
        ],
        features: [
          "session.prompt",
          "session.follow",
          "session.selectModel",
          "commands.execute",
        ],
        discovery: "runtime",
        discoveredAt: expect.any(String),
      });
      expect(requestFor(transport, "session/modelCatalog")).toBeDefined();
      expect(requestFor(transport, "commands/list")?.args).toEqual({
        agentId: "capability-session",
      });
    } finally {
      await runtime.close();
    }
  });

  it("surfaces native approval requests and sends only an explicit response", async () => {
    const transport = new FakeNativeDshTransport("approval-session");
    const runtime = new DSHRuntime({ transportFactory: () => transport });
    const iterator = runtime.run(spec(), "run the command");

    try {
      expect(await nextEvent(iterator)).toEqual({ type: "status", status: "starting" });
      expect(await nextEvent(iterator)).toEqual({ type: "status", status: "running" });

      const requested = iterator.next();
      transport.pushHost({ type: "ready", clientId: "client-1" });
      transport.pushHost({
        type: "waterfall",
        eventId: "approval-1",
        event: "approval/request",
        agentId: "approval-session",
        request: { toolName: "shell", reason: "The command changes files." },
      });
      expect(await requested).toEqual({
        done: false,
        value: {
          type: "interaction.requested",
          requestId: "approval-1",
          kind: "approval",
          title: "Allow shell?",
          description: "The command changes files.",
          options: [
            { id: "rejected", label: "Reject" },
            { id: "allowed-once", label: "Allow once" },
          ],
        },
      });
      expect(allRequestsFor(transport, "$events/result")).toHaveLength(0);

      await runtime.respond("s1", "approval-1", "allowed-once");
      expect(requestFor(transport, "$events/result")?.args).toEqual({
        clientId: "client-1",
        eventId: "approval-1",
        outcome: { kind: "result", value: "allowed-once" },
      });

      const completed = iterator.next();
      transport.pushJournal(
        journalEvent("assistant/message", {
          message: { content: [{ type: "text", text: "done" }] },
        }, 2),
      );
      transport.pushJournal(journalEvent("turn/end", {}, 3));
      transport.pushHost(hostStatus("approval-session", true));
      expect(await completed).toEqual({
        done: false,
        value: { type: "assistant.completed", markdown: "done" },
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
