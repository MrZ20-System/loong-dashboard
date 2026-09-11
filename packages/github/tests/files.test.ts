import { describe, expect, it } from "vitest";

import {
  FILES_BATCH_SIZE,
  GhGitHubMetadataProvider,
  MAX_FILES_PER_PULL_REQUEST,
  normalizeChangeType,
  runWithConcurrency,
  type GitHubFetch,
  type GhGitHubMetadataProviderOptions,
} from "../src/index.js";

const repository = { owner: "acme", name: "rocket" } as const;
const graphQlUrl = "https://api.github.com/graphql";
const rateLimit = {
  cost: 1,
  remaining: 4_999,
  resetAt: "2024-06-11T00:00:00Z",
};

describe("pull request files provider", () => {
  it("batches at 20, preserves input order, and keeps GraphQL node ownership", async () => {
    const refs = Array.from({ length: 21 }, (_, index) => ({
      number: index + 1,
      nodeId: `PR_${index + 1}`,
    })).reverse();
    const responses = [
      graphQlFilesResponse(refs.slice(0, FILES_BATCH_SIZE)),
      graphQlFilesResponse(refs.slice(FILES_BATCH_SIZE)),
    ];
    const http = createFakeHttp(responses.map((body) => httpJson(body)));
    const provider = createProvider(http);

    const results = await provider.fetchPullRequestFiles({
      repository,
      pullRequests: refs,
    });

    expect(results.map((result) => result.number)).toEqual(
      refs.map((ref) => ref.number),
    );
    expect(results[0]?.files[0]).toMatchObject({
      path: "src/file-21.ts",
      changeType: "modified",
    });
    expect(http.calls).toHaveLength(2);
    expect(http.calls.every((call) => call.url === graphQlUrl)).toBe(true);
    expect(requestBody(http, 0).variables.ids).toEqual(
      refs.slice(0, FILES_BATCH_SIZE).map((ref) => ref.nodeId),
    );
    expect(requestBody(http, 1).variables.ids).toEqual(
      refs.slice(FILES_BATCH_SIZE).map((ref) => ref.nodeId),
    );
  });

  it("falls back to REST when GraphQL reports more than 100 files", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      restFile(index + 1),
    );
    const secondPage = [restFile(101, "old-name.ts")];
    const http = createFakeHttp([
      httpJson(graphQlFilesResponseFromNodes([
        graphQlFileNode(7, {
          hasNextPage: true,
          endCursor: "files-next",
        }),
      ])),
      httpJson(firstPage),
      httpJson(secondPage),
    ]);
    const provider = createProvider(http);

    const [result] = await provider.fetchPullRequestFiles({
      repository,
      pullRequests: [{ nodeId: "PR_7", number: 7 }],
    });

    expect(result).toMatchObject({ number: 7, truncated: false });
    expect(result?.files).toHaveLength(101);
    expect(result?.files[100]).toMatchObject({
      path: "src/file-101.ts",
      previousPath: "old-name.ts",
    });
    expect(http.calls.map((call) => call.url)).toEqual([
      graphQlUrl,
      "https://api.github.com/repos/acme/rocket/pulls/7/files?per_page=100&page=1",
      "https://api.github.com/repos/acme/rocket/pulls/7/files?per_page=100&page=2",
    ]);
  });

  it("stops at the 3000-file cap and marks the result truncated", async () => {
    const restPages = Array.from({ length: MAX_FILES_PER_PULL_REQUEST / 100 }, (_, page) =>
      httpJson(Array.from({ length: 100 }, (_, index) => restFile(page * 100 + index + 1))),
    );
    const http = createFakeHttp([
      httpJson(graphQlFilesResponseFromNodes([
        graphQlFileNode(9, { hasNextPage: true, endCursor: "files-next" }),
      ])),
      ...restPages,
    ]);
    const provider = createProvider(http);

    const [result] = await provider.fetchPullRequestFiles({
      repository,
      pullRequests: [{ nodeId: "PR_9", number: 9 }],
    });

    expect(result?.files).toHaveLength(MAX_FILES_PER_PULL_REQUEST);
    expect(result?.truncated).toBe(true);
    expect(http.calls).toHaveLength(1 + MAX_FILES_PER_PULL_REQUEST / 100);
  });

  it("keeps pure file helpers deterministic and rejects empty input without HTTP", async () => {
    expect(normalizeChangeType(" CHANGED ")).toBe("modified");
    expect(normalizeChangeType("DELETED")).toBe("removed");
    expect(normalizeChangeType("future-status")).toBe("future-status");
    await expect(runWithConcurrency([1, 2, 3], 2, async (value) => value * 2))
      .resolves.toEqual([2, 4, 6]);

    const http = createFakeHttp([]);
    const provider = createProvider(http);
    await expect(provider.fetchPullRequestFiles({
      repository,
      pullRequests: [],
    })).resolves.toEqual([]);
    expect(http.calls).toHaveLength(0);
  });
});

function createProvider(
  http: FakeHttp,
  extra: Partial<GhGitHubMetadataProviderOptions> = {},
): GhGitHubMetadataProvider {
  return new GhGitHubMetadataProvider({
    fetch: http.fetch,
    tokenResolver: async () => "test-token",
    ...extra,
  });
}

function graphQlFilesResponse(
  refs: readonly { readonly number: number; readonly nodeId: string }[],
): Record<string, unknown> {
  return graphQlFilesResponseFromNodes(refs.map((ref) => graphQlFileNode(ref.number)));
}

function graphQlFilesResponseFromNodes(
  nodes: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    data: {
      nodes,
      rateLimit,
    },
  };
}

function graphQlFileNode(
  number: number,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
): Record<string, unknown> {
  return {
    number,
    files: {
      nodes: [{
        path: `src/file-${number}.ts`,
        additions: 2,
        deletions: 1,
        changeType: "CHANGED",
      }],
      pageInfo,
    },
  };
}

function restFile(number: number, previousFilename?: string): Record<string, unknown> {
  return {
    filename: `src/file-${number}.ts`,
    status: number % 2 === 0 ? "modified" : "added",
    additions: 2,
    deletions: 1,
    ...(previousFilename === undefined ? {} : { previous_filename: previousFilename }),
  };
}

interface RecordedHttpRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

interface FakeHttp {
  readonly fetch: GitHubFetch;
  readonly calls: RecordedHttpRequest[];
}

function createFakeHttp(responses: readonly Response[]): FakeHttp {
  const calls: RecordedHttpRequest[] = [];
  const fetchImplementation: GitHubFetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = String(value);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error(`unexpected fake HTTP request ${calls.length}`);
    }
    return response;
  };
  return { fetch: fetchImplementation, calls };
}

function httpJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(
  http: FakeHttp,
  index: number,
): { query: string; variables: { ids: string[] } } {
  const body = http.calls[index]?.body;
  if (body === null || body === undefined) {
    throw new Error(`HTTP call ${index} has no body`);
  }
  return JSON.parse(body) as { query: string; variables: { ids: string[] } };
}
