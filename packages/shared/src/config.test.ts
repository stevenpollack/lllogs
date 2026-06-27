import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDbPath, defaultRoot, resolvePaths } from "./config";

const ENV_KEYS = ["CLOGDY_DB", "CLOGDY_ROOT", "XDG_DATA_HOME"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("defaults", () => {
  it("defaultDbPath matches ~/.local/share/clogdy/clogdy.db", () => {
    expect(defaultDbPath()).toBe(join(homedir(), ".local", "share", "clogdy", "clogdy.db"));
  });
  it("XDG_DATA_HOME overrides the share dir", () => {
    process.env.XDG_DATA_HOME = "/data";
    expect(defaultDbPath()).toBe(join("/data", "clogdy", "clogdy.db"));
  });
  it("CLOGDY_DB beats XDG default", () => {
    process.env.CLOGDY_DB = "/custom/x.db";
    expect(defaultDbPath()).toBe("/custom/x.db");
  });
  it("defaultRoot matches ~/.claude/projects", () => {
    expect(defaultRoot()).toBe(join(homedir(), ".claude", "projects"));
  });
  it("CLOGDY_ROOT overrides root default", () => {
    process.env.CLOGDY_ROOT = "/r";
    expect(defaultRoot()).toBe("/r");
  });
});

describe("resolvePaths precedence", () => {
  it("explicit arg beats env", () => {
    process.env.CLOGDY_DB = "/env/db";
    process.env.CLOGDY_ROOT = "/env/root";
    const p = resolvePaths({ db: "/arg/db", root: "/arg/root" });
    expect(p).toEqual({ db: "/arg/db", root: "/arg/root" });
  });
  it("env beats default when no arg", () => {
    process.env.CLOGDY_DB = "/env/db";
    process.env.CLOGDY_ROOT = "/env/root";
    expect(resolvePaths()).toEqual({ db: "/env/db", root: "/env/root" });
  });
  it("falls back to defaults", () => {
    expect(resolvePaths()).toEqual({ db: defaultDbPath(), root: defaultRoot() });
  });
  it("expands a leading ~", () => {
    const p = resolvePaths({ db: "~/x.db", root: "~/projs" });
    expect(p.db).toBe(join(homedir(), "x.db"));
    expect(p.root).toBe(join(homedir(), "projs"));
  });
});
