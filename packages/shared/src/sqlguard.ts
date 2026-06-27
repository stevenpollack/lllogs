/**
 * Pure SQL guard functions. No I/O.
 *
 * Limit: the string-literal state machine handles only single-quoted strings.
 * It does NOT handle dollar-quoting, escape-string syntax (E'...'), or
 * Unicode-escape literals (U&'...'). A comment inside such a literal would be
 * incorrectly stripped. This is sufficient for the MVP guard.
 *
 * Security boundary note — the PRIMARY protection against file/network access
 * and config tampering is the DuckDB engine sandbox set in `withDuck`
 * (`SET enable_external_access=false; SET lock_configuration=true;` after the
 * READ_ONLY ATTACH), which disables read_csv/read_text/glob/ATTACH/COPY/INSTALL
 * at the engine level and pins the config so user SQL cannot re-enable it.
 * `assertSelectOnly` is the SECOND layer: it gives instant 400-level feedback on
 * obviously non-SELECT input before a subprocess is spawned, and blocks the
 * common DDL/DML keywords. It is intentionally NOT the sole security boundary —
 * a keyword denylist over a hand-rolled lexer can never be complete (it does not
 * model dollar-quoting `$$…$$`, escape strings `E'…'`, or Unicode-escape
 * literals `U&'…'`), so it must not be relied on alone. DuckDB itself does NOT
 * reject multi-statement SQL in a single `run()` call, hence this check exists.
 */

/**
 * Remove SQL comments from sql:
 * - block comments (non-nesting)
 * - line comments (-- through end-of-line)
 *
 * Single-quote string-literal aware: -- or /* that appears inside a single-quoted
 * string literal is NOT treated as a comment start. Apostrophe-doubling ('') inside
 * a string is handled correctly.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Single-quoted string: copy verbatim until closing quote (handle '' escapes).
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (j + 1 < n && sql[j + 1] === "'") {
            // escaped apostrophe inside string
            j += 2;
          } else {
            // closing quote
            j++;
            break;
          }
        } else {
          j++;
        }
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && i + 1 < n && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        // unterminated block comment — consume the rest
        i = n;
      } else {
        i = end + 2;
      }
      continue;
    }

    // Line comment: -- through end-of-line
    if (ch === "-" && i + 1 < n && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      if (nl === -1) {
        i = n;
      } else {
        // keep the newline so multi-line SQL keeps its structure
        i = nl;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * The blocked DDL/DML/admin tokens. Word-boundary, case-insensitive check.
 * DuckDB-specific: ATTACH/DETACH/INSTALL/LOAD/COPY/EXPORT/IMPORT let an attacker
 * read/write files or load extensions.
 */
const BLOCKED_TOKENS = [
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "INSTALL",
  "LOAD",
  "COPY",
  "EXPORT",
  "IMPORT",
  "INSERT",
  "UPDATE",
  "UPSERT",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  // NB: "REPLACE" is intentionally NOT blocked — it collides with DuckDB's
  // standard `replace(str, from, to)` scalar function. `CREATE OR REPLACE` and
  // `INSERT OR REPLACE` are already caught by CREATE/INSERT above.
  "TRUNCATE",
  "CALL",
  "GRANT",
  "REVOKE",
  "VACUUM",
  "CHECKPOINT",
] as const;

const BLOCKED_RE = new RegExp("\\b(" + BLOCKED_TOKENS.join("|") + ")\\b", "i");

/**
 * Replace the CONTENTS of single-quoted string literals AND double-quoted
 * identifiers with spaces (keeping the surrounding quote delimiters and the
 * overall length), so a blocked keyword or `;` that appears only inside a
 * literal/identifier is never mistaken for SQL syntax. Doubled-quote escapes
 * (`''` inside a string, `""` inside an identifier) are handled.
 *
 * Without this, `WHERE command LIKE '%npm install%'` would be rejected for the
 * "INSTALL" substring, and `SELECT 1 AS "a;b"` would be flagged as two
 * statements — both legitimate read-only queries.
 */
function maskQuoted(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            out += "  "; // doubled-quote escape — still literal content
            i += 2;
          } else {
            out += quote; // closing delimiter
            i++;
            break;
          }
        } else {
          out += " "; // mask one char of literal/identifier content
          i++;
        }
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Throw if sql is not a safe, single, read-only SELECT/WITH statement.
 *
 * Rules (checked after stripSqlComments + trimming one trailing semicolon, with
 * string-literal/identifier contents masked via maskQuoted):
 * 1. No remaining semicolon outside a literal/identifier — single statement only.
 * 2. Must start with SELECT or WITH.
 * 3. Must not contain any blocked token (word-boundary, case-insensitive),
 *    ignoring tokens that appear only inside a literal/identifier.
 * 4. Must not define a CTE named events (would shadow the wrapper CTE).
 *
 * This is the SECOND security layer — see the file header. The DuckDB engine
 * sandbox in withDuck is the primary boundary.
 */
export function assertSelectOnly(sql: string): void {
  const stripped = stripSqlComments(sql).replace(/;\s*$/, "");
  const masked = maskQuoted(stripped);

  if (masked.includes(";")) {
    throw new Error(
      "SQL guard: multiple statements are not allowed (contains ';' after comment stripping)",
    );
  }

  if (!/^\s*(WITH|SELECT)\b/i.test(stripped)) {
    const first = stripped.trim().split(/\s+/)[0] ?? "(empty)";
    throw new Error(
      "SQL guard: only SELECT or WITH ... SELECT statements are allowed (got '" + first + "')",
    );
  }

  const blockedMatch = BLOCKED_RE.exec(masked);
  if (blockedMatch) {
    throw new Error(
      "SQL guard: blocked token '" +
        blockedMatch[1].toUpperCase() +
        "' is not allowed in a read-only query",
    );
  }

  // Reject user-defined CTE named 'events' -- it would shadow the wrapper CTE.
  if (/\bWITH\s+events\b/i.test(masked)) {
    throw new Error(
      "SQL guard: a CTE named 'events' is not allowed -- it would shadow the facet-scoped CTE wrapper",
    );
  }
}
