import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardPage } from "./BoardPage";

const repositories = [
  {
    id: "loongboard",
    key: "loongboard",
    displayName: "LoongBoard",
    githubOwner: "acme",
    githubName: "loongboard",
    localPath: "/tmp/loongboard",
    remoteName: "origin",
    defaultBranch: "main",
    worktreeSlots: 1,
    enabled: true,
  },
  {
    id: "vllm-ascend",
    key: "vllm-ascend",
    displayName: "vLLM Ascend",
    githubOwner: "vllm-project",
    githubName: "vllm-ascend",
    localPath: "/tmp/vllm-ascend",
    remoteName: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
    enabled: true,
  },
] as const;

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("Board repository navigation", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("navigates to the repository selected in the main selector", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => json({ items: repositories })),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <BoardPage />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const selector = await screen.findByRole("combobox", { name: "Repository" });
    fireEvent.change(selector, { target: { value: "vllm-ascend" } });

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/repositories/vllm-ascend",
    );
  });

  it("keeps repository cards as overview without repeated action links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => json({ items: repositories })),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <BoardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const repositoryName = await screen.findByText("vLLM Ascend");
    const board = repositoryName.closest(".repository-board");
    expect(board).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Repository overview" })).toBeInTheDocument();
    expect(board?.querySelector("nav")).toBeNull();
  });
});
