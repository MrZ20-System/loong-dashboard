import { z } from "zod";

import { utcDateTimeSchema } from "./validation.js";

/**
 * Knowledge repository contracts (plan 15, 17.6). Markdown files are the
 * source of truth; these schemas describe what the HTTP boundary exchanges.
 */

export const knowledgeTreeItemSchema = z
  .object({
    path: z.string().min(1),
    documentId: z.string().nullable(),
    title: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: utcDateTimeSchema,
  })
  .strict();

export const knowledgeTreeResponseSchema = z
  .object({
    items: z.array(knowledgeTreeItemSchema),
  })
  .strict();

/** Read/adopt a document by its repository path (files without id first). */
export const knowledgePathQuerySchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .refine((path) => path.endsWith(".md"), { message: "Knowledge paths must end with .md" }),
  })
  .strict();

/** Image extensions that Markdown may reference from the knowledge repo. */
const KNOWLEDGE_ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
] as const;

function isSafeRelativeAssetPath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("..") &&
    !value.split("/").includes(".")
  );
}

/** Query for GET /api/knowledge/assets (relative image inside the root). */
export const knowledgeAssetPathQuerySchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine(isSafeRelativeAssetPath, {
        message: "Knowledge asset paths must stay inside the knowledge root",
      })
      .refine(
        (path) =>
          KNOWLEDGE_ASSET_EXTENSIONS.some((extension) =>
            path.toLowerCase().endsWith(extension),
          ),
        { message: "Knowledge asset paths must reference a supported image" },
      ),
  })
  .strict();

/** Full document read: front-matter id, repository path, and raw content. */
export const knowledgeDocumentSchema = z
  .object({
    id: z.string().nullable(),
    path: z.string().min(1),
    title: z.string(),
    content: z.string(),
    contentHash: z.string().min(1),
    defaultSessionId: z.string().nullable(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict();

export const knowledgeDocumentResponseSchema = knowledgeDocumentSchema;

export const knowledgeDocumentCreateSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .refine((path) => path.endsWith(".md"), { message: "Knowledge paths must end with .md" }),
    title: z.string().trim().min(1).max(200),
    content: z.string().max(2_000_000).optional().default(""),
  })
  .strict();

export const knowledgeDocumentUpdateSchema = z
  .object({
    content: z.string().max(2_000_000),
  })
  .strict();

export const knowledgeMoveSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .refine((path) => path.endsWith(".md"), { message: "Knowledge paths must end with .md" }),
  })
  .strict();

export const knowledgeVersionSchema = z
  .object({
    id: z.string().min(1),
    documentId: z.string().min(1),
    versionNumber: z.number().int().positive(),
    source: z.enum(["manual", "agent", "external", "restore"]),
    createdAt: utcDateTimeSchema,
  })
  .strict();

export const knowledgeVersionsResponseSchema = z
  .object({
    items: z.array(knowledgeVersionSchema),
  })
  .strict();

/** Full stored version used by restore. */
export const knowledgeVersionDetailSchema = knowledgeVersionSchema.extend({
  content: z.string(),
});

export const knowledgeDocumentParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
});

export const knowledgeVersionParamsSchema = knowledgeDocumentParamsSchema.extend({
  versionId: z.string().trim().min(1).max(128),
});

export type KnowledgeAssetPathQuery = z.infer<typeof knowledgeAssetPathQuerySchema>;
export type KnowledgeTreeItem = z.infer<typeof knowledgeTreeItemSchema>;
export type KnowledgeTreeResponse = z.infer<typeof knowledgeTreeResponseSchema>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeDocumentCreate = z.infer<typeof knowledgeDocumentCreateSchema>;
export type KnowledgeDocumentUpdate = z.infer<typeof knowledgeDocumentUpdateSchema>;
export type KnowledgeMove = z.infer<typeof knowledgeMoveSchema>;
export type KnowledgeVersion = z.infer<typeof knowledgeVersionSchema>;
export type KnowledgeVersionsResponse = z.infer<typeof knowledgeVersionsResponseSchema>;
export type KnowledgeVersionDetail = z.infer<typeof knowledgeVersionDetailSchema>;
export type KnowledgeDocumentParams = z.infer<typeof knowledgeDocumentParamsSchema>;
export type KnowledgeVersionParams = z.infer<typeof knowledgeVersionParamsSchema>;
export type KnowledgePathQuery = z.infer<typeof knowledgePathQuerySchema>;
