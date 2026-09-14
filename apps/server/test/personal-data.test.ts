import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  personalDataInstructionTreeRefreshResponseSchema,
  personalDataStatusSchema,
  type PersonalDataStatus,
} from "@loongboard/contracts";
import {
  RepositoryOnboardingError,
  type RepositoryCloneResult,
  type RepositoryOnboardingGit,
} from "@loongboard/git-workspace";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  PersonalDataService,
  type PersonalDataServiceOptions,
} from "../src/personal-data.js";
import { registerPersonalDataRoutes } from "../src/routes/personal-data.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeGit(options: {
  missing?: string;
  failure?: Error;
  captureInput?: (input: Parameters<RepositoryOnboardingGit["clone"]>[0]) => void;
} = {}): Pick<RepositoryOnboardingGit, "clone"> {
  return {
    async clone(input, cloneOptions): Promise<RepositoryCloneResult> {
      options.captureInput?.(input);
      await input.credential?.();
      if (options.failure !== undefined) throw options.failure;
      const stagingPath = mkdtempSync(join(dirname(input.targetPath), ".personal-data-stage-"));
      try {
        for (const directory of ["knowledge", "prompts", "skills"]) {
          if (directory === options.missing) continue;
          mkdirSync(join(stagingPath, directory));
          writeFileSync(join(stagingPath, directory, ".keep"), "fixture\n");
        }
        await cloneOptions?.validateStagedRepository?.(stagingPath);
        if (existsSync(input.targetPath)) {
          if (readdirSync(input.targetPath).length > 0) {
            throw new RepositoryOnboardingError("target_exists", "Repository target must be empty", input.targetPath);
          }
          rmdirSync(input.targetPath);
        }
        mkdirSync(input.targetPath, { recursive: true });
        for (const directory of ["knowledge", "prompts", "skills"]) {
          if (existsSync(join(stagingPath, directory))) {
            mkdirSync(join(input.targetPath, directory));
            writeFileSync(join(input.targetPath, directory, ".keep"), "fixture\n");
          }
        }
      } finally {
        rmSync(stagingPath, { recursive: true, force: true });
      }
      return {
        action: "cloned",
        targetPath: input.targetPath,
        owner: input.owner,
        name: input.name,
        remoteName: input.remoteName,
        defaultBranch: input.defaultBranch,
        remoteMatched: true,
        defaultBranchAvailable: true,
      };
    },
  };
}

function fixture(options: {
  git?: Pick<RepositoryOnboardingGit, "clone">;
  treeRenderer?: PersonalDataServiceOptions["treeRenderer"];
  credentialToken?: PersonalDataServiceOptions["credentialToken"];
} = {}): {
  root: string;
  personalPath: string;
  knowledgePath: string;
  service: PersonalDataService;
} {
  const root = mkdtempSync(join(tmpdir(), "loongboard-personal-data-"));
  roots.push(root);
  const personalPath = join(root, "personal-data");
  const knowledgePath = join(personalPath, "knowledge");
  return {
    root,
    personalPath,
    knowledgePath,
    service: new PersonalDataService({
      personalPath,
      knowledgePath,
      gitWorkspace: options.git ?? fakeGit(),
      ...(options.treeRenderer === undefined ? {} : { treeRenderer: options.treeRenderer }),
      ...(options.credentialToken === undefined ? {} : { credentialToken: options.credentialToken }),
    }),
  };
}

async function importFixture(service: PersonalDataService): Promise<PersonalDataStatus> {
  return service.importRepository({
    repositoryUrl: "https://github.com/example/personal-data.git",
    branch: "profile/z20",
  });
}

