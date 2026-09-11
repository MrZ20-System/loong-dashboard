import { message } from "../../i18n";

export const metadataMessages = {
  search: message("Search", "搜索"),
  searchList: message("Search list", "搜索列表"),
  pullSearchPlaceholder: message(
    "PR number, author, or title",
    "PR 编号、作者或标题",
  ),
  issueSearchPlaceholder: message(
    "Issue number, author, or title",
    "Issue 编号、作者或标题",
  ),
  pullRequestFeed: message("Pull request feed", "拉取请求列表"),
  issueFeed: message("Issue feed", "议题列表"),
  pullRequest: message("Pull request", "拉取请求"),
  issue: message("Issue", "议题"),
  openPullRequestOnGitHub: message(
    "Open pull request #{number} on GitHub",
    "在 GitHub 上打开拉取请求 #{number}",
  ),
  openIssueOnGitHub: message(
    "Open issue #{number} on GitHub",
    "在 GitHub 上打开议题 #{number}",
  ),
  itemAria: message(
    "{kind} #{number}: {title}",
    "{kind} #{number}：{title}",
  ),
  unknown: message("Unknown", "未知"),
  updated: message("updated {value}", "更新于 {value}"),
  mergedAt: message("merged {value}", "合并于 {value}"),
  pullStats: message(
    "+{additions} −{deletions} in {files} files",
    "+{additions} −{deletions}，共 {files} 个文件",
  ),
  commentStats: message("{count} comments", "{count} 条评论"),
  pageSummary: message(
    "Page {page} of {totalPages} · {firstItem}–{lastItem} of {totalCount}",
    "第 {page} / {totalPages} 页 · {firstItem}–{lastItem}，共 {totalCount} 项",
  ),
  pagination: message("Pagination", "分页"),
  pageIndex: message("Page index", "页码"),
  goToPage: message("Go to page {page}", "前往第 {page} 页"),
  goToPageLabel: message("Go to page", "前往页码"),
  previous: message("Previous", "上一页"),
  next: message("Next", "下一页"),
  go: message("Go", "前往"),
};
