import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitObjectMissingError,
  LocalGitWorkspace,
  MAX_DIFF_FILE_BYTES,
} from "../src/index.js";

/**
 * Real Git fixture: origin bare repository with a base branch and a PR head
 * pushed to refs/pull/1/head. The workspace under test is a fresh clone so
 * preparePull exercises the single-fetch path exactly once.
 */
let root: string;
let workspace: string;
let origin: string;
let baseCommit = "";
let headSha = "";

async function git(cwd: string, args: string[], options: Record<string, unknown> = {}) {
  const result = await execa("git", args, { cwd, ...options });
  return result.stdout.trim();
}

async function writeFile(repo: string, relative: string, content: string) {
  const filePath = path.join(repo, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  await git(repo, ["add", "-A"]);
  return filePath;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loongboard-git-workspace-"));
  origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  await git(seed, ["init", "-b", "main", "."]);
  await git(seed, ["config", "user.email", "test@example.com"]);
  await git(seed, ["config", "user.name", "Test"]);
  await git(seed, ["config", "commit.gpgsign", "false"]);

  // Base branch state.
  await writeFile(seed, "alpha.txt", "line one\nline two\nline three\nline four\n");
  await git(seed, ["commit", "-m", "base alpha"]);
  await writeFile(seed, "kept.txt", "kept\n");
  await git(seed, ["commit", "-m", "base kept"]);
  baseCommit = await git(seed, ["rev-parse", "HEAD"]);

  // PR branch: modify, add, delete, rename (small rename still detected via
  // --find-renames with the similarity threshold satisfied), and binary.
  await git(seed, ["switch", "-c", "pr-1"]);
  await writeFile(seed, "alpha.txt", "line one\nline two CHANGED\nline three\nline four\nline five\n");
  await writeFile(seed, "added.txt", "brand new\n");
  fs.rmSync(path.join(seed, "kept.txt"));
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "modify, add, delete"]);
  await git(seed, ["mv", "alpha.txt", "alpha-renamed.txt"]);
  await git(seed, ["commit", "-m", "rename alpha"]);
  // Binary file added on top of the rename state so numstat marks "-".
  fs.writeFileSync(path.join(seed, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 10]));
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "add binary"]);
  headSha = await git(seed, ["rev-parse", "HEAD"]);

  // Seed a commit only on main after branch point to confirm merge-base stays.
  await git(seed, ["switch", "main"]);
  await writeFile(seed, "main-only.txt", "main\n");
  await git(seed, ["commit", "-m", "main only"]);

  // Create the bare remote and push base + PR head refs.
  await git(seed, ["init", "--bare", origin]);
  await git(seed, ["remote", "add", "origin", origin]);
  await git(seed, ["push", "origin", "main"]);
  await git(seed, ["push", "origin", `pr-1:refs/pull/1/head`]);

  // The workspace under test starts empty so the first prepare exercises the
  // single allowed fetch (a local hard-link clone would already contain the
  // pushed objects and bypass the fetch path).
  workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  await git(workspace, ["init", "-b", "main", "."]);
  await git(workspace, ["config", "user.email", "test@example.com"]);
  await git(workspace, ["config", "user.name", "Test"]);
  await git(workspace, ["remote", "add", "origin", origin]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("LocalGitWorkspace real fixture", () => {
  it("fetches missing PR objects once on first prepare and reuses them after", async () => {
    const service = new LocalGitWorkspace();

    const first = await service.preparePull({
      repositoryPath: workspace,
      remote: "origin",
      baseBranch: "main",
      prNumber: 1,
      headSha,
    });
    expect(first.headSha).toBe(headSha);
    expect(first.mergeBase).toBe(baseCommit);
    expect(first.fetched).toBe(true);

    const second = await service.preparePull({
      repositoryPath: workspace,
      remote: "origin",
      baseBranch: "main",
      prNumber: 1,
      headSha,
    });
    expect(second.fetched).toBe(false);
    expect(second.mergeBase).toBe(baseCommit);
  });

  it("lists changed files with rename, binary, and correct stats", async () => {
    const service = new LocalGitWorkspace();
    const prepare = await service.preparePull({
      repositoryPath: workspace,
      remote: "origin",
      baseBranch: "main",
      prNumber: 1,
      headSha,
    });
    const files = await service.listChangedFiles({
      repositoryPath: workspace,
      mergeBase: prepare.mergeBase,
      headSha,
    });
    const byPath = new Map(files.map((file) => [file.path, file]));

    const alpha = byPath.get("alpha-renamed.txt");
    expect(alpha?.changeType).toBe("renamed");
    expect(alpha?.previousPath).toBe("alpha.txt");
    expect(alpha?.additions).toBe(2);
    expect(alpha?.deletions).toBe(1);

    expect(byPath.get("added.txt")?.changeType).toBe("added");
    expect(byPath.get("added.txt")?.previousPath).toBeNull();
    expect(byPath.get("added.txt")?.additions).toBe(1);

    const removed = files.find((file) => file.path === "kept.txt");
    expect(removed?.changeType).toBe("removed");

    const binary = byPath.get("blob.bin");
    expect(binary?.binary).toBe(true);
    expect(binary?.additions).toBeNull();
    expect(binary?.deletions).toBeNull();
  });

  it("reads complete base and head file content and flags binary", async () => {
    const service = new LocalGitWorkspace();
    const prepare = await service.preparePull({
      repositoryPath: workspace,
      remote: "origin",
      baseBranch: "main",
      prNumber: 1,
      headSha,
    });
    const base = await service.readFile({
      repositoryPath: workspace,
      ref: prepare.mergeBase,
      path: "alpha.txt",
    });
    expect(base.content).toContain("line four");
    expect(base.binary).toBe(false);

    const head = await service.readFile({
      repositoryPath: workspace,
      ref: headSha,
      path: "alpha-renamed.txt",
    });
    expect(head.content).toContain("CHANGED");
    expect(head.content).toContain("line five");

    const blob = await service.readFile({
      repositoryPath: workspace,
      ref: headSha,
      path: "blob.bin",
    });
    expect(blob.binary).toBe(true);
    expect(blob.content).toBeNull();

    // The deleted file is only readable at the base side.
    const baseDeleted = await service.readFile({
      repositoryPath: workspace,
      ref: prepare.mergeBase,
      path: "kept.txt",
    });
    expect(baseDeleted.content).toBe("kept\n");
  });

  it("rejects unsafe paths and reports missing objects explicitly", async () => {
    const service = new LocalGitWorkspace();
    await expect(
      service.readFile({ repositoryPath: workspace, ref: headSha, path: "../escape" }),
    ).rejects.toThrow(/Unsafe git path/);
    await expect(
      service.readFile({ repositoryPath: workspace, ref: headSha, path: "/abs" }),
    ).rejects.toThrow(/Unsafe git path/);

    await expect(
      service.preparePull({
        repositoryPath: workspace,
        remote: "origin",
        baseBranch: "main",
        prNumber: 1,
        headSha: "0".repeat(40),
      }),
    ).rejects.toBeInstanceOf(GitObjectMissingError);
  });

  it("degrades files over the content limit without truncating the contract", async () => {
    const bigRepo = path.join(root, "big-repo");
    fs.mkdirSync(bigRepo);
    await git(bigRepo, ["init", "-b", "main", "."]);
    await git(bigRepo, ["config", "user.email", "test@example.com"]);
    await git(bigRepo, ["config", "user.name", "Test"]);
    const bigFile = path.join(bigRepo, "huge.txt");
    fs.writeFileSync(bigFile, Buffer.alloc(MAX_DIFF_FILE_BYTES + 1, 0x61));
    await git(bigRepo, ["add", "huge.txt"]);
    await git(bigRepo, ["commit", "-m", "huge"]);
    const bigSha = await git(bigRepo, ["rev-parse", "HEAD"]);

    const service = new LocalGitWorkspace();
    const content = await service.readFile({
      repositoryPath: bigRepo,
      ref: bigSha,
      path: "huge.txt",
    });
    expect(content.tooLarge).toBe(true);
    expect(content.content).toBeNull();
    expect(content.sizeBytes).toBeGreaterThan(MAX_DIFF_FILE_BYTES);
  });
});
