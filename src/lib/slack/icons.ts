/** Slack has built-in :flag-au: style emoji for ISO country codes. */
export function countryFlagEmoji(code: string | null): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  return `:flag-${code.toLowerCase()}:`;
}

/** Per-masthead emoji overrides can be added here later (upload custom emoji, map by name). */
const SOURCE_EMOJI: Record<string, string> = {};

export function sourceIcon(sourceName: string | null, countryCode: string | null): string {
  if (sourceName) {
    const key = sourceName.toLowerCase();
    for (const [name, emoji] of Object.entries(SOURCE_EMOJI)) {
      if (key.includes(name)) return emoji;
    }
  }
  return countryFlagEmoji(countryCode) ?? ":newspaper:";
}
