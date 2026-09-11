import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  GitHubClient,
} from "../src/github-client.js";

const repository = { owner: "acme", name: "rocket" } as const;
const rateLimit = {
  cost: 1,
  remaining: 4_999,
  resetAt: "2024-06-11T00:00:00Z",
};

describe("GitHubClient", () => {
  it("caches a resolved token until Settings explicitly clears it", async () => {
    let resolveCount = 0;
    const http = createFakeHttp([
      httpJson({ ok: true }),
      httpJson({ ok: true }),
      httpJson({ ok: true }),
    ]);
    const client = createClient(http, async () => {
      resolveCount += 1;
      return `token-${resolveCount}`;
    });

    await client.requestJson(repository, "PullRequests", "GET", "user", null);
    await client.requestJson(repository, "PullRequests", "GET", "user", null);
    client.clearTokenCache();
    await client.requestJson(repository, "PullRequests", "GET", "user", null);

    expect(resolveCount).toBe(2);
    expect(http.calls.map((call) => call.headers.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });

  it("normalizes GraphQL partial data into the public GraphQL error", async () => {
    const client = createClient(createFakeHttp([
      httpJson({
        data: { repository: { ignored: true } },
        errors: [{ message: "repository access denied", type: "FORBIDDEN" }],
      }),
    ]));

    await expect(
      client.runGraphQL(
        repository,
        "PullRequests",
        "query Test { viewer { login } }",
        {},
        // This schema intentionally models only the response envelope. The
        // transport must reject `errors` even when `data` is present.
        partialResponseSchema,
      ),
    ).rejects.toMatchObject({
      name: "GitHubGraphQLError",
      operation: "PullRequests",
      messages: ["repository access denied"],
      types: ["FORBIDDEN"],
    });
  });

  it("combines REST headers and GraphQL data into a safe connection projection", async () => {
    const http = createFakeHttp([
      httpJson({ login: "octocat", name: "The Octocat" }, 200, {
        "x-ratelimit-remaining": "4997",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": "1718064000",
      }),
      httpJson({
        data: { rateLimit: { ...rateLimit, limit: 5000 } },
      }),
    ]);
    const client = createClient(http);

    const status = await client.checkConnection();
    expect(status).toEqual({
      account: { login: "octocat", name: "The Octocat" },
      rest: {
        remaining: 4997,
        limit: 5000,
        resetAt: "2024-06-11T00:00:00.000Z",
      },
      graphql: {
        remaining: 4999,
        limit: 5000,
        resetAt: "2024-06-11T00:00:00Z",
      },
    });
    expect(http.calls.map((call) => call.url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/graphql",
    ]);
    expect(JSON.stringify(status)).not.toContain("test-token");
  });

  it("normalizes transport failures with operation and URL context", async () => {
    const http: FakeHttp = {
      calls: [],
      fetch: async () => {
        throw new Error("socket closed");
      },
    };
    const client = createClient(http);

    await expect(
      client.requestJson(repository, "Issues", "GET", "issues", null),
    ).rejects.toMatchObject({
      name: "GitHubHttpError",
      operation: "Issues",
      repository: "acme/rocket",
      method: "GET",
      url: "https://api.github.com/issues",
      status: null,
    });
  });
});

const partialResponseSchema = z
  .object({
    data: z.unknown().nullable().optional(),
    errors: z.array(
      z.object({ message: z.string(), type: z.string().optional() }).strict(),
    ).optional(),
  })
  .strict();

interface FakeHttp {
  readonly calls: Array<{
    readonly url: string;
    readonly headers: Record<string, string>;
  }>;
  readonly fetch: typeof fetch;
}

function createClient(
  http: FakeHttp,
  tokenResolver: () => string | null | Promise<string | null> = () => "test-token",
): GitHubClient {
  const client = new GitHubClient({
    ghExecutable: "gh",
    apiBaseUrl: "https://api.github.com",
    fetch: http.fetch,
    tokenResolver,
    commandTimeoutMs: 5_000,
    environment: {},
  });
  return client;
}

function createFakeHttp(responses: readonly Response[]): FakeHttp {
  const calls: Array<{
    readonly url: string;
    readonly headers: Record<string, string>;
  }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = String(value);
    }
    calls.push({ url: String(input), headers });
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error(`unexpected fake HTTP request ${calls.length}`);
    }
    return response;
  };
  return { calls, fetch: fetchImplementation };
}

function httpJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
