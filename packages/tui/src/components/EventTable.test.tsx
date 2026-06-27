import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { EventTable } from "./EventTable";
import { DEFAULT_VISIBLE, columnById, type ColumnDef } from "../columns";
import { makeRow } from "../fixtures";

const cols = DEFAULT_VISIBLE.map(columnById).filter((c): c is ColumnDef => !!c);

const rows = [
  makeRow({ id: 1, tool: "Bash", command: "ls -la" }),
  makeRow({ id: 2, tool: "Read", command: "/etc/hosts" }),
  makeRow({ id: 3, tool: "Edit", command: "App.tsx", isError: true }),
];

describe("EventTable rendering", () => {
  test("wide terminal shows headers and cell values for every row", () => {
    const { lastFrame } = render(
      <EventTable
        rows={rows}
        cursor={0}
        columns={cols}
        frozenIds={new Set()}
        hOffset={0}
        termWidth={200}
        termHeight={20}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("TIME");
    expect(f).toContain("TOOL");
    expect(f).toContain("Bash");
    expect(f).toContain("Read");
    expect(f).toContain("Edit");
    expect(f).toContain("1/3"); // footer position (cursor at row 0)
  });

  test("the error cell renders ERR for a failed tool_result", () => {
    // A narrow column subset so every cell is on-screen regardless of the
    // test surface width (the wide case above truncates the rightmost columns).
    const subset = ["tool", "error"].map(columnById).filter((c): c is ColumnDef => !!c);
    const { lastFrame } = render(
      <EventTable
        rows={rows}
        cursor={0}
        columns={subset}
        frozenIds={new Set()}
        hOffset={0}
        termWidth={40}
        termHeight={20}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("ERR");
  });

  test("narrow terminal with a frozen column scrolls horizontally", () => {
    const { lastFrame } = render(
      <EventTable
        rows={rows}
        cursor={0}
        columns={cols}
        frozenIds={new Set(["time"])}
        hOffset={0}
        termWidth={30}
        termHeight={20}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("TIME"); // frozen column stays on screen
    expect(f).toContain("frozen: time"); // footer reports the pin
    expect(f).toContain("more ▶"); // columns remain off the right edge
  });

  test("empty result set renders the header and a 'no events' footer", () => {
    const { lastFrame } = render(
      <EventTable
        rows={[]}
        cursor={0}
        columns={cols}
        frozenIds={new Set()}
        hOffset={0}
        termWidth={120}
        termHeight={20}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("TIME");
    expect(f).toContain("no events");
  });
});
