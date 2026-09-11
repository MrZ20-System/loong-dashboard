import { useEffect, useState } from "react";

export type PaginationItem = number | "ellipsis";

/** Return a compact, stable page window with both endpoints visible. */
export function getPaginationItems(page: number, totalPages: number): PaginationItem[] {
  const lastPage = Math.max(1, Math.floor(totalPages));
  const currentPage = Math.min(lastPage, Math.max(1, Math.floor(page)));
  if (lastPage <= 7) return Array.from({ length: lastPage }, (_, index) => index + 1);

  const candidates = new Set([1, 2, lastPage - 1, lastPage, currentPage - 1, currentPage, currentPage + 1]);
  const pages = [...candidates].filter((value) => value > 0 && value <= lastPage).sort((a, b) => a - b);
  const result: PaginationItem[] = [];
  pages.forEach((value, index) => {
    if (index > 0 && value - pages[index - 1] > 1) result.push("ellipsis");
    result.push(value);
  });
  return result;
}

export function Pagination({
  page,
  pageSize,
  totalCount,
  totalPages,
  onPageChange,
  disabled = false,
  label = "Pagination",
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  const safeTotalPages = Math.max(1, Math.floor(totalPages));
  const safePage = Math.min(safeTotalPages, Math.max(1, Math.floor(page)));
  const [input, setInput] = useState(String(safePage));

  useEffect(() => setInput(String(safePage)), [safePage]);

  const submitPage = () => {
    const parsed = Number.parseInt(input, 10);
    if (!Number.isFinite(parsed)) {
      setInput(String(safePage));
      return;
    }
    const nextPage = Math.min(safeTotalPages, Math.max(1, parsed));
    setInput(String(nextPage));
    if (nextPage !== safePage) onPageChange(nextPage);
  };

  const firstItem = totalCount === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastItem = totalCount === 0 ? 0 : Math.min(totalCount, safePage * pageSize);

  return (
    <nav className="metadata-pagination" aria-label={label}>
      <span className="metadata-pagination__summary">
        Page {safePage} of {safeTotalPages} · {firstItem}–{lastItem} of {totalCount}
      </span>
      <div className="metadata-pagination__pages" aria-label="Page index">
        <button type="button" onClick={() => onPageChange(safePage - 1)} disabled={disabled || safePage <= 1}>
          Previous
        </button>
        {getPaginationItems(safePage, safeTotalPages).map((item, index) =>
          item === "ellipsis" ? (
            <span className="metadata-pagination__ellipsis" key={`ellipsis-${index}`} aria-hidden="true">…</span>
          ) : (
            <button
              type="button"
              className="metadata-pagination__page"
              key={item}
              aria-label={`Go to page ${item}`}
              aria-current={item === safePage ? "page" : undefined}
              onClick={() => onPageChange(item)}
              disabled={disabled || item === safePage}
            >
              {item}
            </button>
          ),
        )}
        <button type="button" onClick={() => onPageChange(safePage + 1)} disabled={disabled || safePage >= safeTotalPages}>
          Next
        </button>
      </div>
      <form className="metadata-pagination__goto" onSubmit={(event) => { event.preventDefault(); submitPage(); }}>
        <label htmlFor={`${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-input`}>Go to page</label>
        <input
          id={`${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-input`}
          type="number"
          min={1}
          max={safeTotalPages}
          inputMode="numeric"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={disabled}
          aria-label="Go to page"
        />
        <button type="submit" disabled={disabled}>Go</button>
      </form>
    </nav>
  );
}
