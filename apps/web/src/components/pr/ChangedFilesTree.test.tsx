import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChangedFileEntry } from "@loongboard/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { LocaleProvider, LOCALE_STORAGE_KEY } from "../../i18n";

const files: ChangedFileEntry[] = [
  {
    path: "src/features/badge.tsx",
    previousPath: null,
    changeType: "added",
    additions: 2,
    deletions: 0,
    binary: false,
  },
  {
    path: "src/app.ts",
    previousPath: null,
    changeType: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
  },
  {
    path: "src/legacy.ts",
    previousPath: null,
    changeType: "removed",
    additions: 0,
    deletions: 3,
    binary: false,
  },
  {
    path: "data.bin",
    previousPath: null,
    changeType: "added",
    additions: null,
    deletions: null,
    binary: true,
  },
];

function renderTree(selected = "src/app.ts") {
  const onSelect = vi.fn();
  const view = render(
    <ChangedFilesTree
      files={files}
      selected={selected}
      onSelect={onSelect}
    />,
  );
  return { onSelect, ...view };
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    } as Storage,
  });
});

describe("ChangedFilesTree", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    vi.clearAllMocks();
  });

  it("uses nested guide groups without duplicated spacer indentation", () => {
    const { container } = renderTree();
    expect(screen.getByRole("tree", { name: "Changed files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    expect(container.querySelectorAll(".pr-tree-row-indent")).toHaveLength(0);
    expect(container.querySelectorAll(".pr-tree-children").length).toBeGreaterThan(0);
    expect(container.querySelector(".pr-tree-dot")).toBeNull();
    expect(container.querySelector(".change-badge")).toBeNull();
    expect(container.querySelector(".change-file-icon--added")).not.toBeNull();
    expect(container.querySelector(".change-file-icon--modified")).not.toBeNull();
    expect(container.querySelector(".change-file-icon--removed")).not.toBeNull();

    const badge = screen.getByRole("button", {
      name: "Added src/features/badge.tsx",
    });
    expect(badge).toHaveAttribute("data-change-type", "added");
    expect(badge.closest("[role='treeitem']")).toHaveAttribute(
      "aria-level",
      "3",
    );
    expect(screen.getByRole("button", { name: "src" })).not.toHaveAttribute(
      "data-change-tone",
    );
  });

  it("leaves panel visibility controls to the persistent workbench toolbar", () => {
    renderTree();
    expect(screen.queryByRole("button", { name: /changed files/i })).toBeNull();
    expect(screen.getByRole("button", { name: "src" })).toBeInTheDocument();
  });

  it("keeps filtering, clearing, and file selection behavior intact", () => {
    const { onSelect } = renderTree();
    expect(
      screen.getByRole("button", { name: "Modified src/app.ts" }),
    ).toHaveClass("selected");

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), {
      target: { value: "badge" },
    });
    expect(
      screen.getByRole("button", { name: "Added src/features/badge.tsx" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Modified src/app.ts" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Added src/features/badge.tsx" }),
    );
    expect(onSelect).toHaveBeenCalledWith("src/features/badge.tsx");

    fireEvent.click(screen.getByRole("button", { name: "Clear file filter" }));
    expect(
      screen.getByRole("button", { name: "Modified src/app.ts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Added data.bin" }),
    ).toBeInTheDocument();
  });

  it("formats large change statistics with the active locale", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    render(
      <LocaleProvider>
        <ChangedFilesTree
          files={[
            {
              ...files[0],
              additions: 1_234_567,
              deletions: 2_345_678,
            },
          ]}
          selected={null}
          onSelect={() => undefined}
        />
      </LocaleProvider>,
    );

    const row = screen.getByRole("button", {
      name: "新增 src/features/badge.tsx",
    });
    expect(row).toHaveTextContent("+1,234,567");
    expect(row).toHaveTextContent("−2,345,678");
  });
});
