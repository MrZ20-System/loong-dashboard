import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOMAIN_UPDATE_PROMPT } from "@loongboard/contracts";
import { App, appQueryClient } from "./App";
import { LOCALE_STORAGE_KEY } from "./i18n";

const repository = {
  id: "repo", key: "repo", displayName: "LoongBoard", githubOwner: "acme", githubName: "project",
  localPath: "/tmp/project", remoteName: "origin", defaultBranch: "main", worktreeSlots: 1, enabled: true, mergedPullRequestCount: 0,
};

const ciRule = { id: "dom_ci", repositoryId: "repo", name: "CI", color: "#5b8def", position: 0, enabled: true, includePatterns: [".github/**"], excludePatterns: [], createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" };
const docsRule = { id: "dom_docs", repositoryId: "repo", name: "Docs", color: "#2fbf71", position: 1, enabled: true, includePatterns: ["docs/**"], excludePatterns: [], createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" };

const pull = (number: number, domains: Array<{ id: string; name: string; color: string }>) => ({
  repositoryId: "repo", number, title: `Pull ${number}`, url: `https://github.com/acme/project/pull/${number}`,
  authorLogin: "author", status: "open" as const, updatedAt: "2026-09-03T02:03:04.000Z",
  changedFilesCount: 1, additions: 2, deletions: 1, domains,
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } as Storage,
  });
}

