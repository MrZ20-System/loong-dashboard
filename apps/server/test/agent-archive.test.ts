import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendAgentMessage,
  createAgentSession,
  openDatabase,
  type DatabaseClient,
} from "@loongboard/database";
import { runCheckpoint } from "@loongboard/git-workspace";
import type { GitHubMetadataProvider } from "@loongboard/github";
import { afterEach, describe, expect, it } from "vitest";

import { AgentArchiveExporter } from "../src/agent-archive.js";
import { createServerRuntime, type ServerRuntime } from "../src/runtime.js";
import { validateAgentArchivePath } from "../src/system-actions.js";
import { parseSystemConfig } from "../src/config.js";

const databases: DatabaseClient[] = [];
const directories: string[] = [];
const runtimes: ServerRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.app.close();
  }
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { database: DatabaseClient; root: string; archiveRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "loongboard-agent-archive-"));
  directories.push(root);
  const database = openDatabase(join(root, "state.sqlite3"));
  databases.push(database);
  return { database, root, archiveRoot: join(root, "archive-repository") };
}

function session(database: DatabaseClient, id: string, dshHomePath: string): void {
  createAgentSession(database, {
    id,
    scope: { kind: "general", route: id },
    dshHomePath,
    workspacePath: "/workspace/knowledge",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    now: "2026-09-10T00:00:00.000Z",
  });
}

