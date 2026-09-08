import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePage } from "./knowledge";
import { AppThemeContext, KnowledgeEditor } from "./knowledge-editor";

const editorMocks = vi.hoisted(() => {
  const create = vi.fn();
  const updateOptions = vi.fn();
  const dispose = vi.fn();
  const setValue = vi.fn();
  const getValue = vi.fn(() => "");
  const onDidChangeModelContent = vi.fn(() => ({ dispose: vi.fn() }));
  return { create, updateOptions, dispose, setValue, getValue, onDidChangeModelContent };
});

vi.mock("monaco-editor", () => ({
  editor: {
    create: editorMocks.create,
  },
}));

vi.mock(
  "../node_modules/monaco-editor/esm/vs/basic-languages/monaco.contribution.js",
  () => ({}),
);

function renderEditor(theme: "light" | "dark") {
  return render(
    <AppThemeContext.Provider value={theme}>
      <KnowledgeEditor value="# Knowledge" onChange={() => undefined} />
    </AppThemeContext.Provider>,
  );
}

describe("KnowledgeEditor theme propagation", () => {
  beforeEach(() => {
    editorMocks.create.mockImplementation(() => ({
      onDidChangeModelContent: editorMocks.onDidChangeModelContent,
      getValue: editorMocks.getValue,
      setValue: editorMocks.setValue,
      dispose: editorMocks.dispose,
      updateOptions: editorMocks.updateOptions,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates Monaco with vs when the shell theme is light", async () => {
    renderEditor("light");

    await waitFor(() => expect(editorMocks.create).toHaveBeenCalledTimes(1));
    const options = editorMocks.create.mock.calls[0]?.[1] as { theme: string };
    expect(options.theme).toBe("vs");
  });

  it("creates Monaco with vs-dark when the shell theme is dark", async () => {
    renderEditor("dark");

    await waitFor(() => expect(editorMocks.create).toHaveBeenCalledTimes(1));
    const options = editorMocks.create.mock.calls[0]?.[1] as { theme: string };
    expect(options.theme).toBe("vs-dark");
  });

  it("updates a mounted Monaco editor when the shell theme changes", async () => {
    const view = renderEditor("light");
    await waitFor(() => expect(editorMocks.create).toHaveBeenCalledTimes(1));

    view.rerender(
      <AppThemeContext.Provider value="dark">
        <KnowledgeEditor value="# Knowledge" onChange={() => undefined} />
      </AppThemeContext.Provider>,
    );

    await waitFor(() =>
      expect(editorMocks.updateOptions).toHaveBeenCalledWith({ theme: "vs-dark" }),
    );
  });

  it("does not show a Board return link beside the Knowledge title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/knowledge"]}>
          <KnowledgePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const title = await screen.findByRole("heading", { name: "Markdown repository" });
    const pageHeading = title.closest(".page-heading");
    expect(pageHeading).not.toBeNull();
    expect(within(pageHeading as HTMLElement).queryByRole("link", { name: "Board" })).not.toBeInTheDocument();
  });
});
