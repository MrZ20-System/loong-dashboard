import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_REQUIRED_EVENT } from "./auth-required-event";
import {
  fetchPersonalDataSettings,
  fetchRecoverableRepositoryOnboarding,
  fetchRepositorySettings,
  importPersonalData,
  pushPersonalData,
  refreshPersonalDataInstructionTree,
  retryRepositoryOnboarding,
  runPersonalDataCheckpoint,
  updatePersonalDataSettings,
} from "./settings-client";

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

describe("repository onboarding client", () => {
  it("fetches the bounded recoverable list", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ items: [] }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRecoverableRepositoryOnboarding()).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/repository-onboarding", expect.objectContaining({
      headers: { Accept: "application/json" },
    }));
  });

  it("sends only the optional default branch override when retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ jobId: "job-1", status: "queued" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await retryRepositoryOnboarding("job/1", { defaultBranch: "master" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/repository-onboarding/job%2F1/retry", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ defaultBranch: "master" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    }));

    await retryRepositoryOnboarding("job-1");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/repository-onboarding/job-1/retry", expect.objectContaining({
      method: "POST",
      headers: { Accept: "application/json" },
    }));
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("body");
  });
});

describe("Personal Data client", () => {
  it("uses canonical endpoints and preserves the import contract", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(json({ path: "/workspace/personal-data", knowledgePath: "/workspace/personal-data/knowledge", instructionTreePath: "/workspace/personal-data/knowledge/_loongboard/instruction-tree.md", available: true, automaticCheckpoint: false, automaticPush: false, remote: "origin", sourceRef: "main", remoteBranch: "loongboard-personal-data-backup", checkpointCron: "0 0 * * *", pushCron: "0 0 * * *" }, 200))
      .mockResolvedValueOnce(json({ path: "knowledge/_loongboard/instruction-tree.md", updatedAt: "2026-09-14T00:00:00.000Z" }, 200))
      .mockResolvedValueOnce(json({ path: "/workspace/personal-data", knowledgePath: "/workspace/personal-data/knowledge", instructionTreePath: "/workspace/personal-data/knowledge/_loongboard/instruction-tree.md", available: true }, 200))
      .mockResolvedValueOnce(json({ saved: true }, 200))
      .mockResolvedValueOnce(json({ saved: true }, 200))
      .mockResolvedValueOnce(json({ path: "/workspace/personal-data", knowledgePath: "/workspace/personal-data/knowledge", instructionTreePath: "/workspace/personal-data/knowledge/_loongboard/instruction-tree.md", available: true, automaticCheckpoint: false, automaticPush: false, remote: "origin", sourceRef: "main", remoteBranch: "loongboard-personal-data-backup", checkpointCron: "0 0 * * *", pushCron: "0 0 * * *" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPersonalDataSettings()).resolves.toMatchObject({ path: "/workspace/personal-data" });
    await expect(refreshPersonalDataInstructionTree()).resolves.toEqual({ accepted: true });
    await expect(importPersonalData({ repositoryUrl: "https://github.com/acme/personal-data.git", branch: "profile/z20" })).resolves.toEqual({ accepted: true });
    await expect(runPersonalDataCheckpoint()).resolves.toEqual({ accepted: true });
    await expect(pushPersonalData()).resolves.toEqual({ accepted: true });
    await expect(updatePersonalDataSettings({ sourceRef: "main" })).resolves.toMatchObject({ path: "/workspace/personal-data" });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/settings/personal-data",
      "/api/settings/personal-data/instruction-tree/refresh",
      "/api/settings/personal-data/import",
      "/api/settings/personal-data/checkpoint",
      "/api/settings/personal-data/push",
      "/api/settings/personal-data",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ repositoryUrl: "https://github.com/acme/personal-data.git", branch: "profile/z20" }),
    }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("body");
  });
});
