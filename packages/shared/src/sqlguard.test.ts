import { describe, expect, it } from "bun:test";
import { assertSelectOnly, stripSqlComments } from "./sqlguard";

describe("stripSqlComments", () => {
  it("strips block comments", () => {
    expect(stripSqlComments("SELECT /* foo */ 1")).toBe("SELECT  1");
  });

  it("strips line comments", () => {
    expect(stripSqlComments("SELECT 1 -- comment\n")).toBe("SELECT 1 \n");
  });

  it("does NOT strip -- inside a single-quoted string", () => {
    const sql = "SELECT '-- not a comment' AS x";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("does NOT strip /* inside a single-quoted string", () => {
    const sql = "SELECT '/* not a comment */' AS x";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("handles '' escaped apostrophe inside string", () => {
    const sql = "SELECT 'it''s fine -- still inside' AS x";
    expect(stripSqlComments(sql)).toBe(sql);
  });
});

describe("assertSelectOnly — accepted", () => {
  it("accepts a plain SELECT", () => {
    expect(() => assertSelectOnly("SELECT 1")).not.toThrow();
  });

  it("accepts SELECT with WHERE and ORDER BY", () => {
    expect(() =>
      assertSelectOnly("SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool"),
    ).not.toThrow();
  });

  it("accepts WITH x AS (…) SELECT …", () => {
    expect(() => assertSelectOnly("WITH x AS (SELECT 1) SELECT * FROM x")).not.toThrow();
  });

  it("accepts trailing semicolon (trimmed before checks)", () => {
    expect(() => assertSelectOnly("SELECT 1;")).not.toThrow();
  });

  it("accepts SELECT with lowercase keywords", () => {
    expect(() => assertSelectOnly("select * from events")).not.toThrow();
  });

  // Whitespace variants — tabs and newlines between tokens are fine.
  it("accepts SELECT with tabs and newlines between tokens", () => {
    expect(() =>
      assertSelectOnly("SELECT\t*\nFROM\tevents\nWHERE\tkind = 'tool_use'"),
    ).not.toThrow();
  });

  // Semicolon inside a string literal must NOT be treated as a statement separator.
  // Naïve `str.includes(";")` would wrongly fail this — hasSemicolonOutsideStrings fixes it.
  it("accepts semicolon inside a string literal (SELECT ';')", () => {
    expect(() => assertSelectOnly("SELECT ';' AS delim")).not.toThrow();
  });

  it("accepts multiple semicolons inside string literals", () => {
    expect(() => assertSelectOnly("SELECT ';' AS a, ';;' AS b FROM events")).not.toThrow();
  });

  it("accepts escaped apostrophe followed by semicolon in string (SELECT 'it''s;nice')", () => {
    expect(() => assertSelectOnly("SELECT 'it''s;nice' AS x")).not.toThrow();
  });
});

describe("assertSelectOnly — rejected", () => {
  it("rejects DROP TABLE", () => {
    expect(() => assertSelectOnly("DROP TABLE event")).toThrow(/DROP/i);
  });

  it("rejects multi-statement SELECT 1; DELETE", () => {
    const err = expect(() => assertSelectOnly("SELECT 1; DELETE FROM event"));
    err.toThrow();
    try {
      assertSelectOnly("SELECT 1; DELETE FROM event");
    } catch (e) {
      expect((e as Error).message).toMatch(/;|multiple statement/i);
    }
  });

  it("rejects comment-smuggled block: SELECT 1 /* */; DROP …", () => {
    expect(() => assertSelectOnly("SELECT 1 /* */; DROP TABLE event")).toThrow();
  });

  it("rejects comment-smuggled line: SELECT 1 -- x\\n; DROP", () => {
    expect(() => assertSelectOnly("SELECT 1 -- x\n; DROP TABLE event")).toThrow();
  });

  it("rejects COPY events TO 'f'", () => {
    expect(() => assertSelectOnly("COPY events TO 'f'")).toThrow(/COPY/i);
  });

  it("rejects INSTALL httpfs", () => {
    expect(() => assertSelectOnly("INSTALL httpfs")).toThrow(/INSTALL/i);
  });

  it("rejects PRAGMA …", () => {
    expect(() => assertSelectOnly("PRAGMA database_list")).toThrow(/PRAGMA/i);
  });

  it("rejects non-SELECT (VALUES (1))", () => {
    expect(() => assertSelectOnly("VALUES (1)")).toThrow(/only SELECT or WITH/i);
  });

  it("rejects shadowing CTE named 'events'", () => {
    expect(() => assertSelectOnly("WITH events AS (SELECT 1) SELECT * FROM events")).toThrow(
      /events/i,
    );
  });

  it("error message names the violation for DROP", () => {
    let msg = "";
    try {
      assertSelectOnly("DROP TABLE event");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/DROP/i);
  });

  it("error message names the violation for COPY", () => {
    let msg = "";
    try {
      assertSelectOnly("COPY events TO '/tmp/out.csv'");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/COPY/i);
  });

  it("error message mentions CTE shadow for WITH events", () => {
    let msg = "";
    try {
      assertSelectOnly("WITH events AS (SELECT 1) SELECT * FROM events");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/events/i);
  });

  // --- T-5.6 fuzz cases ---

  // Case variants: the BLOCKED_RE is case-insensitive (\bDROP\b with "i" flag).
  it("rejects mixed-case DrOp TABLE", () => {
    expect(() => assertSelectOnly("DrOp TABLE event")).toThrow(/DROP/i);
  });

  it("rejects all-lower drop table", () => {
    expect(() => assertSelectOnly("drop table event")).toThrow(/DROP/i);
  });

  it("rejects mixed-case dRoP", () => {
    expect(() => assertSelectOnly("dRoP TABLE event")).toThrow(/DROP/i);
  });

  // DuckDB-specific: LOAD can load extensions that allow file I/O or network.
  it("rejects LOAD extension (DuckDB-specific)", () => {
    expect(() => assertSelectOnly("LOAD httpfs")).toThrow(/LOAD/i);
  });

  // Nested-looking block comment: DuckDB does NOT support nested /* ... */
  // comments (C-style, non-nesting). Our stripper uses indexOf("*/") so it
  // terminates at the FIRST */, same as DuckDB. The DROP is therefore exposed
  // outside the comment and must be caught.
  it("rejects nested-looking block comment that exposes DROP after first */", () => {
    // After stripSqlComments: "SELECT 1  DROP TABLE event */"
    // (the first */ ends the block comment; DROP is now outside the comment)
    expect(() => assertSelectOnly("SELECT 1 /* /* inner */ DROP TABLE event */")).toThrow(/DROP/i);
  });

  // Semicolon OUTSIDE a string literal still means multi-statement.
  it("rejects semicolon outside string even when string also contains semicolon", () => {
    // ';' is in a string, the second ; is outside.
    expect(() => assertSelectOnly("SELECT ';'; DROP TABLE event")).toThrow(/;|multiple/i);
  });

  // --- Code-review regression: denylist false positives that broke real queries ---

  // The app audits command/prompt TEXT, which routinely contains words like
  // "install"/"drop"/"delete". A blocked token that appears ONLY inside a string
  // literal must not be rejected.
  it("accepts a blocked keyword inside a string literal (LIKE '%npm install%')", () => {
    expect(() =>
      assertSelectOnly("SELECT * FROM events WHERE command LIKE '%npm install%'"),
    ).not.toThrow();
  });

  it("accepts DROP/DELETE substrings inside LIKE patterns", () => {
    expect(() =>
      assertSelectOnly(
        "SELECT text FROM events WHERE text LIKE '%DROP TABLE%' OR text LIKE '%delete from%'",
      ),
    ).not.toThrow();
  });

  // REPLACE collides with DuckDB's standard replace(str, from, to) scalar fn.
  it("accepts the replace() scalar function", () => {
    expect(() =>
      assertSelectOnly("SELECT replace(command, '/home/steven', '~') FROM events"),
    ).not.toThrow();
  });

  // …but CREATE OR REPLACE is still rejected (via the CREATE token).
  it("still rejects CREATE OR REPLACE VIEW", () => {
    expect(() => assertSelectOnly("CREATE OR REPLACE VIEW v AS SELECT 1")).toThrow(/CREATE/i);
  });

  // Double-quoted identifiers may legally contain ';' and apostrophes; the
  // scanner masks them so they don't read as statement separators / desync it.
  it("accepts a ';' inside a double-quoted identifier", () => {
    expect(() => assertSelectOnly('SELECT 1 AS "a;b" FROM events')).not.toThrow();
  });

  it("accepts an apostrophe inside a double-quoted identifier without desync", () => {
    expect(() => assertSelectOnly(`SELECT max(ts) AS "won't" FROM events`)).not.toThrow();
  });

  it("accepts a trailing semicolon after a real query", () => {
    expect(() =>
      assertSelectOnly("SELECT tool, COUNT(*) FROM events GROUP BY tool;"),
    ).not.toThrow();
  });

  // File-reader functions are intentionally NOT keyword-blocked — the DuckDB
  // engine sandbox (enable_external_access=false in withDuck) is the boundary.
  it("does not keyword-block read_text (the engine sandbox is the boundary)", () => {
    expect(() => assertSelectOnly("SELECT content FROM read_text('/etc/passwd')")).not.toThrow();
  });
});
