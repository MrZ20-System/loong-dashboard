import { z } from "zod";

import { utcDateTimeSchema } from "./validation.js";

/** V1 import input. The local destination is always supplied by the server. */
export const personalDataImportSchema = z
  .object({
    repositoryUrl: z.string().trim().min(1).max(2_048),
    branch: z.string().trim().min(1).max(255),
  })
  .strict();

/** Read-only local Personal Data paths and repository availability. */
export const personalDataStatusSchema = z
  .object({
    path: z.string().trim().min(1),
    knowledgePath: z.string().trim().min(1),
    instructionTreePath: z.string().trim().min(1),
    available: z.boolean(),
  })
  .strict();

/** Synchronous import returns the resulting local status. */
export const personalDataImportResponseSchema = personalDataStatusSchema;

/** The refresh operation reports only the overwritten artifact and timestamp. */
export const personalDataInstructionTreeRefreshResponseSchema = z
  .object({
    path: z.string().trim().min(1),
    updatedAt: utcDateTimeSchema,
  })
  .strict();

export type PersonalDataImport = z.infer<typeof personalDataImportSchema>;
export type PersonalDataStatus = z.infer<typeof personalDataStatusSchema>;
export type PersonalDataImportResponse = z.infer<typeof personalDataImportResponseSchema>;
export type PersonalDataInstructionTreeRefreshResponse = z.infer<
  typeof personalDataInstructionTreeRefreshResponseSchema
>;
