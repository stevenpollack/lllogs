import { test, expect } from "@playwright/test";

// Demo walkthrough — records a video of the whole app on the 56k-event corpus.
// Run with CLOGDY_FIXTURE_DB pointed at the big demo DB:
//   CLOGDY_FIXTURE_DB=/…/scratchpad/demo.db bunx playwright test demo
// The resulting test-results/…/video.webm is copied into docs/v2/artifacts/phase5/.
// Deliberate pauses make it watchable; `.pw.ts` so `bun test` ignores it (D-5.i).

const beat = (page: import("@playwright/test").Page, ms = 1100) => page.waitForTimeout(ms);

test("clogdy v2 demo: events → virtualization → facets → drawer → analytics → SQL", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/");

  // 1. Events table over the full corpus.
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });
  await beat(page, 1400);

  // 2. Virtualized scroll — thousands of rows, the DOM stays windowed.
  for (let i = 0; i < 6; i++) {
    await page.locator("main").evaluate((el) => el.scrollBy(0, 2200));
    await beat(page, 600);
  }
  await page.locator("main").evaluate((el) => (el.scrollTop = 0));
  await beat(page, 900);

  // 3. Facet by tool (server-side accurate counts over the full corpus).
  const bash = page.locator("#facets .facet", { hasText: "Bash" });
  if ((await bash.count()) > 0) {
    await bash.first().click();
    await expect(page.locator("#chips .chip").first()).toBeVisible();
    await beat(page, 1300);
  }

  // 4. Open a row drawer (full raw JSON + result), then close it.
  await page.locator("#events tbody#rows tr[data-id]").first().click();
  await expect(page.locator("#drawer")).toBeVisible();
  await beat(page, 1600);
  await page.keyboard.press("Escape");
  await expect(page.locator("#drawer")).toHaveCount(0);
  await beat(page, 700);

  // 5. Analytics tab — per-tool / error / latency p50·p95 / rollups (DuckDB).
  await page.locator("#tab-analytics").click();
  await expect(page.locator("#tab-analytics")).toHaveClass(/active/);
  await beat(page, 2200);
  await page.locator("main").evaluate((el) => el.scrollBy(0, 600));
  await beat(page, 1500);
  await page.locator("main").evaluate((el) => (el.scrollTop = 0));
  await page.locator("#tab-events").click();
  await expect(page.locator("#tab-events")).toHaveClass(/active/);
  await beat(page, 800);

  // 6. Facets + SQL: read-only SQL atop the faceted data.
  await page.locator("#sql-btn").click();
  await expect(page.locator("#sql-editor")).toBeVisible();
  await beat(page, 800);
  await page.locator("#sql-examples-btn").click();
  await expect(page.locator("#sql-examples-list")).toBeVisible();
  await beat(page, 1200);
  await page.locator("#sql-examples-list li").nth(0).click();
  await expect(page.locator("#sql-cm .cm-content")).toContainText("COUNT(*)");
  await beat(page, 1000);
  await page.locator("#sql-run").click();
  await expect(page.locator("#query-result-view")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#sql-banner")).toContainText("live paused");
  await beat(page, 2200);

  // 7. Clear SQL → live faceted events view resumes.
  const cm = page.locator("#sql-cm .cm-content");
  await cm.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });
  await beat(page, 1400);
});
