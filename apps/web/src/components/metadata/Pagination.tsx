import { useEffect, useId, useState } from "react";
import { useI18n, type LocalizedMessage } from "../../i18n";
import { metadataMessages } from "./messages";

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
  label = metadataMessages.pagination,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  label?: string | LocalizedMessage;
}) {
  const { t, formatNumber } = useI18n();
  const labelText = typeof label === "string" ? label : t(label);
  const inputId = useId();
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
    <nav className="metadata-pagination" aria-label={labelText}>
      <span className="metadata-pagination__summary">
        {t(metadataMessages.pageSummary, {
          page: formatNumber(safePage),
          totalPages: formatNumber(safeTotalPages),
          firstItem: formatNumber(firstItem),
          lastItem: formatNumber(lastItem),
          totalCount: formatNumber(totalCount),
        })}
      </span>
      <div className="metadata-pagination__pages" aria-label={t(metadataMessages.pageIndex)}>
        <button type="button" onClick={() => onPageChange(safePage - 1)} disabled={disabled || safePage <= 1}>
          {t(metadataMessages.previous)}
        </button>
        {getPaginationItems(safePage, safeTotalPages).map((item, index) =>
          item === "ellipsis" ? (
            <span className="metadata-pagination__ellipsis" key={`ellipsis-${index}`} aria-hidden="true">…</span>
          ) : (
            <button
              type="button"
              className="metadata-pagination__page"
              key={item}
              aria-label={t(metadataMessages.goToPage, { page: formatNumber(item) })}
              aria-current={item === safePage ? "page" : undefined}
              onClick={() => onPageChange(item)}
              disabled={disabled || item === safePage}
            >
              {formatNumber(item)}
            </button>
          ),
        )}
        <button type="button" onClick={() => onPageChange(safePage + 1)} disabled={disabled || safePage >= safeTotalPages}>
          {t(metadataMessages.next)}
        </button>
      </div>
      <form className="metadata-pagination__goto" onSubmit={(event) => { event.preventDefault(); submitPage(); }}>
        <label htmlFor={inputId}>{t(metadataMessages.goToPageLabel)}</label>
        <input
          id={inputId}
          type="number"
          min={1}
          max={safeTotalPages}
          inputMode="numeric"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={disabled}
          aria-label={t(metadataMessages.goToPageLabel)}
        />
        <button type="submit" disabled={disabled}>{t(metadataMessages.go)}</button>
      </form>
    </nav>
  );
}
