import type { WebhookEventRecord } from "@/lib/store/eventLog";
import type { ProcessSummary, DocResult } from "@/lib/process";
import type { SlackAttachment } from "@/lib/slack/format";
import { INSPECT_CSS } from "./inspect.styles";
import { escHtml, renderCardBody, decisionPill } from "./card";

/** Paging context for the /inspect stream (computed by the route). */
export interface InspectPaging {
  /** The `?before` cursor this page was loaded with (null = latest page). */
  before: number | null;
  /** received_at to load the next older page, or null when there's no older page. */
  olderCursor: number | null;
  /** True when the `?filter=failed` view is active (errored / undelivered events only). */
  failedOnly?: boolean;
  /** Count of failed/undelivered events (last 7 days) — drives the header badge. */
  failedCount?: number;
}

function pretty(json: string | null): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

// Day label + wall-clock time in the feed's home timezone (matches format.ts HOME_FMT).
const DAY_FMT = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: "Australia/Sydney" });
const TIME_FMT = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Australia/Sydney" });

function dayLabel(ms: number): string {
  return DAY_FMT.format(new Date(ms));
}
function dividerText(ms: number, now: number): string {
  const label = dayLabel(ms);
  if (label === dayLabel(now)) return "Today";
  if (label === dayLabel(now - 86_400_000)) return "Yesterday";
  return label;
}
function fmtTime(ms: number): string {
  return Number.isFinite(ms) ? TIME_FMT.format(new Date(ms)) : String(ms);
}

function statLine(s: ProcessSummary): string {
  const failed = s.failed ? ` · ${s.failed} failed` : ""; // absent on pre-change summaries
  return `${s.total} docs · ${s.posted} posted · ${s.dropped} dropped · ${s.duplicates} dup · ${s.merged} merged${failed}`;
}

/** The inline debug panel (revealed on click): decision, brief, ts, time, stats, reason + raw. */
function dbgPanel(ev: WebhookEventRecord, summary: ProcessSummary | null, r: DocResult | null): string {
  const bits: string[] = [];
  if (r) bits.push(decisionPill(r.decision));
  else bits.push(decisionPill(ev.decision));
  if (r?.brief) bits.push(`<span>brief: ${escHtml(r.brief)}</span>`);
  if (r?.slackTs) bits.push(`<span>ts ${escHtml(r.slackTs)}</span>`);
  bits.push(`<span class="dbg-time">${escHtml(fmtTime(ev.received_at))}</span>`);
  if (summary) bits.push(`<span>${escHtml(statLine(summary))}</span>`);
  if (ev.error) bits.push(`<span class="dbg-reason">${escHtml(ev.error)}</span>`);
  const reason = r?.reason ? `<div class="dbg-reason">${escHtml(r.reason)}</div>` : "";
  return `<div class="dbg" hidden>
    <div class="dbg-meta">${bits.join("")}</div>
    ${reason}
    <details><summary>Raw payload</summary><pre>${escHtml(pretty(ev.raw_json))}</pre></details>
  </div>`;
}

function renderCard(ev: WebhookEventRecord, summary: ProcessSummary, r: DocResult): string {
  const att = r.blocks as SlackAttachment;
  const bar = escHtml(att.color || "#868e96");
  return `<article class="att" style="--bar:${bar}">${renderCardBody(att)}${dbgPanel(ev, summary, r)}</article>`;
}

function renderDroppedRow(ev: WebhookEventRecord, summary: ProcessSummary, r: DocResult): string {
  const outlet = r.source ? `<span class="drop-outlet">${escHtml(r.source)}</span>` : "";
  const title = `<span class="drop-title">${escHtml(r.title ?? "(no title)")}</span>`;
  const reason = r.reason ? `<span class="drop-reason">${escHtml(r.reason)}</span>` : "";
  return `<div class="drop-wrap"><div class="drop">${outlet}${title}${reason}</div>${dbgPanel(ev, summary, r)}</div>`;
}

/** A muted placeholder row for events with no renderable documents (unparsed / empty / error). */
function renderBareRow(ev: WebhookEventRecord, summary: ProcessSummary | null): string {
  const label = summary ? "no documents" : "unparsed event";
  const src = ev.source ? `<span class="drop-outlet">${escHtml(ev.source)}</span>` : "";
  const err = ev.error ? `<span class="drop-reason">${escHtml(ev.error)}</span>` : "";
  return `<div class="drop-wrap"><div class="drop">${src}<span class="drop-title">${label}</span>${err}</div>${dbgPanel(ev, summary, null)}</div>`;
}

