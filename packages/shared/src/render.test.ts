import { describe, expect, test } from "bun:test";
import { formatToolInput, reconstructUnifiedDiff, resultLines, splitBashCommand } from "./render";

const BS = String.fromCharCode(92); // a literal backslash, unmangled by source escaping

describe("splitBashCommand", () => {
  test("splits on top-level semicolons", () => {
    expect(splitBashCommand("a; b; c")).toEqual(["a", "b", "c"]);
  });

  test("keeps && and | joined (single segment)", () => {
    expect(splitBashCommand("c1 && c2")).toEqual(["c1 && c2"]);
    expect(splitBashCommand("c1 | c2")).toEqual(["c1 | c2"]);
  });

  test("does not split ; inside quotes", () => {
    expect(splitBashCommand('echo "a;b"; c')).toEqual(['echo "a;b"', "c"]);
    expect(splitBashCommand("echo 'a;b'; c")).toEqual(["echo 'a;b'", "c"]);
  });

  test("does not split an escaped \\; (e.g. find -exec)", () => {
    const command = `find . -exec rm {} ${BS}; ; echo done`;
    expect(splitBashCommand(command)).toEqual([`find . -exec rm {} ${BS};`, "echo done"]);
  });

  test("drops empty segments from trailing/duplicate semicolons", () => {
    expect(splitBashCommand("a;; b ;")).toEqual(["a", "b"]);
  });

  test("splits newline-separated commands verbatim (no html escaping)", () => {
    const command = ["cd /repo", "pkill -x logdy 2>/dev/null", "# a comment", "git status"].join(
      "\n",
    );
    expect(splitBashCommand(command)).toEqual([
      "cd /repo",
      "pkill -x logdy 2>/dev/null",
      "# a comment",
      "git status",
    ]);
  });

  test("keeps a chain operator joined across a line break", () => {
    expect(splitBashCommand("git add . &&\ngit commit")).toEqual(["git add . && git commit"]);
    expect(splitBashCommand("cat x |\nhead")).toEqual(["cat x | head"]);
  });

  test("does not split newlines inside quotes (heredoc-style strings)", () => {
    expect(splitBashCommand("echo 'a\nb'; c")).toEqual(["echo 'a\nb'", "c"]);
  });

  test("an apostrophe inside a # comment does not start a quote", () => {
    const command = ["a", "# can't / won't break things", "b | c"].join("\n");
    expect(splitBashCommand(command)).toEqual(["a", "# can't / won't break things", "b | c"]);
  });

  test("a single command stays a single segment", () => {
    expect(splitBashCommand("ls -la")).toEqual(["ls -la"]);
  });

  test("empty input yields no segments", () => {
    expect(splitBashCommand("")).toEqual([]);
  });
});

describe("resultLines", () => {
  test("empty input yields no lines", () => {
    expect(resultLines({})).toEqual([]);
  });

  test("single plain line has no color key", () => {
    expect(resultLines({ result: "exit 0" })).toEqual([{ text: "exit 0" }]);
  });

  test("multi-line result renders one entry per line, no colors", () => {
    expect(resultLines({ result: "line1\nline2\nline3" })).toEqual([
      { text: "line1" },
      { text: "line2" },
      { text: "line3" },
    ]);
  });

  test("caps at 14 entries and notes how many were hidden", () => {
    const result = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
    const out = resultLines({ result });
    expect(out).toHaveLength(15); // 14 lines + footer
    expect(out[14]).toEqual({ text: "… 6 more lines" });
  });

  test("renders a diff with add/del colors", () => {
    expect(resultLines({ diff: " context\n-removed\n+added" })).toEqual([
      { text: " context" },
      { text: "-removed", color: "del" },
      { text: "+added", color: "add" },
    ]);
  });

  test("diff takes precedence over result", () => {
    expect(resultLines({ result: "plain", diff: "+only the diff" })).toEqual([
      { text: "+only the diff", color: "add" },
    ]);
  });

  test("renders a summary header above the body", () => {
    expect(resultLines({ resultHead: "200 · 60KB · 4.3s", result: "the body" })).toEqual([
      { text: "200 · 60KB · 4.3s", color: "head" },
      { text: "the body" },
    ]);
  });

  test("renders stderr in err color after stdout", () => {
    expect(resultLines({ result: "out line", stderr: "boom" })).toEqual([
      { text: "out line" },
      { text: "boom", color: "err" },
    ]);
  });

  test("clips a long line to 200 chars + ellipsis", () => {
    const out = resultLines({ result: "x".repeat(250) });
    expect(out).toHaveLength(1);
    expect(out[0].text.length).toBe(201);
    expect(out[0].text.endsWith("…")).toBe(true);
  });
});

