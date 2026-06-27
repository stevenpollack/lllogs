/**
 * Shared render helpers — pure, dependency-free ports of v1's audit column
 * logic, returning STRUCTURED DATA (no HTML, no escaping). Callers build DOM
 * via `textContent`, so escaping is unnecessary here.
 */

/**
 * Split a Bash command into its top-level sub-commands.
 *
 * Splits on top-level `;` or newline. Keeps `&&` / `||` / `|` joined, including
 * when the operator trails a line (a `\n` right after a trailing chain operator
 * becomes a space, not a split). Respects single/double quotes (no split inside
 * quotes; `\` escapes inside double quotes), `\`-escaped chars at top level
 * (e.g. `find … -exec rm {} \;`), and `#` comments at a word boundary (consumed
 * verbatim to end of line). Returns trimmed, non-empty segments.
 */
export function splitBashCommand(cmd: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
        buf += ch + cmd[++i];
        continue;
      }
      buf += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    // `#` at a word boundary starts a comment to end of line; consume it
    // verbatim so quotes/`;` inside it (e.g. an apostrophe) stay inert.
    if (ch === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) {
      let k = i;
      while (k < cmd.length && cmd[k] !== "\n") k++;
      buf += cmd.slice(i, k);
      i = k - 1;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      buf += ch + cmd[++i];
      continue;
    }
    if (ch === ";" || ch === "\n") {
      // A newline after a chaining operator continues the command — keep joined.
      if (ch === "\n" && /(?:&&|\|\||\|)\s*$/.test(buf)) {
        buf += " ";
        continue;
      }
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);

  return parts.map((p) => p.trim()).filter(Boolean);
}

export type ResultLineColor = "add" | "del" | "head" | "err";

export interface ResultLine {
  text: string;
  color?: ResultLineColor;
}

export interface ResultEntry {
  resultHead?: string | null;
  diff?: string | null;
  result?: string | null;
  stderr?: string | null;
}

/**
 * Build the structured result lines for a tool result:
 * - optional summary header (`resultHead`, color "head");
 * - a unified diff (`diff`, "+ " → "add", "- " → "del", else uncolored);
 * - otherwise the output (`result`, uncolored) followed by `stderr` ("err").
 *
 * Capped at 14 entries with a synthesized "… N more lines" footer; each entry's
 * text clipped to 200 chars.
 */
export function resultLines(e: ResultEntry): ResultLine[] {
  const MAX = 14;
  const clip = (s: string) => (s.length > 200 ? s.slice(0, 200) + "…" : s);

  const out: ResultLine[] = [];
  let total = 0;
  const push = (text: string, color?: ResultLineColor) => {
    if (total < MAX) out.push(color ? { text: clip(text), color } : { text: clip(text) });
    total++;
  };

  if (e.resultHead) push(e.resultHead, "head");
  if (e.diff) {
    for (const l of e.diff.split("\n")) {
      push(l, l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined);
    }
  } else {
    if (e.result) for (const l of e.result.split("\n")) push(l, undefined);
    if (e.stderr) for (const l of e.stderr.split("\n")) push(l, "err");
  }

  if (total > MAX) out.push({ text: `… ${total - MAX} more lines` });
  return out;
}

/** One line of a compact tool-input preview (the web cell renders each as a JSX row). */
export interface InputLine {
  text: string;
  dim?: boolean; // a secondary / metadata line (rendered muted)
}

const INPUT_CLIP = 100;
const clipInput = (s: string, n = INPUT_CLIP): string => (s.length > n ? s.slice(0, n) + "…" : s);
const firstLine = (s: string): string => {
  const nl = s.indexOf("\n");
  const line = nl === -1 ? s : s.slice(0, nl);
  return line.endsWith("\r") ? line.slice(0, -1) : line; // drop a CRLF carriage return
};
// Lines of content, NOT counting a trailing newline as an extra empty line —
// so "a\nb\nc\n" is 3 and "x\n" is 1 (keeps the single-line Write preview reachable).
const lineCount = (s: string): number =>
  s.length === 0 ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * Up to ~3 scalar `key: value` lines for an unknown tool's input; nested
 * (object/array/null) and oversized (> 200 char) values are skipped. Pure.
 */
function genericInput(inp: Record<string, unknown>): InputLine[] {
  const out: InputLine[] = [];
  for (const [k, v] of Object.entries(inp)) {
    if (out.length >= 3) break;
    if (!isScalar(v)) continue;
    const vs = String(v);
    if (vs.length > 200) continue;
    out.push({ text: `${k}: ${clipInput(vs)}` });
  }
  return out;
}

/**
 * A concise, clamp-friendly preview of a tool_use's full input (the cell is
 * max ~8.5em tall; the Drawer shows full detail separately). Per-tool niceties
 * for Edit/MultiEdit/Write/Read/Task/Glob/Grep; everything else falls back to
 * a few scalar key/value pairs. Bash is normally rendered via `splitBashCommand`
 * — handled here only so it never throws.
 *
 * Pure + defensive: `inputJson` null / invalid / non-object → `[]`. Never throws.
 */
