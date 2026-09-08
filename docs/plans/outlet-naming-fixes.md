# Handoff — outlet naming: slug-derived mastheads, byline-as-outlet, redirect-host outlets

## Goal / definition of done

Slack cards name their publisher correctly. Concretely:

1. `SBS`, `MSN`, `The Canberra Times` etc. instead of `Sbs`, `Msn`, `Canberratimes`.
2. A card never headlines a *person* (or a CMS login name) as the outlet — `Admin`, `Chris`.
3. Existing cards in the 30-day window are corrected in place via `POST /admin/redecode`,
   whose `changes[]` (`from` → `to`) is the verification that it worked.

Done = the highest-volume offenders below are mapped, `npm test` passes, deployed, and a
`redecode` dry run shows the expected `from → to` pairs and nothing unexpected.

## Background: why the names are wrong

Meltwater's "Every Mention" payload has a single name field, `authorName`. It is the OUTLET for
some content (radio, local papers) and the JOURNALIST for wire/syndicated content. The code
recovers the real masthead from the publisher domain. The decision is
`src/lib/meltwater/parse.ts:226-238` — read that block first, it explains itself:

```ts
const keepAuthor = authorIsOutlet(rawAuthor, publisherHost) || !looksLikePerson(rawAuthor);
outlet = mastheadForDomain(publisherHost) ?? (keepAuthor ? null : deriveOutletName(publisherHost));
const sourceName = outlet ?? rawAuthor;
```

Three separate defects fall out of it:

**(A) Slug-derived mastheads.** `authorName` is a byline, the domain is NOT in
`MASTHEAD_BY_DOMAIN` (`src/lib/meltwater/outlets.ts:11`, 43 entries), so the fallback
`deriveOutletName` (`outlets.ts:119`) manufactures a name from the domain: lowercase the host,
strip the public suffix, title-case the registrable label. `sbs.com.au` → `Sbs`, `msn.com` →
`Msn`, `northerndailyleader.com.au` → `Northerndailyleader`.

**(B) Byline-as-outlet.** `looksLikePerson` (`outlets.ts:76`) requires 2–3 capitalised words, so a
one-word `authorName` fails it → `keepAuthor` is true → `outlet` stays null → `sourceName` falls
back to `authorName`. That is how `Admin` (ozarab.media) and `Chris` (footyheadlines.com) end up
headlining cards as if they were mastheads.

**(C) Meltwater redirect host.** Some mentions never expose a real publisher host — `links.source`
resolves to `transition.meltwater.com`, so there is no domain to map.

## Decisions already made

- **(A) must be fixed with map entries, not a smarter fallback.** Nothing distinguishes `msn`
  (an initialism) from `inkl` (a genuinely lowercase brand); any capitalisation heuristic would
  break names that are currently correct. Do NOT try to be clever in `deriveOutletName`.
- **Work in two passes.** Add the ~20 highest-volume / best-known mastheads first, verify on live
  cards, then work down the long tail. Don't land 117 entries in one unreviewed commit.
- **Mind the map's stated contract.** Its doc comment (`outlets.ts:1-9`) says domains are listed
  *only* when `authorName` was observed to be a byline; domains whose `authorName` is already the
  masthead are deliberately absent. Adding a domain forces the mapped name to win over
  `authorName` for that domain — correct for (A), but check you are not overriding a domain that
  was intentionally left out.
- **Keys are bare registrable hosts, no `www.`** — `hostnameOf` (`outlets.ts:86`) strips it.
  `mastheadForDomain` also matches any subdomain, so `sbs.com.au` covers `www.sbs.com.au`.

## Pointers

- Branch `simonhac/vic-election-slack-fanout` (this work is unrelated to that branch's fanout
  feature; consider branching fresh from `main` if the fanout PR has merged).
- `src/lib/meltwater/outlets.ts` — the map (`:11`), `looksLikePerson` (`:76`),
  `mastheadForDomain` (`:96`), `deriveOutletName` (`:119`).
- `src/lib/meltwater/parse.ts:210-240` — `everyMentionToMention`, where outlet vs byline is decided.
- `test/parse.test.ts` — existing outlet/masthead cases; add to these.
- `src/lib/redecode.ts` — reparses each story's embedded `raw` under the CURRENT parser, so map
  changes propagate to already-posted cards. Note it rewrites `primary_mention_json` ONLY.
- `src/lib/snippets.ts` (`repairSnippets`) — the precedent to copy if `outlets_json` also needs
  rewriting: same cap-and-rerun shape, but it does map over `outlets_json` (`:56`), which
  `redecode` does not.
- `README.md` and `docs/duplicate-detection.md` — update if outlet identity semantics change.

## The offenders (production, 90 days, as of 2026-09-08)

117 distinct slug-derived outlet names across 230 cards. Regenerate the full list with:

