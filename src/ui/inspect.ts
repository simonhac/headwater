import type { WebhookEventRecord } from "@/lib/store/eventLog";
import type { ProcessSummary, DocResult } from "@/lib/process";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function pretty(json: string | null): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

const BADGE: Record<string, string> = {
  posted: "#16794e",
  merged: "#1f6f8a",
  preview: "#8a6d00",
  dropped: "#8a1f1f",
  duplicate: "#555",
  logged: "#555",
  error: "#8a1f1f",
};

function badge(text: string): string {
  const color = BADGE[text] ?? "#555";
  return `<span class="badge" style="background:${color}">${esc(text)}</span>`;
}

function renderDocResult(r: DocResult): string {
  const bits = [
    badge(r.decision),
    r.source ? `<b>${esc(r.source)}</b>` : "",
    r.title ? esc(r.title) : "(no title)",
    r.brief ? `<span class="muted">· ${esc(r.brief)}</span>` : "",
    r.reason ? `<span class="reason">${esc(r.reason)}</span>` : "",
  ].filter(Boolean);
  const blocks = r.blocks
    ? `<details><summary>Attachment</summary><pre>${esc(JSON.stringify(r.blocks, null, 2))}</pre></details>`
    : "";
  return `<div class="doc">${bits.join(" ")}${blocks}</div>`;
}

function renderEvent(ev: WebhookEventRecord): string {
  let summary: ProcessSummary | null = null;
  try {
    summary = ev.parsed_json ? (JSON.parse(ev.parsed_json) as ProcessSummary) : null;
  } catch {
    summary = null;
  }
  const docs = summary?.results?.map(renderDocResult).join("") ?? '<div class="muted">not parsed yet</div>';
  const stat = summary
    ? `${summary.total} docs · ${summary.posted} posted · ${summary.dropped} dropped · ${summary.duplicates} dup`
    : "";
  return `
  <div class="event">
    <div class="ev-head">
      ${badge(ev.decision)}
      <span class="time">${esc(fmtTime(ev.received_at))}</span>
      ${ev.source ? `<b>${esc(ev.source)}</b>` : ""}
      <span class="muted">${esc(stat)}</span>
      ${ev.error ? `<span class="reason">${esc(ev.error)}</span>` : ""}
    </div>
    <div class="docs">${docs}</div>
    <details><summary>Raw payload</summary><pre>${esc(pretty(ev.raw_json))}</pre></details>
  </div>`;
}

export function renderInspectPage(events: WebhookEventRecord[], keyQS: string): string {
  const rows = events.length
    ? events.map(renderEvent).join("")
    : '<p class="muted">No webhook events yet. Point a Meltwater Generic Webhook at <code>/webhooks/meltwater/&lt;secret&gt;</code>.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meltwater feed — inspect</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 18px; }
  .event { border: 1px solid #8883; border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
  .ev-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .docs { margin: 8px 0; }
  .doc { padding: 6px 0; border-top: 1px solid #8882; }
  .badge { color: #fff; border-radius: 6px; padding: 1px 7px; font-size: 12px; font-weight: 600; }
  .muted { color: #8889; }
  .time { color: #8889; font-variant-numeric: tabular-nums; }
  .reason { color: #b05; font-size: 12px; }
  details { margin-top: 6px; }
  summary { cursor: pointer; color: #4581e6; font-size: 12px; }
  pre { background: #8881; padding: 10px; border-radius: 8px; overflow: auto; font-size: 12px; }
  a { color: #4581e6; }
</style></head><body>
<h1>Meltwater feed — recent webhook events</h1>
<p><a href="/inspect?${esc(keyQS)}">↻ refresh</a> · <a href="/api/webhooks/recent?${esc(keyQS)}">raw JSON</a></p>
${rows}
</body></html>`;
}
