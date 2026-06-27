#!/usr/bin/env bun
import { resolve } from "node:path";
import { watch } from "node:fs";

const ENTRY = resolve(import.meta.dir, "src/main.tsx");
const SRC = resolve(import.meta.dir, "src");
const OUT = resolve(import.meta.dir, "dist");
const watchMode = process.argv.includes("--watch");

async function build(): Promise<boolean> {
  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUT,
    target: "browser",
    // Skip minification in watch/dev mode — faster rebuilds; prod build minifies.
    minify: !watchMode,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  const ms = Math.round(performance.now() - started);
  console.error(`built ${result.outputs.length} file(s) → packages/web/dist (${ms}ms)`);
  return true;
}

const ok = await build();

if (!watchMode) {
  if (!ok) process.exit(1);
} else {
  // Rebuild on any source change (debounced — editors fire many events per save).
  // index.html is served statically (not bundled), so a CSS edit there needs only
  // a browser refresh; we watch the bundled src/ tree.
  console.error(
    "watching packages/web/src — edit + refresh the browser to see changes (Ctrl-C to stop)",
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(SRC, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void build();
    }, 100);
  });
}
