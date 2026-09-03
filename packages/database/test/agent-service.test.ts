import type { AgentScope } from "@loongboard/contracts";
import { describe, expect, it } from "vitest";
import {
  appendAgentMessage,
  createAgentSession,
  findAgentSession,
  listAgentMessages,
  requireAgentSession,
  updateAgentSession,
} from "../src/agent-service.js";
import { openDatabase } from "../src/migration-runner.js";

const general: AgentScope = { kind: "general" };

function freshDatabase() {
  return openDatabase(":memory:");
}

describe("agent session service", () => {
  it("creates, finds by scope, and lists normalized messages in order", () => {
    const database = freshDatabase();
    const created = createAgentSession(database, {
      id: "sess_1",
      scope: general,
      dshHomePath: "/home/sess_1/dsh",
      workspacePath: "/work/a",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      now: "2026-09-03T00:00:00.000Z",
    });
    expect(created.status).toBe("idle");

    const found = findAgentSession(database, general);
    expect(found?.id).toBe("sess_1");
    expect(requireAgentSession(database, "sess_1").dshHomePath).toBe("/home/sess_1/dsh");

    const user = appendAgentMessage(database, {
      sessionId: "sess_1",
      role: "user",
      contentMarkdown: "hello",
      now: "2026-09-03T00:00:01.000Z",
    });
    expect(user.sequence).toBe(0);
    const assistant = appendAgentMessage(database, {
      sessionId: "sess_1",
      role: "assistant",
      contentMarkdown: "hi",
      metadata: { source: "ds" },
      now: "2026-09-03T00:00:02.000Z",
    });
    expect(assistant.sequence).toBe(1);
    const messages = listAgentMessages(database, "sess_1");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.metadataJson).toEqual({ source: "ds" });

    updateAgentSession(database, "sess_1", { status: "running", dshSessionId: "ds_9" });
    expect(requireAgentSession(database, "sess_1").dshSessionId).toBe("ds_9");
    database.close();
  });
});
