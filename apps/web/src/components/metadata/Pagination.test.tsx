import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getPaginationItems, Pagination } from "./Pagination";

describe("Pagination", () => {
  it("keeps first/last pages and a nearby window with ellipses", () => {
    expect(getPaginationItems(8, 20)).toEqual([1, 2, "ellipsis", 7, 8, 9, "ellipsis", 19, 20]);
    expect(getPaginationItems(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("supports indexed buttons and clamps direct page input", () => {
    const onPageChange = vi.fn();
    render(<Pagination page={8} pageSize={100} totalCount={2000} totalPages={20} onPageChange={onPageChange} />);
    expect(screen.getByRole("button", { name: "Go to page 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to page 20" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to page 8" })).toHaveAttribute("aria-current", "page");
    const input = screen.getByRole("spinbutton", { name: "Go to page" });
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.submit(input.closest("form")!);
    expect(onPageChange).toHaveBeenCalledWith(20);
    fireEvent.click(screen.getByRole("button", { name: "Go to page 9" }));
    expect(onPageChange).toHaveBeenLastCalledWith(9);
  });

  it("gives each page input a locale-independent unique id", () => {
    render(
      <>
        <Pagination page={1} pageSize={10} totalCount={10} totalPages={1} onPageChange={() => undefined} />
        <Pagination page={1} pageSize={10} totalCount={10} totalPages={1} onPageChange={() => undefined} />
      </>,
    );

    const inputs = screen.getAllByRole("spinbutton", { name: "Go to page" });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveAttribute("id");
    expect(inputs[1]).toHaveAttribute("id");
    expect(inputs[0].id).not.toBe(inputs[1].id);
    expect(inputs[0].id).not.toContain("pagination");
  });
});
