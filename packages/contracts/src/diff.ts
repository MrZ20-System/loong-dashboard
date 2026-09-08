import { z } from "zod";

import { repositoryIdSchema } from "./validation.js";

export const fullShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "Expected a full 40-character object id");

/** One changed file entry between two revisions (path, status, line stats). */
export const changedFileEntrySchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).nullable(),
    changeType: z.enum([
      "added",
      "modified",
      "removed",
      "renamed",
      "copied",
      "typechange",
    ]),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
  })
  .strict();

/** Response of POST .../pulls/:number/prepare (plan 17.2). */
export const preparePullResponseSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    number: z.number().int().positive(),
    headSha: fullShaSchema,
    mergeBase: fullShaSchema,
    fetched: z.boolean(),
    files: z.array(changedFileEntrySchema),
  })
  .strict();

/** Response of GET .../pulls/:number/file (plan 11.4 degradation branches). */
export const fileContentResponseSchema = z
  .object({
    path: z.string().min(1),
    ref: fullShaSchema,
    binary: z.boolean(),
    tooLarge: z.boolean(),
    sizeBytes: z.number().int().nonnegative(),
    content: z.string().nullable(),
  })
  .strict();

const safeRepositoryPathSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    "Path must stay inside the repository tree",
  );

export const fileContentQuerySchema = z
  .object({
    path: safeRepositoryPathSchema,
    ref: fullShaSchema,
  })
  .strict();

/**
 * Response of GET .../pulls/:number/tree (full head file list). The server
 * resolves the ref from the stored PR detail so callers can never ask for an
 * arbitrary object; paths are the complete repository-relative file set at
 * that head commit.
 */
export const repositoryTreeResponseSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    number: z.number().int().positive(),
    ref: fullShaSchema,
    files: z.array(safeRepositoryPathSchema),
  })
  .strict();

/** Response of GET .../pulls/:number/local-command (plan 11.5). */
export const localCommandResponseSchema = z
  .object({
    command: z.string().min(1),
  })
  .strict();

export type FullSha = z.infer<typeof fullShaSchema>;
export type ChangedFileEntry = z.infer<typeof changedFileEntrySchema>;
export type PreparePullResponse = z.infer<typeof preparePullResponseSchema>;
export type FileContentResponse = z.infer<typeof fileContentResponseSchema>;
export type FileContentQuery = z.infer<typeof fileContentQuerySchema>;
export type RepositoryTreeResponse = z.infer<typeof repositoryTreeResponseSchema>;
export type LocalCommandResponse = z.infer<typeof localCommandResponseSchema>;
