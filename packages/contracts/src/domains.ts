import { z } from "zod";

import { repositoryIdSchema, utcDateTimeSchema } from "./validation.js";

/**
 * Product-owned instruction used when a user restores the Domain Agent
 * prompt. Keep this in the shared contracts package so the Web and Server
 * agree on the exact persisted default.
 */
export const DEFAULT_DOMAIN_UPDATE_PROMPT = `# Update domains / 更新领域

Analyze this repository and update its Domain definitions in the repository's Domain JSON file.
分析此仓库，并更新仓库 Domain JSON 文件中的领域定义。

User request / 用户要求：

<我输入的内容>

Keep the definitions useful for deterministic changed-file classification. Preserve useful existing metadata, edit the JSON file directly, and explain the changes in the conversation.
保持定义适合对变更文件进行确定性分类。保留有用的现有元数据，直接编辑 JSON 文件，并在对话中说明修改。

Output format / 输出格式：

When finished, write the complete Domain JSON using this structure. 完成后按以下结构写入完整的 Domain JSON：

{
  "version": 1,
  "repositoryId": "<repository-id>",
  "domains": [
    {
      "id": "dom_<stable-id>",
      "name": "Documentation",
      "color": "#5b8def",
      "position": 0,
      "enabled": true,
      "includePatterns": ["docs/**"],
      "excludePatterns": []
    }
  ]
}
`;

/** Domain rule ids are server-generated (`dom_<random>`). */
export const domainRuleIdSchema = z.string().trim().min(1).max(64);

export const domainColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Expected #rrggbb");

const patternSchema = z.string().trim().min(1).max(200);
const includePatternsSchema = z.array(patternSchema).min(1).max(50);
const excludePatternsSchema = z.array(patternSchema).max(50);
const domainNameSchema = z.string().trim().min(1).max(40);

/** The small domain projection attached to pull request list rows. */
export const domainTagSchema = z
  .object({
    id: domainRuleIdSchema,
    name: z.string().trim().min(1),
    color: domainColorSchema,
  })
  .strict();

export const domainRuleSchema = z
  .object({
    id: domainRuleIdSchema,
    repositoryId: repositoryIdSchema,
    name: domainNameSchema,
    color: domainColorSchema,
    position: z.number().int().nonnegative(),
    enabled: z.boolean(),
    includePatterns: includePatternsSchema,
    excludePatterns: excludePatternsSchema,
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict();

export const reclassificationStatusSchema = z
  .object({
    running: z.boolean(),
    pendingCount: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const domainsResponseSchema = z
  .object({
    items: z.array(domainRuleSchema),
    reclassification: reclassificationStatusSchema,
    /** Last source parse error, while the last valid SQLite projection stays visible. */
    sourceError: z.string().nullable().optional(),
  })
  .strict();

export const domainRuleCreateSchema = z
  .object({
    name: domainNameSchema,
    color: domainColorSchema.optional(),
    includePatterns: includePatternsSchema,
    excludePatterns: excludePatternsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const domainRuleUpdateSchema = z
  .object({
    name: domainNameSchema.optional(),
    color: domainColorSchema.optional(),
    includePatterns: includePatternsSchema.optional(),
    excludePatterns: excludePatternsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one field must be provided",
  });

export const domainMutationResponseSchema = z
  .object({
    item: domainRuleSchema,
    reclassification: reclassificationStatusSchema,
  })
  .strict();

export const domainDeleteResponseSchema = z
  .object({
    deleted: z.literal(true),
    reclassification: reclassificationStatusSchema,
  })
  .strict();

/** Path parameters shared by single-domain endpoints. */
export const domainParamsSchema = z
  .object({
    id: repositoryIdSchema,
    domainId: domainRuleIdSchema,
  })
  .strict();

/** Stored current-head file rows for one pull request. */
export const pullRequestFileItemSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).nullable(),
    changeType: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

export const pullRequestFilesResponseSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    number: z.number().int().positive(),
    headSha: z.string().min(1),
    truncated: z.boolean(),
    items: z.array(pullRequestFileItemSchema),
  })
  .strict();

export const pullRequestParamsSchema = z
  .object({
    id: repositoryIdSchema,
    number: z.coerce.number().int().positive(),
  })
  .strict();

export type DomainRuleId = z.infer<typeof domainRuleIdSchema>;
export type DomainTag = z.infer<typeof domainTagSchema>;
export type DomainRule = z.infer<typeof domainRuleSchema>;
export type ReclassificationStatus = z.infer<typeof reclassificationStatusSchema>;
export type DomainsResponse = z.infer<typeof domainsResponseSchema>;
export type DomainRuleCreate = z.infer<typeof domainRuleCreateSchema>;
export type DomainRuleUpdate = z.infer<typeof domainRuleUpdateSchema>;
export type DomainMutationResponse = z.infer<typeof domainMutationResponseSchema>;
export type DomainDeleteResponse = z.infer<typeof domainDeleteResponseSchema>;
export type DomainParams = z.infer<typeof domainParamsSchema>;
export type PullRequestFileItem = z.infer<typeof pullRequestFileItemSchema>;
export type PullRequestFilesResponse = z.infer<typeof pullRequestFilesResponseSchema>;
export type PullRequestParams = z.infer<typeof pullRequestParamsSchema>;