function mockApi(options: { pulls?: unknown[]; domains?: unknown[]; reclassification?: { running: boolean; pendingCount: number | null }; domainMutationError?: string } = {}) {
  let promptContent = "User-authored prompt Ω";
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/auth/status") return json({ enabled: false, unlocked: true });
    if (url.pathname === "/api/repositories") return json({ items: [repository] });
    if (url.pathname.endsWith("/domains/prompt")) {
      if (init?.method === "PUT") promptContent = JSON.parse(String(init.body)).content as string;
      return json({ path: "prompts/update-domains.md", content: promptContent, version: init?.method === "PUT" ? 2 : 1, hash: "prompt-hash" });
    }
    if (url.pathname.endsWith("/domains/source")) return json({ path: "domains.json", content: '{"domains":[]}', version: 1, hash: "source-hash" });
    if (url.pathname.endsWith("/domains/source/versions")) return json({ items: [] });
    if (url.pathname.endsWith("/domains")) {
      if (init?.method === "POST") {
        if (options.domainMutationError !== undefined) {
          return json({ error: { code: "INTERNAL_ERROR", message: options.domainMutationError } }, 500);
        }
        const body = JSON.parse(String(init.body)) as { name: string; color: string; includePatterns: string[]; excludePatterns: string[]; enabled: boolean };
        return json({
          item: { id: "dom_new", repositoryId: "repo", position: 0, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z", ...body },
          reclassification: { running: true, pendingCount: 1 },
        });
      }
      return json({ items: options.domains ?? [], reclassification: options.reclassification ?? { running: false, pendingCount: null } });
    }
    if (url.pathname.endsWith("/pulls")) return json({ items: options.pulls ?? [], page: 1, pageSize: 100, totalCount: (options.pulls ?? []).length, totalPages: 1, calendarTimeZone: "Asia/Shanghai" });
    return json({ error: { code: "INTERNAL_ERROR", message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

describe("domain classification UI", () => {
  beforeEach(() => {
    installStorage();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("renders domain chips on PR rows and toggles repeated domain URL filters", async () => {
    const fetchMock = mockApi({
      pulls: [pull(2, [{ id: "dom_ci", name: "CI", color: "#5b8def" }]), pull(1, [])],
      domains: [ciRule, docsRule],
    });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Pull 2")).toBeInTheDocument();
    expect(screen.getByText("CI")).toBeInTheDocument();
    const domainsFilter = await screen.findByRole("button", { name: /Domains All domains/ });
    fireEvent.click(domainsFilter);
    fireEvent.click(screen.getByRole("option", { name: /Docs/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("domain=dom_docs"))).toBe(true));
    expect(screen.getByRole("option", { name: /Docs/ })).toHaveAttribute("aria-selected", "true");
    // selecting two rules keeps both repeated params (ANY semantics)
    fireEvent.click(screen.getByRole("option", { name: /CI/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("domain=dom_ci&domain=dom_docs") || String(input).includes("domain=dom_docs&domain=dom_ci"))).toBe(true));
  });

  it("shows the reclassification hint only while a run is active", async () => {
    mockApi({ pulls: [pull(2, [])], domains: [ciRule], reclassification: { running: true, pendingCount: 3 } });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    expect(await screen.findByText("Reclassifying…")).toBeInTheDocument();
  });

  it("uses the selected locale for fixed reclassification UI", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    mockApi({ pulls: [pull(2, [])], domains: [ciRule], reclassification: { running: true, pendingCount: 3 } });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    expect(await screen.findByText("正在重新分类…")).toBeInTheDocument();
  });

  it("creates a domain rule from the settings page", async () => {
    const fetchMock = mockApi({ domains: [] });
    renderApp("/settings/domains");
    expect(await screen.findByRole("heading", { name: "Domain rules" })).toBeInTheDocument();
    const settingsSections = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(settingsSections).getByRole("link", { name: "Agent" })).toHaveAttribute("href", "/settings/agent");
    expect(within(settingsSections).getByRole("link", { name: "Domains" })).toHaveAttribute("href", "/settings/domains");
    expect(screen.getByPlaceholderText("Documentation")).toBeInTheDocument();
    expect(screen.getByLabelText("Include patterns")).toHaveAttribute(
      "placeholder",
      "docs/**\nREADME.md",
    );
    expect(screen.getByLabelText("Exclude patterns")).toHaveAttribute(
      "placeholder",
      "docs/generated/**\n**/*.snap",
    );
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "CI" } });
    fireEvent.change(screen.getByLabelText("Include patterns"), { target: { value: ".github/**\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/domains") && init?.method === "POST");
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: "CI", color: expect.any(String), includePatterns: [".github/**"], excludePatterns: [], enabled: true });
    });
    expect(await screen.findByText("Rule created.")).toBeInTheDocument();
  });

  it("keeps Chinese domain mutation errors as alerts with raw details", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    mockApi({ domains: [], domainMutationError: "raw domain mutation detail" });
    renderApp("/settings/domains");
    expect(await screen.findByRole("heading", { name: "领域规则" })).toBeInTheDocument();
    const settingsSections = await screen.findByRole("navigation", { name: "设置分区" });
    expect(within(settingsSections).getByRole("link", { name: "智能代理" })).toHaveAttribute("href", "/settings/agent");
    expect(within(settingsSections).getByRole("link", { name: "领域" })).toHaveAttribute("href", "/settings/domains");
    fireEvent.change(screen.getByLabelText("规则名称"), { target: { value: "CI" } });
    fireEvent.change(screen.getByLabelText("包含模式"), { target: { value: ".github/**\n" } });
    fireEvent.click(screen.getByRole("button", { name: "创建规则" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("保存失败：");
    expect(alert).toHaveTextContent("raw domain mutation detail");
  });

  it("keeps the prompt read-only until editing, persists saves, and restores the canonical default", async () => {
    const fetchMock = mockApi();
    renderApp("/settings/domains");
    await screen.findByRole("heading", { name: "Domain rules" });
    fireEvent.click(screen.getByRole("tab", { name: "Agent update" }));
    const prompt = await screen.findByRole("textbox", { name: "Domain update prompt" });
    await waitFor(() => expect(prompt).toHaveValue("User-authored prompt Ω"));
    expect(prompt).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Use English built-in template" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Chinese built-in template" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(prompt).not.toHaveAttribute("readonly");
    fireEvent.change(prompt, { target: { value: "User-edited prompt" } });
    const putCount = () => fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/domains/prompt") && init?.method === "PUT").length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putCount()).toBe(1));
    expect(prompt).toHaveValue("User-edited prompt");
    expect(prompt).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(putCount()).toBe(2));
    expect(prompt).toHaveValue(DEFAULT_DOMAIN_UPDATE_PROMPT);
    expect(prompt).toHaveAttribute("readonly");
    expect(screen.getByText("Default update prompt restored and saved.")).toBeInTheDocument();
    expect(screen.getByText("LoongBoard (acme/project)")).toBeInTheDocument();
    expect(screen.getByText(/prompts\/update-domains\.md/)).toBeInTheDocument();
  });

  it("keeps the color swatch and hex input aligned and rejects invalid colors", async () => {
    const fetchMock = mockApi({ domains: [] });
    renderApp("/settings/domains");
    await screen.findByRole("heading", { name: "Domain rules" });
    const picker = screen.getByLabelText("Rule color");
    const hex = screen.getByLabelText("Rule color hex value");
    expect(picker).toHaveValue("#5b8def");
    fireEvent.change(hex, { target: { value: "#12" } });
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(picker).toHaveValue("#5b8def");
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "CI" } });
    fireEvent.change(screen.getByLabelText("Include patterns"), { target: { value: ".github/**" } });
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("six-digit hexadecimal");
    fireEvent.change(hex, { target: { value: "#aabbcc" } });
    fireEvent.change(picker, { target: { value: "#123456" } });
    expect(hex).toHaveValue("#123456");
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/domains") && init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body)).color).toBe("#123456");
    });
  });
});
