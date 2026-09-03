#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const fixturePath = requiredEnvironment("LOONGBOARD_FAKE_GH_FIXTURE");
const callLogPath = requiredEnvironment("LOONGBOARD_FAKE_GH_CALL_LOG");
const serverOrigin = process.env.LOONGBOARD_SERVER_ORIGIN;

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fake gh fixture failed: ${message}\n`);
  process.exitCode = 98;
});

async function main() {
  assertArguments(process.argv.slice(2));
  const input = await readStdin();
  const request = parseRequest(input);
  const operation = operationFor(request.query);
  const variables = request.variables;
  const owner = stringValue(variables.owner, "owner");
  const name = stringValue(variables.name, "name");
  const states = stateList(variables.states);
  const cursor = variables.cursor === null ? null : stringValue(variables.cursor, "cursor");
  const fixture = readJson(fixturePath);
  const repository = findRepository(fixture, owner, name);
  const records = readCallLog(callLogPath);
  const mode = isBootstrap(operation, states) ? "bootstrap" : "incremental";
  const generation = mode === "bootstrap"
    ? "bootstrap"
    : incrementalGeneration(records, repository.repositoryId, operation, states, cursor);
  const call = {
    at: new Date().toISOString(),
    repositoryId: repository.repositoryId,
    github: `${owner}/${name}`,
    operation,
    states,
    cursor,
    mode,
    generation,
  };

  const failure = findFailure(fixture.failures ?? [], call);
  appendCall(callLogPath, { ...call, outcome: failure ? "failure" : "success" });
  if (failure !== null) {
    process.stderr.write(`${failure.stderr}\n`);
    process.exitCode = failure.exitCode;
    return;
  }

  const streamKey = `${operation}|${generation}|${states.join(",")}`;
  const stream = repository.streams?.[streamKey];
  if (!stream) {
    throw new Error(`no fixture stream for ${call.github} ${streamKey}`);
  }
  const page = selectPage(stream.pages, cursor, call.github, streamKey);
  const watermark = mode === "incremental"
    ? await readWatermark(repository.repositoryId, operation)
    : null;
  const nodes = resolveDynamic(page.nodes, watermark);
  const payload = responseFor(operation, nodes, page.pageInfo);
  process.stdout.write(JSON.stringify(payload));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertArguments(argumentsList) {
  const expected = ["api", "graphql", "--input", "-"];
  if (argumentsList.length !== expected.length || argumentsList.some((value, index) => value !== expected[index])) {
    throw new Error("unexpected command arguments");
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function parseRequest(input) {
  let decoded;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new Error("request body is not JSON");
  }
  if (decoded === null || typeof decoded !== "object") {
    throw new Error("request body must be an object");
  }
  if (typeof decoded.query !== "string" || decoded.variables === null || typeof decoded.variables !== "object") {
    throw new Error("request body is missing query variables");
  }
  return decoded;
}

function operationFor(query) {
  if (query.includes("pullRequests")) return "pulls";
  if (query.includes("issues")) return "issues";
  throw new Error("unknown GraphQL operation");
}

function stringValue(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function stateList(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("states must be a string array");
  }
  return value;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read fixture control: ${reason}`);
  }
}

function readCallLog(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function appendCall(filePath, call) {
  fs.appendFileSync(filePath, `${JSON.stringify(call)}\n`, "utf8");
}

function findRepository(fixture, owner, name) {
  const github = `${owner}/${name}`;
  const repositories = Object.values(fixture.repositories ?? {});
  const repository = repositories.find((item) => item.github === github);
  if (!repository) throw new Error(`no fixture repository for ${github}`);
  return repository;
}

function isBootstrap(operation, states) {
  if (operation === "pulls") {
    return states.length === 1 && states[0] === "OPEN" ||
      states.length === 2 && states[0] === "CLOSED" && states[1] === "MERGED";
  }
  return states.length === 1 && (states[0] === "OPEN" || states[0] === "CLOSED");
}

function incrementalGeneration(records, repositoryId, operation, states, cursor) {
  if (cursor !== null) {
    const root = [...records].reverse().find((record) =>
      record.repositoryId === repositoryId &&
      record.operation === operation &&
      record.mode === "incremental" &&
      record.cursor === null &&
      Array.isArray(record.states) &&
      record.states.join(",") === states.join(","),
    );
    if (root?.generation) return root.generation;
    throw new Error("incremental cursor has no root generation");
  }
  const rootCalls = records.filter((record) =>
    record.repositoryId === repositoryId &&
    record.operation === operation &&
    record.mode === "incremental" &&
    record.cursor === null &&
    Array.isArray(record.states) &&
    record.states.join(",") === states.join(","),
  ).length;
  return `incremental-${rootCalls + 1}`;
}

function findFailure(failures, call) {
  return failures.find((failure) =>
    failure.repositoryId === call.repositoryId &&
    failure.operation === call.operation &&
    failure.generation === call.generation &&
    failure.states === call.states.join(",") &&
    (failure.cursor ?? null) === call.cursor,
  ) ?? null;
}

function selectPage(pages, cursor, github, streamKey) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(`fixture stream is empty for ${github} ${streamKey}`);
  }
  if (cursor === null) return pages[0];
  const previousIndex = pages.findIndex((page) => page.pageInfo?.endCursor === cursor);
  if (previousIndex < 0 || previousIndex + 1 >= pages.length) {
    throw new Error(`unknown fixture cursor for ${github} ${streamKey}`);
  }
  return pages[previousIndex + 1];
}

async function readWatermark(repositoryId, operation) {
  if (typeof serverOrigin !== "string" || serverOrigin.length === 0) {
    throw new Error("LOONGBOARD_SERVER_ORIGIN is required for incremental fixtures");
  }
  const response = await fetch(`${serverOrigin}/api/repositories/${encodeURIComponent(repositoryId)}/sync-status`);
  if (!response.ok) {
    throw new Error(`sync status returned HTTP ${response.status}`);
  }
  const body = await response.json();
  const state = operation === "pulls" ? body.pullRequests : body.issues;
  if (state === null || typeof state !== "object" || typeof state.watermarkUpdatedAt !== "string") {
    throw new Error("sync status did not expose a previous watermark");
  }
  return state.watermarkUpdatedAt;
}

function resolveDynamic(value, watermark) {
  if (Array.isArray(value)) return value.map((item) => resolveDynamic(item, watermark));
  if (value !== null && typeof value === "object") {
    if (value.$timestamp === "watermark") {
      if (watermark === null) throw new Error("watermark is unavailable");
      const offsetMs = Number(value.offsetMs);
      if (!Number.isInteger(offsetMs)) throw new Error("fixture timestamp offset must be an integer");
      return new Date(Date.parse(watermark) + offsetMs).toISOString();
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDynamic(item, watermark)]));
  }
  return value;
}

function responseFor(operation, nodes, pageInfo) {
  const rateLimit = {
    cost: 1,
    remaining: 4_999,
    resetAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  };
  return {
    data: {
      repository: operation === "pulls"
        ? { pullRequests: { nodes, pageInfo } }
        : { issues: { nodes, pageInfo } },
      rateLimit,
    },
  };
}
