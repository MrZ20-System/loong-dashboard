import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function workspaceManifests() {
  const manifests = [];
  for (const base of ["apps", "packages"]) {
    const directory = path.join(root, base);
    if (!fs.existsSync(directory)) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const filePath = path.join(directory, entry.name, "package.json");
      if (fs.existsSync(filePath)) {
        manifests.push(filePath);
      }
    }
  }
  return manifests.sort((left, right) => left.localeCompare(right));
}

function readManifests() {
  return workspaceManifests().map((filePath) => {
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof manifest.name !== "string") {
      throw new Error(`${path.relative(root, filePath)} must declare a package name`);
    }
    return { filePath, manifest };
  });
}

function run(commandArguments, label) {
  const result = spawnSync(pnpmCommand, commandArguments, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
    return result.status ?? 1;
  }
  return 0;
}

let manifests;
try {
  manifests = readManifests();
} catch (error) {
  console.error(`Workspace test aggregation failed: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

const missing = manifests.filter(({ manifest }) => typeof manifest.scripts?.test !== "string");
if (missing.length > 0) {
  console.error("Workspace test aggregation failed:");
  for (const { filePath } of missing) {
    console.error(`- file: ${path.relative(root, filePath)}`);
    console.error("  rule: every workspace package must expose a test script");
    console.error("  repair: add a focused test command or an explicit empty-package checker");
  }
  process.exitCode = 1;
  process.exit();
}

for (const { manifest } of manifests) {
  const status = run(["--filter", manifest.name, "run", "test"], `${manifest.name} tests`);
  if (status !== 0) {
    process.exitCode = status;
    process.exit();
  }
}

const fixtureStatus = run(
  ["exec", "vitest", "run", "scripts/check-architecture.test.mjs", "--config", "vitest.config.ts"],
  "root architecture fixture tests",
);
process.exitCode = fixtureStatus;
