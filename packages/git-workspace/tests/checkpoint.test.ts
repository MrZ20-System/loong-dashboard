import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushBackupRef, runCheckpoint } from "../src/index.js";

let root: string;
let repo: string;
let remote: string;

async function git(args: string[]) {
  return execa("git", args, { cwd: repo }).then((result) => result.stdout.trim());
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loongboard-checkpoint-"));
  repo = path.join(root, "knowledge");
  remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  await execa("git", ["init", "--bare", remote]);
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

  it("refuses to checkpoint a different checked-out branch", async () => {
    await git(["checkout", "-b", "temporary-work"]);
    fs.writeFileSync(path.join(repo, "wrong-branch.md"), "keep uncommitted\n");
    const before = await git(["rev-parse", "HEAD"]);

    const result = await runCheckpoint({
      repositoryPath: repo,
      message: "must not commit",
      sourceRef: "main",
    });

    expect(result.committed).toBe(false);
    expect(result.error).toContain("source branch mismatch");
    expect(await git(["rev-parse", "HEAD"])).toBe(before);
    expect(await git(["status", "--porcelain"])).toContain("wrong-branch.md");
    fs.rmSync(path.join(repo, "wrong-branch.md"));
    await git(["checkout", "main"]);
  });

  it("pushes a source ref to a differently named remote branch without checkout", async () => {
    await git(["remote", "add", "backup", remote]);
    const beforeBranch = await git(["branch", "--show-current"]);
    const result = await pushBackupRef({
      repositoryPath: repo,
      remote: "backup",
      sourceRef: "main",
      remoteBranch: "loongboard-backup",
    });

    expect(result.pushed).toBe(true);
    expect(await git(["branch", "--show-current"])).toBe(beforeBranch);
    expect(
      await execa("git", ["--git-dir", remote, "rev-parse", "refs/heads/loongboard-backup"])
        .then((value) => value.stdout.trim()),
    ).toBe(result.sourceCommit);
  });

  it("reports a non-fast-forward push without force or checkout", async () => {
    const remoteClone = path.join(root, "remote-clone");
    await execa("git", ["clone", remote, remoteClone]);
    await execa("git", ["config", "user.email", "remote@example.com"], { cwd: remoteClone });
    await execa("git", ["config", "user.name", "Remote"], { cwd: remoteClone });
    await execa("git", ["config", "commit.gpgsign", "false"], { cwd: remoteClone });
    await execa("git", ["checkout", "-b", "loongboard-backup", "origin/loongboard-backup"], { cwd: remoteClone });
    fs.writeFileSync(path.join(remoteClone, "remote-only.md"), "remote\n");
    await execa("git", ["add", "-A"], { cwd: remoteClone });
    await execa("git", ["commit", "-m", "remote advance"], { cwd: remoteClone });
    await execa("git", ["push", "origin", "loongboard-backup"], { cwd: remoteClone });

    const beforeBranch = await git(["branch", "--show-current"]);
    const result = await pushBackupRef({
      repositoryPath: repo,
      remote: "backup",
      sourceRef: "main",
      remoteBranch: "loongboard-backup",
    });

    expect(result.pushed).toBe(false);
    expect(result.error).toContain("[rejected]");
    expect(await git(["branch", "--show-current"])).toBe(beforeBranch);
  });
});
