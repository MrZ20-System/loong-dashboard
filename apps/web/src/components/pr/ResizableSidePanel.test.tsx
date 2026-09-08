import { act } from "react";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PanelCollapseButton,
  ResizableSidePanel,
  clampPanelWidth,
  persistPanelWidth,
  readPersistedPanelWidth,
} from "./ResizableSidePanel";

function dispatchPointerDown(element: HTMLElement, clientX: number) {
  act(() => {
    const event = new Event("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
    }) as Event & { button?: number; clientX?: number };
    event.button = 0;
    event.clientX = clientX;
    element.dispatchEvent(event);
  });
}

function dispatchPointerMove(clientX: number) {
  act(() => {
    const event = new Event("pointermove", {
      bubbles: true,
      cancelable: true,
    }) as Event & { clientX?: number };
    event.clientX = clientX;
    window.dispatchEvent(event);
  });
}

function dispatchPointerUp() {
  act(() => {
    window.dispatchEvent(
      new Event("pointerup", { bubbles: true, cancelable: true }),
    );
  });
}

function renderOpenPanel(
  overrides: Partial<ComponentProps<typeof ResizableSidePanel>> = {},
) {
  return render(
    <ResizableSidePanel
      panelId="test-files"
      side="left"
      open
      label="Changed files"
      defaultWidth={260}
      minWidth={200}
      maxWidth={400}
      {...overrides}
    >
      <p>panel body</p>
    </ResizableSidePanel>,
  );
}

describe("ResizableSidePanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("clamps the persisted and computed widths to the configured range", () => {
    expect(clampPanelWidth(10, 200, 400)).toBe(200);
    expect(clampPanelWidth(500, 200, 400)).toBe(400);
    expect(clampPanelWidth(300, 400, 200)).toBe(300);
    persistPanelWidth("test-files", 900);
    expect(readPersistedPanelWidth("test-files")).toBe(900);
  });

  it("renders nothing when closed and remounts children when opened", () => {
    const { container, rerender } = render(
      <ResizableSidePanel
        panelId="test-closed"
        side="left"
        open={false}
        label="Changed files"
      >
        <p>panel body</p>
      </ResizableSidePanel>,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    expect(
      document.querySelector(".pr-resize-panel__grip"),
    ).not.toBeInTheDocument();

    rerender(
      <ResizableSidePanel
        panelId="test-closed"
        side="left"
        open
        label="Changed files"
        defaultWidth={260}
        minWidth={200}
        maxWidth={400}
      >
        <p>panel body</p>
      </ResizableSidePanel>,
    );
    expect(screen.getByText("panel body")).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize Changed files" }),
    ).toBeInTheDocument();
  });

  it("clamps left-panel width while dragging with the pointer", () => {
    renderOpenPanel({ panelId: "test-drag-left" });
    const grip = screen.getByRole("separator", { name: "Resize Changed files" });

    dispatchPointerDown(grip, 100);
    dispatchPointerMove(900);
    expect(grip).toHaveAttribute("aria-valuenow", "400");
    dispatchPointerUp();

    dispatchPointerDown(grip, 200);
    dispatchPointerMove(-500);
    expect(grip).toHaveAttribute("aria-valuenow", "200");
    dispatchPointerUp();
  });

  it("grows the right panel when the pointer moves left", () => {
    renderOpenPanel({ panelId: "test-drag-right", side: "right" });
    const grip = screen.getByRole("separator", {
      name: "Resize Changed files",
    });

    dispatchPointerDown(grip, 300);
    dispatchPointerMove(250);
    expect(grip).toHaveAttribute("aria-valuenow", "310");
    dispatchPointerUp();

    dispatchPointerDown(grip, 300);
    dispatchPointerMove(50);
    expect(grip).toHaveAttribute("aria-valuenow", "400");
    dispatchPointerUp();
  });

  it("resizes and clamps from the keyboard on the separator", () => {
    renderOpenPanel({ panelId: "test-keyboard" });
    const grip = screen.getByRole("separator", { name: "Resize Changed files" });
    expect(grip).toHaveAttribute("aria-orientation", "vertical");
    expect(grip).toHaveAttribute("aria-valuenow", "260");
    expect(grip).toHaveAttribute("aria-valuemin", "200");
    expect(grip).toHaveAttribute("aria-valuemax", "400");

    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(grip).toHaveAttribute("aria-valuenow", "270");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(grip).toHaveAttribute("aria-valuenow", "260");
    fireEvent.keyDown(grip, { key: "Home" });
    expect(grip).toHaveAttribute("aria-valuenow", "200");
    fireEvent.keyDown(grip, { key: "End" });
    expect(grip).toHaveAttribute("aria-valuenow", "400");
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(grip).toHaveAttribute("aria-valuenow", "400");
  });

  it("keeps a user-resized width after close/reopen and full remount", () => {
    const first = renderOpenPanel({ panelId: "test-persist" });
    const grip = screen.getByRole("separator", { name: "Resize Changed files" });
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(grip).toHaveAttribute("aria-valuenow", "280");

    first.rerender(
      <ResizableSidePanel
        panelId="test-persist"
        side="left"
        open={false}
        label="Changed files"
      >
        <p>panel body</p>
      </ResizableSidePanel>,
    );
    expect(document.querySelector(".pr-resize-panel")).toBeNull();
    first.rerender(
      <ResizableSidePanel
        panelId="test-persist"
        side="left"
        open
        label="Changed files"
        defaultWidth={320}
        minWidth={200}
        maxWidth={400}
      >
        <p>panel body</p>
      </ResizableSidePanel>,
    );
    expect(
      screen.getByRole("separator", { name: "Resize Changed files" }),
    ).toHaveAttribute("aria-valuenow", "280");
    first.unmount();

    renderOpenPanel({ panelId: "test-persist", defaultWidth: 320 });
    expect(
      screen.getByRole("separator", { name: "Resize Changed files" }),
    ).toHaveAttribute("aria-valuenow", "280");
  });

  it("exposes a shared Codicon collapse control for both panel states", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <PanelCollapseButton
        panelId="pr-files"
        label="changed files"
        expanded
        onToggle={onToggle}
        className="pr-file-toggle"
      />,
    );
    const collapse = screen.getByRole("button", {
      name: "Collapse changed files",
    });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(collapse).toHaveAttribute("aria-controls", "pr-files");
    expect(collapse).toHaveClass("pr-panel-collapse", "pr-file-toggle");
    expect(
      document.querySelector(".codicon-layout-sidebar-left"),
    ).not.toBeNull();

    fireEvent.click(collapse);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <PanelCollapseButton
        panelId="pr-files"
        label="changed files"
        expanded={false}
        onToggle={onToggle}
        side="right"
      />,
    );
    const expand = screen.getByRole("button", {
      name: "Expand changed files",
    });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(
      document.querySelector(".codicon-layout-sidebar-right-off"),
    ).not.toBeNull();
  });
});
