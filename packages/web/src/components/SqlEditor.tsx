// CodeMirror 6 SQL editor (syntax highlighting + bracket matching + schema-aware
// autocomplete). Shipped unconditionally — bundle size is not a constraint here;
// the editing UX is worth the weight (user directive, DECISIONS.md D-5.k).
import React, { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { keymap, Prec, EditorView } from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { SQL_COLUMNS, SQL_RELATION } from "@clogdy/shared";

interface SqlEditorProps {
  value: string;
  /** Debounced — fires after the user pauses typing, NOT every keystroke. */
  onChange: (sql: string) => void;
  /** Receives the live editor text so it is never stale despite the debounce. */
  onRun: (sql: string) => void;
  error: string | null;
}

// Lifting every keystroke to the parent re-renders the whole app (incl. the
// mounted virtualized events grid). Debounce so typing stays local to this
// component; Run flushes synchronously so the parent never sees stale text.
const DEBOUNCE_MS = 200;

const EXAMPLES = [
  {
    label: "Tool usage counts",
    sql: "SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool ORDER BY n DESC",
  },
  {
    // NB: dur_ms is always NULL in the current schema (never backfilled), so an
    // example filtering on it would always return zero rows. Use error counts,
    // which exercise a real aggregate over populated columns.
    label: "Errors by tool",
    sql: "SELECT tool, COUNT(*) FILTER (WHERE is_error = 1) errors, COUNT(*) n FROM events WHERE kind='tool_result' GROUP BY tool ORDER BY errors DESC",
  },
  {
    label: "Events per hour",
    sql: "SELECT date_trunc('hour', make_timestamp(ts*1000)) hr, COUNT(*) FROM events GROUP BY hr ORDER BY hr",
  },
];

// Column completions for @codemirror/lang-sql, derived from the single source of
// truth in @clogdy/shared. `detail` shows the type after the label; `info` shows
// the description when the item is highlighted. (Typed structurally as the
// lang-sql schema's Completion shape — no direct @codemirror/autocomplete dep.)
const COLUMN_COMPLETIONS = SQL_COLUMNS.map((c) => ({
  label: c.name,
  type: "property",
  detail: c.type,
  info: c.desc,
}));

export default function SqlEditor({
  value,
  onChange,
  onRun,
  error,
}: SqlEditorProps): React.ReactElement {
  const [showExamples, setShowExamples] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  // Local editor text: per-keystroke updates re-render only this component, not
  // the parent app. The parent is synced on a debounce (and on Run/blur).
  // `value` is read once as the initial document; the editor is the source of
  // truth thereafter (the parent only ever echoes back what we sent), so a later
  // `value` prop change is intentionally NOT folded back in. A future feature
  // that sets sqlText externally while the editor stays mounted would need a
  // value→text resync effect here.
  const [text, setText] = useState(value);
  const docRef = useRef(value); // always the live text, without a re-render
  const viewRef = useRef<EditorView | null>(null);

  // Keep the latest callbacks reachable from the memoized keymap / debounce timer.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending debounce on unmount.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flush = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onChangeRef.current(docRef.current);
  };

  const handleCmChange = (v: string): void => {
    docRef.current = v;
    setText(v); // local, cheap
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onChangeRef.current(docRef.current);
    }, DEBOUNCE_MS);
  };

  // Replace the whole document (Examples) — set local + parent immediately.
  const setDoc = (v: string): void => {
    docRef.current = v;
    setText(v);
    flush();
  };

  const run = (): void => {
    flush();
    onRunRef.current(docRef.current);
  };

  const insertColumn = (name: string): void => {
    const view = viewRef.current;
    if (!view) return;
    // The dispatch fires CodeMirror's onChange → handleCmChange, so text/docRef
    // stay in sync; we only need to move focus and close the menu.
    view.dispatch(view.state.replaceSelection(name));
    view.focus();
    setShowColumns(false);
  };

  const extensions = useMemo(
    () => [
      // schema drives table+column autocomplete; defaultTable lets columns
      // complete without an `events.` prefix.
      sql({
        schema: { [SQL_RELATION]: COLUMN_COMPLETIONS },
        defaultTable: SQL_RELATION,
        upperCaseKeywords: true,
      }),
      EditorView.lineWrapping,
      // Cmd/Ctrl-Enter runs the query (highest precedence so it beats defaults).
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              run();
              return true;
            },
          },
        ]),
      ),
    ],
    [],
  );

  return (
    <div id="sql-editor">
      <div className="sql-toolbar">
        <div className="sql-menu">
          <button
            id="sql-examples-btn"
            onClick={() => {
              setShowExamples((s) => !s);
              setShowColumns(false);
            }}
          >
            Examples ▾
          </button>
          {showExamples && (
            <ul id="sql-examples-list" className="sql-dropdown">
              {EXAMPLES.map((ex) => (
                <li
                  key={ex.label}
                  onClick={() => {
                    setDoc(ex.sql);
                    setShowExamples(false);
                  }}
                >
                  {ex.label}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="sql-menu">
          <button
            id="sql-columns-btn"
            onClick={() => {
              setShowColumns((s) => !s);
              setShowExamples(false);
            }}
          >
            Columns ▾
          </button>
          {showColumns && (
            <ul id="sql-columns-list" className="sql-dropdown">
              <li className="sql-columns-hint" aria-hidden="true">
                from <code>{SQL_RELATION}</code> — click to insert
              </li>
              {SQL_COLUMNS.map((c) => (
                <li
                  key={c.name}
                  className="sql-column"
                  title={c.desc}
                  onClick={() => insertColumn(c.name)}
                >
                  <code className="sql-col-name">{c.name}</code>
                  <span className="sql-col-type">{c.type}</span>
                  <span className="sql-col-desc">{c.desc}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button id="sql-run" onClick={run}>
          ▶ Run
        </button>
        <span className="sql-hint">⌃/⌘+Enter to run · ⌃Space for completions</span>
      </div>
      <CodeMirror
        id="sql-cm"
        value={text}
        onChange={handleCmChange}
        extensions={extensions}
        theme="dark"
        height="140px"
        basicSetup={{ highlightActiveLine: false }}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        onFocus={() => {
          // Clicking into the editor dismisses any open menu (so a dropdown can't
          // swallow the click that should land in the document).
          setShowExamples(false);
          setShowColumns(false);
        }}
        onBlur={() => {
          // Flush the debounce on blur so an action taken right after typing
          // (clicking a facet, the q box, the address bar) sees the latest text
          // in the parent's state.sqlText, not the pre-debounce value.
          flush();
        }}
        placeholder="SELECT … FROM events WHERE …  — Columns ▾ lists every field"
      />
      {error !== null && (
        <div id="sql-error" className="sql-error">
          {error}
        </div>
      )}
    </div>
  );
}
