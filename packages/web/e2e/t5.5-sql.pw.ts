import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// T-5.5 evidence: CodeMirror SQL editor + dynamic result grid wired to facets.
// `import.meta.dir` is Bun-only; use `fileURLToPath` so Playwright's Node loader works.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHOTS = resolve(HERE, "../../../docs/v2/artifacts/phase5");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, name);

test("T-5.5 SQL: facet → SQL editor → run → result → error → clear", async ({ page }) => {
  // Functional SQL-editor evidence runs against the small fixture.db (default
  // CLOGDY_FIXTURE_DB) — fast. The 56k corpus is the virtualization proof's job
  // (T-5.3/T-5.7), not this one; a DuckDB quantile over 56k blows the budget.
  test.setTimeout(120_000);

  await page.goto("/");

  // Wait for events to load
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  // Click the `kind=tool_use` facet so the SQL runs atop a faceted subset.
  const toolUseFacet = page.locator("#facets .facet", { hasText: "tool_use" });
  const fallbackFacet = page.locator("#facets .facet").first();
  const facetToClick = (await toolUseFacet.count()) > 0 ? toolUseFacet : fallbackFacet;
  await facetToClick.click();
  await expect(page.locator("#chips .chip").first()).toBeVisible();

  // Toggle SQL mode
  await page.locator("#sql-btn").click();
  await expect(page.locator("#sql-editor")).toBeVisible();

  // Open the examples dropdown and screenshot it open
  await page.locator("#sql-examples-btn").click();
  await expect(page.locator("#sql-examples-list")).toBeVisible();
  await page.screenshot({ path: shot("T-5.5-examples.png") });

  // Click the "Tool usage counts" example (index 0) — yields real rows on the
  // fixture (Bash/Read/Edit counts), so the dynamic-column grid shows data.
  await page.locator("#sql-examples-list li").nth(0).click();

  // Wait for the CodeMirror content to be populated (React state update + re-render).
  await expect(page.locator("#sql-cm .cm-content")).toContainText("COUNT(*)", {
    timeout: 5_000,
  });

  // Run the query via the Run button.
  await page.locator("#sql-run").click();

  // Wait for result grid to appear (DuckDB subprocess may take several seconds).
  await expect(page.locator("#query-result-view")).toBeVisible({ timeout: 60_000 });

  // Assert dynamic column headers rendered (tool, p50, p95 for the latency query).
  const headers = page.locator("#query-result thead th");
  await expect(headers.first()).toBeVisible({ timeout: 10_000 });
  const headerCount = await headers.count();
  expect(headerCount).toBeGreaterThan(0);

  // Assert banner shows "live paused" with the faceted event count.
  await expect(page.locator("#sql-banner")).toContainText("live paused", { timeout: 10_000 });
  await expect(page.locator("#sql-banner")).toContainText("Querying", { timeout: 5_000 });

  // Screenshot: SQL result with dynamic columns
  await page.screenshot({ path: shot("T-5.5-sql-result.png") });

  // Type an invalid query into CodeMirror (select-all + replace). The client-side
  // guard catches it before the round-trip.
  const cmContent = page.locator("#sql-cm .cm-content");
  await cmContent.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("DROP TABLE events");
  await page.locator("#sql-run").click();

  // Error should appear inline under the editor (client-side guard: instant).
  await expect(page.locator("#sql-error")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#sql-error")).not.toBeEmpty();

  // Last good result is still shown (spec: "grid keeps the last good result").
  await expect(page.locator("#query-result-view")).toBeVisible();

  // Screenshot: inline error under the editor
  await page.screenshot({ path: shot("T-5.5-error.png") });

  // Clear the SQL box → SQL mode exits → live faceted events view resumes.
  await cmContent.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("#query-result-view")).not.toBeVisible();
});