function renderEvent(ev: WebhookEventRecord): string {
  let summary: ProcessSummary | null = null;
  try {
    summary = ev.parsed_json ? (JSON.parse(ev.parsed_json) as ProcessSummary) : null;
  } catch {
    summary = null;
  }
  if (!summary) return renderBareRow(ev, null);

  const kept = summary.results.filter((r) => r.blocks);
  const dropped = summary.results.filter((r) => !r.blocks);
  if (!kept.length && !dropped.length) return renderBareRow(ev, summary);

  const cards = kept.map((r) => renderCard(ev, summary!, r)).join("");
  const drops = dropped.map((r) => renderDroppedRow(ev, summary!, r)).join("");
  return cards + drops;
}

/** Insert day-divider rows between events whose day (Australia/Sydney) differs. */
function renderStream(ascending: WebhookEventRecord[], now: number): string {
  let out = "";
  let lastDay = "";
  for (const ev of ascending) {
    const day = dayLabel(ev.received_at);
    if (day !== lastDay) {
      out += `<div class="day"><span>${escHtml(dividerText(ev.received_at, now))}</span></div>`;
      lastDay = day;
    }
    out += renderEvent(ev);
  }
  return out;
}

/** Compose "/inspect?a&b" from non-empty query parts — clean (no stray "?&") when there are none.
 * `keyQS` is empty now that auth is Cloudflare Access (no ?key=), but stays threaded for local dev. */
function inspectHref(parts: string[]): string {
  const qs = parts.filter(Boolean).join("&amp;");
  return qs ? `/inspect?${qs}` : "/inspect";
}

function renderPager(keyQS: string, paging: InspectPaging): string {
  const base = [escHtml(keyQS), paging.failedOnly ? "filter=failed" : ""]; // keep the filter across pages
  const links: string[] = [];
  if (paging.olderCursor !== null) {
    links.push(`<a href="${inspectHref([...base, `before=${paging.olderCursor}`])}">⌃ Older messages</a>`);
  }
  if (paging.before !== null) {
    links.push(`<a href="${inspectHref(base)}">Latest ›</a>`);
  }
  return links.length ? `<div class="pager">${links.join("")}</div>` : "";
}

export function renderInspectPage(events: WebhookEventRecord[], keyQS: string, paging: InspectPaging): string {
  const now = Date.now();
  // `events` arrive newest-first; display oldest→newest (Slack-style, newest at the bottom).
  const ascending = [...events].reverse();
  const emptyMsg = paging.failedOnly
    ? `<p class="empty">No failed or undelivered events in view. 🎉</p>`
    : `<p class="empty">No webhook events yet. Point a Meltwater Generic Webhook at <code>/webhooks/meltwater/&lt;secret&gt;</code>.</p>`;
  const stream = events.length ? renderPager(keyQS, paging) + renderStream(ascending, now) : emptyMsg;
  // Auto-scroll to the newest card only on the latest page (not while paging through history).
  const autoscroll = paging.before === null && events.length > 0 && !paging.failedOnly ? "1" : "";
  const kq = escHtml(keyQS);
  const failedCount = paging.failedCount ?? 0;
  const filterNav = paging.failedOnly
    ? `<a href="${inspectHref([kq])}">‹ all messages</a> · `
    : failedCount > 0
      ? `<a class="failed-badge" href="${inspectHref([kq, "filter=failed"])}">⚠ ${failedCount} failed</a> · `
      : "";
  const refreshHref = inspectHref([kq, paging.failedOnly ? "filter=failed" : ""]);
  const rawHref = kq ? `/api/webhooks/recent?${kq}` : "/api/webhooks/recent";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Headwater — inspect</title>
<style>${INSPECT_CSS}</style></head><body>
<header class="topbar">
  <h1>Headwater — webhook feed</h1>
  <nav>${filterNav}<a href="${refreshHref}">↻ refresh</a> · <a href="/inspect/stations">stations</a> · <a href="${rawHref}">raw JSON</a></nav>
</header>
<main class="stream">${stream}</main>
<script>
(function(){
  document.addEventListener("click", function(e){
    if (e.target.closest("a")) return;      // let links navigate
    if (e.target.closest(".dbg")) return;   // don't collapse when using the debug panel
    var box = e.target.closest(".att, .drop-wrap");
    if (!box) return;
    var dbg = box.querySelector(".dbg");
    if (!dbg) return;
    dbg.hidden = !dbg.hidden;
    box.setAttribute("aria-expanded", String(!dbg.hidden));
  });
  if (${autoscroll ? "true" : "false"}) window.scrollTo(0, document.documentElement.scrollHeight);
})();
</script>
</body></html>`;
}
