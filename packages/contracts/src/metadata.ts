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

const nonNegativeIntegerSchema = z.number().int().nonnegative();

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
    nextCursor: opaqueCursorSchema.nullable(),
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

export const pullRequestsQuerySchema = z
  .object({
    date: calendarDateSchema.optional(),
    status: pullRequestStatusSchema.optional(),
    cursor: opaqueCursorSchema.optional(),
    // Fastify surfaces a repeated query key as an array; a single value is
    // normalized so `?domain=a` and `?domain=a&domain=b` share one code path.
    // Semantics: a pull request matches when it carries ANY selected domain.
    domain: z.preprocess(
      (value) =>
        value === undefined ? undefined : typeof value === "string" ? [value] : value,
      z.array(domainRuleIdSchema).max(20).optional(),
    ),
  })
  .strict();

export const issuesQuerySchema = z
  .object({
    date: calendarDateSchema.optional(),
    status: issueStatusSchema.optional(),
    cursor: opaqueCursorSchema.optional(),
  })
  .strict();

/** Full stored PR row used by the detail page (plan 17.2, 18.2). */
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

/** Numeric path params shared by issue routes (plan 17.4, 18.3). */
export const issueParamsSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    number: z.preprocess(
      (value) => (typeof value === "string" ? Number(value) : value),
      z.number().int().positive(),
    ),
  })
  .strict();

/** Full stored Issue row used by the issue detail page (plan 1.3, 18.3). */
export const issueDetailSchema = issueListItemSchema.extend({
  createdAt: utcDateTimeSchema,
  closedAt: utcDateTimeSchema.nullable(),
  detailBody: z.string().nullable(),
});

export type PullRequestListItem = z.infer<typeof pullRequestListItemSchema>;
export type PullRequestDetail = z.infer<typeof pullRequestDetailSchema>;
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
