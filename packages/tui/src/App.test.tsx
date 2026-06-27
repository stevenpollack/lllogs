import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App";
import { makeRow, makeFixtureDataSource } from "./fixtures";

/** Let React effects + the (re)load settle between key events. */
const tick = (ms = 30): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

test("/ search filters the buffer to matching rows and shows the active filter", async () => {
  const all = [
    makeRow({ id: 1, tool: "AAA", command: "alpha" }),
    makeRow({ id: 2, tool: "BBB", command: "find the needle" }),
    makeRow({ id: 3, tool: "CCC", command: "beta" }),
  ];
  const ds = makeFixtureDataSource(all);
  // pollMs huge so the live interval never interferes with the assertions.
  const { stdin, lastFrame } = render(<App ds={ds} pollMs={10_000_000} />);
  await tick();

  expect(lastFrame()).toContain("AAA");
  expect(lastFrame()).toContain("BBB");
  expect(lastFrame()).toContain("CCC");

  stdin.write("/"); // enter search mode
  await tick();
  stdin.write("needle"); // type the query
  await tick();
  stdin.write("\r"); // apply
  await tick(60);

  const f = lastFrame() ?? "";
  expect(f).toContain("BBB"); // the matching row remains
  expect(f).not.toContain("AAA"); // non-matching rows are filtered out
  expect(f).not.toContain("CCC");
  expect(f).toContain('q:"needle"'); // status bar reflects the active filter
});

test("facet pane toggles a dimension filter and the table refilters", async () => {
  const all = [
    makeRow({ id: 1, tool: "Bash", command: "one" }),
    makeRow({ id: 2, tool: "Read", command: "two" }),
    makeRow({ id: 3, tool: "Bash", command: "three" }),
  ];
  const ds = makeFixtureDataSource(all);
  const { stdin, lastFrame } = render(<App ds={ds} pollMs={10_000_000} />);
  await tick();

  stdin.write("f"); // open the facet pane
  await tick();
  const pane = lastFrame() ?? "";
  expect(pane).toContain("TOOL");
  expect(pane).toContain("Bash");
  expect(pane).toContain("Read");

  // Items: project:clogdy, session:…, tool:Bash, tool:Read, kind:tool_use, role:assistant.
  // Cursor starts at 0; two downs land on tool:Bash (count-DESC, so the first tool).
  stdin.write("j");
  await tick();
  stdin.write("j");
  await tick();
  stdin.write(" "); // toggle tool:Bash
  await tick(40);
  stdin.write("f"); // close the pane
  await tick(40);

  const f = lastFrame() ?? "";
  expect(f).toContain("tool:Bash"); // active-filter chip
  expect(f).toContain("Bash");
  expect(f).not.toContain("Read"); // the Read row is filtered out
});

// ALL_COLUMNS order: time, project, session, kind, tool, command, … → tool is index 4.
async function toTool(stdin: { write: (s: string) => void }): Promise<void> {
  stdin.write("c"); // open the column menu
  await tick();
  for (let i = 0; i < 4; i++) {
    stdin.write("j");
    await tick(5);
  }
}

test("column menu hides a column from the table", async () => {
  const ds = makeFixtureDataSource([
    makeRow({ id: 1, tool: "Bash" }),
    makeRow({ id: 2, tool: "Read" }),
  ]);
  const { stdin, lastFrame } = render(<App ds={ds} pollMs={10_000_000} />);
  await tick();
  expect(lastFrame()).toContain("TOOL"); // shown by default

  await toTool(stdin);
  stdin.write(" "); // hide TOOL
  await tick();
  stdin.write("c"); // close the menu
  await tick();

  expect(lastFrame()).not.toContain("TOOL");
});

test("column menu sorts the table by a column", async () => {
  // Rows load id-ascending (Read, then Bash); sorting tool ascending flips them.
  const ds = makeFixtureDataSource([
    makeRow({ id: 1, tool: "Read", command: "R" }),
    makeRow({ id: 2, tool: "Bash", command: "B" }),
  ]);
  const { stdin, lastFrame } = render(<App ds={ds} pollMs={10_000_000} />);
  await tick();
  expect(lastFrame()!.indexOf("Read")).toBeLessThan(lastFrame()!.indexOf("Bash")); // id order

  await toTool(stdin);
  stdin.write("s"); // sort by tool, ascending
  await tick();
  stdin.write("c"); // close the menu
  await tick();

  const f = lastFrame() ?? "";
  expect(f).toContain("sort:tool▲");
  expect(f.indexOf("Bash")).toBeLessThan(f.indexOf("Read")); // Bash now sorts first
});

test("Enter opens the drawer; r toggles raw JSON; x re-scopes by correlation", async () => {
  const all = [
    makeRow({
      id: 1,
      tool: "Bash",
      command: "echo alpha",
      corr: "c-1",
      resultHead: "ok-alpha",
      raw: '{"hello":"world"}',
    }),
    makeRow({ id: 2, tool: "Read", command: "/etc/hosts", corr: "c-2" }),
  ];
  const ds = makeFixtureDataSource(all);
  const { stdin, lastFrame } = render(<App ds={ds} pollMs={10_000_000} />);
  await tick();

  stdin.write("k"); // cursor starts at the newest (Read); move up to the Bash row
  await tick();
  stdin.write("\r"); // open the drawer
  await tick();
  expect(lastFrame()).toContain("COMMAND");
  expect(lastFrame()).toContain("echo alpha");
  expect(lastFrame()).toContain("c-1"); // correlation id shown

  stdin.write("r"); // switch to raw JSON
  await tick();
  expect(lastFrame()).toContain('"hello"');

  stdin.write("r"); // back to structured
  await tick();
  stdin.write("x"); // correlate → filter.corr = c-1, close the drawer
  await tick(40);
  const f = lastFrame() ?? "";
  expect(f).toContain("corr:c-1"); // active-filter chip
  expect(f).toContain("Bash");
  expect(f).not.toContain("Read"); // the other correlation is filtered out
});

test("correlate REPLACES the filter (drops a lingering search) and reveals the pair", async () => {
  const all = [
    makeRow({ id: 1, tool: "Read", command: "open thing", corr: "c-9" }), // tool_use half
    makeRow({ id: 2, tool: null, kind: "tool_result", command: null, result: "done", corr: "c-9" }), // its result
  ];
  const ds = makeFixtureDataSource(all);
  const { stdin, lastFrame } = render(<App ds={ds} pollMs={10_000_000} />);
  await tick();

  // Narrow with a search that only matches the tool_use half.
  stdin.write("/");
  await tick();
  stdin.write("open");
  await tick();
  stdin.write("\r");
  await tick(40);
  expect(lastFrame()).toContain('q:"open"');
  expect(lastFrame()).not.toContain("tool_result"); // the result half is filtered out by q

  stdin.write("\r"); // open the drawer on the matching row
  await tick();
  stdin.write("x"); // correlate
  await tick(40);

  const f = lastFrame() ?? "";
  expect(f).toContain("corr:c-9");
  expect(f).not.toContain('q:"open"'); // the search was DROPPED, not ANDed
  expect(f).toContain("tool_result"); // …so the counterpart half is now revealed
});
