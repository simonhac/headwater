/**
 * Digest subscriptions end-to-end: the D1 store, the per-subscriber send (real D1, mocked Resend),
 * and the `/slack/commands` route (signed like Slack does, mocked users.info).
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "@/index";
import { SubscriberStore } from "@/lib/store/subscribers";
import { runDigestSend } from "@/lib/digestSend";
import { slackSignature } from "@/lib/slack/verify";
import { handleDigestCommand } from "@/lib/slack/commands";

const TZ = "Australia/Melbourne";
const SIGNING = "0123456789abcdef0123456789abcdef";
// 08:00 AEDT on 16 Jan 2026.
const MEL_8AM = Date.UTC(2026, 0, 15, 21, 0);
const MEL_DAY = "2026-01-16";

const digestEnv = {
  ...env,
  DIGEST_ENABLED: "true",
  RESEND_API_KEY: "re_" + "a".repeat(30),
  DIGEST_FROM: "digest@example.org",
  SLACK_SIGNING_SECRET: SIGNING,
} as unknown as typeof env & { DIGEST_ENABLED?: string; SLACK_SIGNING_SECRET?: string };

async function insertStory(key: string, createdAt: number) {
  await env.DB.prepare(
    `INSERT INTO stories (story_key, slack_ts, channel, brief_label, primary_mention_json, outlets_json, brief_labels_json, created_at, updated_at)
       VALUES (?, '1.0', 'C1', 'Energy Policy', ?, ?, '["Energy Policy"]', ?, ?)`,
  )
    .bind(
      `C1|${key}|${createdAt}`,
      JSON.stringify({
        url: "https://x.example/a",
        outletUrl: null,
        title: "Something happened",
        sourceName: "The Age",
        mediaType: "online_news",
        countryCode: "AU",
        reach: 5000000,
        sentiment: "neutral",
        publishedAt: "2026-01-15T06:02:00+11:00",
        snippet: "A snippet mentioning Energy Policy today.",
        author: "A. Reporter",
        matchedKeywords: ["Energy Policy"],
      }),
      '[{"name":"The Age","url":null,"reach":5000000}]',
      createdAt,
      createdAt,
    )
    .run();
}

interface Sent {
  url: string;
  to?: string[];
  subject?: string;
  idempotency?: string | null;
}

describe("digest subscribers", () => {
  const store = new SubscriberStore(env.DB);
  let sent: Sent[];
  let resendOk = true;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM digest_subscribers").run();
    await env.DB.prepare("DELETE FROM stories").run();
    sent = [];
    resendOk = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("https://api.resend.com/")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string };
          sent.push({ url: u, to: body.to, subject: body.subject, idempotency: new Headers(init?.headers).get("Idempotency-Key") });
          return resendOk
            ? Response.json({ id: `msg-${sent.length}` })
            : Response.json({ statusCode: 422, name: "validation_error", message: "nope" }, { status: 422 });
        }
        if (u.startsWith("https://slack.com/api/users.info")) {
          const user = new URL(u).searchParams.get("user");
          return Response.json({ ok: true, user: { id: user, tz: TZ, profile: { email: `${user!.toLowerCase()}@example.org` } } });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  describe("store", () => {
    it("upserts, reads, counts and removes", async () => {
      await store.upsert({ slack_user_id: "U1", email: "a@x.org", time_zone: TZ, send_minute: 480, last_sent_day: null }, 1);
      await store.upsert({ slack_user_id: "U1", email: "b@x.org", time_zone: "Europe/London", send_minute: 450, last_sent_day: "2026-01-01" }, 2);
      const row = await store.get("U1");
      expect(row).toMatchObject({ email: "b@x.org", time_zone: "Europe/London", send_minute: 450, last_sent_day: "2026-01-01", created_at: 1, updated_at: 2 });
      expect(await store.count()).toBe(1);
      expect(await store.remove("U1")).toBe(true);
      expect(await store.remove("U1")).toBe(false);
      expect(await store.get("U1")).toBeNull();
    });
  });

  describe("runDigestSend", () => {
    beforeEach(async () => {
      await insertStory("s1", MEL_8AM - 60 * 60 * 1000);
      await store.upsert({ slack_user_id: "U_MEL", email: "mel@example.org", time_zone: TZ, send_minute: 480, last_sent_day: null }, 1);
      // 21:00Z is 21:00 in London — this 8am subscriber was already sent this morning.
      await store.upsert({ slack_user_id: "U_LON", email: "lon@example.org", time_zone: "Europe/London", send_minute: 480, last_sent_day: "2026-01-15" }, 1);
      // Not due yet: wants 9am Melbourne.
      await store.upsert({ slack_user_id: "U_LATE", email: "late@example.org", time_zone: TZ, send_minute: 540, last_sent_day: null }, 1);
    });

    it("sends only to those due, marks them, and is a no-op on the next tick", async () => {
      const r = await runDigestSend(digestEnv, MEL_8AM);
      expect(r).toMatchObject({ candidates: 3, due: 1, sent: 1, failed: 0, storyCount: 1 });
      expect(sent.map((s) => s.to)).toEqual([["mel@example.org"]]);
      expect(sent[0]!.idempotency).toBe(`headwater-digest-U_MEL-${MEL_DAY}-480`);
      expect((await store.get("U_MEL"))!.last_sent_day).toBe(MEL_DAY);

      const again = await runDigestSend(digestEnv, MEL_8AM + 15 * 60 * 1000);
      expect(again).toMatchObject({ due: 0, sent: 0 });
      expect(sent).toHaveLength(1);

      // An hour later the 9am subscriber comes due, and gets the same-run window.
      const later = await runDigestSend(digestEnv, MEL_8AM + 60 * 60 * 1000);
      expect(later).toMatchObject({ due: 1, sent: 1 });
      expect(sent[1]!.to).toEqual(["late@example.org"]);
    });

    it("does not mark a subscriber whose send failed, so the next tick retries", async () => {
      resendOk = false;
      const r = await runDigestSend(digestEnv, MEL_8AM);
      expect(r).toMatchObject({ due: 1, sent: 0, failed: 1 });
      expect(r.results[0]).toMatchObject({ userId: "U_MEL", status: "failed" });
      expect((await store.get("U_MEL"))!.last_sent_day).toBeNull();
    });

    it("dry run reports who is due and sends nothing", async () => {
      const r = await runDigestSend({ ...digestEnv, DIGEST_ENABLED: "false" }, MEL_8AM, { dryRun: true });
      expect(r).toMatchObject({ due: 1, sent: 0, dryRun: true });
      expect(sent).toEqual([]);
      expect((await store.get("U_MEL"))!.last_sent_day).toBeNull();
    });

    it("force sends to everyone not yet sent today, and never to anyone already sent", async () => {
      const r = await runDigestSend(digestEnv, MEL_8AM, { force: true });
      expect(r.due).toBe(2);
      expect(sent.map((s) => s.to![0]).sort()).toEqual(["late@example.org", "mel@example.org"]);
    });

    it("stays silent when disabled", async () => {
      const r = await runDigestSend({ ...digestEnv, DIGEST_ENABLED: "false" }, MEL_8AM);
      expect(r).toMatchObject({ disabled: true, candidates: 0 });
      expect(sent).toEqual([]);
    });

    it("marks the day but sends nothing when the window is empty", async () => {
      await env.DB.prepare("DELETE FROM stories").run();
      const r = await runDigestSend(digestEnv, MEL_8AM);
      expect(r).toMatchObject({ due: 1, sent: 0, empty: true });
      expect(sent).toEqual([]);
      expect((await store.get("U_MEL"))!.last_sent_day).toBe(MEL_DAY);
    });
  });

  describe("handleDigestCommand", () => {
    const cmd = (text: string, nowMs: number) => handleDigestCommand(digestEnv, { userId: "U_ONE", text, nowMs });

    it("subscribes with the profile email + zone, reports status, then unsubscribes", async () => {
      // 06:00 AEDT on 16 Jan: 8am is still ahead, so nothing is pre-marked.
      const morning = Date.UTC(2026, 0, 15, 19, 0);
      let r = await cmd("subscribe", morning);
      expect(r.text).toContain("u_one@example.org");
      expect(r.text).toContain("8:00am");
      expect(r.text).toContain("today at 8:00am");
      expect(await store.get("U_ONE")).toMatchObject({ email: "u_one@example.org", time_zone: TZ, send_minute: 480, last_sent_day: null });

      r = await cmd("status", morning);
      expect(r.text).toContain("subscribed as *u_one@example.org*");
      expect(r.text).toContain("Next: today at 8:00am");

      r = await cmd("unsubscribe", morning);
      expect(r.text).toContain("Unsubscribed");
      expect(await store.get("U_ONE")).toBeNull();

      r = await cmd("", morning);
      expect(r.text).toContain("not subscribed");
      expect((await cmd("unsubscribe", morning)).text).toContain("weren't subscribed");
    });

    it("pre-marks today when the chosen time has already passed, so nothing fires immediately", async () => {
      // 10:00 AEDT on 16 Jan; asking for 7:30 → first digest tomorrow.
      const late = Date.UTC(2026, 0, 15, 23, 0);
      const r = await cmd("subscribe 7:30", late);
      expect(r.text).toContain("7:30am");
      expect(r.text).toContain("tomorrow");
      expect(await store.get("U_ONE")).toMatchObject({ send_minute: 450, last_sent_day: MEL_DAY });
      await insertStory("s1", late - 60 * 60 * 1000);
      expect((await runDigestSend(digestEnv, late)).due).toBe(0);
    });

    it("says 'Updated' on a re-subscribe and notes rounding", async () => {
      const now = Date.UTC(2026, 0, 15, 19, 0);
      await cmd("subscribe", now);
      const r = await cmd("subscribe 7:25", now);
      expect(r.text).toMatch(/^Updated/);
      expect(r.text).toContain("rounded");
      expect((await store.get("U_ONE"))!.send_minute).toBe(450);
    });

    it("explains an unparseable time instead of subscribing", async () => {
      const r = await cmd("subscribe noon", Date.now());
      expect(r.text).toContain("couldn't read");
      expect(await store.get("U_ONE")).toBeNull();
    });

    it("explains a missing scope rather than failing silently", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ ok: false, error: "missing_scope" })),
      );
      const r = await cmd("subscribe", Date.now());
      expect(r.text).toContain("users:read.email");
      expect(await store.get("U_ONE")).toBeNull();
    });
  });

  describe("POST /slack/commands", () => {
    async function slash(text: string, opts: { user?: string; sign?: boolean; env?: object } = {}) {
      const nowMs = Date.now();
      const body = new URLSearchParams({ command: "/digest", text, user_id: opts.user ?? "U_ONE" }).toString();
      const ts = String(Math.floor(nowMs / 1000));
      const sig = opts.sign === false ? "v0=deadbeef" : await slackSignature(SIGNING, ts, body);
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request("https://feed.test/slack/commands", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": ts,
            "x-slack-signature": sig,
          },
          body,
        }),
        { ...digestEnv, ...(opts.env ?? {}) },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    }

    it("rejects a bad signature and a missing secret", async () => {
      expect((await slash("status", { sign: false })).status).toBe(401);
      expect((await slash("status", { env: { SLACK_SIGNING_SECRET: undefined } })).status).toBe(503);
      expect(await store.get("U_ONE")).toBeNull();
    });

    it("runs a signed command and answers ephemerally", async () => {
      const res = await slash("subscribe 7:30");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { response_type: string; text: string };
      expect(body.response_type).toBe("ephemeral");
      expect(body.text).toContain("u_one@example.org");
      expect(body.text).toContain("7:30am");
      expect(await store.get("U_ONE")).toMatchObject({ email: "u_one@example.org", time_zone: TZ, send_minute: 450 });

      const status = (await (await slash("status")).json()) as { text: string };
      expect(status.text).toContain("subscribed as *u_one@example.org*");
    });
  });
});
