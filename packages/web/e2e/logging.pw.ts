import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Import the evidence helpers from the SHARED SOURCE by relative path, not from
// "@clogdy/shared": that barrel resolves to a raw .ts entry inside node_modules,
// which Playwright's Node loader does not transform. `log.ts` is pure (only a
// type-only pino import) so it loads standalone under Playwright.
import { parseLogLines, selectEvents, type LogEntry } from "../../shared/src/log";
import { LOG_DIR, SERVER_LOG } from "./logenv";

// Phase 6 evidence: drive the real UI, then prove correctness from the structured
// logs the server, the analytics child, and the browser actually emitted — not from
// the DOM alone. Mirrors t5.5-sql.pw.ts for the selectors/flow; adds log capture.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHOTS = resolve(HERE, "../../../docs/v2/artifacts/phase6");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, name);

test("Phase 6 logging evidence: server.jsonl + analytics file + browser console line up", async ({
  page,
}) => {
  // The DuckDB child can take several seconds; keep t5.5's generous budget.
  test.setTimeout(120_000);

  // Capture the browser's structured logs (pure JSON lines on console.log) BEFORE
  // navigating, so web.boot — emitted at module load — is not missed.
  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(m.text()));

  // `?log=debug` raises the browser logger to debug for this page (resolveLevel()).
  await page.goto("/?log=debug");

  // Events loaded ⇒ the server handled /api/events + /api/facets and the client
  // subscribed to SSE.
  await expect(page.locator("#events tbody#rows tr[data-id]").first()).toBeVisible({
    timeout: 30_000,
  });

  // Turn Live ON so the client opens an SSE subscription — the end-to-end proof of
  // SSE (server `sse.open` + browser `sse.open`). Live is opt-in (off by default),
  // so without this click no `/api/events/stream` request is ever made.
  await page.locator("#live-btn").click();
  await expect(page.locator("#live-btn")).toHaveClass(/active/);

  // Click the kind=tool_use facet so the SQL runs atop a faceted subset (mirrors t5.5).
  const toolUseFacet = page.locator("#facets .facet", { hasText: "tool_use" });
  const fallbackFacet = page.locator("#facets .facet").first();
  const facetToClick = (await toolUseFacet.count()) > 0 ? toolUseFacet : fallbackFacet;
  await facetToClick.click();
  await expect(page.locator("#chips .chip").first()).toBeVisible();

  // Toggle SQL mode → emits a browser `mode.switch {to:"sql"}`.
  await page.locator("#sql-btn").click();
  await expect(page.locator("#sql-editor")).toBeVisible();

  // Open the examples dropdown and pick "Tool usage counts" (index 0) — a COUNT(*)
  // GROUP BY that returns real rows on the fixture, so the dynamic grid shows data.
  await page.locator("#sql-examples-btn").click();
  await expect(page.locator("#sql-examples-list")).toBeVisible();
  await page.locator("#sql-examples-list li").nth(0).click();
  await expect(page.locator("#sql-cm .cm-content")).toContainText("COUNT(*)", {
    timeout: 5_000,
  });

  // Run → POST /api/query → server spawns analytics --query → DuckDB attaches READ_ONLY.
  await page.locator("#sql-run").click();
  await expect(page.locator("#query-result-view")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#query-result thead th").first()).toBeVisible({
    timeout: 10_000,
  });
  await page.screenshot({ path: shot("logging-sql-result.png") });

  // Invalid query — the CLIENT preflight assertSelectOnly rejects it BEFORE any POST,
  // so it surfaces as a browser `query.error`, NOT a server `query.rejected`.
  const cmContent = page.locator("#sql-cm .cm-content");
  await cmContent.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("DROP TABLE events");
  await page.locator("#sql-run").click();
  await expect(page.locator("#sql-error")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#sql-error")).not.toBeEmpty();
  await page.screenshot({ path: shot("logging-error.png") });

  // Let the last server log lines flush and the async console events drain.
  await page.waitForTimeout(750);

  // ---- Read the evidence -----------------------------------------------------
  const srv: LogEntry[] = parseLogLines(readFileSync(SERVER_LOG, "utf8"));
  const web: LogEntry[] = parseLogLines(consoleLines.join("\n")).filter((e) => e.proc === "web");
  const analyticsFiles = readdirSync(LOG_DIR).filter((f) => /^analytics-.*\.jsonl$/.test(f));
  const ana: LogEntry[] = [];
  for (const f of analyticsFiles) {
    ana.push(...parseLogLines(readFileSync(resolve(LOG_DIR, f), "utf8")));
  }

  // Surface a compact summary in the test output (evidence in the run log).
  const evts = (xs: LogEntry[]): string =>
    [...new Set(xs.map((e) => e.evt).filter(Boolean))].join(", ");
  console.log(
    `[evidence] server lines=${srv.length} web lines=${web.length} ` +
      `analytics files=${analyticsFiles.length} (${analyticsFiles.join(",")})`,
  );
  console.log(`[evidence] server evts: ${evts(srv)}`);
  console.log(`[evidence] analytics evts: ${evts(ana)}`);
  console.log(`[evidence] browser proc:web evts: ${evts(web)}`);

  // ---- SERVER (server.jsonl) -------------------------------------------------
  expect(selectEvents(srv, { evt: "server.boot" }).length).toBeGreaterThanOrEqual(1);

  const reqEnds = selectEvents(srv, { evt: "req.end" });
  expect(reqEnds.some((e) => e.status === 200)).toBeTruthy();

  expect(selectEvents(srv, { evt: "sse.open" }).length).toBeGreaterThanOrEqual(1);

  const querySpawns = selectEvents(srv, { evt: "analytics.spawn" }).filter(
    (e) => e.mode === "query",
  );
  expect(querySpawns.length).toBeGreaterThanOrEqual(1);

  const cleanExits = selectEvents(srv, { evt: "analytics.exit" }).filter((e) => e.code === 0);
  expect(cleanExits.length).toBeGreaterThanOrEqual(1);

  // Stronger: the query spawn and a clean exit share a request id (same /api/query).
  const queryReqIds = new Set(querySpawns.map((e) => e.reqId));
  expect(cleanExits.some((e) => queryReqIds.has(e.reqId))).toBeTruthy();

  // ---- ANALYTICS (analytics-<pid>.jsonl, file-only) --------------------------
  // End-to-end proof of ground rule #4 through the real server→analytics spawn.
  expect(analyticsFiles.length).toBeGreaterThanOrEqual(1);
  expect(selectEvents(ana, { evt: "analytics.run" }).length).toBeGreaterThanOrEqual(1);
  expect(
    selectEvents(ana, { evt: "analytics.attach" }).filter((e) => e.readOnly === true).length,
  ).toBeGreaterThanOrEqual(1);

  // ---- BROWSER (console, proc:"web") -----------------------------------------
  expect(selectEvents(web, { evt: "web.boot" }).length).toBeGreaterThanOrEqual(1);
  expect(selectEvents(web, { evt: "sse.open" }).length).toBeGreaterThanOrEqual(1);
  expect(selectEvents(web, { evt: "query.submit" }).length).toBeGreaterThanOrEqual(1);
  expect(
    selectEvents(web, { evt: "query.result" }).filter(
      (e) => typeof e.rows === "number" && (e.rows as number) >= 1,
    ).length,
  ).toBeGreaterThanOrEqual(1);
  expect(selectEvents(web, { evt: "query.error" }).length).toBeGreaterThanOrEqual(1);
  expect(
    selectEvents(web, { evt: "mode.switch" }).filter((e) => e.to === "sql").length,
  ).toBeGreaterThanOrEqual(1);
});
