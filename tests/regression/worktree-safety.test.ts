import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runGitText,
  WorktreePool,
  WorktreePoolError,
} from "../../packages/git-workspace/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("critical worktree safety", () => {
  it("never recycles a dirty bound slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-worktree-regression-"));
    roots.push(root);
    const repository = join(root, "repository");
    const poolRoot = join(root, "pool");
    await runGitText(root, ["init", repository]);
    await runGitText(repository, ["config", "user.email", "loongboard@example.invalid"]);
    await runGitText(repository, ["config", "user.name", "LoongBoard Regression"]);
    writeFileSync(join(repository, "state.txt"), "first\n", "utf8");
    await runGitText(repository, ["add", "state.txt"]);
    await runGitText(repository, ["commit", "-m", "first"]);
    const firstSha = (await runGitText(repository, ["rev-parse", "HEAD"])).trim();
    writeFileSync(join(repository, "state.txt"), "second\n", "utf8");
    await runGitText(repository, ["commit", "-am", "second"]);
    const secondSha = (await runGitText(repository, ["rev-parse", "HEAD"])).trim();

    const pool = new WorktreePool();
    const first = await pool.allocate({
      mainRepositoryPath: repository,
      poolRoot,
      slotCount: 1,
      prNumber: 1,
      targetSha: firstSha,
      busySlotPaths: [],
    });
    writeFileSync(join(first.slotPath, "state.txt"), "local edit\n", "utf8");

    await expect(pool.allocate({
      mainRepositoryPath: repository,
      poolRoot,
      slotCount: 1,
      prNumber: 2,
      targetSha: secondSha,
      busySlotPaths: [],
      slots: [{
        slotName: first.slotName,
        slotPath: first.slotPath,
        prNumber: 1,
        targetSha: firstSha,
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      }],
    })).rejects.toBeInstanceOf(WorktreePoolError);
    expect(await runGitText(first.slotPath, ["diff", "--", "state.txt"])).toContain("local edit");
  });
});
