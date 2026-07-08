# "Added by MeltStreem" — where we're at

## Symptom

Every card in the Slack feed shows a small grey **"Added by MeltStreem"** footer beneath it.
Streem's equivalent cards do **not** have this. We want ours gone too.

## What it is

It is **not** something we write — we never emit that string ("MeltStreem" is just the app's
name). It's Slack's **automatic app-attribution label**, which Slack stamps on messages an app
posts using the legacy **`attachments`** field.

## Why we can't just remove it

The colored left bar (per–Organisation-Brief) **only exists on `attachments`** — Block Kit
top-level `blocks` have no color. So we post the card as an attachment, and that attachment is what
triggers the attribution.

Things we ruled out / confirmed empirically:

- **Not a channel-membership issue.** The `@meltstreem` bot *is* a member of the channel
  (`/invite` returns "already in this channel"). Apps posting to channels they haven't joined get
  "Added by" too, but that's not our case.
- **Not specific to blocks-in-attachment.** We rebuilt the card from Block-Kit-nested-in-attachment
  to a **classic attachment** (author_icon/author_name/title/fields/footer/color). The card looks
  much better — but "Added by MeltStreem" **still appears**. So it's the *attachment*, not the
  particular attachment style.

## The tradeoff

With our app, it's effectively **either/or**:

| Choice | Colored left bar | "Added by MeltStreem" |
|---|---|---|
| Post as `attachments` (current) | ✅ yes | ❌ shown |
| Post as top-level `blocks` | ❌ no | ✅ gone |

The reliable way to remove the label is to **drop the color bar** and post top-level Block Kit
blocks. No code-level trick was found to keep the bar *and* remove the label.

## The open question (Streem does both)

Streem clearly has a colored bar **and** no "Added by" — so there *is* a way. Our best hypothesis
is a **Slack app-level setting** (something in the app's configuration / distribution / approval
status) that suppresses attachment attribution, which we can't reach from the Worker code. This is
**unverified**. Worth a look in the Slack app admin settings, or a question to Slack support.

## Current decision

**Undecided — keeping the bar (and the label) for now.** The per-brief colors are valuable and the
label is small/grey. Revisit if/when we either:

1. find the app-level setting that hides attribution (keep bar, lose label — best outcome), or
2. decide the label is worse than the bar and switch to top-level blocks (lose bar, lose label).

No code change is pending; this file is the record of the investigation.
