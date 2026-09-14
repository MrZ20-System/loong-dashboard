import { describe, expect, it } from "vitest";

import {
  repositoryOnboardingListResponseSchema,
  repositoryOnboardingRetrySchema,
} from "../src/index.js";

describe("repository onboarding contracts", () => {
  it("accepts an empty retry body or an explicit branch only", () => {
    expect(repositoryOnboardingRetrySchema.parse({})).toEqual({});
    expect(repositoryOnboardingRetrySchema.parse({ defaultBranch: "release" })).toEqual({
      defaultBranch: "release",
    });
    expect(repositoryOnboardingRetrySchema.safeParse({ remote: "origin" }).success).toBe(false);
  });

  it("bounds the onboarding status collection at ten rows", () => {
    const result = repositoryOnboardingListResponseSchema.safeParse({ items: [] });
    expect(result.success).toBe(true);
    expect(repositoryOnboardingListResponseSchema.safeParse({ items: new Array(11).fill({}) }).success)
      .toBe(false);
  });
});
