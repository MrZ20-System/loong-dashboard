import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workspaceRoot = dirname(fileURLToPath(import.meta.url));
const runningFromWorkspaceRoot = process.cwd() === workspaceRoot;

export default defineConfig({
  test: {
    include: runningFromWorkspaceRoot
      ? ["scripts/**/*.test.mjs", "tests/**/*.test.{ts,tsx,mjs}"]
      : ["test/**/*.test.{ts,tsx,mjs}", "tests/**/*.test.{ts,tsx,mjs}"],
    exclude: [
      "node_modules",
      "dist",
      "coverage",
    ],
    passWithNoTests: true,
  },
});
