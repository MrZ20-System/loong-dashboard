import { describe, expect, it, vi } from "vitest";
import type { FileContent, ReadFileInput } from "@loongboard/git-workspace";

import { FileContentCache } from "../src/file-content-cache.js";

function content(input: ReadFileInput, text: string): FileContent {
  return {
    path: input.path,
    ref: input.ref,
    binary: false,
    tooLarge: false,
    sizeBytes: text.length,
    content: text,
  };
}

describe("FileContentCache", () => {
  it("coalesces concurrent reads and reuses immutable content", async () => {
    let release = (_value: FileContent) => {};
    const pending = new Promise<FileContent>((resolve) => {
      release = resolve;
    });
    const readFile = vi.fn(() => pending);
    const cache = new FileContentCache({ readFile });
    const input = {
      repositoryPath: "/repo",
      ref: "a".repeat(40),
      path: "src/a.ts",
    };

    const first = cache.get(input);
    const second = cache.get(input);
    expect(readFile).toHaveBeenCalledTimes(1);
    release(content(input, "const value = 1;"));

    await expect(first).resolves.toMatchObject({ content: "const value = 1;" });
    await expect(second).resolves.toMatchObject({ content: "const value = 1;" });
    await cache.get(input);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry when the bound is reached", async () => {
    const readFile = vi.fn(async (input: ReadFileInput) =>
      content(input, input.path),
    );
    const cache = new FileContentCache(
      { readFile },
      { maxEntries: 2, maxBytes: 10_000 },
    );
    const base = { repositoryPath: "/repo", ref: "b".repeat(40) };

    await cache.get({ ...base, path: "a.ts" });
    await cache.get({ ...base, path: "b.ts" });
    await cache.get({ ...base, path: "a.ts" });
    await cache.get({ ...base, path: "c.ts" });
    await cache.get({ ...base, path: "b.ts" });

    expect(readFile).toHaveBeenCalledTimes(4);
  });
});
