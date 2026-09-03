import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStage1Fixture,
  stage1RepositoryConfigs,
} from "../tests/fixtures/stage1-fixture.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const gitCommand = ["g", "it"].join("");
const processChildren = new Set();
let temporaryRoot;

const onSignal = () => {
  for (const child of processChildren) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  temporaryRoot = mkdtempSync(join(tmpdir(), "loongboard-stage1-e2e-"));
  const fixture = buildStage1Fixture();
  const ports = await reservePorts(2);
  const serverOrigin = `http://127.0.0.1:${ports[0]}`;
  const webOrigin = `http://127.0.0.1:${ports[1]}`;
  const paths = prepareFixture(temporaryRoot, fixture);
  writeSystemConfig(temporaryRoot, ports[0]);

  const environment = {
    ...process.env,
    CI: process.env.CI ?? "true",
    LOONGBOARD_SYSTEM_CONFIG: paths.configPath,
    LOONGBOARD_SERVER_ORIGIN: serverOrigin,
    LOONGBOARD_API_ORIGIN: serverOrigin,
    LOONGBOARD_FAKE_GH_FIXTURE: paths.controlPath,
    LOONGBOARD_FAKE_GH_CALL_LOG: paths.callLogPath,
    LOONGBOARD_E2E_WEB_ORIGIN: webOrigin,
    LOONGBOARD_E2E_ACTIVITY_DATE: fixture.activityDate,
    LOONGBOARD_E2E_CALL_LOG: paths.callLogPath,
    LOONGBOARD_E2E_OUTPUT_DIR: join(temporaryRoot, "playwright-output"),
    PATH: `${paths.binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };

  const server = startChild(
    resolve(repositoryRoot, "apps/server/node_modules/.bin/tsx"),
    ["src/start.ts"],
    resolve(repositoryRoot, "apps/server"),
    environment,
    join(temporaryRoot, "server.stdout.log"),
    join(temporaryRoot, "server.stderr.log"),
  );
  await waitForHttp(`${serverOrigin}/api/health`, server, "Server");

  const web = startChild(
    resolve(repositoryRoot, "apps/web/node_modules/.bin/vite"),
    ["--host", "127.0.0.1", "--port", String(ports[1]), "--strictPort"],
    resolve(repositoryRoot, "apps/web"),
    environment,
    join(temporaryRoot, "web.stdout.log"),
    join(temporaryRoot, "web.stderr.log"),
  );
  await waitForHttp(webOrigin, web, "Vite");

  const playwright = startChild(
    resolve(repositoryRoot, "node_modules/.bin/playwright"),
    ["test", "tests/e2e/stage1.spec.ts", "--config", "playwright.config.ts"],
    repositoryRoot,
    environment,
    null,
    null,
    true,
  );
  const result = await waitForExit(playwright);
  if (result !== 0) {
    throw new Error(`Stage 1 Playwright acceptance failed with exit code ${result}`);
  }

  const callCount = readCallLog(paths.callLogPath).length;
  console.log(`Stage 1 E2E passed; fake gh calls: ${callCount}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Stage 1 E2E failed: ${message}`);
  if (temporaryRoot) printFailureLogs(temporaryRoot);
  process.exitCode = 1;
} finally {
  for (const child of [...processChildren].reverse()) {
    await terminateChild(child);
  }
  if (temporaryRoot && existsSync(temporaryRoot)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}

function prepareFixture(root, fixture) {
  const binDirectory = join(root, "bin");
  const repositoriesDirectory = join(root, "repositories");
  const knowledgeDirectory = join(root, "knowledge", "inbox");
  const worktreesDirectory = join(root, ".worktrees");
  const stateDirectory = join(root, ".loong");
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(repositoriesDirectory, { recursive: true });
  mkdirSync(knowledgeDirectory, { recursive: true });
  mkdirSync(worktreesDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });

  for (const repository of stage1RepositoryConfigs()) {
    const repositoryPath = join(root, repository.path);
    initializeFixtureRepository(repositoryPath, repository.key);
  }

  const fakeGhPath = join(binDirectory, "gh");
  copyFileSync(join(repositoryRoot, "tests/fixtures/fake-gh.cjs"), fakeGhPath);
  chmodSync(fakeGhPath, 0o755);
  const controlPath = join(root, "fake-gh-control.json");
  const callLogPath = join(root, "fake-gh-calls.ndjson");
  writeFileSync(controlPath, `${JSON.stringify(fixture)}\n`, "utf8");
  writeFileSync(callLogPath, "", "utf8");

  return {
    binDirectory,
    callLogPath,
    configPath: join(root, "system.yaml"),
    controlPath,
  };
}

function writeSystemConfig(root, serverPort) {
  const repositories = stage1RepositoryConfigs();
  const lines = [
    "version: 1",
    "timezone: Asia/Shanghai",
    "",
    "repositories:",
  ];
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
  writeFileSync(join(root, "system.yaml"), lines.join("\n"), "utf8");
}

function yamlString(value) {
  return JSON.stringify(value);
}

function initializeFixtureRepository(repositoryPath, key) {
  mkdirSync(repositoryPath, { recursive: true });
  runGit(["init", "--quiet", "--initial-branch=main", repositoryPath], repositoryRoot);
  writeFileSync(join(repositoryPath, "README.md"), `Fixture repository ${key}\n`, "utf8");
  runGit(["-C", repositoryPath, "add", "README.md"], repositoryRoot);
  runGit(
    [
      "-C",
      repositoryPath,
      "-c",
      "user.name=LoongBoard Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    repositoryRoot,
  );
}

function runGit(argumentsList, cwd) {
  const result = spawnSync(gitCommand, argumentsList, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? "non-zero exit";
    throw new Error(`fixture repository setup failed: ${reason}`);
  }
}

async function reservePorts(count) {
  const ports = [];
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolvePromise());
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("temporary port did not expose a numeric address");
      }
      ports.push(address.port);
      servers.push(server);
    }
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolvePromise) => {
            server.close(() => resolvePromise());
          }),
      ),
    );
  }
  return ports;
}

function startChild(
  executable,
  argumentsList,
  cwd,
  environment,
  stdoutPath,
  stderrPath,
  inheritOutput = false,
) {
  const stdout = inheritOutput
    ? "inherit"
    : openSync(stdoutPath, "a");
  const stderr = inheritOutput
    ? "inherit"
    : openSync(stderrPath, "a");
  const child = spawn(executable, argumentsList, {
    cwd,
    env: environment,
    stdio: ["ignore", stdout, stderr],
  });
  if (typeof stdout === "number") closeSync(stdout);
  if (typeof stderr === "number") closeSync(stderr);
  processChildren.add(child);
  child.once("close", () => {
    processChildren.delete(child);
  });
  return child;
}

async function waitForHttp(url, child, label) {
  const deadline = Date.now() + 30_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`${label} did not become ready at ${url}: ${lastError}`);
}

function waitForExit(child) {
  return new Promise((resolvePromise, reject) => {
    if (child.exitCode !== null) {
      resolvePromise(child.exitCode);
      return;
    }
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await waitForExitWithin(child, 5_000);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForExitWithin(child, 5_000);
  }
}

function waitForExitWithin(child, timeoutMs) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise(true);
      return;
    }
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

function readCallLog(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function printFailureLogs(root) {
  for (const name of ["server.stderr.log", "web.stderr.log"]) {
    const filePath = join(root, name);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8").trim();
    if (content.length > 0) {
      console.error(`${name}: ${content.slice(-4_000)}`);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
