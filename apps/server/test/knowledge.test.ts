import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@loongboard/database";
import { KnowledgeController } from "../src/knowledge.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Knowledge checkpoint policy", () => {
  it("keeps checkpoint settings on canonical fields only", () => {
    const database = openDatabase(":memory:");
    const knowledgePath = mkdtempSync(join(tmpdir(), "loongboard-knowledge-test-"));
    cleanups.push(() => database.close());
    cleanups.push(() => rmSync(knowledgePath, { recursive: true, force: true }));

    const controller = new KnowledgeController({
      database,
      knowledgePath,
      chats: {} as never,
      checkpoint: {
        autoCommit: true,
        autoPush: false,
        remote: "origin",
        sourceRef: "release",
        remoteBranch: "knowledge-backup",
        checkpointIntervalMinutes: 60,
        pushIntervalMinutes: 240,
      },
    });
    cleanups.push(() => controller.close());

    expect(controller.checkpointSettings()).toEqual({
      autoCommit: true,
      autoPush: false,
      remote: "origin",
      sourceRef: "release",
      remoteBranch: "knowledge-backup",
      checkpointIntervalMinutes: 60,
      pushIntervalMinutes: 240,
    });

    controller.updateCheckpoint({ sourceRef: "main", checkpointIntervalMinutes: null });
    const updated = controller.checkpointSettings();
    expect(updated.sourceRef).toBe("main");
    expect(updated.checkpointIntervalMinutes).toBeNull();
    expect(updated).not.toHaveProperty("branch");
    expect(updated).not.toHaveProperty("intervalMinutes");
  });
});
