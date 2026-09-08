import { describe, it, expect } from "vitest";
import type { Env } from "@/env";
import { validateConfig, summarizeConfig } from "@/lib/config/validate";
import type { Routing } from "@/lib/routing";

// A fully valid env with DUMMY values (never real secrets). validateConfig only reads string
// fields, so DB can be a stub.
const GOOD: Partial<Env> = {
  WEBHOOK_SHARED_SECRET: "wh_test_token_0000000000000000000000",
  REPLAY_KEY: "replay_test_key_000000000000000000000",
  SLACK_BOT_TOKEN: "xoxb-fake-not-a-real-bot-token-000000",
  SLACK_DEFAULT_CHANNEL: "C0TEST000AA",
  POSTING_ENABLED: "true",
};

const mkEnv = (over: Partial<Env> = {}): Env => ({ ...GOOD, ...over }) as Env;
const issue = (env: Env, name: string) => summarizeConfig(validateConfig(env)).issues.find((i) => i.name === name);

describe("validateConfig", () => {
  it("passes a fully well-formed env", () => {
    const { ok, issues } = summarizeConfig(validateConfig(mkEnv()));
    expect(ok).toBe(true);
    expect(issues).toEqual([]);
  });

  it("catches the whole-URL-as-token footgun (the real outage)", () => {
    const env = mkEnv({ WEBHOOK_SHARED_SECRET: "https://example.com/webhooks/meltwater/deadbeef" });
    const c = issue(env, "WEBHOOK_SHARED_SECRET");
    expect(c?.severity).toBe("error");
    expect(c?.detail).toMatch(/URL|slash|whitespace/i);
    expect(summarizeConfig(validateConfig(env)).ok).toBe(false);
  });

  it("flags missing token secrets as errors", () => {
    for (const name of ["WEBHOOK_SHARED_SECRET", "REPLAY_KEY"] as const) {
      const c = issue(mkEnv({ [name]: undefined }), name);
      expect(c).toMatchObject({ severity: "error", detail: "missing" });
    }
  });

  it("warns (not errors) on a too-short token", () => {
    const env = mkEnv({ REPLAY_KEY: "short" });
    expect(issue(env, "REPLAY_KEY")?.severity).toBe("warn");
    // a warning alone must not fail configOk
    expect(summarizeConfig(validateConfig(env)).ok).toBe(true);
  });

  it("requires an xoxb- Slack bot token", () => {
    expect(issue(mkEnv({ SLACK_BOT_TOKEN: "xoxp-not-a-bot-token-1234567890" }), "SLACK_BOT_TOKEN")?.severity).toBe("error");
    expect(issue(mkEnv({ SLACK_BOT_TOKEN: undefined }), "SLACK_BOT_TOKEN")?.detail).toBe("missing");
  });

  it("requires a channel id or #name", () => {
    expect(issue(mkEnv({ SLACK_DEFAULT_CHANNEL: "general" }), "SLACK_DEFAULT_CHANNEL")?.severity).toBe("error");
    expect(summarizeConfig(validateConfig(mkEnv({ SLACK_DEFAULT_CHANNEL: "#general" }))).ok).toBe(true);
  });

  it("warns on a non-true/false POSTING_ENABLED without failing configOk", () => {
    const env = mkEnv({ POSTING_ENABLED: "TRUE" });
    expect(issue(env, "POSTING_ENABLED")?.severity).toBe("warn");
    expect(summarizeConfig(validateConfig(env)).ok).toBe(true);
  });

  it("accepts a well-formed routing and flags a malformed channel id", () => {
    const good: Routing = { v: 1, briefs: { mps: ["C0TEST000AA", "#vic-2026"] }, updatedAt: 1 };
    expect(summarizeConfig(validateConfig(mkEnv(), good)).ok).toBe(true);
    const bad: Routing = { v: 1, briefs: { mps: ["general"] }, updatedAt: 1 };
    const i = summarizeConfig(validateConfig(mkEnv(), bad)).issues.find((x) => x.name === "routing");
    expect(i?.severity).toBe("error");
    expect(i?.detail).toContain("mps");
  });

  it("warns (without failing configOk) on a routed brief that no longer exists", () => {
    const stale: Routing = { v: 1, briefs: { "ghost-brief": ["C0TEST000AA"] }, updatedAt: 1 };
    const sum = summarizeConfig(validateConfig(mkEnv(), stale));
    expect(sum.ok).toBe(true);
    expect(sum.issues.find((x) => x.name === "routing.briefs")?.severity).toBe("warn");
  });

  it("routes the synthesized 'default' brief without warning", () => {
    const r: Routing = { v: 1, briefs: { default: ["C0TEST000AA"] }, updatedAt: 1 };
    expect(summarizeConfig(validateConfig(mkEnv(), r)).issues).toHaveLength(0);
  });

  it("never echoes a channel id from the routing (they are treated as secret)", () => {
    const r: Routing = { v: 1, briefs: { mps: ["not-a-channel-id"] }, updatedAt: 1 };
    const serialized = JSON.stringify(summarizeConfig(validateConfig(mkEnv(), r)));
    expect(serialized).not.toContain("not-a-channel-id");
  });

  it("never leaks a secret value in the summary", () => {
    const secret = GOOD.WEBHOOK_SHARED_SECRET!;
    const env = mkEnv({ WEBHOOK_SHARED_SECRET: `https://x/${secret}` }); // malformed but contains the secret
    const serialized = JSON.stringify(summarizeConfig(validateConfig(env)));
    expect(serialized).not.toContain(secret);
  });
});
