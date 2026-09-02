import { z } from "zod";

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
  })
  .strict();

export const issuesQuerySchema = z
  .object({
    date: calendarDateSchema.optional(),
    status: issueStatusSchema.optional(),
    cursor: opaqueCursorSchema.optional(),
  })
  .strict();

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

export type PullRequestListItem = z.infer<typeof pullRequestListItemSchema>;
export type IssueListItem = z.infer<typeof issueListItemSchema>;
export type ActivityDay = z.infer<typeof activityDaySchema>;
export type PullRequestsResponse = z.infer<typeof pullRequestsResponseSchema>;
export type IssuesResponse = z.infer<typeof issuesResponseSchema>;
export type ActivityDaysResponse = z.infer<typeof activityDaysResponseSchema>;
export type PullRequestsQuery = z.infer<typeof pullRequestsQuerySchema>;
export type IssuesQuery = z.infer<typeof issuesQuerySchema>;
export type ActivityDaysQuery = z.infer<typeof activityDaysQuerySchema>;
