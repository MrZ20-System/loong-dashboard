import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fakeGhPath = join(testDirectory, "fake-gh.cjs");
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe("fake GitHub command fixture", () => {
  it("keeps the incremental generation across a cursor continuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-fake-gh-"));
    temporaryRoots.push(root);
    const fixturePath = join(root, "fixture.json");
    const callLogPath = join(root, "calls.ndjson");
    writeFileSync(fixturePath, JSON.stringify({
      version: 1,
      repositories: {
        alpha: {
          repositoryId: "alpha",
          github: "acme/alpha",
          streams: {
            "pulls|incremental-1|OPEN,CLOSED,MERGED": {
              pages: [
                { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next-page" } },
                { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              ],
            },
          },
        },
      },
      failures: [],
    }), "utf8");
    writeFileSync(callLogPath, "", "utf8");

    const statusServer = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ pullRequests: { watermarkUpdatedAt: "2026-09-03T00:00:00.000Z" } }));
    });
    await new Promise((resolvePromise, reject) => {
      statusServer.once("error", reject);
      statusServer.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = statusServer.address();
    if (!address || typeof address === "string") throw new Error("status server port was not numeric");
    const environment = {
      ...process.env,
      LOONGBOARD_FAKE_GH_FIXTURE: fixturePath,
      LOONGBOARD_FAKE_GH_CALL_LOG: callLogPath,
      LOONGBOARD_SERVER_ORIGIN: `http://127.0.0.1:${address.port}`,
    };

    try {
      const first = await runFakeGh(environment, {
        query: "query PullRequests { repository { pullRequests { nodes { id } } } }",
        variables: {
          owner: "acme",
          name: "alpha",
          states: ["OPEN", "CLOSED", "MERGED"],
          cursor: null,
        },
      });
      const second = await runFakeGh(environment, {
        query: "query PullRequests { repository { pullRequests { nodes { id } } } }",
        variables: {
          owner: "acme",
          name: "alpha",
          states: ["OPEN", "CLOSED", "MERGED"],
          cursor: "next-page",
        },
      });
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(second.stderr).toBe("");
      const calls = readFileSync(callLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call.generation)).toEqual([
        "incremental-1",
        "incremental-1",
      ]);
      expect(calls.map((call) => call.cursor)).toEqual([null, "next-page"]);
      expect(calls.every((call) => !Object.hasOwn(call, "query"))).toBe(true);
    } finally {
      await new Promise((resolvePromise) => statusServer.close(resolvePromise));
    }
  });
});

function runFakeGh(environment, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [fakeGhPath, "api", "graphql", "--input", "-"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (exitCode) => resolvePromise({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(JSON.stringify(input));
  });
}
