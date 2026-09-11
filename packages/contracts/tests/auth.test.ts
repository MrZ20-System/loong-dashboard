import { describe, expect, it } from "vitest";

import {
  authPasswordUpdateSchema,
  authStatusSchema,
  authUnlockRequestSchema,
} from "../src/index.js";

describe("authentication contracts", () => {
  it("keeps the status projection free of secret fields", () => {
    expect(authStatusSchema.parse({ enabled: true, unlocked: false })).toEqual({
      enabled: true,
      unlocked: false,
    });
    expect(() => authStatusSchema.parse({ enabled: true, unlocked: false, hash: "secret" })).toThrow();
  });

  it("validates password request bounds without accepting extra fields", () => {
    expect(authUnlockRequestSchema.parse({ password: "secret" })).toEqual({ password: "secret" });
    expect(authPasswordUpdateSchema.parse({ password: "new", currentPassword: "old" })).toEqual({
      password: "new",
      currentPassword: "old",
    });
    expect(() => authUnlockRequestSchema.parse({ password: "" })).toThrow();
    expect(() => authPasswordUpdateSchema.parse({ password: "new", hash: "secret" })).toThrow();
  });
});
