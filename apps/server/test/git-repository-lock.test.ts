import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { GitRepositoryLock } from "../src/git-repository-lock.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("GitRepositoryLock", () => {
  it("serializes operations for one canonical repository path", async () => {
    const lock = new GitRepositoryLock();
    const firstRelease = deferred();
    const events: string[] = [];
    const first = lock.run("/tmp/repository", async () => {
      events.push("first:start");
      await firstRelease.promise;
      events.push("first:end");
    });
    const second = lock.run("/tmp/./repository", async () => {
      events.push("second:start");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstRelease.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows different repositories to run concurrently", async () => {
    const lock = new GitRepositoryLock();
    const firstRelease = deferred();
    let secondStarted = false;
    const first = lock.run("/tmp/one", async () => firstRelease.promise);
    const second = lock.run("/tmp/two", async () => {
      secondStarted = true;
    });
    await second;
    expect(secondStarted).toBe(true);
    firstRelease.resolve();
    await first;
  });

  it("uses one key for a repository and its symlink alias", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-git-lock-"));
    const repository = join(root, "repository");
    const alias = join(root, "alias");
    mkdirSync(repository);
    symlinkSync(repository, alias, "dir");
    try {
      const lock = new GitRepositoryLock();
      const firstRelease = deferred();
      const events: string[] = [];
      const first = lock.run(repository, async () => {
        events.push("first:start");
        await firstRelease.promise;
        events.push("first:end");
      });
      const second = lock.run(alias, async () => {
        events.push("second:start");
      });
      await Promise.resolve();
      expect(events).toEqual(["first:start"]);
      firstRelease.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(["first:start", "first:end", "second:start"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases a key after failure", async () => {
    const lock = new GitRepositoryLock();
    await expect(lock.run("/tmp/repository", async () => {
      throw new Error("git failed");
    })).rejects.toThrow("git failed");
    await expect(lock.run("/tmp/repository", async () => "ready")).resolves.toBe("ready");
  });
});
