import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangedFileEntry } from "@loongboard/contracts";
import {
  buildRepositoryTree,
  RepositoryTree,
} from "./RepositoryTree";

function changedFile(
  overrides: Partial<ChangedFileEntry>,
): ChangedFileEntry {
  return {
    path: "src/a.ts",
    previousPath: null,
    changeType: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    ...overrides,
  };
}

const headFiles = [
  "README.md",
  "src/a.ts",
  "src/keep.ts",
  "src/removed-folder/kept.txt",
];

const changedFiles = [
  changedFile({ path: "src/a.ts", changeType: "modified" }),
  changedFile({
    path: "src/removed-folder/gone.txt",
    changeType: "removed",
  }),
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RepositoryTree", () => {
  it("decorates head files and ancestor folders from changed entries", () => {
    render(
      <RepositoryTree
        headFiles={headFiles}
        changedFiles={changedFiles}
        selectedPath={null}
        onSelect={() => undefined}
        defaultExpandedPaths={[
          "src",
          "src/removed-folder",
        ]}
      />,
    );

    const modified = screen.getByRole("button", {
      name: "Modified src/a.ts",
    });
    expect(modified).toHaveAttribute("data-change-type", "modified");
    expect(within(modified).queryByText("M")).not.toBeInTheDocument();
    expect(modified.querySelector(".change-file-icon--modified")).not.toBeNull();
    expect(modified).toHaveTextContent("+1−1");

    const unchanged = screen.getByRole("button", {
      name: "src/keep.ts",
    });
    expect(unchanged).not.toHaveAttribute("data-change-type");
    expect(within(unchanged).queryByText(/^[AMDRCT]$/)).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute(
      "data-change-tone",
      "removed",
    );
    const removedFolder = screen.getByRole("button", {
      name: "src/removed-folder",
    });
    expect(removedFolder).toHaveAttribute("data-change-tone", "removed");
    expect(
      document.querySelector(
        ".repository-tree__dot[data-change-tone='removed']",
      ),
    ).not.toBeNull();

    expect(
      screen.getByRole("button", {
        name: "Deleted src/removed-folder/gone.txt",
      }),
    ).toBeInTheDocument();
  });

  it("formats large changed-file statistics in the repository tree", () => {
    const large = changedFile({
      path: "src/large.ts",
      additions: 1_234_567,
      deletions: 2_345_678,
    });
    render(
      <RepositoryTree
        headFiles={[large.path]}
        changedFiles={[large]}
        selectedPath={null}
        onSelect={() => undefined}
      />,
    );

    const row = screen.getByRole("button", { name: "Modified src/large.ts" });
    expect(row).toHaveTextContent("+1,234,567");
    expect(row).toHaveTextContent("−2,345,678");
  });

  it("filters the full tree and expands matching branches", async () => {
    render(
      <RepositoryTree
        headFiles={headFiles}
        changedFiles={changedFiles}
        selectedPath={null}
        onSelect={() => undefined}
        defaultExpandedPaths={[]}
      />,
    );

    const src = screen.getByRole("button", { name: "src" });
    expect(src).toHaveAttribute("aria-expanded", "false");

    const filter = screen.getByRole("searchbox", {
      name: "Filter repository files",
    });
    fireEvent.change(filter, { target: { value: "keep" } });

    expect(screen.getByRole("button", { name: "src/keep.ts" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Modified src/a.ts" }),
    ).not.toBeInTheDocument();
    expect(src).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Clear repository file filter" }));
    expect(screen.queryByRole("button", { name: "src/keep.ts" })).not.toBeInTheDocument();
  });

  it("toggles folder expansion and reports the selected file path", () => {
    const onSelect = vi.fn();
    const view = render(
      <RepositoryTree
        headFiles={headFiles}
        changedFiles={changedFiles}
        selectedPath={null}
        onSelect={onSelect}
        defaultExpandedPaths={["src"]}
      />,
    );

    const src = screen.getByRole("button", { name: "src" });
    fireEvent.click(src);
    expect(src).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "Modified src/a.ts" }),
    ).not.toBeInTheDocument();

    fireEvent.click(src);
    expect(
      screen.getByRole("button", { name: "Modified src/a.ts" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Modified src/a.ts" }),
    );
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");

    view.rerender(
      <RepositoryTree
        headFiles={headFiles}
        changedFiles={changedFiles}
        selectedPath="src/a.ts"
        onSelect={onSelect}
        defaultExpandedPaths={["src"]}
      />,
    );
    expect(
      screen.getByRole("treeitem", { selected: true }),
    ).toHaveTextContent("a.ts");
  });

  it("keeps panel controls outside the tree and omits the repository count header", () => {
    render(
      <RepositoryTree
        headFiles={headFiles}
        changedFiles={changedFiles}
        selectedPath={null}
        onSelect={() => undefined}
        panelId="pr-file-panel"
      />,
    );
    expect(screen.queryByText(/Repository files \(/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse repository files" }),
    ).not.toBeInTheDocument();
  });

  it("builds a sorted tree with unchanged rows left undecorated", () => {
    const nodes = buildRepositoryTree(
      ["z.txt", "a/deep.txt", "a/z/deep2.txt", "b.txt"],
      [changedFile({ path: "a/deep.txt", changeType: "added" })],
    );
    expect(nodes.map((node) => node.path)).toEqual(["a", "b.txt", "z.txt"]);
    expect(nodes[0]?.children.map((node) => node.path)).toEqual([
      "a/z",
      "a/deep.txt",
    ]);
    expect(nodes[0]?.tone).toBe("added");
    expect(nodes[0]?.children[0]?.tone).toBeNull();
  });

  it("uses removed, added, then modified as the folder tone priority", () => {
    const addedOverModified = buildRepositoryTree(
      ["root/modified.ts", "root/added.ts"],
      [
        changedFile({ path: "root/modified.ts", changeType: "modified" }),
        changedFile({ path: "root/added.ts", changeType: "added" }),
      ],
    );
    expect(addedOverModified[0]?.tone).toBe("added");

    const removedOverAdded = buildRepositoryTree(
      ["root/modified.ts", "root/added.ts"],
      [
        changedFile({ path: "root/modified.ts", changeType: "modified" }),
        changedFile({ path: "root/added.ts", changeType: "added" }),
        changedFile({ path: "root/removed.ts", changeType: "removed" }),
      ],
    );
    expect(removedOverAdded[0]?.tone).toBe("removed");
  });
});