describe("AgentArchiveExporter", () => {
  it("exports only normalized metadata/transcript and is idempotent", () => {
    const { database, root, archiveRoot } = fixture();
    const dshHome = join(root, "agent-sessions", "sess_archive", "dsh-home");
    writeFileSync(join(mkdtempSync(join(root, "secret-")), "provider.secret"), "do-not-copy");
    session(database, "sess_archive", dshHome);
    appendAgentMessage(database, {
      sessionId: "sess_archive",
      role: "assistant",
      contentMarkdown: "second",
      now: "2026-09-10T00:00:02.000Z",
    });
    appendAgentMessage(database, {
      sessionId: "sess_archive",
      role: "user",
      contentMarkdown: "first",
      metadata: { z: "last", a: "first" },
      now: "2026-09-10T00:00:01.000Z",
    });

    const exporter = new AgentArchiveExporter({ database, archiveRoot });
    const first = exporter.export();
    expect(first).toMatchObject({ sessionCount: 1, messageCount: 2, writtenFiles: 2, unchangedFiles: 0 });
    const directory = join(archiveRoot, "conversations", "sess_archive");
    const metadataPath = join(directory, "metadata.json");
    const transcriptPath = join(directory, "transcript.jsonl");
    const metadata = readFileSync(metadataPath, "utf8");
    const transcript = readFileSync(transcriptPath, "utf8");
    const metadataStat = statSync(metadataPath);
    const transcriptStat = statSync(transcriptPath);

    expect(metadata).not.toContain("dshHomePath");
    expect(metadata).not.toContain("provider.secret");
    expect(JSON.parse(metadata)).toMatchObject({
      title: null,
      titleSource: "provisional",
    });
    expect(transcript.split("\n").filter(Boolean)).toHaveLength(2);
    expect(JSON.parse(transcript.split("\n")[0] ?? "{}")).toMatchObject({
      sequence: 0,
      contentMarkdown: "second",
    });
    expect(readdirSync(archiveRoot)).toEqual(["conversations"]);

    const second = exporter.export();
    expect(second).toMatchObject({ sessionCount: 1, messageCount: 2, writtenFiles: 0, unchangedFiles: 2 });
    expect(statSync(metadataPath).mtimeMs).toBe(metadataStat.mtimeMs);
    expect(statSync(transcriptPath).mtimeMs).toBe(transcriptStat.mtimeMs);
    expect(readFileSync(metadataPath, "utf8")).toBe(metadata);
    expect(readFileSync(transcriptPath, "utf8")).toBe(transcript);
  });

  it("rejects path traversal ids before writing any archive file", () => {
    const { database, archiveRoot } = fixture();
    session(database, "../escape", "/runtime/agent-sessions/escape/dsh-home");
    expect(() => new AgentArchiveExporter({ database, archiveRoot }).export()).toThrow(
      /not a safe directory name/,
    );
    expect(existsSync(archiveRoot)).toBe(false);
  });

  it("rejects archive targets inside runtime and source repositories", () => {
    const { root } = fixture();
    const input = {
      statePath: join(root, ".loong"),
      worktreesPath: join(root, "worktrees"),
      knowledgePath: join(root, "knowledge"),
      codeRepositoryPath: join(root, "code"),
      create: false,
    };
    mkdirSync(input.statePath, { recursive: true });
    mkdirSync(input.worktreesPath, { recursive: true });
    mkdirSync(input.knowledgePath, { recursive: true });
    mkdirSync(input.codeRepositoryPath, { recursive: true });
    expect(() => validateAgentArchivePath({ ...input, archivePath: join(input.statePath, "agent-sessions") })).toThrow(/unsafe/);
    expect(() => validateAgentArchivePath({ ...input, archivePath: join(input.knowledgePath, ".git") })).toThrow(/unsafe/);
    expect(() => validateAgentArchivePath({ ...input, archivePath: join(input.codeRepositoryPath, "archive") })).toThrow(/unsafe/);
    expect(() => validateAgentArchivePath({ ...input, archivePath: root })).toThrow(/unsafe/);

    const stateAlias = join(root, "state-alias");
    symlinkSync(input.statePath, stateAlias, "dir");
    expect(() => validateAgentArchivePath({
      ...input,
      archivePath: join(stateAlias, "future-archive"),
    })).toThrow(/unsafe/);
  });

  it("does not initialize a missing Git repository during archive checkpoint", async () => {
    const { database, archiveRoot } = fixture();
    session(database, "sess_uninitialized", "/runtime/agent-sessions/sess_uninitialized/dsh-home");
    new AgentArchiveExporter({ database, archiveRoot }).export();
    const result = await runCheckpoint({
      repositoryPath: archiveRoot,
      message: "archive checkpoint",
      sourceRef: "main",
    });
    expect(result.committed).toBe(false);
    expect(result.error).toMatch(/not a git repository/i);
    expect(existsSync(join(archiveRoot, ".git"))).toBe(false);
  });

  it("hydrates a persisted archive path without creating the default sibling", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-agent-archive-runtime-"));
    directories.push(root);
    const archivePath = join(root, "configured-archive");
    const defaultArchivePath = join(root, "agent-history");
    mkdirSync(join(root, "knowledge"), { recursive: true });
    mkdirSync(join(root, "worktrees"), { recursive: true });
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ version: 1, agentArchive: { archiveRepositoryPath: archivePath } }),
      "utf8",
    );
    const config = parseSystemConfig({
      version: 2,
      timezone: "UTC",
      repositories: [],
      knowledge: { path: join(root, "knowledge"), inbox: "inbox", historyLimit: 10 },
      runtime: {
        statePath: join(root, ".loong"),
        worktreesPath: join(root, "worktrees"),
        serverHost: "127.0.0.1",
        serverPort: 4174,
      },
      agent: {
        defaultProvider: "deepseek-official",
        defaultModel: "deepseek-v4-flash",
        defaultReasoningEffort: "high",
        idleProcessMinutes: 0,
      },
    }, join(root, "system.yaml"));
    const emptyProvider = {
      async *fetchPullRequestUpdates() { /* no repositories */ },
      async *fetchIssueUpdates() { /* no repositories */ },
      async fetchPullRequestFiles() { return []; },
      async fetchIssueDetail() { throw new Error("not used"); },
    } as unknown as GitHubMetadataProvider;
    const runtime = createServerRuntime({ config, systemRoot: root, provider: emptyProvider });
    runtimes.push(runtime);

    expect(runtime.settings.agentArchiveSettingsSync().archiveRepositoryPath).toBe(archivePath);
    const settings = await runtime.settings.agentArchiveSettings();
    expect(settings.archiveRepositoryPath).toBe(archivePath);
    const response = await runtime.app.inject({ method: "GET", url: "/api/settings/agent-archive" });
    expect(response.statusCode).toBe(200);
    expect(response.json().archiveRepositoryPath).toBe(archivePath);
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(defaultArchivePath)).toBe(false);
  });

  it("uses systemRoot/agent-history when no archive path is persisted", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-agent-archive-default-"));
    directories.push(root);
    mkdirSync(join(root, "knowledge"), { recursive: true });
    mkdirSync(join(root, "worktrees"), { recursive: true });
    const config = parseSystemConfig({
      version: 2,
      timezone: "UTC",
      repositories: [],
      knowledge: { path: join(root, "knowledge"), inbox: "inbox", historyLimit: 10 },
      runtime: {
        statePath: join(root, ".loong"),
        worktreesPath: join(root, "worktrees"),
        serverHost: "127.0.0.1",
        serverPort: 4174,
      },
      agent: {
        defaultProvider: "deepseek-official",
        defaultModel: "deepseek-v4-flash",
        defaultReasoningEffort: "high",
        idleProcessMinutes: 0,
      },
    }, join(root, "system.yaml"));
    const emptyProvider = {
      async *fetchPullRequestUpdates() { /* no repositories */ },
      async *fetchIssueUpdates() { /* no repositories */ },
      async fetchPullRequestFiles() { return []; },
      async fetchIssueDetail() { throw new Error("not used"); },
    } as unknown as GitHubMetadataProvider;

    const runtime = createServerRuntime({ config, systemRoot: root, provider: emptyProvider });
    runtimes.push(runtime);

    expect(runtime.settings.agentArchiveSettingsSync().archiveRepositoryPath).toBe(
      join(root, "agent-history"),
    );
    expect(existsSync(join(root, "agent-history"))).toBe(true);
  });
});
