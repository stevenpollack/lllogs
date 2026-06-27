import React, { useRef, useEffect, useState } from "react";
import type { EventFilter } from "@lllogs/shared";
import { asArray } from "@lllogs/shared";
import type { VisibilityState } from "@tanstack/react-table";

function shortSession(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

// What the free-text `q` box actually does (server: command/text/result LIKE %q%).
// NB: not "case-insensitive" — the events list uses SQLite LIKE (insensitive)
// but SQL mode scopes the DuckDB CTE whose LIKE is case-sensitive, so we don't
// promise a case rule.
const SEARCH_HELP =
  "Substring search across the COMMAND, TEXT and RESULT columns (not a regex). " +
  "SQL LIKE wildcards apply: % matches any run of characters, _ matches exactly " +
  "one. For exact or structured queries, use ƒx SQL.";

interface FilterBarProps {
  filter: EventFilter;
  liveOn: boolean;
  qValue: string;
  onQChange: (v: string) => void;
  onRemoveFilter: (key: string, value?: string) => void;
  onToggleLive: () => void;
  sqlActive: boolean;
  onToggleSql: () => void;
  // Events-table column hide/show menu (only shown for the events view).
  showColumnMenu: boolean;
  columns: { id: string; label: string }[];
  columnVisibility: VisibilityState;
  onToggleColumn: (id: string) => void;
}

export function FilterBar({
  filter,
  liveOn,
  qValue,
  onQChange,
  onRemoveFilter,
  onToggleLive,
  sqlActive,
  onToggleSql,
  showColumnMenu,
  columns,
  columnVisibility,
  onToggleColumn,
}: FilterBarProps): React.ReactElement {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Debounce q input
  function handleInput(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = e.target.value;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onQChange(v.trim());
    }, 250);
  }

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  // Column menu open/close, with click-outside to dismiss.
  const [showCols, setShowCols] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showCols) return;
    const onDoc = (e: MouseEvent): void => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) {
        setShowCols(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showCols]);
  // The whole menu unmounts when leaving the events view; close it so it doesn't
  // re-render already-open (and so the click-outside listener detaches).
  useEffect(() => {
    if (!showColumnMenu) setShowCols(false);
  }, [showColumnMenu]);

  const visibleCount = columns.filter((c) => columnVisibility[c.id] !== false).length;
  const hiddenCount = columns.length - visibleCount;

  // One chip per selected value, so a multi-select dimension (e.g. kind =
  // tool_use + tool_result) shows two separately-removable chips.
  const chips = Object.entries(filter)
    .filter(([k]) => k !== "q")
    .flatMap(([k, v]) => asArray(v).map((val) => ({ key: k, value: String(val) })));

  return (
    <div id="bar">
      <input
        id="q"
        type="text"
        placeholder="search command · text · result…"
        title={SEARCH_HELP}
        defaultValue={qValue}
        onChange={handleInput}
      />
      <span id="q-help" title={SEARCH_HELP} aria-label="search help">
        ⓘ
      </span>
      <span id="chips">
        {chips.map(({ key, value }) => (
          <span key={`${key}:${value}`} className="chip" onClick={() => onRemoveFilter(key, value)}>
            {key}: {key === "session" ? shortSession(value) : value} ✕
          </span>
        ))}
      </span>
      {showColumnMenu && (
        <div className="col-menu" ref={colMenuRef}>
          <button id="col-menu-btn" onClick={() => setShowCols((s) => !s)}>
            Columns{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""} ▾
          </button>
          {showCols && (
            <ul id="col-menu-list" className="sql-dropdown">
              {columns.map((c) => {
                const visible = columnVisibility[c.id] !== false;
                // Don't let the user uncheck the last visible column (a 0-column
                // grid renders empty rows that wreck the virtualizer).
                const lockedOn = visible && visibleCount <= 1;
                return (
                  <li key={c.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={visible}
                        disabled={lockedOn}
                        onChange={() => onToggleColumn(c.id)}
                      />
                      {c.label}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <button id="sql-btn" className={sqlActive ? "active" : ""} onClick={onToggleSql}>
        ƒx SQL
      </button>
      <button id="live-btn" className={liveOn ? "active" : ""} onClick={onToggleLive}>
        {liveOn ? "Live ●" : "Live"}
      </button>
    </div>
  );
}
