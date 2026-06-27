import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  db: string;
  root: string;
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultDbPath(): string {
  return (
    process.env.CLOGDY_DB ??
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "clogdy", "clogdy.db")
  );
}

export function defaultRoot(): string {
  return process.env.CLOGDY_ROOT ?? join(homedir(), ".claude", "projects");
}

/**
 * Resolve DB + transcript-root paths from args → env → default. Expands a leading
 * `~`. Creates no directories (callers mkdir).
 */
export function resolvePaths(argv?: { db?: string; root?: string }): Paths {
  const db = expandHome(argv?.db ?? defaultDbPath());
  const root = expandHome(argv?.root ?? defaultRoot());
  return { db, root };
}
