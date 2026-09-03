#!/usr/bin/env node
"use strict";

const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

const realExecutable = requiredEnvironment("LOONGBOARD_REAL_GH");
const callLogPath = requiredEnvironment("LOONGBOARD_REAL_GH_CALL_LOG");

const inputChunks = [];
process.stdin.on("data", (chunk) => inputChunks.push(Buffer.from(chunk)));
process.stdin.on("end", () => {
  const child = spawn(realExecutable, process.argv.slice(2), {
    shell: false,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => {
    const buffer = Buffer.from(chunk);
    stdoutChunks.push(buffer);
    process.stdout.write(buffer);
  });
  child.stderr.on("data", (chunk) => {
    const buffer = Buffer.from(chunk);
    stderrChunks.push(buffer);
    process.stderr.write(buffer);
  });
  child.once("error", (error) => {
    appendCall({
      argv: process.argv.slice(2),
      exitCode: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: error.code ?? "spawn-failed",
    });
    process.exitCode = 127;
  });
  child.once("close", (exitCode, signal) => {
    appendCall({
      argv: process.argv.slice(2),
      exitCode,
      signal,
      stdoutBytes: Buffer.concat(stdoutChunks).byteLength,
      stderrBytes: Buffer.concat(stderrChunks).byteLength,
    });
    process.exitCode = exitCode ?? 1;
  });
  child.stdin.end(Buffer.concat(inputChunks));
});

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    process.stderr.write(`recording gh: ${name} is required\n`);
    process.exit(98);
  }
  return value;
}

function appendCall(record) {
  appendFileSync(
    callLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
    "utf8",
  );
}
