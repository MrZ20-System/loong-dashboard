import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

test.describe.configure({ mode: "serial" });

const callLogPath = process.env.LOONGBOARD_E2E_CALL_LOG;
const activityDate = process.env.LOONGBOARD_E2E_ACTIVITY_DATE ?? "";

test("Stage 1 metadata flow stays local until sync and preserves failed rows", async ({
  page,
  request,
}) => {
  expect(callLogPath, "E2E runner must provide a fake-gh call log").toBeTruthy();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "LoongBoard" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Repository" })).toContainText(
    "Alpha Fixture",
  );
  expect(readCalls()).toHaveLength(0);

  await page.getByRole("link", { name: "Open Pull Requests" }).click();
  await expect(page).toHaveURL(/\/repositories\/alpha\/pulls$/);
  await expect(page.getByText("No pulls match these filters.")).toBeVisible();
  expect(readCalls()).toHaveLength(0);

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Sync started.")).toBeVisible();
  const firstAlphaStatus = await waitForSync(request, "alpha", "idle");
  const firstAlphaCalls = readCalls().filter(
    (call) => call.repositoryId === "alpha" && call.generation === "bootstrap",
  );
  expect(firstAlphaCalls).toHaveLength(4);
  expect(firstAlphaCalls.map((call) => `${call.operation}:${call.states.join(",")}`).sort()).toEqual([
    "issues:CLOSED",
    "issues:OPEN",
    "pulls:CLOSED,MERGED",
    "pulls:OPEN",
  ]);
  expect(firstAlphaCalls.every((call) => call.cursor === null)).toBe(true);

  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("Alpha tie PR 1000")).toBeVisible();
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(50);
  expect(await cellText(rows.nth(0), 0)).toBe("#1000");
  expect(await cellText(rows.nth(1), 0)).toBe("#999");
  expect(await cellText(rows.nth(49), 0)).toBe("#951");
  await expect(page.locator('dl[aria-label="List metrics"]')).toContainText("Changed files");
  await expect(page.locator('dl[aria-label="List metrics"]')).toContainText("Line changes");

  const callsBeforeListPagination = readCalls().length;
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(rows).toHaveCount(58);
  expect(readCalls()).toHaveLength(callsBeforeListPagination);

  await page.getByRole("combobox", { name: "Status" }).selectOption("merged");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Alpha merged PR");
  await page.getByRole("combobox", { name: "Status" }).selectOption("");
  await page.locator('input[aria-label="Activity date"]').fill(activityDate);
  await expect(page).toHaveURL(new RegExp(`date=${activityDate}`));
  await expect(rows.first()).toBeVisible();

  await page.goto("/repositories/alpha/issues");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator("table tbody tr")).toHaveCount(3);
  const issueMetricValues = await metricValues(page);
  expect(issueMetricValues.Comments).toBe("0");
  expect(issueMetricValues["Line changes"]).toBe("0");

  await page.goto("/");
  await page.getByRole("combobox", { name: "Repository" }).selectOption("beta");
  await expect(page).toHaveURL(/\/repositories\/beta\/pulls$/);
  await page.getByRole("button", { name: "Sync now" }).click();
  await waitForSync(request, "beta", "idle");
  const betaBootstrapCalls = readCalls().filter(
    (call) => call.repositoryId === "beta" && call.generation === "bootstrap",
  );
  expect(betaBootstrapCalls).toHaveLength(4);

  await page.goto("/repositories/alpha/pulls");
  const callsBeforeIncremental = readCalls().length;
  const priorPullWatermark = firstAlphaStatus.pullRequests.watermarkUpdatedAt;
  expect(priorPullWatermark).toBeTruthy();
  await page.getByRole("button", { name: "Sync now" }).click();
  const secondAlphaStatus = await waitForSync(request, "alpha", "idle");
  expect(secondAlphaStatus.pullRequests.watermarkUpdatedAt).toBeTruthy();
  expect(secondAlphaStatus.pullRequests.watermarkUpdatedAt! > priorPullWatermark!).toBe(true);

  const secondAlphaCalls = readCalls().slice(callsBeforeIncremental);
  expect(secondAlphaCalls).toHaveLength(2);
  expect(secondAlphaCalls.map((call) => `${call.operation}:${call.generation}`).sort()).toEqual([
    "issues:incremental-1",
    "pulls:incremental-1",
  ]);
  expect(secondAlphaCalls.every((call) => call.cursor === null)).toBe(true);

  const secondPulls = await json(request, "/api/repositories/alpha/pulls");
  const secondPullsItems = [...secondPulls.items];
  let nextPullCursor = secondPulls.nextCursor;
  while (nextPullCursor !== null) {
    const nextPage = await json(
      request,
      `/api/repositories/alpha/pulls?cursor=${encodeURIComponent(nextPullCursor)}`,
    );
    secondPullsItems.push(...nextPage.items);
    nextPullCursor = nextPage.nextCursor;
  }
  const equalityPull = secondPullsItems.find(
    (item) => item.title === "Alpha incremental watermark equality PR",
  );
  expect(equalityPull?.updatedAt).toBe(
    new Date(Date.parse(priorPullWatermark!) - 120_000).toISOString(),
  );
  expect(secondPullsItems.some((item) => item.number === 1_098)).toBe(false);

  const callsBeforeFailure = readCalls().length;
  await page.getByRole("button", { name: "Sync now" }).click();
  const failedAlphaStatus = await waitForSync(request, "alpha", "failed");
  expect(failedAlphaStatus.pullRequests.status).toBe("idle");
  expect(failedAlphaStatus.issues.status).toBe("failed");
  expect(failedAlphaStatus.issues.lastError).toContain("fixture issue stream failure");
  const failureCalls = readCalls().slice(callsBeforeFailure);
  expect(failureCalls).toHaveLength(2);
  expect(failureCalls.map((call) => `${call.operation}:${call.generation}`).sort()).toEqual([
    "issues:incremental-2",
    "pulls:incremental-2",
  ]);

  const retainedIssues = await json(request, "/api/repositories/alpha/issues");
  expect(retainedIssues.items.some((item) => item.title === "Alpha incremental watermark equality issue")).toBe(true);
  await page.reload();
  await expect(page.locator('[role="alert"]')).toContainText(
    "Last sync failed. Existing rows remain available.",
  );
  await page.goto("/repositories/alpha/issues");
  await expect(page.locator('[role="alert"]')).toContainText(
    "Last sync failed. Existing rows remain available.",
  );
  await expect(page.getByText("Alpha incremental watermark equality issue")).toBeVisible();
});

