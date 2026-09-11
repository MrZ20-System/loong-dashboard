import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@loongboard/database";
import { KnowledgeController, type KnowledgeControllerOptions } from "../src/knowledge.js";

type TestWatcher = EventEmitter & { closeCalls: number; close(): void };

function testWatcher(): TestWatcher {
  const watcher = new EventEmitter() as TestWatcher;
  watcher.closeCalls = 0;
  watcher.close = () => {
    watcher.closeCalls += 1;
  };
  return watcher;
}

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

  it("falls back to lazy indexing after an asynchronous watcher error", async () => {
    const database = openDatabase(":memory:");
    const knowledgePath = mkdtempSync(join(tmpdir(), "loongboard-knowledge-watch-test-"));
    const watchers: TestWatcher[] = [];
    const watchFactory = (() => {
      const watcher = testWatcher();
      watchers.push(watcher);
      return watcher;
    }) as unknown as NonNullable<KnowledgeControllerOptions["watch"]>;
    const controller = new KnowledgeController({
      database,
      knowledgePath,
      chats: {} as never,
      watch: watchFactory,
    });
    cleanups.push(() => database.close());
    cleanups.push(() => rmSync(knowledgePath, { recursive: true, force: true }));
    cleanups.push(() => controller.close());

    controller.start();
    expect(watchers).toHaveLength(1);
    queueMicrotask(() => watchers[0]!.emit("error", new Error("watch failed")));
    await Promise.resolve();
    expect(watchers[0]!.closeCalls).toBe(1);

    controller.start();
    expect(watchers).toHaveLength(2);
    queueMicrotask(() => watchers[0]!.emit("error", new Error("late old watcher error")));
    await Promise.resolve();
    expect(watchers[1]!.closeCalls).toBe(0);
    await controller.close();
    expect(watchers[1]!.closeCalls).toBe(1);
    await controller.close();
    expect(watchers[1]!.closeCalls).toBe(1);
  });
});
