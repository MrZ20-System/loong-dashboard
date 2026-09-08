import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterDropdown } from "./FilterDropdown";

const statusOptions = [
  { value: "draft", label: "draft" },
  { value: "open", label: "open" },
  { value: "merged", label: "merged" },
];

describe("FilterDropdown", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("selects a single option by pointer and closes", () => {
    const onChange = vi.fn();
    render(
      <FilterDropdown
        label="Status"
        emptyLabel="All statuses"
        options={statusOptions}
        selected={[]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Status All statuses/ }));
    fireEvent.click(screen.getByRole("option", { name: "open" }));
    expect(onChange).toHaveBeenCalledWith(["open"]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("navigates options with arrow keys and confirms with Enter", () => {
    const onChange = vi.fn();
    render(
      <FilterDropdown
        label="Status"
        emptyLabel="All statuses"
        options={statusOptions}
        selected={[]}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Status All statuses/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "draft" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("option", { name: "draft" }), {
      key: "ArrowDown",
    });
    expect(screen.getByRole("option", { name: "open" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("option", { name: "open" }), {
      key: "Enter",
    });
    expect(onChange).toHaveBeenCalledWith(["open"]);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(
      <FilterDropdown
        label="Status"
        emptyLabel="All statuses"
        options={statusOptions}
        selected={[]}
        onChange={() => undefined}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Status All statuses/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("option", { name: "draft" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("supports multiple selections and closes on outside pointer press", () => {
    const onChange = vi.fn();
    const domainOptions = [
      { value: "dom_ci", label: "CI" },
      { value: "dom_docs", label: "Docs" },
    ];
    const { rerender } = render(
      <FilterDropdown
        label="Domains"
        emptyLabel="All domains"
        multiple
        options={domainOptions}
        selected={[]}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Domains All domains/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "CI" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    rerender(
      <FilterDropdown
        label="Domains"
        emptyLabel="All domains"
        multiple
        options={domainOptions}
        selected={["dom_ci"]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("option", { name: "Docs" }));
    expect(onChange).toHaveBeenLastCalledWith(["dom_ci", "dom_docs"]);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
