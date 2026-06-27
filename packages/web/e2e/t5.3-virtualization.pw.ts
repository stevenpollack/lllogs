import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// T-5.3 evidence: virtualized events table DOM is bounded even on the 56k corpus.
// Run with:
//   LLLOGS_FIXTURE_DB=/tmp/.../scratchpad/demo.db bunx playwright test t5.3-virtualization

// `import.meta.dir` is Bun-only; the Playwright runner loads this under Node.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHOTS = resolve(HERE, "../../../docs/v2/artifacts/phase5");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, name);

// The virtualizer window + overscan: much less than the ~56k corpus rows.
// With estimateSize=28 and overscan=12 and a typical viewport, expect ≤ 80 DOM rows.
const MAX_DOM_ROWS = 80;

test("T-5.3 virtualization: DOM row count is bounded on 56k corpus", async ({ page }) => {
  await page.goto("/");

  // Wait for the events table to render at least one row.
  const rowLocator = page.locator("#events tbody#rows tr[data-id]");
  await expect(rowLocator.first()).toBeVisible({ timeout: 30_000 });

  // (2) Assert DOM row count is bounded — far fewer than the 56,984 corpus rows.
  const topRowCount = await rowLocator.count();
  console.log(
    `[T-5.3] DOM rows at top: ${topRowCount} (corpus ≈ 56,984; must be < ${MAX_DOM_ROWS})`,
  );
  expect(topRowCount).toBeLessThan(MAX_DOM_ROWS);
  expect(topRowCount).toBeGreaterThan(0);

  // (3) Screenshot at top.
  await page.screenshot({ path: shot("T-5.3-top.png"), fullPage: false });

  // (4) Scroll the events scroll container down substantially (~10k rows * 28px ≈ 280k px).
  // The scroll element is <main> (the element the virtualizer's getScrollElement returns).
  await page.locator("main").evaluate((el) => {
    el.scrollTop = 280_000;
  });

  // Wait for the virtualizer to re-render the new window after scroll.
  await page.waitForTimeout(300);

  // Assert DOM row count stays bounded after scrolling.
  const scrolledRowCount = await rowLocator.count();
  console.log(`[T-5.3] DOM rows after scroll: ${scrolledRowCount} (must be < ${MAX_DOM_ROWS})`);
  expect(scrolledRowCount).toBeLessThan(MAX_DOM_ROWS);
  expect(scrolledRowCount).toBeGreaterThan(0);

  // (4) Screenshot scrolled.
  await page.screenshot({ path: shot("T-5.3-scrolled.png"), fullPage: false });
});
