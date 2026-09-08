import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangedFileEntry } from "@loongboard/contracts";

import {
  prefetchChangedFileContents,
  prFileQueryOptions,
} from "./pr-file-cache";

const mergeBase = "a".repeat(40);
const headSha = "b".repeat(40);

function file(
  path: string,
  changeType: ChangedFileEntry["changeType"],
  binary = false,
): ChangedFileEntry {
  return {
    path,
    previousPath: null,
    changeType,
    additions: binary ? null : 1,
    deletions: binary ? null : 1,
    binary,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PR immutable file cache", () => {
  it("prefetches every text side once and reuses it by SHA", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.searchParams.get("path") ?? "";
      const ref = url.searchParams.get("ref") ?? "";
      return new Response(
        JSON.stringify({
          path,
          ref,
          binary: false,
          tooLarge: false,
          sizeBytes: path.length,
          content: path,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const files = [
      file("modified.ts", "modified"),
      file("added.ts", "added"),
      file("removed.ts", "removed"),
      file("asset.bin", "added", true),
    ];

    await expect(
      prefetchChangedFileContents(client, {
        repositoryId: "repo",
        number: 7,
        files,
        mergeBase,
        headSha,
        concurrency: 2,
      }),
    ).resolves.toEqual({ loaded: 4, failed: 0, budgetReached: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await client.fetchQuery(
      prFileQueryOptions("repo", 7, "modified.ts", headSha),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    client.clear();
  });

  it("stops scheduling new reads after reaching the memory budget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input), "http://localhost");
        const path = url.searchParams.get("path") ?? "";
        const ref = url.searchParams.get("ref") ?? "";
        return new Response(
          JSON.stringify({
            path,
            ref,
            binary: false,
            tooLarge: false,
            sizeBytes: 100,
            content: "x".repeat(100),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const result = await prefetchChangedFileContents(client, {
      repositoryId: "repo",
      number: 8,
      files: [file("one.ts", "added"), file("two.ts", "added")],
      mergeBase,
      headSha,
      concurrency: 1,
      budgetBytes: 1,
    });

    expect(result).toEqual({ loaded: 1, failed: 0, budgetReached: true });
    client.clear();
  });
});
