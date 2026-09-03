import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  spawnProcessTree,
  terminateProcessTree,
} from "../../scripts/process-tree.mjs";

const temporaryRoots = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe("acceptance process tree cleanup", () => {
  it.runIf(process.platform !== "win32")(
    "kills a signal-resistant descendant before cleanup returns",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "loongboard-process-tree-"));
      temporaryRoots.push(root);
      const heartbeatPath = join(root, "heartbeat.txt");
      const descendantPidPath = join(root, "descendant.pid");
      const descendantSource = [
        'const { appendFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        `appendFileSync(${JSON.stringify(heartbeatPath)}, "started\\n");`,
        `setInterval(() => appendFileSync(${JSON.stringify(heartbeatPath)}, "tick\\n"), 20);`,
      ].join(" ");
      const leaderSource = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const leader = spawnProcessTree(process.execPath, ["-e", leaderSource], {
        stdio: "ignore",
      });
      try {
        await waitFor(() => existsSync(descendantPidPath) && existsSync(heartbeatPath));
        const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
        expect(Number.isInteger(descendantPid)).toBe(true);

        await terminateProcessTree(leader, {
          gracefulTimeoutMs: 100,
          killTimeoutMs: 2_000,
        });
        const sizeAfterTermination = readFileSync(heartbeatPath, "utf8").length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(readFileSync(heartbeatPath, "utf8").length).toBe(sizeAfterTermination);
        expect(processExists(descendantPid)).toBe(false);
      } finally {
        await terminateProcessTree(leader, {
          gracefulTimeoutMs: 100,
          killTimeoutMs: 2_000,
        });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails visibly after stopping the root when descendants cannot be discovered",
    async () => {
      const originalPath = process.env.PATH;
      const originalKill = process.kill.bind(process);
      const leader = spawnProcessTree(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0) {
          const error = new Error("group signal denied");
          error.code = "EPERM";
          throw error;
        }
        return originalKill(pid, signal);
      });
      process.env.PATH = tmpdir();

      try {
        await expect(
          terminateProcessTree(leader, {
            gracefulTimeoutMs: 500,
            killTimeoutMs: 500,
          }),
        ).rejects.toThrow("could not be safely discovered or signaled");
        await waitFor(
          () => leader.exitCode !== null || leader.signalCode !== null,
        );
        expect(leader.signalCode).toBe("SIGTERM");
      } finally {
        process.env.PATH = originalPath;
        vi.restoreAllMocks();
        await terminateProcessTree(leader, {
          gracefulTimeoutMs: 100,
          killTimeoutMs: 500,
        });
      }
    },
  );
});

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("process-tree fixture did not become ready");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
