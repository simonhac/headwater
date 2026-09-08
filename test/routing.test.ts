import { describe, it, expect } from "vitest";
import { channelsFor, configuredChannels, emptyRouting, loadRouting, parseRoutingForm, type Routing } from "@/lib/routing";
import type { Env } from "@/env";

const env = (dflt?: string) => ({ SLACK_DEFAULT_CHANNEL: dflt }) as unknown as Env;
const routing = (briefs: Record<string, string[]>): Routing => ({ v: 1, briefs, updatedAt: 0 });

/** D1 stub for loadRouting's `SELECT value FROM ops_state WHERE key = ?`.first(). */
const fakeDB = (value: string | null) =>
  ({ prepare: () => ({ bind: () => ({ first: async () => (value === null ? null : { value }) }) }) }) as unknown as D1Database;

describe("channelsFor", () => {
  it("falls back to the default channel when the brief is unrouted", () => {
    expect(channelsFor("mps", emptyRouting(), env("C_DEFAULT"))).toEqual(["C_DEFAULT"]);
    expect(channelsFor("mps", routing({ mps: [] }), env("C_DEFAULT"))).toEqual(["C_DEFAULT"]);
  });

  it("returns the routed channels, de-duped and blank-free", () => {
    expect(channelsFor("mps", routing({ mps: ["C_A", " ", "C_B", "C_A"] }), env("C_DEFAULT"))).toEqual(["C_A", "C_B"]);
  });

  it("does NOT implicitly add the default channel to a routed brief", () => {
    expect(channelsFor("mps", routing({ mps: ["C_VIC"] }), env("C_DEFAULT"))).toEqual(["C_VIC"]);
  });

  it("yields nothing when there is no routing and no default channel", () => {
    expect(channelsFor("mps", emptyRouting(), env(undefined))).toEqual([]);
  });
});

describe("configuredChannels", () => {
  it("lists the default first, then every routed channel, de-duped", () => {
    const r = routing({ mps: ["C_A"], teals: ["C_DEFAULT", "C_B"], "vic-election-2026": ["C_A", "C_VIC"] });
    expect(configuredChannels(r, env("C_DEFAULT"))).toEqual(["C_DEFAULT", "C_A", "C_B", "C_VIC"]);
  });

  it("omits a missing default channel", () => {
    expect(configuredChannels(routing({ mps: ["C_A"] }), env(undefined))).toEqual(["C_A"]);
  });
});

describe("parseRoutingForm", () => {
  const briefIds = ["mps", "vic-election-2026", "default"];
  const allowed = ["C_A", "C_B"];

  it("accepts both a single value and an array (parseBody all: true)", () => {
    const r = parseRoutingForm({ "r.mps": "C_A", "r.vic-election-2026": ["C_A", "C_B"] }, briefIds, allowed);
    expect(r.briefs).toEqual({ mps: ["C_A"], "vic-election-2026": ["C_A", "C_B"] });
  });

  it("routes the synthesized 'default' brief like any other", () => {
    expect(parseRoutingForm({ "r.default": "C_B" }, briefIds, allowed).briefs).toEqual({ default: ["C_B"] });
  });

  it("drops unknown brief ids and channels not in the live Slack list", () => {
    const r = parseRoutingForm({ "r.ghost-brief": "C_A", "r.mps": ["C_A", "C_GONE"] }, briefIds, allowed);
    expect(r.briefs).toEqual({ mps: ["C_A"] });
  });

  it("omits briefs with nothing ticked, so they fall back to the default", () => {
    expect(parseRoutingForm({ "r.mps": [] }, briefIds, allowed).briefs).toEqual({});
    expect(parseRoutingForm({}, briefIds, allowed).briefs).toEqual({});
  });

  it("ignores non-string values", () => {
    expect(parseRoutingForm({ "r.mps": [new File([], "x"), "C_A"] }, briefIds, allowed).briefs).toEqual({ mps: ["C_A"] });
  });
});

describe("loadRouting", () => {
  it("returns the empty routing when nothing is stored", async () => {
    expect(await loadRouting(fakeDB(null))).toEqual(emptyRouting());
  });

  it("degrades to the empty routing on malformed JSON rather than throwing", async () => {
    expect(await loadRouting(fakeDB("{not json"))).toEqual(emptyRouting());
    expect(await loadRouting(fakeDB("null"))).toEqual(emptyRouting());
    expect(await loadRouting(fakeDB('"a string"'))).toEqual(emptyRouting());
  });

  it("keeps only array-valued brief entries and cleans them", async () => {
    const r = await loadRouting(fakeDB(JSON.stringify({ v: 1, briefs: { mps: ["C_A", "", "C_A"], bad: "C_B" }, updatedAt: 7 })));
    expect(r).toEqual({ v: 1, briefs: { mps: ["C_A"] }, updatedAt: 7 });
  });
});