```sql
SELECT json_extract(primary_mention_json,'$.sourceName') AS outlet,
       json_extract(primary_mention_json,'$.outletUrl')  AS ourl,
       count(*) n
FROM stories WHERE created_at > (unixepoch()-90*86400)*1000
GROUP BY outlet ORDER BY n DESC;
```

then keep rows matching `^[A-Z][a-z0-9]+$` (the shape `deriveOutletName` emits for a
single-label domain). Run it with
`npx wrangler d1 execute headwater --remote --json --command "..."`.

Highest-volume first (count, current wrong name, host, suggested):

| n | now | host | should be |
|---|---|---|---|
| 9 | `Capitalbrief` | capitalbrief.com | Capital Brief |
| 9 | `Activenetworks` | activenetworks.com.au | *verify the real masthead* |
| 8 | `Yahoo` | au.news.yahoo.com | Yahoo News |
| 6 | `Sbs` | sbs.com.au | SBS |
| 6 | `Bordermail` | bordermail.com.au | The Border Mail |
| 5 | `Ntnews` | ntnews.com.au | NT News |
| 5 | `Croakey` | croakey.org | Croakey Health Media |
| 4 | `Msn` | msn.com | MSN |
| 4 | `Medicalrepublic` | medicalrepublic.com.au | The Medical Republic |
| 4 | `Citynews` | citynews.com.au | CityNews |
| 3 | `Thesaturdaypaper` | thesaturdaypaper.com.au | The Saturday Paper |
| 3 | `Canberratimes` | canberratimes.com.au | The Canberra Times |
| 3 | `Thedailyaus` | thedailyaus.com.au | The Daily Aus |
| 3 | `Aph` | aph.gov.au | Parliament of Australia |
| 2 | `Northerndailyleader` | northerndailyleader.com.au | The Northern Daily Leader |
| 2 | `Illawarramercury` | illawarramercury.com.au | Illawarra Mercury |

Verify each masthead's actual styling before adding it — several above are educated guesses
from the domain, which is exactly the failure mode being fixed.

Class (B), needing a different fix: `Admin` ← ozarab.media, `Chris` ← footyheadlines.com.
Class (C): `Ultra106five` ← transition.meltwater.com — **verify before touching**; the station
really is branded "Ultra106five", so this may be correct already and only matched the
detection regex by coincidence.

## Transient state not in the repo

- Migrations `0010` and `0011` are **already applied to remote D1**; `main`'s deployed build
  marker is `headwater-25`. Do not re-run migrations.
- `REPLAY_KEY` for `/admin/*` lives in 1Password: `op://headwater-prod/env/REPLAY_KEY`.
  **Explain what you need and get explicit consent before invoking `op`** (global rule).
- A 15-minute reconcile cron re-drives the last 72h through the pipeline and is seen-aware. It
  will NOT re-post existing cards, but it does mean parser changes reach recent events on their
  own. Deploy before concluding a change had no effect.
- `POST /admin/redecode?hours=720&dryRun=1` was run on 2026-09-08 for an unrelated snippet fix:
  802 scanned, 25 changed. So a `redecode` at that window is known to be quick and low-churn —
  a much larger `changed` count after a map change means the change is broader than intended.
- One `webhook_events` row has malformed `raw_json` (1 of ~2450). Any
  `json_extract(raw_json, …)` over the whole table needs a `json_valid(raw_json)=1` guard in a
  **materialised CTE** — a plain `WHERE` still errors with `malformed JSON: SQLITE_ERROR 7500`.

## Next actions

1. Read `parse.ts:210-240` and `outlets.ts` end to end; confirm the (A)/(B)/(C) split above
   still matches the code.
2. Regenerate the offender list from production (query above) — the counts here are a snapshot.
3. Pass one: add the ~20 verified mastheads to `MASTHEAD_BY_DOMAIN`, with a test per tricky case
   (initialisms, `The …` prefixes, subdomain matching such as `au.news.yahoo.com`).
4. `npm run typecheck && npm test`, deploy, then `POST /admin/redecode?hours=720&dryRun=1` and
   read `changes[]` before running it for real.
5. Only then design (B): decide whether to widen `looksLikePerson`, add a "not a masthead"
   deny-list (`admin`, `editor`, `staff`, `newsroom`, …), or require a mapped masthead before a
   one-word `authorName` may headline a card. Discuss before implementing — it changes what
   every card claims its source is.

## Out of scope / guardrails

- Do NOT add capitalisation heuristics to `deriveOutletName` (see Decisions).
- Do NOT run `/admin/orphans` to tidy anything — it deletes every card lacking a story row.
  Test cards have their own cleanup: `POST /admin/test-post?cleanup=1`.
- Do NOT run `/admin/replay` with `reset=1` or `purge=1`; both are destructive and unnecessary
  here. `redecode` updates cards in place and preserves reactions/threads.
- Don't commit, or suggest committing, until the user asks.
- House rules in `CLAUDE.md`/`AGENTS.md` apply: `npm run typecheck && npm test` before commit,
  `npm run deploy` (never bare `pnpm deploy`), no `timeout` CLI on macOS.
