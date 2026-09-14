import { z } from "zod";

import { domainRuleIdSchema, domainTagSchema } from "./domains.js";
import { fullShaSchema } from "./diff.js";
import {
  calendarDateSchema,
  issueStatusSchema,
  opaqueCursorSchema,
  pullRequestStatusSchema,
  repositoryIdSchema,
  utcDateTimeSchema,
} from "./validation.js";
import { archiveFilterSchema } from "./retention.js";

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const listSearchSchema = z.string().trim().max(200).optional();
export const pullRequestListSortSchema = z.enum(["updated", "number"]);

const repeatedQueryValues = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  return typeof value === "string" ? [value] : value;
};

function normalizeRepeatedValues(value: unknown): unknown {
  const values = repeatedQueryValues(value);
  if (!Array.isArray(values)) return values;
  return [...new Set(values)];
}

function normalizeArchiveValues(value: unknown): unknown {
  const values = repeatedQueryValues(value);
  if (!Array.isArray(values)) return values;
  // `all` is a compatibility shortcut. The canonical multi-select form is
  // `archive=current&archive=archived`; an explicit `all` is represented by
  // the empty selection so the two independent options remain authoritative.
  if (values.includes("all")) return [];
  return [...new Set(values)];
}

const pullRequestStatusQuerySchema = z.preprocess(
  normalizeRepeatedValues,
  z.array(pullRequestStatusSchema).max(4).optional(),
);
const issueStatusQuerySchema = z.preprocess(
  normalizeRepeatedValues,
  z.array(issueStatusSchema).max(2).optional(),
);
const archiveQuerySchema = z.preprocess(
  normalizeArchiveValues,
  z.array(archiveFilterSchema).max(2).optional(),
);

/** Page-based list controls used by Pull Requests and Merged projections. */
const pageQuerySchema = z.preprocess(
  (value) => (value === undefined ? undefined : Number(value)),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
);
const pageSizeQuerySchema = z.preprocess(
  (value) => (value === undefined ? undefined : Number(value)),
  z.number().int().positive().max(100).optional(),
);

export const pullRequestListItemSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().url(),
    authorLogin: z.string().nullable(),
    status: pullRequestStatusSchema,
    updatedAt: utcDateTimeSchema,
    changedFilesCount: nonNegativeIntegerSchema,
    additions: nonNegativeIntegerSchema,
    deletions: nonNegativeIntegerSchema,
    domains: z.array(domainTagSchema),
    archivedAt: utcDateTimeSchema.nullable().optional(),
    payloadPrunedAt: utcDateTimeSchema.nullable().optional(),
  })
  .strict();

export const issueListItemSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().url(),
    authorLogin: z.string().nullable(),
    status: issueStatusSchema,
    commentsCount: nonNegativeIntegerSchema,
    updatedAt: utcDateTimeSchema,
    archivedAt: utcDateTimeSchema.nullable().optional(),
    payloadPrunedAt: utcDateTimeSchema.nullable().optional(),
  })
  .strict();

/** One stored GitHub Issue comment shown on the Issue detail page. */
export const issueCommentSchema = z
  .object({
    id: z.number().int().positive(),
    authorLogin: z.string().nullable(),
    body: z.string(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
    url: z.string().url(),
  })
  .strict();

export const activityDaySchema = z
  .object({
    date: calendarDateSchema,
    count: nonNegativeIntegerSchema,
  })
  .strict();

export const pullRequestsResponseSchema = z
  .object({
    items: z.array(pullRequestListItemSchema),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive().max(100),
    totalCount: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    calendarTimeZone: z.string().trim().min(1),
  })
  .strict();

/** Current PR metadata projected onto the immutable merge-time timeline. */
export const mergedPullRequestListItemSchema = pullRequestListItemSchema
  .extend({ mergedAt: utcDateTimeSchema })
  .strict();

export const mergedPullRequestsQuerySchema = z
  .object({
    page: pageQuerySchema,
    search: listSearchSchema,
    limit: pageSizeQuerySchema,
    domain: z.preprocess(
      (value) =>
        value === undefined ? undefined : typeof value === "string" ? [value] : value,
      z.array(domainRuleIdSchema).max(20).optional(),
    ),
  })
  .strict();

export const mergedPullRequestsResponseSchema = z
  .object({
    items: z.array(mergedPullRequestListItemSchema),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive().max(100),
    totalCount: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    calendarTimeZone: z.string().trim().min(1),
  })
  .strict();

export const issuesResponseSchema = z
  .object({
    items: z.array(issueListItemSchema),
    nextCursor: opaqueCursorSchema.nullable(),
    calendarTimeZone: z.string().trim().min(1),
  })
  .strict();

export const activityDaysResponseSchema = z
  .object({
    days: z.array(activityDaySchema),
    calendarTimeZone: z.string().trim().min(1),
  })
  .strict();

const validDateRange = ({ from, to }: { from?: string; to?: string }) =>
  from === undefined || to === undefined || from <= to;

export const pullRequestsQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    /** Repeated status keys are an ANY-match multi-select; a single legacy key is accepted. */
    status: pullRequestStatusQuerySchema,
    sort: pullRequestListSortSchema.optional(),
    search: listSearchSchema,
    page: pageQuerySchema,
    limit: pageSizeQuerySchema,
    // Fastify surfaces a repeated query key as an array; a single value is
    // normalized so `?domain=a` and `?domain=a&domain=b` share one code path.
    // Semantics: a pull request matches when it carries ANY selected domain.
    domain: z.preprocess(
      (value) =>
        value === undefined ? undefined : typeof value === "string" ? [value] : value,
      z.array(domainRuleIdSchema).max(20).optional(),
    ),
    /** Current and archived are independent selections; both means all. */
    archive: archiveQuerySchema,
  })
  .strict()
  .refine(validDateRange, {
    message: "from must be on or before to",
    path: ["to"],
  });

