import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "@/index";

// The media-type footer icons are served by a PUBLIC route (Slack's image proxy fetches them
// unauthenticated for the attachment `footer_icon`), so no Cloudflare Access header is passed here —
// a 200 confirms the route is NOT behind the Access gate.
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;
const get = (path: string) => worker.fetch(new Request(`https://worker.test${path}`), env, ctx());

describe("GET /icons/media/v1/:name (public media-type footer icons)", () => {
  it("serves a PNG with an immutable long cache, un-gated", async () => {
    const res = await get("/icons/media/v1/tv.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number \x89PNG
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves every media-type slug", async () => {
    for (const slug of ["tv", "radio", "newspaper", "globe", "message-circle"]) {
      const res = await get(`/icons/media/v1/${slug}.png`);
      expect(res.status, slug).toBe(200);
      expect(res.headers.get("content-type"), slug).toBe("image/png");
    }
  });

  it("404s an unknown icon name", async () => {
    const res = await get("/icons/media/v1/nope.png");
    expect(res.status).toBe(404);
  });
});
