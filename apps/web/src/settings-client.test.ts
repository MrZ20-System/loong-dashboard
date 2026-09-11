import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_REQUIRED_EVENT } from "./auth-required-event";
import { fetchRepositorySettings } from "./settings-client";

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings client auth boundary", () => {
  it("dispatches auth-required for a matching 401 and preserves the request error", async () => {
    const onAuthRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        json({ error: { code: "AUTH_REQUIRED", message: "Unlock required" } }, 401),
      ),
    );
    try {
      await expect(fetchRepositorySettings("repo")).rejects.toThrow(
        "GET /api/repositories/repo/settings failed with HTTP 401",
      );
      expect(onAuthRequired).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    }
  });

  it("does not dispatch auth-required for other 401 errors", async () => {
    const onAuthRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        json({ error: { code: "INTERNAL_ERROR", message: "Failure" } }, 401),
      ),
    );
    try {
      await expect(fetchRepositorySettings("repo")).rejects.toThrow(
        "GET /api/repositories/repo/settings failed with HTTP 401: Failure",
      );
      expect(onAuthRequired).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    }
  });
});
