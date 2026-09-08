import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChangedFileEntry } from "@loongboard/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangedFilesTree } from "./ChangedFilesTree";

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

describe("ChangedFilesTree", () => {
  afterEach(() => {
    cleanup();
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
});
