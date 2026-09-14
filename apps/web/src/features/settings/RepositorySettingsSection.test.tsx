import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider, translate } from "../../i18n";
import type { RepositoryOnboarding } from "../../settings-client";
import { onboardingFailure, OnboardingProgress, RepositoryOnboardingCard, repositoryDefaultsFromUrl } from "./RepositorySettingsSection";

const settingsMocks = vi.hoisted(() => ({
  createRepositoryOnboarding: vi.fn(),
  fetchRepositoryOnboarding: vi.fn(),
  fetchRecoverableRepositoryOnboarding: vi.fn(),
  retryRepositoryOnboarding: vi.fn(),
  cancelRepositoryOnboarding: vi.fn(),
}));

vi.mock("../../settings-client", async () => {
  const actual = await vi.importActual<typeof import("../../settings-client")>("../../settings-client");
  return { ...actual, ...settingsMocks };
});

afterEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.removeItem("loongboard.repository-onboarding.jobId");
  vi.restoreAllMocks();
});

beforeEach(() => {
  settingsMocks.fetchRecoverableRepositoryOnboarding.mockResolvedValue({ items: [] });
});

function onboardingJob(overrides: Partial<RepositoryOnboarding> = {}): RepositoryOnboarding {
  return { jobId: "job-1", status: "ready", step: "ready", detail: "Ready", progress: 100, repositoryId: "repo", githubMetadataPending: false, input: { github: "owner/repo", cloneUrl: "https://github.com/owner/repo.git", key: "owner-repo", displayName: "repo", remoteName: "upstream", defaultBranch: "main", targetPath: "/data/repositories/repo", worktreeSlots: 10 }, error: null, createdAt: "2026-09-13T00:00:00.000Z", startedAt: "2026-09-13T00:00:00.000Z", finishedAt: "2026-09-13T00:00:01.000Z", updatedAt: "2026-09-13T00:00:01.000Z", ...overrides };
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<LocaleProvider><QueryClientProvider client={queryClient}><MemoryRouter><RepositoryOnboardingCard /></MemoryRouter></QueryClientProvider></LocaleProvider>);
}

