import { describe, expect, it } from "bun:test";
import { flattenLine, projectFromCwd } from "./flatten";

const j = (o: unknown) => JSON.stringify(o);

describe("flattenLine drop rules", () => {
  it("non-JSON line → []", () => {
    expect(flattenLine("not json {", 0)).toEqual([]);
  });
  it("line without message → [] (file-history-snapshot shape)", () => {
    expect(flattenLine(j({ type: "file-history-snapshot", uuid: "x", messageId: "m" }), 0)).toEqual(
      [],
    );
  });
  it("null JSON → []", () => {
    expect(flattenLine("null", 0)).toEqual([]);
  });
});

describe("flattenLine content shapes", () => {
  it("string content → one prompt event", () => {
    const ev = flattenLine(j({ uuid: "u1", message: { content: "hi" } }), 0);
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("prompt");
    expect(ev[0].text).toBe("hi");
    expect(ev[0].blockIdx).toBe(0);
  });

  it("[text, tool_use] → two events with correct blockIdx and tool fields", () => {
    const ev = flattenLine(
      j({
        uuid: "u2",
        message: {
          content: [
            { type: "text", text: "doing it" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      0,
    );
    expect(ev.map((e) => e.kind)).toEqual(["text", "tool_use"]);
    expect(ev[0].blockIdx).toBe(0);
    expect(ev[1].blockIdx).toBe(1);
    expect(ev[1].tool).toBe("Bash");
    expect(ev[1].command).toBe("ls");
    expect(ev[1].corr).toBe("t1");
    expect(ev[1].inputJson).toBe('{"command":"ls"}');
  });
});

describe("role derivation (orthogonal to kind)", () => {
  it("string content → prompt carries message.role", () => {
    const ev = flattenLine(j({ uuid: "u", message: { role: "user", content: "hi" } }), 0);
    expect(ev[0].role).toBe("user");
  });
  it("every block from a line shares that line's role", () => {
    const ev = flattenLine(
      j({
        uuid: "u",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "doing it" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      0,
    );
    expect(ev.map((e) => e.role)).toEqual(["assistant", "assistant"]);
  });
  it("absent message.role → role null (defensive parsing)", () => {
    const ev = flattenLine(j({ uuid: "u", message: { content: "hi" } }), 0);
    expect(ev[0].role).toBeNull();
  });
  it("non-string message.role → role null", () => {
    const ev = flattenLine(j({ uuid: "u", message: { role: 42, content: "hi" } }), 0);
    expect(ev[0].role).toBeNull();
  });
});

describe("tool_use command precedence", () => {
  const cmd = (input: Record<string, unknown>) =>
    flattenLine(
      j({ uuid: "u", message: { content: [{ type: "tool_use", id: "t", name: "X", input }] } }),
      0,
    )[0].command;

  it("file_path used when no command", () => {
    expect(cmd({ file_path: "/x" })).toBe("/x");
  });
  it("unknown keys → JSON.stringify(input)", () => {
    expect(cmd({ foo: 1 })).toBe('{"foo":1}');
  });
  it("empty input → ''", () => {
    expect(cmd({})).toBe("");
  });
});

describe("tool_result enrichment", () => {
  const tr = (toolUseResult: unknown, blockExtra: Record<string, unknown> = {}) =>
    flattenLine(
      j({
        uuid: "u",
        toolUseResult,
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "raw", ...blockExtra }],
        },
      }),
      0,
    )[0];

  it("structuredPatch → diff joined with \\n", () => {
    const ev = tr({ structuredPatch: [{ lines: ["-a", "+b"] }, { lines: ["+c"] }] });
    expect(ev.diff).toBe("-a\n+b\n+c");
  });
  it("stdout/stderr → result and stderr", () => {
    const ev = tr({ stdout: "out", stderr: "err" });
    expect(ev.result).toBe("out");
    expect(ev.stderr).toBe("err");
  });
  it("url+bytes → resultHead 'code · size · dur'", () => {
    const ev = tr({ url: "http://x", bytes: 2048, code: 200, durationMs: 1500 });
    expect(ev.resultHead).toBe("200 · 2.0KB · 1.5s");
  });
  it("searchCount+query → 'N results · \"q\"'", () => {
    const ev = tr({ searchCount: 3, query: "q" });
    expect(ev.resultHead).toBe('3 results · "q"');
  });
});

describe("isError semantics", () => {
  it("tool_result is_error:true → isError:true", () => {
    const ev = flattenLine(
      j({
        uuid: "u",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t", content: "x", is_error: true }],
        },
      }),
      0,
    );
    expect(ev[0].isError).toBe(true);
  });
  it("text block → isError:null", () => {
    const ev = flattenLine(
      j({ uuid: "u", message: { content: [{ type: "text", text: "x" }] } }),
      0,
    );
    expect(ev[0].isError).toBeNull();
  });
});

describe("projectFromCwd", () => {
  it("trailing slash trimmed → basename", () => {
    expect(projectFromCwd("/home/u/repos/app/")).toBe("app");
  });
  it("undefined → ''", () => {
    expect(projectFromCwd(undefined)).toBe("");
  });
});

describe("uuid fallback", () => {
  it("absent uuid → sessionId:lineIndex", () => {
    const ev = flattenLine(j({ sessionId: "sess", message: { content: "hi" } }), 7);
    expect(ev[0].uuid).toBe("sess:7");
  });
});

describe("unknown block types", () => {
  it("image block skipped, onSkip called with 'image'", () => {
    const skipped: string[] = [];
    const ev = flattenLine(
      j({ uuid: "u", message: { content: [{ type: "image", source: {} }] } }),
      0,
      { onSkip: (t) => skipped.push(t) },
    );
    expect(ev).toEqual([]);
    expect(skipped).toEqual(["image"]);
  });
});
