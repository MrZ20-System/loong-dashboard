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

  it("rejects Git execution outside the Git workspace or Knowledge Git service", () => {
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

  it("allows the DSH, database, GitHub, Git workspace, Knowledge Git, and acyclic fixtures", () => {
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
      "packages/knowledge/src/git-service.ts",
      'export const checkpoint = () => execa("git", ["commit"]);\n',
    );
    addFixtureFile(
      root,
      "packages/agent-runtime-dsh/package.json",
      JSON.stringify({
        name: "@loongboard/agent-runtime-dsh",
        dependencies: {
          "@deepseek-ai/dsh": "0.1.2-alpha.5",
          "@deepseek-ai/dsh-sdk-client": "0.1.2-alpha.5",
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
