import { z } from "zod";

/** The frozen response returned by GET /api/health. */
export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
