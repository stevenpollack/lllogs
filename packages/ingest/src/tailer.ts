export interface TailerOptions {
  root: string;
  full: boolean;
  /** poll interval in ms when watching forever (default 500) */
  intervalMs?: number;
  /** initial cursors so a restart resumes instead of re-reading (path → byte offset). */
  cursors?: Map<string, number>;
}

/**
 * Tail every `*.jsonl` under `opts.root`, invoking `sink(path, line)` for every
 * complete line. Ported from v1 `scripts/follow.ts`: per-file byte offset +
 * partial-line remainder, glob scan, truncate-resets-to-0.
 *
 * - `once === true`: perform exactly one full pass over the tree, flush each file's
 *   complete lines, then resolve (no polling loop).
 * - `once` falsey: poll every `intervalMs` forever (Phase 2 watch).
 * - `opts.cursors` seeds the offset map at start (resume).
 * - `opts.full === false`: files present at the first pass are skipped to EOF
 *   (history); a file appearing later is read from 0.
 */
export function tail(
  opts: TailerOptions,
  sink: (path: string, line: string) => void,
  once?: boolean,
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 500;
  const offsets = new Map<string, number>();
  if (opts.cursors) {
    for (const [path, off] of opts.cursors) offsets.set(path, off);
  }
  const remainders = new Map<string, string>();

  async function emitDelta(path: string): Promise<void> {
    const file = Bun.file(path);
    let size: number;
    try {
      size = file.size;
    } catch {
      return; // vanished between scan and read
    }

    let from = offsets.get(path) ?? 0;
    if (size < from) {
      from = 0; // truncated / rotated — re-read from the top
      remainders.delete(path);
    }
    if (size <= from) return;

    const chunk = await file.slice(from, size).text();
    offsets.set(path, size);

    const text = (remainders.get(path) ?? "") + chunk;
    const nl = text.lastIndexOf("\n");
    if (nl === -1) {
      remainders.set(path, text); // still no complete line — keep buffering
      return;
    }
    remainders.set(path, text.slice(nl + 1));

    for (const line of text.slice(0, nl).split("\n")) {
      if (line.length) sink(path, line);
    }
  }

  async function tick(initial: boolean): Promise<void> {
    const seen = new Set<string>();
    for await (const path of new Bun.Glob("**/*.jsonl").scan({
      cwd: opts.root,
      absolute: true,
    })) {
      seen.add(path);
      if (!offsets.has(path)) {
        // Files already present at startup are "history": without `full`, skip to
        // their EOF and stream only future appends. A file that appears *later* is
        // a new session — always read it from the top, even without `full`.
        if (initial && !opts.full) {
          try {
            offsets.set(path, Bun.file(path).size);
          } catch {
            offsets.set(path, 0);
          }
          continue;
        }
        offsets.set(path, 0);
      }
      await emitDelta(path);
    }
    // Forget files that disappeared, so a recreated path re-reads from the start.
    for (const path of offsets.keys()) {
      if (!seen.has(path)) {
        offsets.delete(path);
        remainders.delete(path);
      }
    }
  }

  return (async () => {
    let initial = true;
    for (;;) {
      await tick(initial);
      initial = false;
      if (once) return;
      await Bun.sleep(intervalMs);
    }
  })();
}
