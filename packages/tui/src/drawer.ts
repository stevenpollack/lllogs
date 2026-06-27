import type { EventRow } from "@lllogs/shared";
import {
  splitBashCommand,
  formatToolInput,
  resultLines,
  reconstructUnifiedDiff,
} from "@lllogs/shared";
import { fmtTime } from "./columns";

/** One rendered drawer line. `color` is an Ink color name. */
export interface DrawerLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

function colorForResult(c: "add" | "del" | "head" | "err" | undefined): string | undefined {
  switch (c) {
    case "add":
      return "green";
    case "del":
      return "red";
    case "head":
      return "gray";
    case "err":
      return "red";
    default:
      return undefined;
  }
}

function colorForDiff(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "green";
  if (line.startsWith("-") && !line.startsWith("---")) return "red";
  if (line.startsWith("@@")) return "cyan";
  return undefined;
}

/**
 * The structured detail view for one event: a key/value header, the command or
 * tool input (Bash split into sub-commands; other tools via the shared
 * formatToolInput), a colored unified diff (reconstructed from the raw line) or
 * the colored result lines, and any prompt/thinking/assistant text. Reuses the
 * @lllogs/shared render helpers wholesale — pure, never throws.
 */
export function buildDrawerLines(e: EventRow): DrawerLine[] {
  const out: DrawerLine[] = [];
  const head = (s: string): void => {
    out.push({ text: "" });
    out.push({ text: s.toUpperCase(), bold: true, color: "cyan" });
  };
  const kv = (k: string, v: string | number | null | undefined): void => {
    if (v != null && v !== "") out.push({ text: `${k.padEnd(8)} ${v}` });
  };

  kv("time", fmtTime(e.ts));
  kv("project", e.project);
  kv("session", e.sessionId);
  kv("kind", e.kind);
  kv("role", e.role);
  kv("tool", e.tool);
  kv("corr", e.corr);
  if (e.isError != null)
    out.push({
      text: `error    ${e.isError ? "ERROR" : "ok"}`,
      color: e.isError ? "red" : undefined,
    });
  kv("dur", e.durMs != null ? `${e.durMs}ms` : null);
  kv("branch", e.gitBranch);

  if (e.tool === "Bash" && e.command) {
    head("command");
    for (const seg of splitBashCommand(e.command)) out.push({ text: seg });
  } else if (e.tool) {
    const input = formatToolInput(e.tool, e.inputJson);
    if (input.length) {
      head("input");
      for (const l of input) out.push({ text: l.text, dim: l.dim });
    } else if (e.command) {
      head("command");
      out.push({ text: e.command });
    }
  }

  const diff = reconstructUnifiedDiff(e.raw);
  if (diff) {
    head("diff");
    for (const l of diff.split("\n")) out.push({ text: l, color: colorForDiff(l) });
  } else {
    const rl = resultLines({
      resultHead: e.resultHead,
      diff: e.diff,
      result: e.result,
      stderr: e.stderr,
    });
    if (rl.length) {
      head("result");
      for (const l of rl) out.push({ text: l.text, color: colorForResult(l.color) });
    }
  }

  if (e.text) {
    head("text");
    for (const l of e.text.split("\n")) out.push({ text: l });
  }

  return out;
}

/**
 * The raw JSONL line, pretty-printed (indented JSON) for drilling into a record.
 * Plain text (no ANSI) so Ink renders it cleanly; falls back to the verbatim line
 * if it isn't valid JSON. Never throws.
 */
export function buildRawLines(e: EventRow): DrawerLine[] {
  try {
    const parsed: unknown = JSON.parse(e.raw);
    return JSON.stringify(parsed, null, 2)
      .split("\n")
      .map((text) => ({ text }));
  } catch {
    return e.raw.split("\n").map((text) => ({ text }));
  }
}