export const issuesQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    /** Repeated status keys are an ANY-match multi-select; a single legacy key is accepted. */
    status: issueStatusQuerySchema,
    search: listSearchSchema,
    limit: z.preprocess(
      (value) => (value === undefined ? undefined : Number(value)),
      z.number().int().positive().max(100).optional(),
    ),
    cursor: opaqueCursorSchema.optional(),
    /** Current and archived are independent selections; both means all. */
    archive: archiveQuerySchema,
  })
  .strict()
  .refine(validDateRange, {
    message: "from must be on or before to",
    path: ["to"],
  });

/** Full stored PR row used by the detail page. */
export const pullRequestDetailSchema = pullRequestListItemSchema.extend({
  createdAt: utcDateTimeSchema,
  closedAt: utcDateTimeSchema.nullable(),
  mergedAt: utcDateTimeSchema.nullable(),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  headSha: fullShaSchema,
  detailBody: z.string().nullable(),
});

export const activityDaysQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
  })
  .strict()
  .refine(({ from, to }) => from <= to, {
    message: "from must be on or before to",
    path: ["to"],
  });

/** Numeric path params shared by issue routes. */
export const issueParamsSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    number: z.preprocess(
      (value) => (typeof value === "string" ? Number(value) : value),
      z.number().int().positive(),
    ),
  })
  .strict();

/** Full stored Issue row used by the issue detail page. */
export const issueDetailSchema = issueListItemSchema.extend({
  createdAt: utcDateTimeSchema,
  closedAt: utcDateTimeSchema.nullable(),
  detailBody: z.string().nullable(),
  comments: z.array(issueCommentSchema),
});

export type PullRequestListItem = z.infer<typeof pullRequestListItemSchema>;
export type MergedPullRequestListItem = z.infer<typeof mergedPullRequestListItemSchema>;
export type MergedPullRequestsQuery = z.infer<typeof mergedPullRequestsQuerySchema>;
export type MergedPullRequestsResponse = z.infer<typeof mergedPullRequestsResponseSchema>;
export type PullRequestListSort = z.infer<typeof pullRequestListSortSchema>;
export type PullRequestDetail = z.infer<typeof pullRequestDetailSchema>;
export type IssueComment = z.infer<typeof issueCommentSchema>;
export type IssueListItem = z.infer<typeof issueListItemSchema>;
export type IssueDetail = z.infer<typeof issueDetailSchema>;
export type IssueParams = z.infer<typeof issueParamsSchema>;
export type ActivityDay = z.infer<typeof activityDaySchema>;
export type PullRequestsResponse = z.infer<typeof pullRequestsResponseSchema>;
export type IssuesResponse = z.infer<typeof issuesResponseSchema>;
export type ActivityDaysResponse = z.infer<typeof activityDaysResponseSchema>;
export type PullRequestsQuery = z.infer<typeof pullRequestsQuerySchema>;
export type IssuesQuery = z.infer<typeof issuesQuerySchema>;
export type ActivityDaysQuery = z.infer<typeof activityDaysQuerySchema>;