describe("formatToolInput", () => {
  test("Edit: file_path + a line-delta change indicator", () => {
    const inp = JSON.stringify({
      file_path: "/a/b.ts",
      old_string: "x\ny",
      new_string: "x\ny\nz",
      replace_all: false,
    });
    expect(formatToolInput("Edit", inp)).toEqual([
      { text: "/a/b.ts" },
      { text: "2 → 3 lines", dim: true },
    ]);
  });

  test("Edit: replace_all is flagged in the indicator", () => {
    const inp = JSON.stringify({
      file_path: "/a/b.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
    expect(formatToolInput("Edit", inp)).toEqual([
      { text: "/a/b.ts" },
      { text: "1 → 1 lines (all)", dim: true },
    ]);
  });

  test("Write: file_path + line count", () => {
    const inp = JSON.stringify({ file_path: "/a/c.md", content: "l1\nl2\nl3" });
    expect(formatToolInput("Write", inp)).toEqual([
      { text: "/a/c.md" },
      { text: "3 lines", dim: true },
    ]);
  });

  test("Write: single-line content shows the line itself", () => {
    const inp = JSON.stringify({ file_path: "/a/c.md", content: "just one line" });
    expect(formatToolInput("Write", inp)).toEqual([
      { text: "/a/c.md" },
      { text: "just one line", dim: true },
    ]);
  });

  test("Write: a trailing newline is not counted as an extra line", () => {
    const inp = JSON.stringify({ file_path: "/a/c.md", content: "l1\nl2\nl3\n" });
    expect(formatToolInput("Write", inp)).toEqual([
      { text: "/a/c.md" },
      { text: "3 lines", dim: true },
    ]);
  });

  test("Write: a single newline-terminated line still previews the line", () => {
    const inp = JSON.stringify({ file_path: "/a/c.md", content: "just one line\n" });
    expect(formatToolInput("Write", inp)).toEqual([
      { text: "/a/c.md" },
      { text: "just one line", dim: true },
    ]);
  });

  test("Read: file_path + range when offset/limit present", () => {
    const inp = JSON.stringify({ file_path: "/a/d.ts", offset: 930, limit: 50 });
    expect(formatToolInput("Read", inp)).toEqual([
      { text: "/a/d.ts" },
      { text: "from 930 · limit 50", dim: true },
    ]);
  });

  test("Task: subagent_type + first line of prompt", () => {
    const inp = JSON.stringify({
      subagent_type: "Explore",
      prompt: "find the thing\nthen do more",
    });
    expect(formatToolInput("Task", inp)).toEqual([
      { text: "Explore" },
      { text: "find the thing", dim: true },
    ]);
  });

  test("Task: a CRLF prompt drops the trailing carriage return", () => {
    const inp = JSON.stringify({ subagent_type: "Explore", prompt: "find the thing\r\nthen more" });
    expect(formatToolInput("Task", inp)).toEqual([
      { text: "Explore" },
      { text: "find the thing", dim: true },
    ]);
  });

  test("generic tool: up to 3 scalar pairs, capped", () => {
    const inp = JSON.stringify({ one: "1", two: 2, three: true, four: "4" });
    expect(formatToolInput("Frobnicate", inp)).toEqual([
      { text: "one: 1" },
      { text: "two: 2" },
      { text: "three: true" },
    ]);
  });

  test("generic tool: nested and oversized values are skipped", () => {
    const inp = JSON.stringify({
      keep: "yes",
      nested: { a: 1 },
      arr: [1, 2],
      big: "z".repeat(300),
    });
    expect(formatToolInput("Frobnicate", inp)).toEqual([{ text: "keep: yes" }]);
  });

  test("null inputJson → []", () => {
    expect(formatToolInput("Edit", null)).toEqual([]);
  });

  test("invalid JSON → []", () => {
    expect(formatToolInput("Edit", "{not json")).toEqual([]);
  });

  test("non-object JSON (array) → []", () => {
    expect(formatToolInput("Edit", "[1,2,3]")).toEqual([]);
  });

  test("does not throw on Bash; previews the command's first line", () => {
    const inp = JSON.stringify({ command: "ls -la\nrm -rf nope" });
    expect(formatToolInput("Bash", inp)).toEqual([{ text: "ls -la" }]);
  });
});

describe("reconstructUnifiedDiff", () => {
  const raw = JSON.stringify({
    toolUseResult: {
      filePath: "/home/u/file.ts",
      structuredPatch: [
        { oldStart: 37, oldLines: 7, newStart: 37, newLines: 12, lines: [" ctx", "-old", "+new"] },
        { oldStart: 80, oldLines: 1, newStart: 85, newLines: 2, lines: ["-a", "+b", "+c"] },
      ],
    },
  });

  test("emits diff --git / --- / +++ headers", () => {
    const out = reconstructUnifiedDiff(raw);
    expect(out).not.toBeNull();
    expect(out).toMatch(/^diff --git a\/.+ b\/.+$/m);
    expect(out).toMatch(/^--- a\//m);
    expect(out).toMatch(/^\+\+\+ b\//m);
  });

  test("emits a valid hunk header per hunk, with bodies", () => {
    const out = reconstructUnifiedDiff(raw)!;
    expect(out).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
    expect(out).toContain("@@ -37,7 +37,12 @@");
    expect(out).toContain("@@ -80,1 +85,2 @@");
    // hunk bodies carry their ' '/'+'/'-' prefixes verbatim
    expect(out).toContain("\n+new");
    expect(out).toContain("\n-old");
  });

  test("falls back to 'file' when filePath is absent", () => {
    const r = JSON.stringify({
      toolUseResult: {
        structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+x"] }],
      },
    });
    expect(reconstructUnifiedDiff(r)).toContain("diff --git a/file b/file");
  });

  test("strips CR/LF from filePath so the header stays single-line", () => {
    const r = JSON.stringify({
      toolUseResult: {
        filePath: "/x/y\nevil",
        structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+x"] }],
      },
    });
    const out = reconstructUnifiedDiff(r)!;
    expect(out.split("\n")[0]).toBe("diff --git a//x/y evil b//x/y evil");
  });

  test("no structuredPatch → null", () => {
    expect(
      reconstructUnifiedDiff(JSON.stringify({ toolUseResult: { filePath: "/x" } })),
    ).toBeNull();
  });

  test("empty structuredPatch → null", () => {
    expect(
      reconstructUnifiedDiff(JSON.stringify({ toolUseResult: { structuredPatch: [] } })),
    ).toBeNull();
  });

  test("invalid JSON → null", () => {
    expect(reconstructUnifiedDiff("not json at all")).toBeNull();
  });
});