describe("PersonalDataService", () => {
  it("reports server-injected paths and imports into the required repository layout", async () => {
    let capturedBranch: string | undefined;
    const fixtureData = fixture({
      git: fakeGit({ captureInput: (input) => { capturedBranch = input.defaultBranch; } }),
    });
    expect(fixtureData.service.getStatus()).toMatchObject({
      path: fixtureData.personalPath,
      knowledgePath: fixtureData.knowledgePath,
      available: false,
    });

    const status = await importFixture(fixtureData.service);
    expect(status.available).toBe(true);
    expect(capturedBranch).toBe("profile/z20");
    expect(readdirSync(fixtureData.personalPath).sort()).toEqual(["knowledge", "prompts", "skills"]);
  });

  it("rejects a non-empty target without changing its contents", async () => {
    const fixtureData = fixture();
    mkdirSync(fixtureData.personalPath, { recursive: true });
    const keep = join(fixtureData.personalPath, "keep.txt");
    writeFileSync(keep, "keep\n");
    await expect(importFixture(fixtureData.service)).rejects.toMatchObject({
      code: "PERSONAL_DATA_IMPORT_CONFLICT",
    });
    expect(readFileSync(keep, "utf8")).toBe("keep\n");
  });

  it("validates required directories in staging before installing", async () => {
    const fixtureData = fixture({ git: fakeGit({ missing: "skills" }) });
    await expect(importFixture(fixtureData.service)).rejects.toMatchObject({
      code: "PERSONAL_DATA_IMPORT_FAILED",
      message: expect.stringContaining("skills"),
    });
    expect(existsSync(fixtureData.personalPath)).toBe(false);
  });

  it("redacts credential material from import failures", async () => {
    const secret = "ghp_personal_data_secret";
    const fixtureData = fixture({
      git: fakeGit({ failure: new Error(`remote rejected ${secret}`) }),
      credentialToken: () => secret,
    });
    await expect(importFixture(fixtureData.service)).rejects.toMatchObject({
      code: "PERSONAL_DATA_IMPORT_FAILED",
    });
    try {
      await importFixture(fixtureData.service);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("renders prompts and skills with tree-node-cli semantics and overwrites the artifact", async () => {
    const rendered: string[] = [];
    const fixtureData = fixture({
      treeRenderer: (path, options) => {
        rendered.push(path);
        expect(options).toMatchObject({
          allFiles: true,
          fullPath: true,
          gitignore: false,
          maxDepth: Number.POSITIVE_INFINITY,
        });
        return path.endsWith("/prompts") ? "prompts\n`-- prompts/example.md" : "skills\n`-- skills/example.md";
      },
    });
    await importFixture(fixtureData.service);
    const output = join(fixtureData.knowledgePath, "_loongboard", "instruction-tree.md");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, "old\n");
    const refreshed = fixtureData.service.refreshInstructionTree();
    expect(personalDataInstructionTreeRefreshResponseSchema.parse(refreshed)).toEqual(refreshed);
    expect(rendered).toEqual([
      join(fixtureData.personalPath, "prompts"),
      join(fixtureData.personalPath, "skills"),
    ]);
    expect(readFileSync(output, "utf8")).toBe([
      "# Instruction Tree",
      "",
      "## Prompts",
      "",
      "```text",
      "prompts",
      "`-- prompts/example.md",
      "```",
      "",
      "## Skills",
      "",
      "```text",
      "skills",
      "`-- skills/example.md",
      "```",
      "",
    ].join("\n"));
  });

  it("uses the real tree-node-cli renderer with paths relative to Personal Data", () => {
    const fixtureData = fixture();
    mkdirSync(join(fixtureData.personalPath, "prompts"), { recursive: true });
    mkdirSync(join(fixtureData.personalPath, "skills", "release"), { recursive: true });
    mkdirSync(fixtureData.knowledgePath, { recursive: true });
    writeFileSync(join(fixtureData.personalPath, "prompts", "foo.md"), "prompt\n");
    writeFileSync(join(fixtureData.personalPath, "skills", "release", "SKILL.md"), "skill\n");

    const refreshed = fixtureData.service.refreshInstructionTree();
    const instructionTree = readFileSync(refreshed.path, "utf8");
    expect(instructionTree).toContain("prompts/foo.md");
    expect(instructionTree).toContain("skills/release/SKILL.md");
    expect(instructionTree).not.toContain(fixtureData.personalPath);
  });

  it("exposes status, synchronous import, and refresh routes", async () => {
    const fixtureData = fixture();
    const app = Fastify();
    registerPersonalDataRoutes(app, { personalData: fixtureData.service });
    const before = await app.inject({ method: "GET", url: "/api/settings/personal-data" });
    expect(before.statusCode).toBe(200);
    expect(personalDataStatusSchema.safeParse(JSON.parse(before.body)).success).toBe(true);

    const imported = await app.inject({
      method: "POST",
      url: "/api/settings/personal-data/import",
      payload: {
        repositoryUrl: "example/personal-data",
        branch: "profile/z20",
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(JSON.parse(imported.body).available).toBe(true);

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/settings/personal-data/instruction-tree/refresh",
    });
    expect(refreshed.statusCode).toBe(200);
    expect(JSON.parse(refreshed.body).path).toContain("instruction-tree.md");
    const instructionTree = readFileSync(JSON.parse(refreshed.body).path, "utf8");
    expect(instructionTree).toContain("# Instruction Tree");
    expect(instructionTree).toContain("prompts/.keep");
    expect(instructionTree).toContain("skills/.keep");
    await app.close();

    const postOnlyApp = Fastify();
    registerPersonalDataRoutes(postOnlyApp, {
      personalData: fixtureData.service,
      registerStatusRoute: false,
    });
    expect((await postOnlyApp.inject({ method: "GET", url: "/api/settings/personal-data" })).statusCode).toBe(404);
    await postOnlyApp.close();
  });
});
