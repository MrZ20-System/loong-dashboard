import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { message, useI18n } from "./i18n";
import { AgentChatPanel } from "./agent-chat";
import { fetchIssueDetail, refreshIssueDetail } from "./issue-client";
import { MarkdownView } from "./markdown";
import { restoreIssueMetadata } from "./retention-client";

const issueMessages = {
  invalidNumber: message("Invalid issue number.", "无效的 Issue 编号。"),
  loading: message("Loading issue…", "正在加载 Issue…"),
  unavailable: message("Issue unavailable", "Issue 不可用"),
  unableLoad: message("Unable to load issue: {detail}", "无法加载 Issue：{detail}"),
  backToIssues: message("Back to issues", "返回 Issue 列表"),
  openOnGithub: message(
    "Open issue #{number} on GitHub",
    "在 GitHub 上打开 Issue #{number}",
  ),
  openedThisIssue: message("opened this issue", "创建了此 Issue"),
  comments: message("{count} comments", "{count} 条评论"),
  updated: message("updated {value}", "更新于 {value}"),
  updatedLabel: message("updated", "更新于"),
  backToList: message("Back to list", "返回列表"),
  archived: message("Archived", "已归档"),
  restoring: message("Restoring…", "正在恢复…"),
  restore: message("Restore", "恢复"),
  unableRestore: message("Unable to restore: {detail}", "无法恢复：{detail}"),
  cachedDetailsCleaned: message("Cached details cleaned", "缓存详情已清理"),
  refreshing: message("Refreshing…", "正在刷新…"),
  refreshFromGithub: message("Refresh from GitHub", "从 GitHub 刷新"),
  unableRefresh: message("Unable to refresh: {detail}", "无法刷新：{detail}"),
  noStoredBody: message(
    "This issue has no stored body.",
    "此 Issue 没有已存储的正文。",
  ),
  commentsHeading: message("Comments", "评论"),
  noComments: message("No comments yet.", "暂无评论。"),
  created: message("created", "创建于"),
  issueChat: message("Issue chat", "Issue 对话"),
  unknown: message("unknown", "未知"),
} as const;

/**
 * Issue detail page: cached markdown body and
 * comments fetched on demand from GitHub, with an Issue-scoped Agent chat
 * on the right whose cwd is the repository root. Nothing is auto-injected
 * into the prompt; the GitHub links are provided for reference.
 */
export function IssueDetailPage() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const { repositoryId = "", number: rawNumber = "" } = useParams();
  const number = Number(rawNumber);
  const enabled = repositoryId.length > 0 && Number.isInteger(number) && number > 0;
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["issue", repositoryId, number],
    enabled,
    queryFn: ({ signal }) => {
      void signal;
      return fetchIssueDetail(repositoryId, number);
    },
  });
  const restore = useMutation({
    mutationFn: () => restoreIssueMetadata(repositoryId, number),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["issue", repositoryId, number] });
      void queryClient.invalidateQueries({ queryKey: ["metadata", repositoryId, "issues"] });
    },
  });
  const refresh = useMutation({
    mutationFn: () => refreshIssueDetail(repositoryId, number),
    onSuccess: (refreshed) => {
      queryClient.setQueryData(["issue", repositoryId, number], refreshed);
      void queryClient.invalidateQueries({ queryKey: ["metadata", repositoryId, "issues"] });
    },
  });

  if (!enabled) return <p role="alert">{t(issueMessages.invalidNumber)}</p>;
  if (detail.isPending) return <p role="status">{t(issueMessages.loading)}</p>;
  if (detail.isError) {
    return (
      <section>
        <h2>{t(issueMessages.unavailable)}</h2>
        <p role="alert">{t(issueMessages.unableLoad, { detail: detail.error.message })}</p>
        <Link to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}>{t(issueMessages.backToIssues)}</Link>
      </section>
    );
  }
  const issue = detail.data;
  const isArchived = issue.archivedAt != null;
  const isPayloadPruned = issue.payloadPrunedAt != null;
  return (
    <section className="issue-detail issue-detail--focus" aria-labelledby="issue-title">
      <div className="page-heading issue-heading">
        <div className="issue-heading__summary">
          <p className="eyebrow">{repositoryId}</p>
          <h2 id="issue-title">
            {issue.title}{" "}
            <a
              className="pr-number-link"
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              aria-label={t(issueMessages.openOnGithub, { number: issue.number })}
            >
              #{issue.number}
            </a>
          </h2>
          <p className="pr-meta pr-meta--github">
            <span className={`pr-status-pill pr-status-pill--${issue.status}`}>
              {issue.status}
            </span>
            <strong>{issue.authorLogin ?? t(issueMessages.unknown)}</strong>
            <span>{t(issueMessages.openedThisIssue)}</span>
            <span className="pr-updated">{formatDateTime(issue.createdAt)}</span>
            <span aria-hidden="true">·</span>
            <span>{t(issueMessages.comments, { count: formatNumber(issue.commentsCount) })}</span>
            <span aria-hidden="true">·</span>
            <span className="pr-updated">{t(issueMessages.updated, { value: formatDateTime(issue.updatedAt) })}</span>
          </p>
        </div>
        <div className="pr-heading-actions">
          <Link to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}>{t(issueMessages.backToList)}</Link>
        </div>
      </div>
      {isArchived && (
        <aside className="metadata-archive-banner" role="status">
          <strong>{t(issueMessages.archived)}</strong>
          <button type="button" onClick={() => restore.mutate()} disabled={restore.isPending}>
            {restore.isPending ? t(issueMessages.restoring) : t(issueMessages.restore)}
          </button>
          {restore.isError && <span role="alert">{t(issueMessages.unableRestore, { detail: restore.error.message })}</span>}
        </aside>
      )}
      {isPayloadPruned && (
        <aside className="metadata-archive-banner" role="status">
          <strong>{t(issueMessages.cachedDetailsCleaned)}</strong>
          <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? t(issueMessages.refreshing) : t(issueMessages.refreshFromGithub)}
          </button>
          {refresh.isError && <span role="alert">{t(issueMessages.unableRefresh, { detail: refresh.error.message })}</span>}
        </aside>
      )}
      <div className="issue-layout">
        <div>
          <div className="issue-body">
            {issue.detailBody !== null && issue.detailBody.length > 0 ? (
              <MarkdownView text={issue.detailBody} />
            ) : (
              <p role="status">{t(issueMessages.noStoredBody)}</p>
            )}
          </div>
          <section className="issue-comments" aria-labelledby="issue-comments-heading">
            <h3 id="issue-comments-heading">{t(issueMessages.commentsHeading)}</h3>
            {issue.comments.length === 0 ? (
              <p role="status">{t(issueMessages.noComments)}</p>
            ) : (
              <ol className="issue-comment-list">
                {issue.comments.map((comment) => (
                  <li key={comment.id} className="issue-comment">
                    <p className="issue-comment-meta">
                      <strong>{comment.authorLogin ?? t(issueMessages.unknown)}</strong>
                      {` · ${t(issueMessages.created)} `}
                      {formatDateTime(comment.createdAt)}
                      {` · ${t(issueMessages.updatedLabel)} `}
                      {formatDateTime(comment.updatedAt)}
                      {" · "}
                      <a href={comment.url} target="_blank" rel="noreferrer">
                        GitHub
                      </a>
                    </p>
                    <MarkdownView text={comment.body} />
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
        <AgentChatPanel
          scope={{ kind: "issue", repositoryId, issueNumber: issue.number }}
          heading={t(issueMessages.issueChat)}
        />
      </div>
    </section>
  );
}
