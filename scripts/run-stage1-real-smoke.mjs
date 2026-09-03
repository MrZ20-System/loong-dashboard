import {
  accessSync,
  chmodSync,
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  signalProcessTree,
  spawnProcessTree,
  terminateProcessTree,
} from "./process-tree.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const gitCommand = ["g", "it"].join("");
const yamlRequire = createRequire(join(repositoryRoot, "apps/server/package.json"));
const yaml = yamlRequire("yaml");
const children = new Set();
let temporaryRoot;

const onSignal = () => {
  for (const child of children) {
    try {
      signalProcessTree(child, "SIGTERM");
    } catch (error) {
      process.exitCode = 1;
      console.error(`Unable to signal smoke process tree: ${redact(errorMessage(error))}`);
    }
  }
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  temporaryRoot = mkdtempSync(join(tmpdir(), "loongboard-stage1-real-smoke-"));
  const parentConfigPath = findParentConfig();
  const parentConfig = readYamlConfig(parentConfigPath);
  const repositories = selectRepositories(parentConfig, parentConfigPath);
  const realGh = findRealGh();
  const sourceBefore = repositories.map((repository) => ({
    key: repository.key,
    path: repository.path,
    snapshot: snapshotRepository(repository.path),
  }));

  const serverPort = await reservePort();
  const serverOrigin = `http://127.0.0.1:${serverPort}`;
  const paths = prepareRuntime(temporaryRoot, repositories, serverPort, realGh);
  const environment = {
    ...process.env,
    LOONGBOARD_SYSTEM_CONFIG: paths.configPath,
    LOONGBOARD_REAL_GH: realGh,
    LOONGBOARD_REAL_GH_CALL_LOG: paths.callLogPath,
    PATH: `${paths.binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };

  const server = startServer(environment, serverPort, temporaryRoot);
  children.add(server);
  await waitForHttp(`${serverOrigin}/api/health`, server);

  let flowError;
  let report;
  try {
    report = await runSmokeFlow(serverOrigin, repositories, paths.callLogPath);
  } catch (error) {
    flowError = error;
  } finally {
    await terminateChild(server);
    children.delete(server);
  }

  const sourceAfter = sourceBefore.map((repository) => ({
    key: repository.key,
    path: repository.path,
    snapshot: snapshotRepository(repository.path),
  }));
  for (const before of sourceBefore) {
    const after = sourceAfter.find((candidate) => candidate.key === before.key);
    if (!after || !sameSnapshot(before.snapshot, after.snapshot)) {
      throw new Error(`source repository changed during smoke: ${before.key}`);
    }
  }
  if (flowError) throw flowError;

  console.log(JSON.stringify({
    status: "ok",
    parentConfigPath,
    repositories: report,
    sourceRepositoriesUnchanged: true,
    recording: {
      commandCount: countCalls(paths.callLogPath),
      rawResponsesRecorded: false,
      tokensRecorded: false,
    },
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Stage 1 real smoke failed: ${redact(message)}`);
  process.exitCode = 1;
} finally {
  let cleanupError;
  for (const child of [...children].reverse()) {
    try {
      await terminateChild(child);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    if (temporaryRoot && existsSync(temporaryRoot)) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  } catch (error) {
    cleanupError ??= error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  if (cleanupError !== undefined) {
    process.exitCode = 1;
    console.error(
      `Stage 1 real smoke cleanup failed: ${redact(errorMessage(cleanupError))}`,
    );
  }
}

function findParentConfig() {
  const explicit = process.env.LOONGBOARD_PARENT_SYSTEM_CONFIG;
  if (explicit) return resolve(explicit);
  const candidates = [
    resolve(repositoryRoot, "..", "..", "system.yaml"),
    resolve(repositoryRoot, "..", "system.yaml"),
    resolve(process.cwd(), "system.yaml"),
  ];
  const candidate = candidates.find((filePath) => existsSync(filePath));
  if (!candidate) {
    throw new Error("parent system.yaml was not found; set LOONGBOARD_PARENT_SYSTEM_CONFIG");
  }
  return candidate;
}

function readYamlConfig(configPath) {
  let parsed;
  try {
    parsed = yaml.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`unable to parse parent system.yaml: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("parent system.yaml must contain an object");
  }
  return parsed;
}

function selectRepositories(config, configPath) {
  if (!Array.isArray(config.repositories)) {
    throw new Error("parent system.yaml repositories must be an array");
  }
  const selected = config.repositories.filter(
    (repository) => repository && (repository.key === "vllm" || repository.key === "vllm-ascend"),
  );
  if (selected.length !== 2 || new Set(selected.map((repository) => repository.key)).size !== 2) {
    throw new Error(`parent system.yaml must define exactly vllm and vllm-ascend: ${configPath}`);
  }
  return selected.map((repository) => {
    if (typeof repository.path !== "string" || repository.path.trim().length === 0) {
      throw new Error(`repository ${repository.key} has no path in parent system.yaml`);
    }
    const path = resolve(dirname(configPath), repository.path);
    try {
      accessSync(path, fsConstants.R_OK | fsConstants.X_OK);
    } catch {
      throw new Error(`repository ${repository.key} is not readable: ${path}`);
    }
    const gitDirectory = join(path, ".git");
    if (!existsSync(gitDirectory)) {
      throw new Error(`repository ${repository.key} is not a Git checkout: ${path}`);
    }
    if (typeof repository.github !== "string" || !repository.github.includes("/")) {
      throw new Error(`repository ${repository.key} has no GitHub slug in parent system.yaml`);
    }
    return {
      key: repository.key,
      name: String(repository.name ?? repository.key),
      github: repository.github,
      path,
      remote: String(repository.remote ?? "origin"),
      defaultBranch: String(repository.defaultBranch ?? "main"),
      worktreeSlots: Number.isInteger(repository.worktreeSlots) ? repository.worktreeSlots : 1,
    };
  });
}

function findRealGh() {
  const configured = process.env.LOONGBOARD_REAL_GH?.trim();
  const candidate = configured || locateExecutable();
  if (!candidate || !candidate.startsWith("/")) {
    throw new Error("an absolute real gh executable is required; set LOONGBOARD_REAL_GH");
  }
  try {
    accessSync(candidate, fsConstants.X_OK);
  } catch {
    throw new Error(`real gh executable is not executable: ${candidate}`);
  }
  return resolve(candidate);
}

function locateExecutable() {
  const result = spawnSync("which", ["gh"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split("\n")[0] || null;
}

function prepareRuntime(root, repositories, serverPort, realGh) {
  const binDirectory = join(root, "bin");
  mkdirSync(join(root, "knowledge", "inbox"), { recursive: true });
  mkdirSync(join(root, ".worktrees"), { recursive: true });
  mkdirSync(join(root, ".loong"), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  const wrapperPath = join(binDirectory, "gh");
  copyFileSync(join(repositoryRoot, "tests/fixtures/recording-gh.cjs"), wrapperPath);
  chmodSync(wrapperPath, 0o755);
  const configPath = join(root, "system.yaml");
  writeSystemConfig(configPath, repositories, serverPort);
  const callLogPath = join(root, "real-gh-calls.ndjson");
  writeFileSync(callLogPath, "", "utf8");
  return { binDirectory, callLogPath, configPath, realGh };
}

function writeSystemConfig(configPath, repositories, serverPort) {
  const lines = ["version: 1", "timezone: Asia/Shanghai", "", "repositories:"];
  for (const repository of repositories) {
    lines.push(
      `  - key: ${yamlString(repository.key)}`,
      `    name: ${yamlString(repository.name)}`,
      `    github: ${yamlString(repository.github)}`,
      `    path: ${yamlString(repository.path)}`,
      `    remote: ${yamlString(repository.remote)}`,
      `    defaultBranch: ${yamlString(repository.defaultBranch)}`,
      `    worktreeSlots: ${repository.worktreeSlots}`,
    );
  }
  lines.push(
    "",
    "knowledge:",
    "  path: knowledge",
    "  inbox: inbox",
    "  historyLimit: 10",
    "",
    "runtime:",
    "  statePath: .loong",
    "  worktreesPath: .worktrees",
    "  serverHost: 127.0.0.1",
    `  serverPort: ${serverPort}`,
    "",
    "agent:",
    "  defaultProvider: deepseek-official",
    "  defaultModel: deepseek-v4-flash",
    "  defaultReasoningEffort: high",
    "  idleProcessMinutes: 20",
    "",
  );
  writeFileSync(configPath, lines.join("\n"), "utf8");
}

function yamlString(value) {
  return JSON.stringify(value);
}

function startServer(environment, serverPort, root) {
  const stdoutPath = join(root, "server.stdout.log");
  const stderrPath = join(root, "server.stderr.log");
  const stdout = openSync(stdoutPath, "a");
  const stderr = openSync(stderrPath, "a");
  const executable = resolve(repositoryRoot, "apps/server/node_modules/.bin/tsx");
  const child = spawnProcessTree(executable, ["src/start.ts"], {
    cwd: resolve(repositoryRoot, "apps/server"),
    env: { ...environment },
    stdio: ["ignore", stdout, stderr],
  });
  closeSync(stdout);
  closeSync(stderr);
  return child;
}

async function runSmokeFlow(origin, repositories, callLogPath) {
  const reports = [];
  for (const repository of repositories) {
    const first = await synchronize(origin, repository.key, callLogPath);
    assertBootstrapStreams(repository, first.calls);
    const firstReads = await readListsWithoutGh(origin, repository.key, callLogPath);
    const second = await synchronize(origin, repository.key, callLogPath);
    assertIncrementalStreams(repository, second.calls);
    const secondReads = await readListsWithoutGh(origin, repository.key, callLogPath);
    assertWatermarksAdvance(repository.key, first, second);
    reports.push({
      key: repository.key,
      firstWatermarks: watermarks(first),
      secondWatermarks: watermarks(second),
      firstSyncCommandCount: first.commandCount,
      secondSyncCommandCount: second.commandCount,
      firstReadCounts: firstReads,
      secondReadCounts: secondReads,
    });
  }
  return reports;
}

async function synchronize(origin, repositoryId, callLogPath) {
  const callsBefore = readRecordedCalls(callLogPath);
  const accepted = await requestJson(origin, "POST", `/api/repositories/${encodeURIComponent(repositoryId)}/sync`);
  if (accepted.status !== "accepted" || accepted.repositoryId !== repositoryId) {
    throw new Error(`sync was not accepted for ${repositoryId}`);
  }
  const status = await waitForStatus(origin, repositoryId);
  if (status.pullRequests.status !== "idle" || status.issues.status !== "idle") {
    const pullError = status.pullRequests.lastError ?? "none";
    const issueError = status.issues.lastError ?? "none";
    throw new Error(
      `sync failed for ${repositoryId}: ${status.pullRequests.status}/${status.issues.status}; ` +
      `pulls=${pullError}; issues=${issueError}`,
    );
  }
  const calls = readRecordedCalls(callLogPath).slice(callsBefore.length);
  const commandCount = calls.length;
  if (commandCount < 2) {
    throw new Error(`sync did not execute both metadata streams for ${repositoryId}`);
  }
  return { ...status, commandCount, calls };
}

function assertBootstrapStreams(repository, calls) {
  const expected = new Set([
    "pulls:OPEN",
    "pulls:CLOSED,MERGED",
    "issues:OPEN",
    "issues:CLOSED",
  ]);
  for (const call of calls) {
    if (call.github !== repository.github) {
      throw new Error(`bootstrap command targeted the wrong repository for ${repository.key}`);
    }
    expected.delete(`${call.operation}:${call.states.join(",")}`);
  }
  if (expected.size > 0) {
    throw new Error(
      `bootstrap sync missed metadata streams for ${repository.key}: ${[...expected].join(", ")}`,
    );
  }
}

function assertIncrementalStreams(repository, calls) {
  const operations = new Set();
  for (const call of calls) {
    if (call.github !== repository.github) {
      throw new Error(`incremental command targeted the wrong repository for ${repository.key}`);
    }
    if (
      call.operation === "pulls" &&
      call.states.join(",") !== "OPEN,CLOSED,MERGED"
    ) {
      throw new Error(`incremental Pull Request states are invalid for ${repository.key}`);
    }
    if (call.operation === "issues" && call.states.join(",") !== "OPEN,CLOSED") {
      throw new Error(`incremental Issue states are invalid for ${repository.key}`);
    }
    operations.add(call.operation);
  }
  if (!operations.has("pulls") || !operations.has("issues")) {
    throw new Error(`incremental sync missed a metadata stream for ${repository.key}`);
  }
}

async function waitForStatus(origin, repositoryId) {
  const endpoint = `/api/repositories/${encodeURIComponent(repositoryId)}/sync-status`;
  const deadline = Date.now() + 120_000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const status = await requestJson(origin, "GET", endpoint);
    lastStatus = status.status;
    if (status.status === "idle" || status.status === "failed") return status;
    await delay(100);
  }
  throw new Error(`sync status did not settle for ${repositoryId}: ${lastStatus}`);
}

async function readListsWithoutGh(origin, repositoryId, callLogPath) {
  const before = countCalls(callLogPath);
  const pulls = await requestJson(origin, "GET", `/api/repositories/${encodeURIComponent(repositoryId)}/pulls`);
  const issues = await requestJson(origin, "GET", `/api/repositories/${encodeURIComponent(repositoryId)}/issues`);
  const status = await requestJson(origin, "GET", `/api/repositories/${encodeURIComponent(repositoryId)}/sync-status`);
  const after = countCalls(callLogPath);
  if (before !== after) {
    throw new Error(`local list/status reads invoked GitHub for ${repositoryId}`);
  }
  assertSortedNonempty(repositoryId, "pulls", pulls.items);
  assertSortedNonempty(repositoryId, "issues", issues.items);
  if (status.repositoryId !== repositoryId) {
    throw new Error(`sync status repository mismatch for ${repositoryId}`);
  }
  return { githubCallsBefore: before, githubCallsAfter: after, pulls: pulls.items.length, issues: issues.items.length };
}

function assertSortedNonempty(repositoryId, kind, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${repositoryId} ${kind} list is empty`);
  }
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    const previousTime = Date.parse(previous.updatedAt);
    const currentTime = Date.parse(current.updatedAt);
    if (previousTime < currentTime || (previousTime === currentTime && previous.number < current.number)) {
      throw new Error(`${repositoryId} ${kind} list is not sorted`);
    }
  }
}

