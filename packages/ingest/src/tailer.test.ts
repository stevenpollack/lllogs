import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tail } from "./tailer";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lllogs-tail-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("one full pass delivers all complete lines, drops a trailing partial line", async () => {
  // file a: 3 complete lines (final newline present)
  writeFileSync(join(dir, "a.jsonl"), "a1\na2\na3\n");
  // file b: 2 complete lines + a partial trailing line (no final newline)
  writeFileSync(join(dir, "b.jsonl"), "b1\nb2\nb3partial");

  const got: Array<[string, string]> = [];
  await tail({ root: dir, full: true }, (p, l) => got.push([p, l]), true);

  const lines = got.map(([, l]) => l).sort();
  expect(lines).toEqual(["a1", "a2", "a3", "b1", "b2"]);
  // The partial trailing line must NOT be delivered.
  expect(lines).not.toContain("b3partial");
});

test("seeded cursor delivers only the suffix of a file", async () => {
  const path = join(dir, "c.jsonl");
  const content = "c1\nc2\nc3\n";
  writeFileSync(path, content);
  // Seed the cursor to just past "c1\n".
  const off = Buffer.byteLength("c1\n");
  const cursors = new Map<string, number>([[path, off]]);

  const got: string[] = [];
  await tail({ root: dir, full: true, cursors }, (_p, l) => got.push(l), true);

  expect(got.sort()).toEqual(["c2", "c3"]);
});

test("full:false skips history on the first pass (no lines from pre-existing files)", async () => {
  writeFileSync(join(dir, "h.jsonl"), "h1\nh2\n");
  const got: string[] = [];
  await tail({ root: dir, full: false }, (_p, l) => got.push(l), true);
  expect(got).toEqual([]);
});
