import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkArchitecture } from "./check-architecture.mjs";

const temporaryDirectories = [];

function makeFixture(relativeFile, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loongboard-architecture-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, relativeFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return root;
}

function addFixtureFile(root, relativeFile, content) {
  const filePath = path.join(root, relativeFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("architecture boundary fixtures", () => {
  it("rejects a DSH import outside the adapter package", () => {
    const root = makeFixture(
      "packages/agent-runtime/src/runtime.ts",
      'import { DeepSeekHarness } from "@deepseek-ai/dsh";\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["dsh-import"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/agent-runtime/src/runtime.ts",
        rule: "dsh-import",
        description: expect.stringContaining("packages/agent-runtime-dsh"),
        repair: expect.stringContaining("Move the DSH import"),
      }),
    ]);
  });

  it("rejects raw SQL outside the database package", () => {
    const root = makeFixture(
      "packages/github/src/query.ts",
      'export const query = "SELECT id FROM pull_requests";\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["raw-sql"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/github/src/query.ts",
        rule: "raw-sql",
        description: expect.stringContaining("packages/database"),
        repair: expect.stringContaining("Move SQL"),
      }),
    ]);
  });

  it("does not mistake JSX elements or collection methods for raw SQL", () => {
    const root = makeFixture(
      "apps/web/src/page.tsx",
      `export function Page() {
  const entries = new Map();
  entries.delete("old");
  return <select aria-label="Repository"><option>Example</option></select>;
}\n`,
    );

    expect(
      checkArchitecture(root, { rules: new Set(["raw-sql"]) }),
    ).toEqual([]);
  });

  it("does not mistake HTTP method strings or UI copy for raw SQL", () => {
    const root = makeFixture(
      "apps/web/src/client.ts",
      [
        'export const remove = () => fetch("/api/x", { method: "DELETE" });',
        'const message = `Delete failed: ${new Error("boom").message}`;',
        'if (message.startsWith("Save") || message.startsWith("Delete")) { throw new Error("Delete rule?"); }',
        'const query = "SELECT";',
        'const label = "Update failed";',
        "",
      ].join("\n"),
    );

    expect(
      checkArchitecture(root, { rules: new Set(["raw-sql"]) }),
    ).toEqual([]);
  });

  it("rejects raw DELETE FROM and INSERT INTO outside the database package", () => {
    const root = makeFixture(
      "packages/github/src/query.ts",
      'export const remove = "DELETE FROM pull_request_files";\nexport const add = "INSERT INTO t VALUES (1)";\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["raw-sql"]) });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual(
      expect.objectContaining({ file: "packages/github/src/query.ts", rule: "raw-sql" }),
    );
  });

  it("rejects GitHub CLI execution outside the GitHub package", () => {
    const root = makeFixture(
      "packages/server/src/sync.ts",
      'import { execa } from "execa";\nexport const run = () => execa("gh", ["api"]);\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["gh-execution"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/server/src/sync.ts",
        rule: "gh-execution",
        description: expect.stringContaining("packages/github"),
        repair: expect.stringContaining("Move gh execution"),
      }),
    ]);
  });

  it("rejects Git execution outside the Git workspace", () => {
    const root = makeFixture(
      "packages/server/src/worktree.ts",
      'import { execa } from "execa";\nexport const run = () => execa("git", ["status"]);\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["git-execution"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/server/src/worktree.ts",
        rule: "git-execution",
        description: expect.stringContaining("packages/git-workspace"),
        repair: expect.stringContaining("Move git execution"),
      }),
    ]);
  });

  it("rejects execaCommand Git execution outside the Git workspace", () => {
    const root = makeFixture(
      "apps/server/src/worktree.ts",
      'import { execaCommand } from "execa";\nexport const run = () => execaCommand("git status");\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["git-execution"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "apps/server/src/worktree.ts",
        rule: "git-execution",
      }),
    ]);
  });

  it("rejects Knowledge Git execution even when the file name looks like a service", () => {
    const root = makeFixture(
      "packages/knowledge/src/git-service.ts",
      'import { execa } from "execa";\nexport const checkpoint = () => execa("git", ["status"]);\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["git-execution"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/knowledge/src/git-service.ts",
        rule: "git-execution",
        description: expect.stringContaining("only in packages/git-workspace"),
      }),
    ]);
  });

  it("does not mistake command-copy strings or HTTP DELETE for Git execution", () => {
    const root = makeFixture(
      "apps/web/src/help.ts",
      [
        'const command = "git status";',
        'const request = fetch("/api/items", { method: "DELETE" });',
        "",
      ].join("\n"),
    );

    expect(
      checkArchitecture(root, { rules: new Set(["git-execution"]) }),
    ).toEqual([]);
  });

  it("rejects synchronous Git process execution outside the Git workspace", () => {
    const root = makeFixture(
      "apps/server/src/worktree.ts",
      [
        'import { execSync, spawnSync } from "node:child_process";',
        'export const status = () => execSync("git status");',
        'export const probe = () => spawnSync("git", ["status"]);',
        "",
      ].join("\n"),
    );

    const violations = checkArchitecture(root, { rules: new Set(["git-execution"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "apps/server/src/worktree.ts",
        rule: "git-execution",
      }),
    ]);
  });

  it("rejects shell-template Git execution outside the Git workspace", () => {
    const root = makeFixture(
      "apps/server/src/worktree.ts",
      'export const run = (ref) => exec(`git show ${ref}`);\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["git-execution"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "apps/server/src/worktree.ts",
        rule: "git-execution",
      }),
    ]);
  });

  it("allows only the explicitly approved Git fixture tests", () => {
    const root = makeFixture(
      "apps/server/test/worktree-capacity.test.ts",
      'import { execFileSync } from "node:child_process";\nexport const seed = () => execFileSync("git", ["init"]);\n',
    );

    expect(
      checkArchitecture(root, { rules: new Set(["git-execution"]) }),
    ).toEqual([]);
  });

  it("rejects direct Git execution from an unapproved test source", () => {
    const root = makeFixture(
      "apps/server/test/unapproved.test.ts",
      'import { execa } from "execa";\nexport const run = () => execa("git", ["status"]);\n',
    );

    const violations = checkArchitecture(root, { rules: new Set(["git-execution"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "apps/server/test/unapproved.test.ts",
        rule: "git-execution",
      }),
    ]);
  });

  it("rejects DSH dependencies declared by a non-adapter package manifest", () => {
    const root = makeFixture(
      "packages/server/package.json",
      JSON.stringify({
        name: "@loongboard/server",
        dependencies: { "@deepseek-ai/dsh": "0.1.2-alpha.5" },
      }),
    );

    const violations = checkArchitecture(root, { rules: new Set(["dsh-manifest"]) });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/server/package.json",
        rule: "dsh-manifest",
        description: expect.stringContaining("Non-adapter package manifests"),
        repair: expect.stringContaining("Remove the DSH dependency"),
      }),
    ]);
  });

  it("rejects an invalid workspace dependency direction", () => {
    const root = makeFixture(
      "packages/contracts/package.json",
      JSON.stringify({
        name: "@loongboard/contracts",
        dependencies: { "@loongboard/database": "workspace:*" },
      }),
    );
    addFixtureFile(
      root,
      "packages/database/package.json",
      JSON.stringify({ name: "@loongboard/database" }),
    );

    const violations = checkArchitecture(root, {
      rules: new Set(["workspace-dependency-direction"]),
    });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/contracts/package.json",
        rule: "workspace-dependency-direction",
        description: expect.stringContaining(
          "@loongboard/contracts -> @loongboard/database",
        ),
        repair: expect.stringContaining("Move the dependency"),
      }),
    ]);
  });

  it("rejects Server dependencies on Web and unapproved workspace packages", () => {
    const root = makeFixture(
      "apps/server/package.json",
      JSON.stringify({
        name: "@loongboard/server",
        dependencies: {
          "@loongboard/web": "workspace:*",
          "@loongboard/unknown": "workspace:*",
        },
      }),
    );
    addFixtureFile(
      root,
      "apps/web/package.json",
      JSON.stringify({ name: "@loongboard/web" }),
    );
    addFixtureFile(
      root,
      "packages/unknown/package.json",
      JSON.stringify({ name: "@loongboard/unknown" }),
    );

    const violations = checkArchitecture(root, {
      rules: new Set(["workspace-dependency-direction"]),
    });

    expect(violations).toHaveLength(2);
    expect(violations.map((item) => item.description)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@loongboard/server -> @loongboard/web"),
        expect.stringContaining("@loongboard/server -> @loongboard/unknown"),
      ]),
    );
  });

  it("allows the exact current Server workspace dependency set", () => {
    const root = makeFixture(
      "apps/server/package.json",
      JSON.stringify({
        name: "@loongboard/server",
        dependencies: {
          "@loongboard/agent-runtime": "workspace:*",
          "@loongboard/agent-runtime-dsh": "workspace:*",
          "@loongboard/contracts": "workspace:*",
          "@loongboard/database": "workspace:*",
          "@loongboard/git-workspace": "workspace:*",
          "@loongboard/github": "workspace:*",
          "@loongboard/knowledge": "workspace:*",
          "@loongboard/scheduler": "workspace:*",
        },
      }),
    );
    for (const name of [
      "agent-runtime",
      "agent-runtime-dsh",
      "contracts",
      "database",
      "git-workspace",
      "github",
      "knowledge",
      "scheduler",
    ]) {
      addFixtureFile(
        root,
        `packages/${name}/package.json`,
        JSON.stringify({ name: `@loongboard/${name}` }),
      );
    }

    expect(
      checkArchitecture(root, { rules: new Set(["workspace-dependency-direction"]) }),
    ).toEqual([]);
  });

  it("rejects Scheduler dependencies beyond Contracts", () => {
    const root = makeFixture(
      "packages/scheduler/package.json",
      JSON.stringify({
        name: "@loongboard/scheduler",
        dependencies: {
          "@loongboard/contracts": "workspace:*",
          "@loongboard/database": "workspace:*",
        },
      }),
    );
    addFixtureFile(
      root,
      "packages/contracts/package.json",
      JSON.stringify({ name: "@loongboard/contracts" }),
    );
    addFixtureFile(
      root,
      "packages/database/package.json",
      JSON.stringify({ name: "@loongboard/database" }),
    );

    const violations = checkArchitecture(root, {
      rules: new Set(["workspace-dependency-direction"]),
    });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/scheduler/package.json",
        description: expect.stringContaining(
          "@loongboard/scheduler -> @loongboard/database",
        ),
      }),
    ]);
  });

  it("rejects Agent Runtime DSH dependencies beyond Agent Runtime", () => {
    const root = makeFixture(
      "packages/agent-runtime-dsh/package.json",
      JSON.stringify({
        name: "@loongboard/agent-runtime-dsh",
        dependencies: {
          "@loongboard/agent-runtime": "workspace:*",
          "@loongboard/contracts": "workspace:*",
        },
      }),
    );
    addFixtureFile(
      root,
      "packages/agent-runtime/package.json",
      JSON.stringify({ name: "@loongboard/agent-runtime" }),
    );
    addFixtureFile(
      root,
      "packages/contracts/package.json",
      JSON.stringify({ name: "@loongboard/contracts" }),
    );

    const violations = checkArchitecture(root, {
      rules: new Set(["workspace-dependency-direction"]),
    });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/agent-runtime-dsh/package.json",
        description: expect.stringContaining(
          "@loongboard/agent-runtime-dsh -> @loongboard/contracts",
        ),
      }),
    ]);
  });

  it("rejects GitHub dependencies beyond its current empty workspace set", () => {
    const root = makeFixture(
      "packages/github/package.json",
      JSON.stringify({
        name: "@loongboard/github",
        dependencies: { "@loongboard/contracts": "workspace:*" },
      }),
    );
    addFixtureFile(
      root,
      "packages/contracts/package.json",
      JSON.stringify({ name: "@loongboard/contracts" }),
    );

    const violations = checkArchitecture(root, {
      rules: new Set(["workspace-dependency-direction"]),
    });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/github/package.json",
        description: expect.stringContaining(
          "@loongboard/github -> @loongboard/contracts",
        ),
      }),
    ]);
  });

  it("rejects circular workspace package dependencies", () => {
    const root = makeFixture(
      "packages/alpha/package.json",
      JSON.stringify({
        name: "@loongboard/alpha",
        dependencies: { "@loongboard/beta": "workspace:*" },
      }),
    );
    addFixtureFile(
      root,
      "packages/beta/package.json",
      JSON.stringify({
        name: "@loongboard/beta",
        dependencies: { "@loongboard/alpha": "workspace:*" },
      }),
    );

    const violations = checkArchitecture(root, {
      rules: new Set(["circular-dependencies"]),
    });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "packages/alpha/package.json",
        rule: "circular-dependencies",
        description: expect.stringContaining(
          "@loongboard/alpha -> @loongboard/beta -> @loongboard/alpha",
        ),
        repair: expect.stringContaining("Remove the dependency cycle"),
      }),
    ]);
  });

  it("allows the DSH, database, GitHub, Git workspace, and acyclic fixtures", () => {
    const root = makeFixture(
      "packages/agent-runtime-dsh/src/client.ts",
      'import { DeepSeekHarness } from "@deepseek-ai/dsh";\n',
    );
    addFixtureFile(
      root,
      "packages/database/src/migrations.ts",
      'export const migration = "CREATE TABLE example (id TEXT)";\n',
    );
    addFixtureFile(
      root,
      "packages/github/src/provider.ts",
      'export const run = () => execa("gh", ["api"]);\n',
    );
    addFixtureFile(
      root,
      "packages/git-workspace/src/runner.ts",
      'export const run = () => execa("git", ["status"]);\n',
    );
    addFixtureFile(
      root,
      "packages/agent-runtime-dsh/package.json",
      JSON.stringify({
        name: "@loongboard/agent-runtime-dsh",
        dependencies: {
          "@deepseek-ai/dsh": "0.1.2-alpha.5",
          "@deepseek-ai/dsh-sdk-client": "0.1.2-alpha.5",
          "@loongboard/agent-runtime": "workspace:*",
        },
      }),
    );
    addFixtureFile(
      root,
      "packages/github/package.json",
      JSON.stringify({
        name: "@loongboard/github",
        dependencies: { "@loongboard/contracts": "workspace:*" },
      }),
    );
    addFixtureFile(
      root,
      "apps/web/package.json",
      JSON.stringify({
        name: "@loongboard/web",
        dependencies: { "@loongboard/contracts": "workspace:*" },
      }),
    );
    addFixtureFile(
      root,
      "packages/alpha/package.json",
      JSON.stringify({
        name: "@loongboard/alpha",
        dependencies: { "@loongboard/beta": "workspace:*" },
      }),
    );
    addFixtureFile(
      root,
      "packages/beta/package.json",
      JSON.stringify({ name: "@loongboard/beta" }),
    );

    expect(checkArchitecture(root)).toEqual([]);
  });
});