export function formatToolInput(tool: string | null, inputJson: string | null): InputLine[] {
  if (!inputJson) return [];
  let inp: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    inp = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const out: InputLine[] = [];
  const path = typeof inp.file_path === "string" ? inp.file_path : null;

  switch (tool) {
    case "Edit": {
      if (path) out.push({ text: clipInput(path) });
      const from = typeof inp.old_string === "string" ? lineCount(inp.old_string) : 0;
      const to = typeof inp.new_string === "string" ? lineCount(inp.new_string) : 0;
      out.push({
        text: `${from} → ${to} lines${inp.replace_all === true ? " (all)" : ""}`,
        dim: true,
      });
      return out;
    }
    case "MultiEdit": {
      if (path) out.push({ text: clipInput(path) });
      const n = Array.isArray(inp.edits) ? inp.edits.length : 0;
      out.push({ text: `${n} edit${n === 1 ? "" : "s"}`, dim: true });
      return out;
    }
    case "Write": {
      if (path) out.push({ text: clipInput(path) });
      if (typeof inp.content === "string") {
        const n = lineCount(inp.content);
        out.push(
          n > 1
            ? { text: `${n} lines`, dim: true }
            : { text: clipInput(firstLine(inp.content)), dim: true },
        );
      }
      return out;
    }
    case "Read": {
      if (path) out.push({ text: clipInput(path) });
      const parts: string[] = [];
      if (typeof inp.offset === "number") parts.push(`from ${inp.offset}`);
      if (typeof inp.limit === "number") parts.push(`limit ${inp.limit}`);
      if (parts.length) out.push({ text: parts.join(" · "), dim: true });
      return out;
    }
    case "Task": {
      if (typeof inp.subagent_type === "string") out.push({ text: clipInput(inp.subagent_type) });
      if (typeof inp.prompt === "string" && inp.prompt.length)
        out.push({ text: clipInput(firstLine(inp.prompt)), dim: true });
      else if (typeof inp.description === "string")
        out.push({ text: clipInput(inp.description), dim: true });
      return out.length ? out : genericInput(inp);
    }
    case "Glob":
    case "Grep": {
      if (typeof inp.pattern === "string") out.push({ text: clipInput(inp.pattern) });
      if (typeof inp.path === "string") out.push({ text: `in ${clipInput(inp.path)}`, dim: true });
      else if (typeof inp.glob === "string")
        out.push({ text: `glob ${clipInput(inp.glob)}`, dim: true });
      return out.length ? out : genericInput(inp);
    }
    case "Bash": {
      if (typeof inp.command === "string") out.push({ text: clipInput(firstLine(inp.command)) });
      return out.length ? out : genericInput(inp);
    }
    default:
      return genericInput(inp);
  }
}

/**
 * Reconstruct a VALID unified-diff string (the kind react-diff-view's `parseDiff`
 * consumes) from a tool_result's raw JSONL line. The stored `diff` column drops
 * the `@@`/`---`/`+++` headers parseDiff needs; here we rebuild them from
 * `toolUseResult.structuredPatch` (hunks: {oldStart,oldLines,newStart,newLines,
 * lines}). File label = `toolUseResult.filePath` if present, else `file`.
 *
 * Pure + defensive: bad JSON / no structuredPatch / no usable hunks → `null`.
 * Never throws. (No react-diff-view dep here — shared stays dependency-light.)
 */
export function reconstructUnifiedDiff(rawLine: string): string | null {
  let tur: unknown;
  try {
    const line: unknown = JSON.parse(rawLine);
    tur = line && typeof line === "object" ? (line as Record<string, unknown>).toolUseResult : null;
  } catch {
    return null;
  }
  if (!tur || typeof tur !== "object") return null;
  const hunks = (tur as Record<string, unknown>).structuredPatch;
  if (!Array.isArray(hunks) || hunks.length === 0) return null;

  const fp = (tur as Record<string, unknown>).filePath;
  // Strip CR/LF so a stray newline in the path can't inject extra header lines
  // (which would make parseDiff mis-split the unified diff).
  const file = typeof fp === "string" && fp.length ? fp.replace(/[\r\n]+/g, " ") : "file";
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const lines: string[] = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  let emitted = 0;
  for (const h of hunks) {
    if (!h || typeof h !== "object") continue;
    const hunk = h as Record<string, unknown>;
    lines.push(
      `@@ -${num(hunk.oldStart)},${num(hunk.oldLines)} +${num(hunk.newStart)},${num(hunk.newLines)} @@`,
    );
    if (Array.isArray(hunk.lines))
      for (const l of hunk.lines) if (typeof l === "string") lines.push(l);
    emitted++;
  }
  if (emitted === 0) return null;

  return lines.join("\n");
}
