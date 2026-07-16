import type { StationResolution } from "@/lib/meltwater/stations";
import type { RenderState } from "@/do/stationRenderer";
import { escHtml } from "./card";

// Wall-clock in the feed's home timezone (matches inspect.ts / format.ts HOME_FMT).
const FMT = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Australia/Sydney",
});
function fmt(ms: number | null): string {
  return ms != null && Number.isFinite(ms) ? FMT.format(new Date(ms)) : "";
}

const CSS = `
:root { color-scheme: light dark; --bg: #fafafa; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; background: var(--bg); }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; } }
/* Opaque backgrounds on the sticky rows so scrolling content never shows through them. */
.topbar { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; padding: 14px 20px; border-bottom: 1px solid #8884; position: sticky; top: 0; z-index: 2; background: var(--bg); }
.topbar h1 { font-size: 16px; margin: 0; }
.topbar nav { font-size: 13px; color: #8a8a8a; }
.topbar nav a { color: #3b82f6; text-decoration: none; }
.topbar nav a:hover { text-decoration: underline; }
main { padding: 12px 20px 48px; }
table { border-collapse: collapse; width: 100%; max-width: 1000px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 7px 12px; border-bottom: 1px solid #8882; }
th { position: sticky; top: 50px; z-index: 1; background: var(--bg); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #8a8a8a; cursor: default; box-shadow: inset 0 -1px 0 #8883; }
td.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a8a8a; }
td.name { font-weight: 600; }
td.num { text-align: right; }
tr.pending td.name { color: #b45309; font-weight: 500; }
.muted { color: #9a9a9a; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.pill.ok { background: #16a34a22; color: #16a34a; }
.pill.wait { background: #d9770622; color: #d97706; }
.stat { color: #8a8a8a; }
.renderer { padding: 8px 20px; font-size: 12.5px; color: #8a8a8a; border-bottom: 1px solid #8882; }
.renderer b { color: inherit; font-weight: 600; }
.warn { color: #d97706; font-weight: 600; }
.empty { padding: 32px; text-align: center; color: #9a9a9a; }
`;

function statusPill(r: StationResolution): string {
  return r.name ? `<span class="pill ok">resolved</span>` : `<span class="pill wait">pending</span>`;
}

/** "time of resolution" cell: a timestamp, "seeded" for the pre-timestamp hand-seeds, else blank. */
function resolvedCell(r: StationResolution): string {
  if (!r.name) return `<span class="muted">—</span>`;
  return r.resolved_at != null ? escHtml(fmt(r.resolved_at)) : `<span class="muted">seeded</span>`;
}

function row(r: StationResolution): string {
  const attempts = r.attempts == null ? `<span class="muted">—</span>` : String(r.attempts);
  const name = r.name ? escHtml(r.name) : `<span class="muted">unresolved</span>`;
  return `<tr class="${r.name ? "resolved" : "pending"}">
    <td>${statusPill(r)}</td>
    <td class="code">${escHtml(r.code)}</td>
    <td class="name">${name}</td>
    <td>${escHtml(fmt(r.first_sighting))}</td>
    <td>${resolvedCell(r)}</td>
    <td class="num">${attempts}</td>
    <td class="num">${r.sightings}</td>
  </tr>`;
}

/** Relative time label, e.g. "3m ago" / "in 12s" / "—". */
function rel(ms: number | null, now: number): string {
  if (ms == null) return "—";
  const d = ms - now;
  const a = Math.abs(d);
  const s = a < 60_000 ? `${Math.round(a / 1000)}s` : a < 3_600_000 ? `${Math.round(a / 60_000)}m` : `${(a / 3_600_000).toFixed(1)}h`;
  return d < 0 ? `${s} ago` : `in ${s}`;
}

/** One-line drainer status: queue depth, daily browser-time budget, last launch, next drain. */
function renderStatus(s: RenderState): string {
  const used = Math.round(s.budgetUsedMs / 1000);
  const cap = Math.round(s.budgetCapMs / 1000);
  const pct = s.budgetCapMs ? Math.round((100 * s.budgetUsedMs) / s.budgetCapMs) : 0;
  const budget = `<span${s.budgetUsedMs >= s.budgetCapMs ? ' class="warn"' : ""}>${used}s / ${cap}s today (${pct}%)</span>`;
  const maxed = s.queuedTotal - s.queued;
  const maxedBit = maxed > 0 ? ` <span class="warn">+${maxed} maxed-out</span>` : "";
  const drain = s.alarmAt == null ? "idle" : rel(s.alarmAt, s.now);
  const noBrowser = s.hasBrowser ? "" : ' · <span class="warn">no BROWSER binding</span>';
  const backoff = s.launchBlockedUntil
    ? ` · <span class="warn">rate-limited (${s.launchFailures}× launch fails) — retry ${rel(s.launchBlockedUntil, s.now)}</span>`
    : "";
  return `<div class="renderer"><b>renderer:</b> ${s.queued} queued${maxedBit} · browser ${budget} · last launch ${rel(s.lastLaunchAt, s.now)} · next drain ${drain}${backoff}${noBrowser}</div>`;
}

/** Station-resolution status table — one row per broadcast code we've seen, oldest first. */
export function renderStationsPage(rows: StationResolution[], state: RenderState | null = null): string {
  const resolved = rows.filter((r) => r.name).length;
  const pending = rows.length - resolved;
  const body = rows.length
    ? rows.map(row).join("")
    : `<tr><td colspan="7" class="empty">No broadcast station codes seen yet.</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Headwater — station resolution</title>
<style>${CSS}</style></head><body>
<header class="topbar">
  <h1>Headwater — broadcast station resolution</h1>
  <nav><span class="stat">${rows.length} codes · ${resolved} resolved · ${pending} pending</span> · <a href="/inspect/stations">↻ refresh</a> · <a href="/inspect">‹ inspect</a></nav>
</header>
${state ? renderStatus(state) : ""}
<main>
<table>
  <thead><tr>
    <th>Status</th><th>Code</th><th>Resolved name</th><th>First sighting</th><th>Resolved</th><th>Attempts</th><th>Sightings</th>
  </tr></thead>
  <tbody>${body}</tbody>
</table>
</main>
</body></html>`;
}
