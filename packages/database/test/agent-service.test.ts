import type { AgentScope } from "@loongboard/contracts";
import { describe, expect, it } from "vitest";
import {
  appendAgentMessage,
  createAgentSession,
  findAgentSession,
  InvalidAgentSessionTitleError,
  listAgentMessages,
  listAgentSessions,
  renameAgentSession,
  requireAgentSession,
  setGeneratedAgentSessionTitleIfProvisional,
  updateAgentSession,
} from "../src/agent-service.js";
import { listAgentArchiveProjection } from "../src/agent-archive-service.js";
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
    expect(created.title).toBeNull();
    expect(created.titleSource).toBe("provisional");

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

  it("persists title provenance and lets generated titles win only once", () => {
    const database = freshDatabase();
    createAgentSession(database, {
      id: "sess_title",
      scope: general,
      dshHomePath: "/home/sess_title/dsh",
      workspacePath: "/work/title",
      provider: "deepseek-official",
      model: "model",
      reasoningEffort: "high",
      now: "2026-09-03T00:00:00.000Z",
    });

    const first = setGeneratedAgentSessionTitleIfProvisional(
      database,
      "sess_title",
      "  Generated title  ",
    );
    expect(first.updated).toBe(true);
    expect(first.session.title).toBe("Generated title");
    expect(first.session.titleSource).toBe("generated");
    const second = setGeneratedAgentSessionTitleIfProvisional(
      database,
      "sess_title",
      "A later title",
    );
    expect(second.updated).toBe(false);
    expect(second.session.title).toBe("Generated title");
    database.close();
  });

  it("protects a manual title from generated replacement", () => {
    const database = freshDatabase();
    createAgentSession(database, {
      id: "sess_manual_title",
      scope: general,
      dshHomePath: "/home/sess_manual_title/dsh",
      workspacePath: "/work/title",
      provider: "deepseek-official",
      model: "model",
      reasoningEffort: "high",
      now: "2026-09-03T00:00:00.000Z",
    });
    const renamed = renameAgentSession(database, "sess_manual_title", "  My title  ");
    expect(renamed.title).toBe("My title");
    expect(renamed.titleSource).toBe("manual");
    expect(
      setGeneratedAgentSessionTitleIfProvisional(database, "sess_manual_title", "Generated"),
    ).toMatchObject({ updated: false, session: { title: "My title", titleSource: "manual" } });
    database.close();
  });

  it("enforces one-line, non-empty, 80-code-point titles", () => {
    const database = freshDatabase();
    createAgentSession(database, {
      id: "sess_title_validation",
      scope: general,
      dshHomePath: "/home/sess_title_validation/dsh",
      workspacePath: "/work/title",
      provider: "deepseek-official",
      model: "model",
      reasoningEffort: "high",
      now: "2026-09-03T00:00:00.000Z",
    });
    const valid = "😀".repeat(80);
    expect(renameAgentSession(database, "sess_title_validation", valid).title).toBe(valid);
    for (const invalid of ["😀".repeat(81), "line\nbreak", "   "]) {
      expect(() => renameAgentSession(database, "sess_title_validation", invalid)).toThrow(
        InvalidAgentSessionTitleError,
      );
    }
    database.close();
  });

  it("projects title provenance and searches titles first", () => {
    const database = freshDatabase();
    createAgentSession(database, {
      id: "sess_search_title",
      scope: general,
      dshHomePath: "/home/sess_search_title/dsh",
      workspacePath: "/work/title",
      provider: "deepseek-official",
      model: "model",
      reasoningEffort: "high",
      title: "Searchable conversation",
      now: "2026-09-03T00:00:00.000Z",
    });
    expect(listAgentSessions(database, { search: "searchable" })).toMatchObject([
      { id: "sess_search_title", title: "Searchable conversation", titleSource: "manual" },
    ]);
    database.close();
  });

  it("reads archive sessions and messages in one grouped projection", () => {
    const database = freshDatabase();
    createAgentSession(database, {
      id: "sess_archive_a",
      scope: general,
      dshHomePath: "/runtime/secret-a/dsh-home",
      workspacePath: "/workspace/a",
      provider: "deepseek-official",
      model: "model-a",
      reasoningEffort: "high",
      now: "2026-09-03T00:00:00.000Z",
    });
    createAgentSession(database, {
      id: "sess_archive_b",
      scope: { kind: "general", route: "repo" },
      dshHomePath: "/runtime/secret-b/dsh-home",
      workspacePath: "/workspace/b",
      provider: "deepseek-official",
      model: "model-b",
      reasoningEffort: "low",
      now: "2026-09-03T00:00:01.000Z",
    });
    appendAgentMessage(database, {
      sessionId: "sess_archive_b",
      role: "assistant",
      contentMarkdown: "second",
      now: "2026-09-03T00:00:03.000Z",
    });
    appendAgentMessage(database, {
      sessionId: "sess_archive_a",
      role: "user",
      contentMarkdown: "first",
      now: "2026-09-03T00:00:02.000Z",
    });
    appendAgentMessage(database, {
      sessionId: "sess_archive_a",
      role: "assistant",
      contentMarkdown: "reply",
      metadata: { source: "normalized" },
      now: "2026-09-03T00:00:04.000Z",
    });

    try {
      let queryCount = 0;
      const statements: string[] = [];
      const projectionDatabase = {
        prepare: (sql: string) => {
          queryCount += 1;
          statements.push(sql);
          return database.prepare(sql);
        },
      } as unknown as typeof database;
      const projection = listAgentArchiveProjection(projectionDatabase);
      expect(queryCount).toBe(2);
      expect(statements[1]).not.toContain("IN (");
      expect(projection.map((item) => item.session.id)).toEqual([
        "sess_archive_a",
        "sess_archive_b",
      ]);
      expect(projection[0]?.messages.map((message) => message.contentMarkdown)).toEqual([
        "first",
        "reply",
      ]);
      expect(projection[1]?.messages.map((message) => message.contentMarkdown)).toEqual([
        "second",
      ]);
      expect(projection[0]?.session.titleSource).toBe("provisional");
      expect(projection[0]?.session).not.toHaveProperty("dshHomePath");
      expect(listAgentArchiveProjection(database, { sessionIds: ["sess_archive_b"] })).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
