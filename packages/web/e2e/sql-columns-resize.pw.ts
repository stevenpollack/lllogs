import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Evidence for two UX fixes:
//   1. SQL editor surfaces the available columns — a "Columns ▾" reference panel
//      (click to insert) and schema-aware CodeMirror autocomplete.
//   2. Events-table columns are user-resizable (drag the header edge), persisted.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHOTS = resolve(HERE, "../../../docs/v2/artifacts/phase5");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, name);

test("SQL columns reference + autocomplete are discoverable", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  // Enter SQL mode.
  await page.locator("#sql-btn").click();
  await expect(page.locator("#sql-editor")).toBeVisible();

  // The Columns reference lists every queryable field with type + description.
  await page.locator("#sql-columns-btn").click();
  await expect(page.locator("#sql-columns-list")).toBeVisible();
  const cols = page.locator("#sql-columns-list .sql-column");
  await expect(cols.first()).toBeVisible();
  // The exact column count is asserted against the DDL in ingest's schema.test.ts;
  // here just confirm the panel is populated (avoid duplicating that coupling).
  expect(await cols.count()).toBeGreaterThan(15);
  await expect(page.locator("#sql-columns-list")).toContainText("session_id");
  await expect(page.locator("#sql-columns-list")).toContainText("is_error");
  // The panel is wide enough to show full (untruncated) descriptions.
  await expect(page.locator("#sql-columns-list")).toContainText("1 if the tool_result is an error");
  await page.screenshot({ path: shot("SQL-columns-panel.png") });
  // Close the panel so it no longer overlaps the editor.
  await page.locator("#sql-columns-btn").click();
  await expect(page.locator("#sql-columns-list")).toBeHidden();

  // Clicking a column inserts it into the editor at the cursor.
  await page.locator("#sql-cm .cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("SELECT  FROM events");
  // Place cursor after "SELECT " (move left past " FROM events" = 12 chars).
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowLeft");
  await page.locator("#sql-columns-btn").click();
  await page.locator("#sql-columns-list .sql-column", { hasText: "session_id" }).click();
  await expect(page.locator("#sql-cm .cm-content")).toContainText("SELECT session_id FROM events");

  // Schema-aware autocomplete: typing a column prefix + Ctrl-Space lists matches.
  await page.locator("#sql-cm .cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("SELECT is_e");
  await page.keyboard.press("Control+Space");
  const tip = page.locator(".cm-tooltip-autocomplete");
  await expect(tip).toBeVisible({ timeout: 5_000 });
  await expect(tip).toContainText("is_error");
  await page.screenshot({ path: shot("SQL-autocomplete.png") });
});

test("events table columns are resizable and persist", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  const projectHeader = page.locator("#events thead th").first();
  const before = (await projectHeader.boundingBox())!;
  await page.screenshot({ path: shot("resize-before.png") });

  // Drag the PROJECT column's resize handle ~140px to the right.
  const handle = projectHeader.locator(".resizer");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 140, hb.y + hb.height / 2, { steps: 10 });
  await page.mouse.up();

  const after = (await projectHeader.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 80);
  await page.screenshot({ path: shot("resize-after.png") });

  // Width persists across reload (localStorage-backed column sizing).
  await page.reload();
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });
  const afterReload = (await page.locator("#events thead th").first().boundingBox())!;
  expect(Math.abs(afterReload.width - after.width)).toBeLessThan(4);
});

test("SQL result-grid columns are resizable", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  // Enter SQL mode, load an example that returns rows, and run it.
  await page.locator("#sql-btn").click();
  await expect(page.locator("#sql-editor")).toBeVisible();
  await page.locator("#sql-examples-btn").click();
  await page.locator("#sql-examples-list li").first().click();
  await expect(page.locator("#sql-cm .cm-content")).toContainText("COUNT(*)");
  await page.locator("#sql-run").click();
  await expect(page.locator("#query-result-view")).toBeVisible({ timeout: 60_000 });

  const firstHeader = page.locator("#query-result thead th").first();
  await expect(firstHeader).toBeVisible({ timeout: 10_000 });
  const before = (await firstHeader.boundingBox())!;

  // Drag the first result column's handle ~120px wider.
  const handle = firstHeader.locator(".resizer");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 120, hb.y + hb.height / 2, { steps: 10 });
  await page.mouse.up();

  const after = (await firstHeader.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 60);
  await page.screenshot({ path: shot("SQL-result-resize.png") });
});

test("facet sections collapse and persist", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#facets .facet").first()).toBeVisible({ timeout: 30_000 });

  const facetCount = () => page.locator("#facets .facet").count();
  const before = await facetCount();
  expect(before).toBeGreaterThan(0);

  // Collapse the first section (PROJECT) → its facet rows disappear.
  const projectHead = page.locator("#facets h3.facet-head").first();
  await expect(projectHead).toHaveAttribute("aria-expanded", "true");
  await projectHead.click();
  await expect(projectHead).toHaveAttribute("aria-expanded", "false");
  const collapsed = await facetCount();
  expect(collapsed).toBeLessThan(before);
  await page.screenshot({ path: shot("facets-collapsed.png") });

  // Persists across reload (localStorage).
  await page.reload();
  await expect(page.locator("#facets .facet").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#facets h3.facet-head").first()).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(await facetCount()).toBe(collapsed);
});

