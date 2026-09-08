/**
 * `/inspect/routing` — the brief → Slack channel matrix. Rows are briefs (from `feed.config.ts`,
 * plus the synthesized "unmatched" brief), columns are the channels the bot is a member of, and the
 * ticks are stored in D1 (`ops_state.routing`) so routing changes need no redeploy.
 *
 * An all-unticked row falls back to `SLACK_DEFAULT_CHANNEL`, which is what every brief did before
 * fanout existed — so an empty table reproduces the old behaviour exactly.
 */
import type { BriefRule } from "@/config/feed.config";
import type { SlackChannel } from "@/lib/slack/channels";
import { isMuted, type Routing } from "@/lib/routing";
import { escHtml } from "./card";

// Wall-clock in the feed's home timezone (matches stations.ts / inspect.ts / format.ts).
const FMT = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Australia/Sydney",
});

const CSS = `
:root { color-scheme: light dark; --bg: #fafafa; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; background: var(--bg); }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; } }
.topbar { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; padding: 14px 20px; border-bottom: 1px solid #8884; position: sticky; top: 0; z-index: 2; background: var(--bg); }
.topbar h1 { font-size: 16px; margin: 0; }
.topbar nav { font-size: 13px; color: #8a8a8a; }
.topbar nav a { color: #3b82f6; text-decoration: none; }
.topbar nav a:hover { text-decoration: underline; }
main { padding: 12px 20px 48px; }
table { border-collapse: collapse; max-width: 1000px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #8882; }
th { background: var(--bg); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #8a8a8a; }
th.ch { text-align: center; vertical-align: top; white-space: nowrap; text-transform: none; font-size: 12.5px; letter-spacing: 0; color: inherit; }
th.ch .tag { display: block; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; color: #8a8a8a; font-weight: 600; }
td.pick { text-align: center; }
td.pick input { width: 16px; height: 16px; cursor: pointer; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; vertical-align: baseline; }
.brief { font-weight: 600; }
.muted { color: #9a9a9a; font-weight: 400; font-size: 12.5px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.actions { margin: 20px 0 8px; display: flex; align-items: center; gap: 14px; }
button { font: inherit; font-weight: 600; padding: 7px 18px; border-radius: 6px; border: 1px solid #3b82f6; background: #3b82f6; color: #fff; cursor: pointer; }
button:hover { background: #2563eb; }
.flash { padding: 8px 20px; font-size: 13px; background: #16a34a1a; color: #15803d; border-bottom: 1px solid #8882; }
.error { padding: 10px 20px; font-size: 13px; background: #dc26261a; color: #b91c1c; border-bottom: 1px solid #8882; }
.hint { max-width: 1000px; margin-top: 18px; font-size: 12.5px; color: #8a8a8a; }
.empty { padding: 32px; text-align: center; color: #9a9a9a; }
.muted-row { color: #b91c1c; font-weight: 600; font-size: 12.5px; }
@media (prefers-color-scheme: dark) { .muted-row { color: #f87171; } }
td.pick input.implied { accent-color: #9a9a9a; }
`;

/** The synthesized brief `resolveBrief` returns for mentions no `matchNames`/keyword rule claims. */
const UNMATCHED_ROW: BriefRule = { id: "default", label: "Unmatched (default brief)", keywords: [] };

export interface RoutingPageProps {
  /** Briefs from `feed.config.ts`, in config order (which is also `resolveBrief` precedence order). */
  briefs: BriefRule[];
  channels: SlackChannel[];
  routing: Routing;
  defaultChannel: string;
  /** Success banner after a save. */
  flash?: string;
  /** Blocking problem (e.g. Slack `missing_scope`) shown instead of an empty table. */
  error?: string;
  /** One-line "what Slack actually returned" note, so an empty picker is diagnosable in place. */
  diagnostic?: string;
}

