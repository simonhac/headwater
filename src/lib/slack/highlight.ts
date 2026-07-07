/** Slack mrkdwn requires these three chars escaped everywhere (incl. inside code). */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Truncate on a word boundary with an ellipsis (Streem-style tight snippet). */
export function truncate(s: string, max = 300): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Snap back to the last word boundary unless that would discard too much.
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Wrap each keyword occurrence in backticks so Slack renders it as a grey
 * monospace pill — Streem's highlight style. Longest-first (so multi-word
 * keywords win), case-insensitive, word-boundaried, no double-wrapping.
 */
export function highlightKeywordsAsCode(text: string, keywords: string[]): string {
  const esc = escapeMrkdwn(text);
  const terms = [...new Set(keywords.filter(Boolean))].sort((a, b) => b.length - a.length).map(escapeRegex);
  if (!terms.length) return esc;
  const re = new RegExp("(?<![\\w`])(" + terms.join("|") + ")(?![\\w`])", "gi");
  return esc.replace(re, (m) => "`" + m + "`");
}

/** "Mentions: `renewable (3)`, `Ross Garnaut (1)`" — counts over the full text. */
export function buildMentionsLine(text: string, keywords: string[]): string | null {
  const counts: { kw: string; n: number }[] = [];
  for (const kw of [...new Set(keywords.filter(Boolean))]) {
    const re = new RegExp("(?<![\\w])" + escapeRegex(kw) + "(?![\\w])", "gi");
    const n = (text.match(re) ?? []).length;
    if (n > 0) counts.push({ kw, n });
  }
  if (!counts.length) return null;
  counts.sort((a, b) => b.n - a.n);
  return "Mentions: " + counts.map((c) => "`" + escapeMrkdwn(c.kw) + " (" + c.n + ")`").join(", ");
}

/** Does the text contain any of the keywords (word-boundaried, case-insensitive)? */
export function hasAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => new RegExp("(?<![\\w])" + escapeRegex(kw) + "(?![\\w])", "i").test(text));
}
