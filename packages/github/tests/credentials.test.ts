import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubCredentialService } from "../src/index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-github-credential-"));
  directories.push(directory);
  return {
    directory,
    filePath: join(directory, "github-credential.json"),
  };
}

describe("GitHubCredentialService", () => {
  it("reports no credential when neither environment nor gh is configured", async () => {
    const { filePath } = fixture();
    const service = new GitHubCredentialService({
      filePath,
      environment: {},
      ghExecutable: "false",
    });

    await expect(service.summary()).resolves.toEqual({
      configured: false,
      source: "none",
    });
  });

  it("uses the saved token without exposing it in the summary and writes mode 0600", async () => {
    const { filePath } = fixture();
    const service = new GitHubCredentialService({
      filePath,
      environment: {},
      ghExecutable: "false",
    });
    service.save("saved-secret");

    await expect(service.summary()).resolves.toEqual({
      configured: true,
      source: "settings",
    });
    await expect(service.resolve()).resolves.toEqual({
      token: "saved-secret",
      source: "settings",
    });
    expect(JSON.stringify(await service.summary())).not.toContain("saved-secret");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ version: 1 });
  });

  it("does not include malformed credential content in its parse error", () => {
    const { filePath } = fixture();
    writeFileSync(filePath, '{"token":"do-not-leak",', "utf8");
    const service = new GitHubCredentialService({
      filePath,
      environment: {},
      ghExecutable: "false",
    });

    expect(() => service.storedToken()).toThrow("invalid JSON");
    expect(() => service.storedToken()).toThrowError(
      expect.not.stringContaining("do-not-leak"),
    );
  });

  it("shares the GH_TOKEN source with both summary and resolution", async () => {
    const { filePath } = fixture();
    const service = new GitHubCredentialService({
      filePath,
      environment: { GH_TOKEN: "environment-secret" },
      ghExecutable: "false",
    });

    await expect(service.summary()).resolves.toEqual({
      configured: true,
      source: "GH_TOKEN",
    });
    await expect(service.resolveToken()).resolves.toBe("environment-secret");
  });
});