function briefCell(b: BriefRule, muted: boolean): string {
  const swatch = b.color ? `<span class="swatch" style="background:${escHtml(b.color)}"></span>` : "";
  const names = (b.matchNames ?? []).map((n) => escHtml(n)).join(", ");
  const matches = names ? `<div class="muted mono">${names}</div>` : "";
  // A muted brief is the one state you can reach by accident, so call it out rather than leaving
  // an empty row to be read as "not configured yet".
  const warn = muted ? `<div class="muted-row">⚠ not posted anywhere</div>` : "";
  return `<td>${swatch}<span class="brief">${escHtml(b.label)}</span>${matches}${warn}</td>`;
}

function row(b: BriefRule, channels: SlackChannel[], routing: Routing, defaultChannel: string): string {
  const configured = routing.briefs[b.id];
  // An unconfigured brief posts to the default channel, so SHOW that: tick the default column.
  // Ticks then mean exactly one thing everywhere on the page — "this channel receives this brief".
  const on = new Set(configured ?? [defaultChannel]);
  const implied = configured === undefined;
  const picks = channels
    .map((c) => {
      const checked = on.has(c.id);
      // The implied default tick is greyed: it's the current state, but it was inherited rather
      // than chosen, and saving the form makes it explicit.
      const cls = checked && implied ? ' class="implied"' : "";
      return `<td class="pick"><input type="checkbox"${cls} name="r.${escHtml(b.id)}" value="${escHtml(c.id)}"${checked ? " checked" : ""} aria-label="${escHtml(b.label)} → ${escHtml(c.name)}"></td>`;
    })
    .join("");
  return `<tr>${briefCell(b, isMuted(b.id, routing))}${picks}</tr>`;
}

export function renderRoutingPage(p: RoutingPageProps): string {
  const rows = [...p.briefs, UNMATCHED_ROW];
  const head = p.channels
    .map(
      (c) =>
        `<th class="ch">${c.isPrivate ? "🔒 " : ""}#${escHtml(c.name)}${c.id === p.defaultChannel ? `<span class="tag">default</span>` : ""}</th>`,
    )
    .join("");
  const defaultName = p.channels.find((c) => c.id === p.defaultChannel)?.name;
  const defaultLabel = defaultName ? `#${defaultName}` : "the default channel";
  const body = p.channels.length
    ? rows.map((b) => row(b, p.channels, p.routing, p.defaultChannel)).join("")
    : `<tr><td class="empty">No channels found — the bot isn't a member of any channel yet.</td></tr>`;
  const saved = p.routing.updatedAt ? `Saved ${escHtml(FMT.format(new Date(p.routing.updatedAt)))}` : "Never saved";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Headwater — routing</title>
<style>${CSS}</style></head><body>
<header class="topbar">
  <h1>Headwater — brief routing</h1>
  <nav><a href="/inspect/routing">↻ refresh</a> · <a href="/inspect/stations">stations</a> · <a href="/inspect">‹ inspect</a></nav>
</header>
${p.flash ? `<div class="flash">${escHtml(p.flash)}</div>` : ""}
${p.error ? `<div class="error">${escHtml(p.error)}</div>` : ""}
<main>
<form method="post" action="/inspect/routing">
<table>
  <thead><tr><th>Organisation Brief</th>${head}</tr></thead>
  <tbody>${body}</tbody>
</table>
<div class="actions"><button type="submit">Save routing</button><span class="muted">${saved}</span></div>
</form>
<p class="hint">A tick means that channel receives that brief — that's the whole rule. Greyed ticks are
briefs that have never been routed: they post to ${escHtml(defaultLabel)} by default, and saving makes
that explicit. Untick every box in a row and the brief posts <strong>nowhere</strong>. The same headline
routed to two channels is two separate cards — they never fold into one.</p>
<p class="hint">Don't see a channel? <span class="mono">/invite @headwater</span> in it, then ↻ refresh.</p>
${p.diagnostic ? `<p class="hint mono">${escHtml(p.diagnostic)}</p>` : ""}
</main>
</body></html>`;
}
