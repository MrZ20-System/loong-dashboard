import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "../src/index.js";

describe("healthResponseSchema", () => {
  it("parses the frozen health response", () => {
    expect(healthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rejects an invalid status", () => {
    expect(healthResponseSchema.safeParse({ status: "degraded" }).success).toBe(false);
    expect(healthResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects extra response fields", () => {
    expect(
      healthResponseSchema.safeParse({ status: "ok", extra: true }).success,
    ).toBe(false);
  });
});
