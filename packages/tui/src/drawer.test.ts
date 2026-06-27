import { describe, expect, test } from "bun:test";
import { buildDrawerLines, buildRawLines } from "./drawer";
import { makeRow } from "./fixtures";

const joined = (lines: { text: string }[]): string => lines.map((l) => l.text).join("\n");

describe("buildDrawerLines", () => {
  test("Bash event: header + command + result sections", () => {
    const e = makeRow({ tool: "Bash", command: "echo hi && ls", resultHead: "ran", result: "hi" });
    const s = joined(buildDrawerLines(e));
    expect(s).toContain("Bash");
    expect(s).toContain("COMMAND");
    expect(s).toContain("echo hi && ls"); // chained → kept as one segment
    expect(s).toContain("RESULT");
    expect(s).toContain("ran");
  });

  test("an error is flagged in red", () => {
    const err = buildDrawerLines(makeRow({ isError: true })).find((l) =>
      l.text.startsWith("error"),
    );
    expect(err?.color).toBe("red");
  });

  test("diff lines are colored from the reconstructed unified diff", () => {
    const raw = JSON.stringify({
      toolUseResult: {
        filePath: "/a.ts",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
        ],
      },
    });
    const lines = buildDrawerLines(makeRow({ tool: "Edit", raw }));
    expect(lines.some((l) => l.text === "+new" && l.color === "green")).toBe(true);
    expect(lines.some((l) => l.text === "-old" && l.color === "red")).toBe(true);
  });

  test("prompt text is included", () => {
    const lines = buildDrawerLines(
      makeRow({ kind: "prompt", tool: null, command: null, text: "hello world" }),
    );
    expect(joined(lines)).toContain("hello world");
  });
});

describe("buildRawLines", () => {
  test("pretty-prints the raw JSON line", () => {
    const s = joined(buildRawLines(makeRow({ raw: '{"a":1,"b":{"c":2}}' })));
    expect(s).toContain('"a": 1');
    expect(s).toContain('"c": 2');
  });

  test("falls back to the verbatim line for non-JSON", () => {
    expect(buildRawLines(makeRow({ raw: "not json" }))[0]!.text).toBe("not json");
  });
});
