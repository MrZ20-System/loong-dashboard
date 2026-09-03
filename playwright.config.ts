import { defineConfig } from "@playwright/test";

const browserExecutablePath = process.env.LOONGBOARD_E2E_BROWSER_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  outputDir: process.env.LOONGBOARD_E2E_OUTPUT_DIR ?? "test-results",
  use: {
    baseURL: process.env.LOONGBOARD_E2E_WEB_ORIGIN ?? "http://127.0.0.1:5173",
    ...(browserExecutablePath
      ? { launchOptions: { executablePath: browserExecutablePath } }
      : {}),
  },
});
