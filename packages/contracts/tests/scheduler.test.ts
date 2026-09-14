import { describe, expect, it } from "vitest";

import {
  scheduledTaskCreateSchema,
  scheduledTaskUpdateSchema,
} from "../src/index.js";

const common = {
  name: "Repository sync",
  cronExpression: "0 * * * *",
  timezone: "UTC",
  kind: "system" as const,
  action: "repository.sync" as const,
};

describe("scheduled task repository bindings", () => {
  it("requires repositoryId for repository-scoped system actions", () => {
    expect(scheduledTaskCreateSchema.safeParse(common).success).toBe(false);
    expect(
      scheduledTaskCreateSchema.safeParse({
        ...common,
        repositoryId: "repo",
      }).success,
    ).toBe(true);
    expect(
      scheduledTaskCreateSchema.safeParse({
        ...common,
        action: "personal-data.checkpoint",
      }).success,
    ).toBe(true);
  });

  it("leaves action-only updates valid for server-side merge", () => {
    expect(
      scheduledTaskUpdateSchema.safeParse({ action: "repository.sync" }).success,
    ).toBe(true);
  });
});