describe("repository onboarding", () => {
  it("derives defaults for all supported GitHub URL forms", () => {
    expect(repositoryDefaultsFromUrl("https://github.com/vllm-project/vllm.git")).toMatchObject({ owner: "vllm-project", name: "vllm", worktreeSlots: 10, syncLookbackDays: 7 });
    expect(repositoryDefaultsFromUrl("git@github.com:vllm-project/vllm-ascend.git")?.key).toBe("vllm-project-vllm-ascend");
    expect(repositoryDefaultsFromUrl("vllm-project/vllm")?.displayName).toBe("vllm");
  });

  it("submits 10 worktree slots and a fixed seven-day sync window, preserving input while locale changes", async () => {
    settingsMocks.createRepositoryOnboarding.mockResolvedValue({ jobId: "job-1" });
    settingsMocks.fetchRepositoryOnboarding.mockReturnValue(new Promise(() => undefined));
    renderCard();
    const input = screen.getByLabelText("GitHub URL");
    fireEvent.change(input, { target: { value: "owner/repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
    await waitFor(() => expect(settingsMocks.createRepositoryOnboarding).toHaveBeenCalledWith(expect.objectContaining({ url: "owner/repo", remote: "upstream", defaultBranch: "main", worktreeSlots: 10 })));
    expect(input).toHaveValue("owner/repo");
  });

  it("updates auto-derived fields when the URL changes, but preserves fields edited by the user", () => {
    renderCard();
    const input = screen.getByLabelText("GitHub URL");
    fireEvent.change(input, { target: { value: "vllm-project/vllm" } });
    fireEvent.click(screen.getByText("Advanced settings"));
    expect(screen.getByLabelText("Display name")).toHaveValue("vllm");
    expect(screen.getByLabelText("Repository key")).toHaveValue("vllm-project-vllm");
    fireEvent.change(input, { target: { value: "vllm-project/vllm-ascend" } });
    expect(screen.getByLabelText("Display name")).toHaveValue("vllm-ascend");
    expect(screen.getByLabelText("Repository key")).toHaveValue("vllm-project-vllm-ascend");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "My repository" } });
    fireEvent.change(input, { target: { value: "owner/another" } });
    expect(screen.getByLabelText("Display name")).toHaveValue("My repository");
    expect(screen.getByLabelText("Repository key")).toHaveValue("owner-another");
  });

  it("renders credential-pending ready state and retry/cancel actions with the original detail", () => {
    const retry = vi.fn();
    const cancel = vi.fn();
    const job = onboardingJob({ githubMetadataPending: true });
    render(<LocaleProvider><MemoryRouter><OnboardingProgress job={job} onRetry={retry} onCancel={cancel} retrying={false} cancelling={false} /></MemoryRouter></LocaleProvider>);
    expect(screen.getByText(/Code is connected/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configure GitHub access" })).toHaveAttribute("href", "/settings/integrations");
    fireEvent.click(screen.getByRole("button", { name: "Credentials configured — continue first sync" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("exposes retry with an editable branch and limits cancel to the pre-registration phases", () => {
    const retry = vi.fn();
    const cancel = vi.fn();
    const { rerender } = render(<LocaleProvider><MemoryRouter><OnboardingProgress job={onboardingJob({ status: "failed", step: "failed", detail: "remote denied", progress: 0, repositoryId: null, error: { code: "REMOTE_DENIED", message: "remote denied", retryable: true } })} onRetry={retry} onCancel={cancel} retrying={false} cancelling={false} /></MemoryRouter></LocaleProvider>);
    expect(screen.getByLabelText("Default branch for retry")).toHaveValue("main");
    fireEvent.change(screen.getByLabelText("Default branch for retry"), { target: { value: "master" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("master");
    rerender(<LocaleProvider><MemoryRouter><OnboardingProgress job={onboardingJob({ status: "cloning", step: "cloning", detail: "Cloning", progress: 20, repositoryId: null })} onRetry={retry} onCancel={cancel} retrying={false} cancelling={false} /></MemoryRouter></LocaleProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
    rerender(<LocaleProvider><MemoryRouter><OnboardingProgress job={onboardingJob({ status: "registering", step: "registering", detail: "Registering", progress: 60, repositoryId: null })} onRetry={retry} onCancel={cancel} retrying={false} cancelling={false} /></MemoryRouter></LocaleProvider>);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.getByText("Repository registration has started and can no longer be cancelled.")).toBeInTheDocument();
    expect(screen.queryByText(/Repository onboarding failed:/)).not.toBeInTheDocument();
  });

  it("recovers the newest active or failed job when no stored job is available", async () => {
    const recovered = onboardingJob({ status: "failed", step: "failed", detail: "remote denied", progress: 0, repositoryId: null, updatedAt: "2026-09-13T02:00:00.000Z", error: { code: "REMOTE_DENIED", message: "remote denied", retryable: true } });
    settingsMocks.fetchRecoverableRepositoryOnboarding.mockResolvedValue({ items: [recovered] });
    settingsMocks.fetchRepositoryOnboarding.mockResolvedValue(recovered);
    renderCard();
    await waitFor(() => expect(settingsMocks.fetchRecoverableRepositoryOnboarding).toHaveBeenCalledOnce());
    expect(await screen.findByText(/remote denied/)).toBeInTheDocument();
    expect(window.sessionStorage.getItem("loongboard.repository-onboarding.jobId")).toBe("job-1");
  });

  it("maps a default-branch failure to the bilingual retry guidance", () => {
    expect(onboardingFailure(
      (localizedMessage, values) => translate("zh-CN", localizedMessage, values),
      new Error('POST /api/repository-onboarding/job-1/retry failed with HTTP 409: default branch "main" does not exist'),
      "main",
    )).toBe('默认分支 "main" 不存在。请修改默认分支后重试。');
  });

  it("keeps onboarding steps and duplicate-repository feedback fully localized in Chinese", () => {
    expect(onboardingFailure(
      (localizedMessage, values) => translate("zh-CN", localizedMessage, values),
      new Error("POST /api/repositories failed with HTTP 409: Repository key or GitHub repository is already configured: owner-repo"),
    )).toBe("仓库接入失败：该 GitHub 仓库或仓库键已接入（owner-repo）。");
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("zh-CN");
    render(<LocaleProvider><MemoryRouter><OnboardingProgress job={onboardingJob({ status: "cloning", step: "cloning", detail: "", progress: 20, repositoryId: null })} onRetry={vi.fn()} onCancel={vi.fn()} retrying={false} cancelling={false} /></MemoryRouter></LocaleProvider>);
    expect(screen.getAllByText("克隆 / 复用").length).toBeGreaterThan(0);
  });
});
