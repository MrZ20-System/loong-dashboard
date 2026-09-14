import { mkdtemp, mkdir, symlink, writeFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  GitCommandError,
  RepositoryOnboardingError,
  RepositoryOnboardingGit,
  runGitText,
  type RepositoryOnboardingInput,
  type RepositoryGitRunner,
} from "../src/index.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd, reject: true });
  return result.stdout;
}

async function fixture(): Promise<{ root: string; source: string; runner: RepositoryGitRunner; input: (target: string) => RepositoryOnboardingInput }> {
  const root = await mkdtemp(join(tmpdir(), "loongboard-onboarding-"));
  const managedRoot = join(root, "managed");
  const source = join(root, "source");
  await mkdir(managedRoot);
  await mkdir(source);
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.email", "test@example.invalid"]);
  await git(source, ["config", "user.name", "Test"]);
  await writeFile(join(source, "README.md"), "fixture\n");
  await git(source, ["add", "README.md"]);
  await git(source, ["commit", "-m", "fixture"]);
  const runner: RepositoryGitRunner = {
    async runText(cwd, args, options) {
      if (args[0] !== "clone") return runGitText(cwd, args, options);
      const cloneArgs = [...args];
      const sourceIndex = cloneArgs.length - 2;
      cloneArgs[sourceIndex] = `file://${source}`;
      const output = await runGitText(cwd, cloneArgs, options);
      await runGitText(cloneArgs.at(-1)!, ["remote", "set-url", "upstream", "https://github.com/fixture/repo.git"], options);
      return output;
    },
  };
  return {
    root,
    source,
    runner,
    input: (targetPath) => ({
      cloneUrl: "https://github.com/fixture/repo.git",
      owner: "fixture",
      name: "repo",
      remoteName: "upstream",
      defaultBranch: "main",
      targetPath,
      managedRoot,
    }),
  };
}

