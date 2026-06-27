import type { EventKind, FlatEvent } from "./types";

export interface FlattenOptions {
  /** Called once per skipped/unknown block type (schema-drift signal). */
  onSkip?: (blockType: string) => void;
}

/** basename of a cwd path (v1's rule): cwd.replace(/\/+$/,"").split("/").pop() || cwd. "" if no cwd. */
export function projectFromCwd(cwd: string | undefined | null): string {
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
}

type AnyRecord = Record<string, any>;

/**
 * Parse one raw JSONL line into 0..n FlatEvents. See CONTRACTS §3.
 * Pure: no I/O, no globals.
 */
export function flattenLine(
  rawLine: string,
  lineIndex: number,
  opts?: FlattenOptions,
): FlatEvent[] {
  let line: AnyRecord | null;
  try {
    line = JSON.parse(rawLine);
  } catch {
    return [];
  }
  if (line == null || typeof line !== "object") return [];
  if (line.message == null) return [];

  const cwd: string | null = typeof line.cwd === "string" ? line.cwd : null;
  const project = projectFromCwd(cwd);
  const sessionId: string = typeof line.sessionId === "string" ? line.sessionId : "";
  const parentUuid: string | null = typeof line.parentUuid === "string" ? line.parentUuid : null;
  const gitBranch: string | null = typeof line.gitBranch === "string" ? line.gitBranch : null;
  const uuid: string =
    typeof line.uuid === "string" && line.uuid.length
      ? line.uuid
      : `${line.sessionId ?? "?"}:${lineIndex}`;
  const parsed = Date.parse(line.timestamp);
  const ts = Number.isNaN(parsed) ? 0 : parsed;
  const role: string | null = typeof line.message.role === "string" ? line.message.role : null;

  // Common scalar fields shared by every event derived from this line.
  const base = {
    uuid,
    parentUuid,
    sessionId,
    project,
    cwd,
    ts,
    role,
    gitBranch,
    raw: rawLine,
  };

  const mk = (kind: EventKind, blockIdx: number, over: Partial<FlatEvent>): FlatEvent => ({
    ...base,
    blockIdx,
    kind,
    tool: null,
    command: null,
    corr: null,
    isError: null,
    inputJson: null,
    result: null,
    stderr: null,
    diff: null,
    resultHead: null,
    text: null,
    durMs: null,
    ...over,
  });

  const content = line.message.content;

  // String content → a single prompt event.
  if (typeof content === "string") {
    return [mk("prompt", 0, { text: content })];
  }

  if (!Array.isArray(content)) return [];

  const tur: AnyRecord | undefined =
    line.toolUseResult && typeof line.toolUseResult === "object"
      ? (line.toolUseResult as AnyRecord)
      : undefined;

  const out: FlatEvent[] = [];

  content.forEach((block: AnyRecord, blockIdx: number) => {
    const type = block?.type;
    if (type === "tool_use") {
      const inp = (block.input ?? {}) as AnyRecord;
      const inputJson = JSON.stringify(inp);
      const command =
        inp.command ??
        inp.file_path ??
        inp.url ??
        inp.query ??
        inp.path ??
        inp.pattern ??
        (Object.keys(inp).length ? inputJson : "");
      out.push(
        mk("tool_use", blockIdx, {
          tool: typeof block.name === "string" ? block.name : null,
          command,
          inputJson,
          corr: typeof block.id === "string" ? block.id : null,
        }),
      );
    } else if (type === "tool_result") {
      let result =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      let stderr: string | null = null;
      let diff: string | null = null;
      let resultHead: string | null = null;

      if (tur) {
        if (Array.isArray(tur.structuredPatch)) {
          const diffLines = (tur.structuredPatch as AnyRecord[]).flatMap(
            (h) => (h?.lines ?? []) as string[],
          );
          if (diffLines.length) diff = diffLines.join("\n");
        } else if (typeof tur.stdout === "string" || typeof tur.stderr === "string") {
          if (typeof tur.stdout === "string") result = tur.stdout;
          if (typeof tur.stderr === "string" && tur.stderr.length > 0) stderr = tur.stderr;
          if (tur.interrupted === true) resultHead = "⚠ interrupted";
        } else if (typeof tur.url === "string" && typeof tur.bytes === "number") {
          const size = tur.bytes < 1024 ? `${tur.bytes}B` : `${(tur.bytes / 1024).toFixed(1)}KB`;
          const dur =
            typeof tur.durationMs === "number"
              ? tur.durationMs >= 1000
                ? `${(tur.durationMs / 1000).toFixed(1)}s`
                : `${tur.durationMs}ms`
              : "";
          resultHead = [tur.code, size, dur].filter(Boolean).join(" · ");
        } else if (Array.isArray(tur.results) || typeof tur.searchCount === "number") {
          const n = Array.isArray(tur.results) ? tur.results.length : tur.searchCount;
          const q = typeof tur.query === "string" ? ` · "${tur.query.slice(0, 60)}"` : "";
          resultHead = `${n} results${q}`;
        }
      }

      out.push(
        mk("tool_result", blockIdx, {
          isError: block.is_error === true,
          result,
          stderr,
          diff,
          resultHead,
          corr: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
        }),
      );
    } else if (type === "text") {
      out.push(mk("text", blockIdx, { text: typeof block.text === "string" ? block.text : null }));
    } else if (type === "thinking") {
      out.push(
        mk("thinking", blockIdx, {
          text: typeof block.thinking === "string" ? block.thinking : null,
        }),
      );
    } else {
      opts?.onSkip?.(typeof type === "string" ? type : String(type));
    }
  });

  return out;
}
