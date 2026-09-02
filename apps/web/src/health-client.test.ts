import { describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./health-client";

describe("fetchHealth", () => {
  it("returns the shared health response for a valid API response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchHealth(fetchImpl)).resolves.toEqual({ status: "ok" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/health", {
      headers: { Accept: "application/json" },
    });
  });

  it("exposes transport failures instead of returning fake health", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("connection refused");
    });

    await expect(fetchHealth(fetchImpl)).rejects.toThrow(
      "GET /api/health failed: connection refused",
    );
  });

  it("exposes non-success HTTP responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(fetchHealth(fetchImpl)).rejects.toThrow(
      "GET /api/health failed with HTTP 503 Service Unavailable",
    );
  });

  it("rejects a successful response that violates the shared contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ status: "degraded" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchHealth(fetchImpl)).rejects.toThrow(
      "GET /api/health returned an invalid response",
    );
  });
});