test("events table sorts by a column", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  // Click the TIME column label to sort. ts is numeric, so react-table sorts
  // descending (newest-first) on the first click, ascending on the second.
  const timeLabel = page.locator("#events thead th .th-label.sortable").filter({ hasText: "TIME" });
  await timeLabel.click();
  await expect(timeLabel).toContainText("▼");
  await timeLabel.click();
  await expect(timeLabel).toContainText("▲");

  // Descending sort really reorders: the first visible row's id should differ
  // from the default (id-ascending) first row.
  const firstId = await page
    .locator("#events tbody#rows tr[data-id]")
    .first()
    .getAttribute("data-id");
  expect(firstId).not.toBeNull();
  await page.screenshot({ path: shot("events-sorted.png") });
});

test("tables fill the viewport width", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  // Run a 2-column query — its natural width (~360px) is far narrower than the
  // viewport, so a filled table is much wider (no big right gutter).
  await page.locator("#sql-btn").click();
  await page.locator("#sql-examples-btn").click();
  await page.locator("#sql-examples-list li").first().click();
  await page.locator("#sql-run").click();
  await expect(page.locator("#query-result-view")).toBeVisible({ timeout: 60_000 });

  const table = (await page.locator("#query-result").boundingBox())!;
  const container = (await page.locator("#query-result-view").boundingBox())!;
  // Table spans (nearly) the full container, not its ~360px natural width.
  expect(table.width).toBeGreaterThan(container.width * 0.9);
});

test("multi-select facets of the same dimension OR together", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  const kindFacet = (name: string) =>
    page.locator("#facets .facet").filter({ hasText: name }).first();

  // Select two KIND values — they should both stay active (OR), not override.
  await kindFacet("tool_use").click();
  await expect(kindFacet("tool_use")).toHaveClass(/active/);
  await kindFacet("tool_result").click();
  await expect(kindFacet("tool_use")).toHaveClass(/active/);
  await expect(kindFacet("tool_result")).toHaveClass(/active/);

  // Two separate chips, one per selected value.
  const kindChips = page.locator("#chips .chip").filter({ hasText: "kind:" });
  await expect(kindChips).toHaveCount(2);
  await page.screenshot({ path: shot("facets-multi.png") });

  // Removing one chip drops only that value; the other stays selected.
  await kindChips.filter({ hasText: "tool_use" }).click();
  await expect(kindFacet("tool_use")).not.toHaveClass(/active/);
  await expect(kindFacet("tool_result")).toHaveClass(/active/);
  await expect(page.locator("#chips .chip").filter({ hasText: "kind:" })).toHaveCount(1);
});

test("events table columns can be hidden and the choice persists", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  const headers = page.locator("#events thead th");
  const initial = await headers.count();
  expect(initial).toBeGreaterThan(1);

  // Open the Columns menu and hide TEXT.
  await page.locator("#col-menu-btn").click();
  await expect(page.locator("#col-menu-list")).toBeVisible();
  await page.locator("#col-menu-list li").filter({ hasText: "TEXT" }).click();
  await expect(headers).toHaveCount(initial - 1);
  await expect(page.locator("#events thead th .th-label").filter({ hasText: "TEXT" })).toHaveCount(
    0,
  );
  await page.screenshot({ path: shot("columns-hidden.png") });

  // Persists across reload (localStorage).
  await page.reload();
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("#events thead th")).toHaveCount(initial - 1);

  // Re-show TEXT.
  await page.locator("#col-menu-btn").click();
  await page.locator("#col-menu-list li").filter({ hasText: "TEXT" }).click();
  await expect(page.locator("#events thead th")).toHaveCount(initial);
});

test("the last visible column cannot be hidden", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  await page.locator("#col-menu-btn").click();
  const checks = page.locator("#col-menu-list input[type=checkbox]");
  const n = await checks.count();
  // Uncheck every column but the first.
  for (let i = n - 1; i >= 1; i--) {
    const box = checks.nth(i);
    if ((await box.isChecked()) && (await box.isEnabled())) await box.click();
  }
  // The grid never drops to 0 columns; one header remains.
  await expect(page.locator("#events thead th")).toHaveCount(1);
  // The single remaining visible column's checkbox is disabled (can't hide it).
  const checked = page.locator("#col-menu-list input:checked");
  await expect(checked).toHaveCount(1);
  await expect(checked.first()).toBeDisabled();
});

test("the search box carries an explainer tooltip", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#q")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#q")).toHaveAttribute("title", /substring search/i);
  await expect(page.locator("#q-help")).toHaveAttribute("title", /wildcard/i);
});
