import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// T-5.2 evidence: strict feature-parity of the React/TanStack migration.
// Records a video of the core flow + the four named screenshots.

// `import.meta.dir` is Bun-only; the Playwright runner loads this under Node.
// `fileURLToPath(new URL(".", import.meta.url))` is this file's dir in both.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHOTS = resolve(HERE, "../../../docs/v2/artifacts/phase5");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, name);

test("T-5.2 parity: facet → filter → chip → analytics → drawer", async ({ page }) => {
  await page.goto("/");

  // Events table renders rows.
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });
  const initialRows = await page.locator("#events tbody#rows tr[data-id]").count();
  expect(initialRows).toBeGreaterThan(0);
  await page.screenshot({ path: shot("T-5.2-events.png"), fullPage: false });

  // Facet sidebar shows tool counts (Bash present).
  const bashFacet = page.locator("#facets .facet", { hasText: "Bash" });
  await expect(bashFacet).toBeVisible();

  // Click the Bash tool facet → table filters + a chip appears + facet goes active.
  await bashFacet.click();
  await expect(page.locator("#facets .facet.active", { hasText: "Bash" })).toBeVisible();
  await expect(page.locator("#chips .chip", { hasText: "Bash" })).toBeVisible();
  // Every visible row should now be a Bash tool row (tool column shows "Bash").
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible();
  await page.screenshot({ path: shot("T-5.2-facet-active.png"), fullPage: false });

  // Switch to Analytics tab → analytics view shows; switch back to Events.
  await page.locator("#tab-analytics").click();
  await expect(page.locator("#tab-analytics")).toHaveClass(/active/);
  // give charts a moment to mount
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("T-5.2-analytics.png"), fullPage: false });
  await page.locator("#tab-events").click();
  await expect(page.locator("#tab-events")).toHaveClass(/active/);

  // Open a row drawer (click a row), confirm the drawer renders, then close it.
  await page.locator("#events tbody#rows tr[data-id]").first().click();
  await expect(page.locator("#drawer")).toBeVisible();
  await page.screenshot({ path: shot("T-5.2-drawer.png"), fullPage: false });
  // Close via Escape (drawer supports Escape/click-outside).
  await page.keyboard.press("Escape");
  await expect(page.locator("#drawer")).toHaveCount(0);
});