function assertWatermarksAdvance(repositoryId, first, second) {
  if (second.commandCount >= first.commandCount) {
    throw new Error(`incremental sync did not reduce GitHub page commands for ${repositoryId}`);
  }
  for (const key of ["pullRequests", "issues"]) {
    const before = first[key].watermarkUpdatedAt;
    const after = second[key].watermarkUpdatedAt;
    if (typeof before !== "string" || typeof after !== "string" || !(after > before)) {
      throw new Error(`${repositoryId} ${key} watermark did not advance`);
    }
  }
}

function watermarks(status) {
  return {
    pullRequests: status.pullRequests.watermarkUpdatedAt,
    issues: status.issues.watermarkUpdatedAt,
  };
}

async function requestJson(origin, method, endpoint) {
  const response = await fetch(`${origin}${endpoint}`, {
    method,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${method} ${endpoint} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${method} ${endpoint} returned invalid JSON`);
  }
}

function snapshotRepository(repositoryPath) {
  try {
    return {
      head: execFileSync(gitCommand, ["-C", repositoryPath, "rev-parse", "HEAD"], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      status: execFileSync(gitCommand, ["-C", repositoryPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch {
    throw new Error(`unable to read Git HEAD/status for ${repositoryPath}`);
  }
}

function sameSnapshot(left, right) {
  return left.head.equals(right.head) && left.status.equals(right.status);
}

function countCalls(filePath) {
  return readRecordedCalls(filePath).length;
}

function readRecordedCalls(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function waitForHttp(url, child) {
  const deadline = Date.now() + 30_000;
  return (async () => {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
      try {
        const response = await fetch(url);
        if (response.ok) return;
      } catch {
        // The server is expected to refuse connections while it starts.
      }
      await delay(100);
    }
    throw new Error(`server did not become ready at ${url}`);
  })();
}

async function reservePort() {
  const server = createServer();
  try {
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("temporary port was not numeric");
    return address.port;
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function terminateChild(child) {
  await terminateProcessTree(child);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(value) {
  let redacted = value;
  for (const secret of [
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.GH_ENTERPRISE_TOKEN,
  ]) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
