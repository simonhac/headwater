/**
 * Stylesheet for the /inspect page — a light+dark Slack-channel replica.
 *
 * The `.sr-*` rules are lifted verbatim from mrtippy's Slack renderer
 * (`packages/slack-gallery/src/styles.css` in the mrtippy repo) so the excerpt
 * pills, links, field columns and footer match the real Slack channel. mrtippy
 * renders Block-Kit user messages and is light-only; we render classic Slack
 * *attachments*, so the `.att-*` rules add what mrtippy lacks — the coloured
 * left bar (per Organisation Brief), a compact inline logo/masthead header, a
 * day divider, the click-to-expand debug panel, paging controls and a dark
 * theme. Colours are driven through custom properties so dark mode is a token
 * swap. If you re-sync from mrtippy, keep the `.sr-*` block in step.
 */
export const INSPECT_CSS = `
:root {
  color-scheme: light dark;
  --page-bg: #f8f8f8;
  --surface: #ffffff;
  --text: #1d1c1d;
  --muted: #616061;
  --link: #1264a3;
  --hair: rgba(29, 28, 29, 0.13);
  --hair-soft: rgba(29, 28, 29, 0.08);
  --divider-line: #d1d5db;
  --divider-text: #374151;
  --code-bg: rgba(29, 28, 29, 0.04);
  --code-border: rgba(29, 28, 29, 0.13);
  --code-fg: rgb(192, 19, 67);
  --crimson: #e01e5a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page-bg: #1a1d21;
    --surface: #222529;
    --text: #d1d2d3;
    --muted: #ababad;
    --link: #1d9bd1;
    --hair: rgba(255, 255, 255, 0.13);
    --hair-soft: rgba(255, 255, 255, 0.08);
    --divider-line: rgba(255, 255, 255, 0.16);
    --divider-text: #ababad;
    --code-bg: rgba(255, 255, 255, 0.06);
    --code-border: rgba(255, 255, 255, 0.14);
    --code-fg: #e8916b;
    --crimson: #e01e5a;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page-bg);
  color: var(--text);
  font: 15px/1.46668 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* top bar */
.topbar {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--surface);
  border-bottom: 1px solid var(--hair);
  padding: 12px 20px;
  display: flex;
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
}
.topbar h1 { font-size: 15px; font-weight: 900; margin: 0; }
.topbar nav { font-size: 13px; color: var(--muted); }
.topbar a { color: var(--link); text-decoration: none; }
.topbar a:hover { text-decoration: underline; }
.topbar a.failed-badge {
  color: #fff;
  background: var(--crimson);
  border-radius: 9999px;
  padding: 1px 9px;
  font-weight: 700;
  font-size: 12px;
}
.topbar a.failed-badge:hover { text-decoration: none; opacity: 0.9; }

.stream { max-width: 780px; margin: 0 auto; padding: 8px 20px 72px; }

/* paging controls */
.pager {
  display: flex;
  justify-content: center;
  gap: 20px;
  padding: 14px 0;
  font-size: 13px;
}
.pager a { color: var(--link); text-decoration: none; font-weight: 600; }
.pager a:hover { text-decoration: underline; }

/* day divider (ported from mrtippy web/components/date-divider.tsx) */
.day {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0 8px;
  position: sticky;
  top: 44px;
  z-index: 3;
}
.day::before, .day::after {
  content: "";
  flex: 1;
  border-top: 1px solid var(--divider-line);
}
.day span {
  font-size: 12px;
  font-weight: 600;
  color: var(--divider-text);
  background: var(--page-bg);
  border: 1px solid var(--divider-line);
  border-radius: 9999px;
  padding: 4px 12px;
  white-space: nowrap;
}

/* ── Slack renderer (sr-*), copied verbatim from mrtippy ── */
.sr-section-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 16px;
}
.sr-section-field { min-width: 0; }
.sr-context {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 4px 0;
}
.sr-context-item {
  font-size: 13px;
  color: var(--muted);
  line-height: 18px;
}
.sr-inline-code {
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 3px;
  padding: 2px 3px 1px;
  font-size: 12px;
  font-family: "Monaco", "Menlo", "Consolas", monospace;
  color: var(--code-fg);
  white-space: pre-wrap;
  line-height: 18px;
}
.sr-link { color: var(--link); text-decoration: none; }
.sr-link:hover { text-decoration: underline; }

/* ── classic-attachment frame (our own; mrtippy has no attachment renderer) ── */
.att {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--hair-soft);
  border-radius: 8px;
  margin: 6px 0;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.02);
}
.att-main {
  padding: 10px 14px 12px 18px;
  cursor: pointer;
}
.att-main::before {
  content: "";
  position: absolute;
  left: 6px;
  top: 8px;
  bottom: 8px;
  width: 4px;
  border-radius: 8px;
  background: var(--bar, #868e96);
}
.att-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}
.att-logo {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  object-fit: cover;
  flex: 0 0 auto;
}
.att-masthead { font-weight: 700; font-size: 15px; color: var(--text); }
.att-title {
  display: block;
  font-weight: 700;
  font-size: 15px;
  margin: 2px 0 4px;
  overflow-wrap: anywhere;
}
.att-title.att-title--plain { color: var(--text); cursor: text; }
.att-text {
  font-size: 15px;
  color: var(--text);
  margin: 2px 0 8px;
  overflow-wrap: anywhere;
}
.sr-section-fields { margin: 6px 0 8px; }
.att-field-label {
  font-weight: 700;
  font-size: 12px;
  color: var(--text);
  margin-bottom: 1px;
}
.att-field-value { font-size: 13px; color: var(--text); overflow-wrap: anywhere; }
.att-footer { margin-top: 6px; overflow-wrap: anywhere; }

/* compact dropped row */
.drop {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--muted);
  padding: 4px 14px 4px 18px;
  cursor: pointer;
}
.drop-outlet { font-weight: 700; color: var(--text); opacity: 0.7; }
.drop-title { color: var(--muted); }
.drop-reason { color: var(--crimson); font-size: 12px; }

/* inline debug panel (revealed on click) */
.dbg {
  border-top: 1px dashed var(--hair);
  padding: 8px 14px 10px 18px;
  font-size: 12px;
  color: var(--muted);
}
.dbg[hidden] { display: none; }
.dbg .dbg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.deco-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  color: #fff;
  letter-spacing: 0.02em;
  text-transform: lowercase;
}
.dbg-time { font-variant-numeric: tabular-nums; }
.dbg-reason { color: var(--crimson); }
.dbg details { margin-top: 6px; }
.dbg summary {
  cursor: pointer;
  color: var(--muted);
  list-style: none;
}
.dbg summary::-webkit-details-marker { display: none; }
.dbg summary::before { content: "\\25B8 "; }
.dbg details[open] summary::before { content: "\\25BE "; }
.dbg pre {
  background: var(--code-bg);
  border: 1px solid var(--hair-soft);
  border-radius: 6px;
  padding: 10px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.4;
  font-family: "Monaco", "Menlo", "Consolas", monospace;
  color: var(--text);
}

.empty { max-width: 780px; margin: 40px auto; color: var(--muted); padding: 0 20px; }
.empty code {
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 3px;
  padding: 1px 4px;
}
`;
