import { describe, expect, it } from "vitest";
import { DEFAULT_API_ORIGIN, resolveApiOrigin } from "./api-proxy";

describe("Vite API proxy target", () => {
  it("uses the local server as the default target", () => {
    expect(resolveApiOrigin()).toBe(DEFAULT_API_ORIGIN);
    expect(resolveApiOrigin("   ")).toBe(DEFAULT_API_ORIGIN);
  });

  it("uses the configured API origin when provided", () => {
    expect(resolveApiOrigin("http://127.0.0.1:5174")).toBe(
      "http://127.0.0.1:5174",
    );
  });
});
