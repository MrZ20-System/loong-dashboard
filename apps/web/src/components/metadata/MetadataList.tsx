import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n, type I18nContextValue } from "../../i18n";
import type {
  IssueListItem,
  PullRequestListItem,
} from "../../metadata-client";
import { DomainChips } from "../domain/DomainChips";
import { metadataMessages } from "./messages";

export type MetadataKind = "pulls" | "issues";
export type MetadataListItem = PullRequestListItem | IssueListItem;

export function matchesMetadataSearch(
  item: MetadataListItem,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;

  const numberNeedle = needle.startsWith("#") ? needle.slice(1) : needle;
  const numberMatches =
    numberNeedle.length > 0 &&
    /^\d+$/.test(numberNeedle) &&
    String(item.number).includes(numberNeedle);
  return (
    numberMatches ||
    item.title.toLowerCase().includes(needle) ||
    item.authorLogin?.toLowerCase().includes(needle) === true
  );
}

export function MetadataSearchField({
  kind,
  value,
  onChange,
}: {
  kind: MetadataKind;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="search-filter">
      <span>{t(metadataMessages.search)}</span>
      <input
        type="search"
        aria-label={t(metadataMessages.searchList)}
        placeholder={
          kind === "pulls"
            ? t(metadataMessages.pullSearchPlaceholder)
            : t(metadataMessages.issueSearchPlaceholder)
        }
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function isPullRequest(
  kind: MetadataKind,
  item: MetadataListItem,
): item is PullRequestListItem {
  return kind === "pulls";
}

export function MetadataFeed({
  kind,
  items,
  groupByUpdatedDay = false,
  calendarTimeZone = "Asia/Shanghai",
}: {
  kind: MetadataKind;
  items: MetadataListItem[];
  groupByUpdatedDay?: boolean;
  calendarTimeZone?: string;
}) {
  const navigate = useNavigate();
  const i18n = useI18n();
  if (items.length === 0) return null;

  let previousDay: string | null = null;
  const rows: ReactNode[] = [];
  for (const item of items) {
    const day = groupByUpdatedDay ? calendarDay(item.updatedAt, calendarTimeZone) : null;
    if (day !== null && day !== previousDay) {
      rows.push(
        <li className="feed-date-divider" role="separator" key={`date-${day}`}>
          <span>{formatCalendarDay(day, i18n)}</span>
        </li>,
      );
      previousDay = day;
    }
      rows.push(renderMetadataItem(item, kind, navigate, i18n, calendarTimeZone));
  }

  return (
    <ul
      className="feed-list"
      aria-label={kind === "pulls" ? i18n.t(metadataMessages.pullRequestFeed) : i18n.t(metadataMessages.issueFeed)}
    >
      {rows}
    </ul>
  );
}

function calendarDay(value: string, timeZone: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(timestamp);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // If the browser cannot construct the formatter, keep rendering the item
    // without a divider.
  }
  return value;
}

function formatCalendarDay(day: string, i18n: I18nContextValue): string {
  // `calendarDay` returns the original value for invalid timestamps. Keep it
  // untouched instead of appending a synthetic time and changing the user's
  // raw data (for example, `not-a-date` must not become `not-a-datT12:00:00Z`).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  return i18n.formatDate(
    `${day}T12:00:00Z`,
    { year: "numeric", month: "short", day: "numeric" },
    "UTC",
  );
}

function renderMetadataItem(
  item: MetadataListItem,
  kind: MetadataKind,
  navigate: ReturnType<typeof useNavigate>,
  i18n: I18nContextValue,
  calendarTimeZone: string,
): ReactNode {
  const singular = kind === "pulls"
    ? i18n.t(metadataMessages.pullRequest)
    : i18n.t(metadataMessages.issue);
  const detailPath = `/repositories/${encodeURIComponent(item.repositoryId)}/${kind}/${item.number}`;
  const updatedAt = i18n.formatDateTime(item.updatedAt, undefined, calendarTimeZone);
  const dynamicStats = isPullRequest(kind, item)
    ? i18n.t(metadataMessages.pullStats, {
        additions: i18n.formatNumber(item.additions),
        deletions: i18n.formatNumber(item.deletions),
        files: i18n.formatNumber(item.changedFilesCount),
      })
    : i18n.t(metadataMessages.commentStats, {
        count: i18n.formatNumber(item.commentsCount),
      });
  return (
          <li
            key={item.number}
            className="feed-row feed-row--interactive"
            role="link"
            tabIndex={0}
            aria-label={i18n.t(metadataMessages.itemAria, { kind: singular, number: item.number, title: item.title })}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("a, button, input, select, textarea")
              ) {
                return;
              }
              navigate(detailPath);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                navigate(detailPath);
              }
            }}
          >
            <div className="feed-row__rail">
              <a
                className="feed-row__number"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                aria-label={i18n.t(
                  kind === "pulls"
                    ? metadataMessages.openPullRequestOnGitHub
                    : metadataMessages.openIssueOnGitHub,
                  { number: item.number },
                )}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                #{item.number}
              </a>
              <span className={`status-pill status-${item.status}`}>
                {item.status}
              </span>
            </div>
            <div className="feed-row__content">
              <div className="feed-row__title-line">
                <h3 className="feed-row__title">{item.title}</h3>
                {isPullRequest(kind, item) && (
                  <DomainChips domains={item.domains} />
                )}
              </div>
              <p className="feed-row__meta">
                <span>{item.authorLogin ?? i18n.t(metadataMessages.unknown)}</span>
                <span aria-hidden="true">·</span>
                <span>{i18n.t(metadataMessages.updated, { value: updatedAt })}</span>
                <span aria-hidden="true">·</span>
                <span>{dynamicStats}</span>
              </p>
            </div>
          </li>
  );
}
