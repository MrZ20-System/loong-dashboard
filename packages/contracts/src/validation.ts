import { z } from "zod";

/**
 * A calendar date without a time or offset. Calendar dates are deliberately
 * validated without relying on JavaScript's Date parser, which normalizes
 * invalid values such as 2026-02-31.
 */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));

    if (year < 1 || month < 1 || month > 12 || day < 1) {
      return false;
    }

    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
      31,
      leapYear ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];

    return day <= daysInMonth[month - 1];
  }, "Expected a real calendar date");

/** Canonical UTC timestamps used by the HTTP and persistence boundaries. */
export const utcDateTimeSchema = z.string().datetime({ offset: false });

export const repositoryIdSchema = z.string().trim().min(1);

/**
 * Cursors are opaque at the HTTP boundary. The database owns their encoding;
 * this schema intentionally validates only that a cursor is present and not
 * blank.
 */
export const opaqueCursorSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Cursor must not be blank");

export type OpaqueCursor = z.infer<typeof opaqueCursorSchema>;

export const pullRequestStatusSchema = z.enum([
  "draft",
  "open",
  "closed",
  "merged",
]);

export const issueStatusSchema = z.enum(["open", "closed"]);

export const syncStatusSchema = z.enum(["idle", "running", "failed"]);

export const entityKindSchema = z.enum(["pull_request", "issue"]);

export type PullRequestStatus = z.infer<typeof pullRequestStatusSchema>;
export type IssueStatus = z.infer<typeof issueStatusSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type EntityKind = z.infer<typeof entityKindSchema>;