async function waitForSync(
  request: APIRequestContext,
  repositoryId: string,
  expected: "idle" | "failed",
) {
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/api/repositories/${encodeURIComponent(repositoryId)}/sync-status`,
        );
        if (!response.ok()) return `HTTP ${response.status()}`;
        return (await response.json()).status as string;
      },
      { timeout: 30_000, intervals: [100, 250, 500] },
    )
    .toBe(expected);
  return json(request, `/api/repositories/${encodeURIComponent(repositoryId)}/sync-status`);
}

async function json(request: APIRequestContext, url: string) {
  const response = await request.get(url);
  expect(response.ok(), `${url} returned HTTP ${response.status()}`).toBe(true);
  return response.json() as Promise<any>;
}

function readCalls(): Array<{
  repositoryId: string;
  operation: string;
  states: string[];
  cursor: string | null;
  generation: string;
}> {
  if (!callLogPath || !existsSync(callLogPath)) return [];
  return readFileSync(callLogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as {
      repositoryId: string;
      operation: string;
      states: string[];
      cursor: string | null;
      generation: string;
    });
}

async function cellText(row: ReturnType<Page["locator"]>, index: number) {
  return (await row.locator("td").nth(index).textContent())?.trim();
}

async function metricValues(page: Page): Promise<Record<string, string>> {
  return page.locator('dl[aria-label="List metrics"] > div').evaluateAll((nodes) =>
    Object.fromEntries(
      nodes.map((node) => [
        node.querySelector("dt")?.textContent?.trim() ?? "",
        node.querySelector("dd")?.textContent?.trim() ?? "",
      ]),
    ),
  );
}
