import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheckpoint } from "../src/index.js";

let root: string;
let repo: string;

async function git(args: string[]) {
  return execa("git", args, { cwd: repo }).then((result) => result.stdout.trim());
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loongboard-checkpoint-"));
  repo = path.join(root, "knowledge");
  fs.mkdirSync(repo);
  await git(["init", "-b", "main", "."]);
  await git(["config", "user.email", "t@e.c"]);
  await git(["config", "user.name", "T"]);
  await git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "notes.md"), "# First\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "init"]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runCheckpoint", () => {
  it("commits pending changes and skips a clean repository", async () => {
    fs.writeFileSync(path.join(repo, "notes.md"), "# Second\n");
    const committed = await runCheckpoint({
      repositoryPath: repo,
      message: "chore(knowledge): checkpoint t1",
    });
    expect(committed.committed).toBe(true);
    expect(await git(["status", "--porcelain"])).toBe("");

    const clean = await runCheckpoint({
      repositoryPath: repo,
      message: "chore(knowledge): checkpoint t2",
    });
    expect(clean.committed).toBe(false);
  });

  it("records a push failure without losing the commit", async () => {
    fs.writeFileSync(path.join(repo, "notes.md"), "# Third\n");
    const result = await runCheckpoint({
      repositoryPath: repo,
      message: "chore(knowledge): checkpoint t3",
      push: true,
      remote: "origin", // no remote is configured in the fixture repo
      branch: "main",
    });
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.error).toBeDefined();
    expect(await git(["status", "--porcelain"])).toBe("");
  });
});