describe("RepositoryOnboardingGit", () => {
  it("clones a missing repository and adopts it idempotently", async () => {
    const { root, source, runner, input } = await fixture();
    const target = join(root, "managed", "repo");
    const service = new RepositoryOnboardingGit({ runner });
    await expect(service.clone(input(target))).resolves.toMatchObject({ action: "cloned", targetPath: target });
    await expect(service.adopt(input(target))).resolves.toMatchObject({ action: "adopted", targetPath: target });
    expect(await git(target, ["remote", "get-url", "upstream"])).toBe("https://github.com/fixture/repo.git");
  });

  it("classifies the real Git missing-default-branch clone error", async () => {
    const { root, runner, input } = await fixture();
    const target = join(root, "managed", "missing-branch");
    const defaultBranch = "release/does-not-exist";

    await expect(new RepositoryOnboardingGit({ runner }).clone({
      ...input(target),
      defaultBranch,
    })).rejects.toMatchObject({
      code: "default_branch_missing",
      message: expect.stringContaining(`default branch "${defaultBranch}" does not exist`),
    });
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an ordinary clone failure classified as clone_failed", async () => {
    const { root, runner, input } = await fixture();
    const target = join(root, "managed", "clone-failed");
    const failingRunner: RepositoryGitRunner = {
      async runText(cwd, args, options) {
        if (args[0] === "clone") {
          throw new GitCommandError(
            cwd,
            args,
            128,
            "fatal: unable to access 'https://github.com/fixture/repo.git/': Could not resolve host: github.com\n",
          );
        }
        return runner.runText(cwd, args, options);
      },
    };

    await expect(new RepositoryOnboardingGit({ runner: failingRunner }).clone(input(target)))
      .rejects.toMatchObject({
        code: "clone_failed",
        message: expect.stringContaining("Git repository clone failed"),
      });
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates an initially missing managed root for clone", async () => {
    const { root, source, runner, input } = await fixture();
    const managedRoot = join(root, "created-managed");
    const target = join(managedRoot, "repo");
    await expect(new RepositoryOnboardingGit({ runner }).clone({ ...input(target), managedRoot }))
      .resolves.toMatchObject({ action: "cloned", targetPath: target });
    expect(await git(target, ["remote", "get-url", "upstream"])).toBe("https://github.com/fixture/repo.git");
  });

  it("ensures an existing matching repository without overwriting it", async () => {
    const { root, input, runner } = await fixture();
    const target = join(root, "managed", "repo");
    const service = new RepositoryOnboardingGit({ runner });
    await service.clone(input(target));
    await expect(service.ensure(input(target))).resolves.toMatchObject({ action: "adopted" });
  });

  it("serializes concurrent ensure calls and never replaces an empty target", async () => {
    const { root, input, runner } = await fixture();
    const target = join(root, "managed", "concurrent");
    const service = new RepositoryOnboardingGit({ runner });
    const results = await Promise.all([service.ensure(input(target)), service.ensure(input(target))]);
    expect(results.map((result) => result.action).sort()).toEqual(["adopted", "cloned"]);

    const raceTarget = join(root, "managed", "race");
    let createdByRace = false;
    const racingRunner: RepositoryGitRunner = {
      async runText(cwd, args, options) {
        const output = await runner.runText(cwd, args, options);
        if (args[0] === "show-ref" && !createdByRace) {
          createdByRace = true;
          await mkdir(raceTarget);
        }
        return output;
      },
    };
    await expect(new RepositoryOnboardingGit({ runner: racingRunner }).clone(input(raceTarget)))
      .rejects.toMatchObject({ code: "target_exists" });
    expect(await readdir(raceTarget)).toEqual([]);
  });

  it("cleans an exclusively owned partial target after install failure and abort", async () => {
    const { root, input, runner } = await fixture();
    const target = join(root, "managed", "failed-install");
    let moves = 0;
    const failingService = new RepositoryOnboardingGit({
      runner,
      renameEntry: async (source, destination) => {
        if (moves++ === 1) throw new Error("injected install failure");
        await rename(source, destination);
      },
    });
    await expect(failingService.clone(input(target))).rejects.toMatchObject({ code: "clone_failed" });
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new RepositoryOnboardingGit({ runner }).clone(input(target))).resolves.toMatchObject({ action: "cloned" });

    const abortTarget = join(root, "managed", "aborted-install");
    const controller = new AbortController();
    let abortedAfterFirstMove = false;
    const abortingService = new RepositoryOnboardingGit({
      runner: {
        async runText(cwd, args, options) {
          return runner.runText(cwd, args, options);
        },
      },
      renameEntry: async (source, destination) => {
        await rename(source, destination);
        if (!abortedAfterFirstMove) {
          abortedAfterFirstMove = true;
          controller.abort();
        }
      },
    });
    await expect(abortingService.clone(input(abortTarget), { signal: controller.signal })).rejects.toMatchObject({ code: "canceled" });
    await expect(readdir(abortTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new RepositoryOnboardingGit({ runner }).clone(input(abortTarget))).resolves.toMatchObject({ action: "cloned" });

    const protectedTarget = join(root, "managed", "protected-install");
    let injectedExternalChange = false;
    const protectedService = new RepositoryOnboardingGit({
      runner,
      renameEntry: async (source, destination) => {
        await rename(source, destination);
        if (!injectedExternalChange) {
          injectedExternalChange = true;
          await writeFile(join(protectedTarget, "external.txt"), "keep\n");
          throw new Error("injected failure after external change");
        }
      },
    });
    await expect(protectedService.clone(input(protectedTarget))).rejects.toMatchObject({ code: "clone_failed" });
    await expect(readdir(protectedTarget)).resolves.toContain("external.txt");
  });

  it("rejects remote mismatch and non-git directories", async () => {
    const fixtureData = await fixture();
    const target = join(fixtureData.root, "managed", "repo");
    await mkdir(target);
    await expect(new RepositoryOnboardingGit({ runner: fixtureData.runner }).adopt(fixtureData.input(target))).rejects.toMatchObject({ code: "not_git_repository" });

    await git(target, ["init", "--initial-branch=main"]);
    await git(target, ["remote", "add", "upstream", "https://github.com/other/repository.git"]);
    await expect(new RepositoryOnboardingGit({ runner: fixtureData.runner }).adopt(fixtureData.input(target))).rejects.toMatchObject({ code: "remote_mismatch" });
  });

  it("accepts only credential-free GitHub clone URL forms", async () => {
    const { root, input, runner } = await fixture();
    const service = new RepositoryOnboardingGit({ runner });
    await expect(service.clone({ ...input(join(root, "managed", "ssh")), cloneUrl: "git@github.com:fixture/repo.git" }))
      .resolves.toMatchObject({ action: "cloned" });
    const invalidService = new RepositoryOnboardingGit();
    for (const cloneUrl of [
      "file:///tmp/source",
      "https://git.example.com/fixture/repo.git",
      "https://token@github.com/fixture/repo.git",
      "https://github.com:443/fixture/repo.git",
      "https://github.com/fixture/repo.git?token=secret",
    ]) {
      await expect(invalidService.clone({ ...input(join(root, "managed", `invalid-${cloneUrl.length}`)), cloneUrl }))
        .rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("rejects paths outside the managed root and symlink escapes", async () => {
    const { root, input, runner } = await fixture();
    const service = new RepositoryOnboardingGit({ runner });
    await expect(service.clone(input(join(root, "outside")))).rejects.toMatchObject({ code: "unsafe_path" });
    const link = join(root, "managed", "link");
    await symlink(root, link);
    await expect(service.clone(input(join(link, "repo")))).rejects.toMatchObject({ code: "unsafe_path" });
    const targetLink = join(root, "managed", "target-link");
    await symlink(root, targetLink);
    await expect(service.clone(input(targetLink))).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("does not overwrite an existing target and reports cancellation safely", async () => {
    const { root, input, runner } = await fixture();
    const target = join(root, "managed", "existing");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "keep\n");
    await expect(new RepositoryOnboardingGit({ runner }).clone(input(target))).rejects.toMatchObject({ code: "target_exists" });

    const controller = new AbortController();
    controller.abort();
    await expect(new RepositoryOnboardingGit().clone(input(join(root, "managed", "cancelled")), { signal: controller.signal }))
      .rejects.toMatchObject({ code: "canceled" });
  });

  it("never includes a credential in an onboarding error", async () => {
    const { root, input } = await fixture();
    const target = join(root, "managed", "secret");
    const secret = "super-secret-token";
    const badInput = { ...input(target), cloneUrl: "https://github.com/fixture/repo.git", credential: () => ({ token: secret }) };
    const service = new RepositoryOnboardingGit({
      runner: {
        async runText() {
          throw new Error(secret);
        },
      },
    });
    try {
      await service.clone(badInput);
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryOnboardingError);
      expect(String(error)).not.toContain(secret);
    }
  });
});
