import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { Codicon } from "./codicon";
import "./pr-workbench-panels.css";

export type ResizablePanelSide = "left" | "right";

export const MIN_SIDE_PANEL_WIDTH = 180;
export const DEFAULT_SIDE_PANEL_WIDTH = 300;
export const MAX_SIDE_PANEL_WIDTH = 560;
export const SIDE_PANEL_RESIZE_STEP = 10;

const WIDTH_STORAGE_PREFIX = "loongboard.pr-panel-width";
const inMemoryPanelWidths = new Map<string, number>();

function widthStorageKey(panelId: string): string {
  return `${WIDTH_STORAGE_PREFIX}.${panelId}`;
}

export function clampPanelWidth(
  width: number,
  minWidth = MIN_SIDE_PANEL_WIDTH,
  maxWidth = MAX_SIDE_PANEL_WIDTH,
): number {
  const min = Math.min(minWidth, maxWidth);
  const max = Math.max(minWidth, maxWidth);
  return Math.min(Math.max(width, min), max);
}

export function readPersistedPanelWidth(panelId: string): number | null {
  const inMemory = inMemoryPanelWidths.get(panelId);
  if (inMemory !== undefined) return inMemory;
  try {
    const raw = window.localStorage.getItem(widthStorageKey(panelId));
    if (raw === null) return null;
    const width = Number(raw);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

export function persistPanelWidth(panelId: string, width: number): void {
  const rounded = Math.round(width);
  inMemoryPanelWidths.set(panelId, rounded);
  try {
    window.localStorage.setItem(widthStorageKey(panelId), String(rounded));
  } catch {
    // Persistence is best-effort; the page-lifetime in-memory width still works.
  }
}

export interface ResizableSidePanelProps {
  /** Stable id used for width persistence and component bookkeeping. */
  readonly panelId: string;
  /** Which workbench edge the panel occupies; controls drag direction. */
  readonly side: ResizablePanelSide;
  /** Closed panels render nothing: no width, no rail, and no resize handle. */
  readonly open: boolean;
  /** Human-readable panel name, e.g. "Changed files". */
  readonly label: string;
  readonly children: ReactNode;
  readonly defaultWidth?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  /** Pixel delta applied by one keyboard arrow press. */
  readonly resizeStep?: number;
  /** Optional DOM id for the open panel wrapper (outside aria-controls). */
  readonly id?: string;
  /** Optional extra class appended to the panel wrapper. */
  readonly className?: string;
}

interface DragState {
  readonly clientX: number;
  readonly startWidth: number;
}

/**
 * Resizable wrapper for PR workbench side panels. While open it owns a
 * keyboard-accessible vertical separator whose drag/arrow adjustments move
 * the panel edge. The final width is clamped to [minWidth, maxWidth] and
 * persisted per panelId so collapse/reopen keeps the user's width.
 */
export function ResizableSidePanel({
  panelId,
  side,
  open,
  label,
  children,
  defaultWidth = DEFAULT_SIDE_PANEL_WIDTH,
  minWidth = MIN_SIDE_PANEL_WIDTH,
  maxWidth = MAX_SIDE_PANEL_WIDTH,
  resizeStep = SIDE_PANEL_RESIZE_STEP,
  id,
  className,
}: ResizableSidePanelProps) {
  const min = Math.min(minWidth, maxWidth);
  const max = Math.max(minWidth, maxWidth);
  const fallbackWidth = clampPanelWidth(defaultWidth, min, max);
  const [width, setWidth] = useState(() => {
    const persisted = readPersistedPanelWidth(panelId);
    return clampPanelWidth(persisted ?? fallbackWidth, min, max);
  });
  const latestWidth = useRef(width);
  const dragStart = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) {
      dragStart.current = null;
      setDragging(false);
      return;
    }
    const handleMove = (event: globalThis.PointerEvent) => {
      const start = dragStart.current;
      if (start === null) return;
      const delta = event.clientX - start.clientX;
      const raw =
        side === "left"
          ? start.startWidth + delta
          : start.startWidth - delta;
      const next = clampPanelWidth(raw, min, max);
      latestWidth.current = next;
      setWidth(next);
    };
    const handleStop = () => {
      if (dragStart.current === null) return;
      dragStart.current = null;
      setDragging(false);
      persistPanelWidth(panelId, latestWidth.current);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleStop);
    window.addEventListener("pointercancel", handleStop);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleStop);
      window.removeEventListener("pointercancel", handleStop);
    };
  }, [max, min, open, panelId, side]);

  const handleGripPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (dragStart.current !== null) return;
    if (event.button !== undefined && event.button !== 0) return;
    dragStart.current = {
      clientX: event.clientX,
      startWidth: latestWidth.current,
    };
    setDragging(true);
    event.preventDefault();
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an optimization; window listeners still work.
      }
    }
  };

  const handleGripKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = latestWidth.current + resizeStep;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = latestWidth.current - resizeStep;
    } else if (event.key === "Home") {
      next = min;
    } else if (event.key === "End") {
      next = max;
    }
    if (next === null) return;
    event.preventDefault();
    const clamped = clampPanelWidth(next, min, max);
    latestWidth.current = clamped;
    setWidth(clamped);
    persistPanelWidth(panelId, clamped);
  };

  if (!open) return null;

  const wrapperClass = [
    "pr-resize-panel",
    `pr-resize-panel--${side}`,
    ...(className !== undefined ? [className] : []),
    ...(dragging ? ["pr-resize-panel--dragging"] : []),
  ].join(" ");
  const gripClass = [
    "pr-resize-panel__grip",
    ...(dragging ? ["pr-resize-panel__grip--active"] : []),
  ].join(" ");
  const grip = (
    <div
      role="separator"
      aria-label={`Resize ${label}`}
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      className={gripClass}
      onPointerDown={handleGripPointerDown}
      onKeyDown={handleGripKeyDown}
    />
  );

  return (
    <div
      {...(id !== undefined ? { id } : {})}
      className={wrapperClass}
      style={{ width: `${Math.round(width)}px` }}
      data-resizable-panel-id={panelId}
    >
      {side === "right" ? grip : null}
      <div className="pr-resize-panel__content">{children}</div>
      {side === "left" ? grip : null}
    </div>
  );
}

export function panelCollapseCodicon(
  side: ResizablePanelSide,
  expanded: boolean,
): string {
  if (side === "right") {
    return expanded ? "layout-sidebar-right" : "layout-sidebar-right-off";
  }
  return expanded ? "layout-sidebar-left" : "layout-sidebar-left-off";
}

export interface PanelCollapseButtonProps {
  readonly panelId: string;
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly side?: ResizablePanelSide;
  readonly className?: string;
}

/**
 * Shared collapse control matching the workbench's Codicon language. The icon
 * flips to the "show side panel" glyph for the closed state, so the same
 * control can also render the page-level expansion button.
 */
export function PanelCollapseButton({
  panelId,
  label,
  expanded,
  onToggle,
  side = "left",
  className,
}: PanelCollapseButtonProps) {
  const classes = ["pr-panel-collapse"];
  if (className !== undefined) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      aria-expanded={expanded}
      aria-controls={panelId}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      data-panel-side={side}
      onClick={onToggle}
    >
      <Codicon
        name={panelCollapseCodicon(side, expanded)}
        className="pr-panel-collapse-icon"
      />
    </button>
  );
}
