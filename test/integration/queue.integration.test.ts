import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "@/index";
import { EventLog } from "@/lib/store/eventLog";

const RECEIVED_AT = 1783500000000;
const qctx = () => ({ waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

// A NEWS "Every Mention" payload (real flat shape). Same `title` → same story (folds); non-broadcast
// so no station-resolve fetch fires.
function everyMention(o: { title: string; article: string; author?: string }) {
  return {
    type: "Every Mention",
    providerType: "online_news",
    title: o.title,
    statusLine: "📰 480k Reach — 😐 Neutral Sentiment",
    source: "MPs",
    keywords: "MP",
    authorName: o.author ?? "The Australian",
    text: "Independent MP is calling on the government.",
    links: { article: o.article, source: "https://news.example.test/" },
  };
}

async function count(table: "stories" | "webhook_events"): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

const msg = (id: string): Message<string> =>
  ({ id: `m-${id}`, timestamp: new Date(RECEIVED_AT), body: id, attempts: 1, ack() {}, retry() {} }) as unknown as Message<string>;
const batch = (ids: string[]): MessageBatch<string> =>
  ({ queue: "headwater-ingest", messages: ids.map(msg), ackAll() {}, retryAll() {} }) as unknown as MessageBatch<string>;

describe("queue consumer — sequential ingestion (real D1 + mocked Slack)", () => {
  let calls: string[];

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM stories").run();
    await env.DB.prepare("DELETE FROM seen_mentions").run();
    await env.DB.prepare("DELETE FROM webhook_events").run();
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return Response.json({ ok: true, ts: "1783500000.000100" });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const postCount = () => calls.filter((u) => u.includes("chat.postMessage")).length;
  const updateCount = () => calls.filter((u) => u.includes("chat.update")).length;

  it("serializes a same-story burst into ONE card (the race the queue fixes)", async () => {
    const log = new EventLog(env.DB);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `burst${i}`;
      const payload = everyMention({ title: "One shared headline", article: `https://x.example/${i}`, author: `Outlet ${i}` });
      await log.append({ id, receivedAt: RECEIVED_AT + i, raw: JSON.stringify(payload), decision: "logged" });
      ids.push(id);
    }
    await worker.queue!(batch(ids), env, qctx());
    expect(await count("stories")).toBe(1); // one story, not six
    expect(postCount()).toBe(1); // one chat.postMessage
    expect(updateCount()).toBe(5); // the rest folded in via chat.update
  });

  it("delivers a single archived event (marks it posted) and acks a message whose row is gone", async () => {
    const log = new EventLog(env.DB);
    await log.append({ id: "solo", receivedAt: RECEIVED_AT, raw: JSON.stringify(everyMention({ title: "Solo", article: "https://x.example/solo" })), decision: "logged" });
    await worker.queue!(batch(["solo", "nope"]), env, qctx()); // "nope" has no archived row → acked, no throw
    expect(postCount()).toBe(1);
    const row = await env.DB.prepare("SELECT decision FROM webhook_events WHERE id='solo'").first<{ decision: string }>();
    expect(row!.decision).toBe("posted");
  });

  it("webhook handler archives then enqueues the archived id when INGEST_QUEUE is bound, returns 200", async () => {
    const sends: string[] = [];
    const qenv = {
      ...env,
      WEBHOOK_SHARED_SECRET: "hb-secret",
      INGEST_QUEUE: { send: async (id: string) => void sends.push(id) },
    } as unknown as typeof env;
    const req = new Request("http://local/webhooks/meltwater/hb-secret", {
      method: "POST",
      body: JSON.stringify(everyMention({ title: "In", article: "https://x.example/in" })),
    });
    const res = await worker.fetch!(req, qenv, qctx());
    expect(res.status).toBe(200);
    expect(await count("webhook_events")).toBe(1); // archived first
    expect(sends).toHaveLength(1); // then enqueued
    const row = await env.DB.prepare("SELECT id FROM webhook_events").first<{ id: string }>();
    expect(sends[0]).toBe(row!.id); // enqueued the archived event id
    expect(postCount()).toBe(0); // handler no longer posts inline (the consumer does)
  });
});
