import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { AgentChatPanel } from "./agent-chat";
import { fetchIssueDetail, refreshIssueDetail } from "./issue-client";
import { MarkdownView } from "./markdown";
import { restoreIssueMetadata } from "./retention-client";

/**
 * Issue detail page: cached markdown body and
 * comments fetched on demand from GitHub, with an Issue-scoped Agent chat
 * on the right whose cwd is the repository root. Nothing is auto-injected
 * into the prompt; the GitHub links are provided for reference.
 */
export function IssueDetailPage() {
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

  if (!enabled) return <p role="alert">Invalid issue number.</p>;
  if (detail.isPending) return <p role="status">Loading issue…</p>;
  if (detail.isError) {
    return (
      <section>
        <h2>Issue unavailable</h2>
        <p role="alert">{detail.error.message}</p>
        <Link to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}>Back to issues</Link>
      </section>
    );
  }
  const issue = detail.data;
  const isArchived = issue.archivedAt != null;
  const isPayloadPruned = issue.payloadPrunedAt != null;
  return (
    <section className="issue-detail" aria-labelledby="issue-title">
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
              aria-label={`Open issue #${issue.number} on GitHub`}
            >
              #{issue.number}
            </a>
          </h2>
          <p className="pr-meta pr-meta--github">
            <span className={`pr-status-pill pr-status-pill--${issue.status}`}>
              {issue.status}
            </span>
            <strong>{issue.authorLogin ?? "unknown"}</strong>
            <span>opened this issue</span>
            <span className="pr-updated">{issue.createdAt}</span>
            <span aria-hidden="true">·</span>
            <span>{issue.commentsCount} comments</span>
            <span aria-hidden="true">·</span>
            <span className="pr-updated">updated {issue.updatedAt}</span>
          </p>
        </div>
        <div className="pr-heading-actions">
          <Link to={`/repositories/${encodeURIComponent(repositoryId)}/issues`}>Back to list</Link>
        </div>
      </div>
      {isArchived && (
        <aside className="metadata-archive-banner" role="status">
          <strong>Archived</strong>
          <button type="button" onClick={() => restore.mutate()} disabled={restore.isPending}>
            {restore.isPending ? "Restoring…" : "Restore"}
          </button>
          {restore.isError && <span role="alert">Unable to restore: {restore.error.message}</span>}
        </aside>
      )}
      {isPayloadPruned && (
        <aside className="metadata-archive-banner" role="status">
          <strong>Cached details cleaned</strong>
          <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Refreshing…" : "Refresh from GitHub"}
          </button>
          {refresh.isError && <span role="alert">Unable to refresh: {refresh.error.message}</span>}
        </aside>
      )}
      <div className="issue-layout">
        <div>
          <div className="issue-body">
            {issue.detailBody !== null && issue.detailBody.length > 0 ? (
              <MarkdownView text={issue.detailBody} />
            ) : (
              <p role="status">This issue has no stored body.</p>
            )}
          </div>
          <section className="issue-comments" aria-labelledby="issue-comments-heading">
            <h3 id="issue-comments-heading">Comments</h3>
            {issue.comments.length === 0 ? (
              <p role="status">No comments yet.</p>
            ) : (
              <ol className="issue-comment-list">
                {issue.comments.map((comment) => (
                  <li key={comment.id} className="issue-comment">
                    <p className="issue-comment-meta">
                      <strong>{comment.authorLogin ?? "unknown"}</strong>
                      {" · created "}
                      {comment.createdAt}
                      {" · updated "}
                      {comment.updatedAt}
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
          heading="Issue chat"
        />
      </div>
    </section>
  );
}
