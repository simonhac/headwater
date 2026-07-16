import { DurableObject } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "@/env";
import { renderTitleOnPage, stationNameFromTitle } from "@/lib/meltwater/station-resolve";
import { stationNameForCode, upsertStationName } from "@/lib/meltwater/stations";

// --- free-tier Browser Rendering guards (see README / plan) ---
/** At most one NEW browser instance per 20s on the free plan. We reuse one browser per drain, so
 * this only spaces consecutive drains that each have to launch fresh. */
const MIN_LAUNCH_SPACING_MS = 20_000;
/** 10 min/day browser time on the free plan — stop a margin under it and resume the next UTC day. */
const DAILY_BUDGET_MS = 9 * 60 * 1000;
/** Give up on a code after this many failed render attempts (a permanently-broken viewer). Low so a
 * broken viewer can't burn the daily budget retrying — 3 x ~a-few-seconds, not 5 x 45s. */
const MAX_ATTEMPTS = 3;
/** Codes rendered per drain pass, so one alarm invocation stays well within Worker limits. */
const PER_DRAIN_MAX = 25;
/** When work remains after a pass, re-arm the alarm this far out (also covers launch spacing). */
const RESUME_DELAY_MS = 20_000;
/** Exponential backoff after a `puppeteer.launch` failure (Cloudflare 429 "Rate limit exceeded"):
 * a HARD floor, so poke/enqueue can't pull the alarm earlier and re-hammer the rate limit. */
const LAUNCH_BACKOFF_BASE_MS = 60_000; // 1 min after the first failure
const LAUNCH_BACKOFF_MAX_MS = 20 * 60_000; // capped at 20 min (rate limits clear within minutes; a daily cap by next UTC day)
const DAY_MS = 86_400_000;

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;

interface QueueRow {
  code: string;
  viewer_url: string;
  attempts: number;
}

interface Budget {
  day: number;
  usedMs: number;
}

/** Live drainer state, surfaced on /inspect/stations so a stall is visible (budget vs backoff vs queue). */
export interface RenderState {
  queued: number; // rows still eligible to render (attempts < MAX_ATTEMPTS)
  queuedTotal: number; // all render_queue rows (incl. maxed-out, permanently-failed)
  budgetUsedMs: number; // browser time used so far today
  budgetCapMs: number; // the daily guard (< Cloudflare's 10 min/day)
  lastLaunchAt: number | null; // last browser launch attempt (epoch ms)
  launchBlockedUntil: number | null; // in launch backoff until this epoch ms (Cloudflare 429), else null
  launchFailures: number; // consecutive launch failures
  alarmAt: number | null; // next scheduled drain (epoch ms), or null when idle
  hasBrowser: boolean; // whether the BROWSER binding is present
  now: number; // server time, so the UI can render "ago"/"in"
}

/**
 * Serial broadcast-station renderer — the ONLY place a browser is launched. A single account-wide
 * instance (see {@link client}) is single-threaded, so bursts of ingest enqueues collapse into ONE
 * warm, serial drain instead of dozens of concurrent `puppeteer.launch()` calls that the free tier's
 * "1 new browser / 20s" limit would reject (→ 0% success in production before this). The queue lives
 * in D1 (`render_queue`, deduped by code); coordination state (last launch, daily budget, launch
 * backoff) lives in DO storage. Ingestion posts the safety-net card immediately and this fills in the
 * real station later, which the hourly redecode then upgrades onto the posted card.
 */
export class StationRenderer extends DurableObject<Env> {
  /** In-isolate reentrancy guard for {@link drain} (alarms never overlap, but this is belt-and-braces). */
  private draining = false;

  /** Queue a code for rendering (idempotent) and ensure the drainer will run. */
  async enqueue(code: string, viewerUrl: string): Promise<void> {
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO render_queue (code, viewer_url, attempts, enqueued_at) VALUES (?, ?, 0, ?)",
    )
      .bind(code, viewerUrl, Date.now())
      .run();
    await this.ensureAlarm(Date.now());
  }

  /** Kick the drainer to service any backlog (cron backstop). */
  async poke(): Promise<void> {
    if ((await this.pending()) > 0) await this.ensureAlarm(Date.now());
  }

  /** Live drainer state for the status page. */
  async state(): Promise<RenderState> {
    const now = Date.now();
    const day = Math.floor(now / DAY_MS);
    const b = (await this.ctx.storage.get<Budget>("budget")) ?? { day, usedMs: 0 };
    const total = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM render_queue").first<{ n: number }>();
    const blocked = (await this.ctx.storage.get<number>("launchBlockedUntil")) ?? 0;
    return {
      queued: await this.pending(),
      queuedTotal: total?.n ?? 0,
      budgetUsedMs: b.day === day ? b.usedMs : 0,
      budgetCapMs: DAILY_BUDGET_MS,
      lastLaunchAt: (await this.ctx.storage.get<number>("lastLaunchAt")) ?? null,
      launchBlockedUntil: blocked > now ? blocked : null,
      launchFailures: (await this.ctx.storage.get<number>("launchFailures")) ?? 0,
      alarmAt: await this.ctx.storage.getAlarm(),
      hasBrowser: !!this.env.BROWSER,
      now,
    };
  }

  /** Arm the alarm for `at` (never sooner than launch spacing). Moves an existing LATER alarm earlier
   * so a new enqueue can't be stuck behind a "resume tomorrow" (budget-deferred) alarm. */
  private async ensureAlarm(at: number): Promise<void> {
    const lastLaunch = (await this.ctx.storage.get<number>("lastLaunchAt")) ?? 0;
    const desired = Math.max(at, lastLaunch + MIN_LAUNCH_SPACING_MS);
    const cur = await this.ctx.storage.getAlarm();
    if (cur != null && cur <= desired) return; // an equal-or-earlier alarm already covers this
    await this.ctx.storage.setAlarm(desired);
  }

  async alarm(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    let next: number | null = null;
    try {
      next = await this.drain(); // epoch ms to resume, or null to go idle
    } catch (e) {
      console.error(`[station-render] drain failed: ${String(e)}`);
      next = Date.now() + RESUME_DELAY_MS;
    } finally {
      this.draining = false;
    }
    if (next != null) await this.ensureAlarm(next);
  }

  private async pending(): Promise<number> {
    const row = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM render_queue WHERE attempts < ?")
      .bind(MAX_ATTEMPTS)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * One drain pass: reuse a single browser across every queued code, then disconnect. Returns the
   * epoch ms at which to run the NEXT pass, or null when there's nothing more to do (empty queue, or
   * no Browser Rendering binding — so we never busy-loop re-arming when we can't make progress).
   */
  private async drain(): Promise<number | null> {
    if (!this.env.BROWSER) return null; // no binding (tests) → idle, don't re-arm
    if ((await this.budgetRemainingMs()) <= 0) {
      console.warn(`[station-render] daily browser budget spent (${DAILY_BUDGET_MS}ms) — deferring to next UTC day`);
      return nextUtcDay();
    }

    const items = (
      await this.env.DB.prepare(
        "SELECT code, viewer_url, attempts FROM render_queue WHERE attempts < ? ORDER BY enqueued_at LIMIT ?",
      )
        .bind(MAX_ATTEMPTS, PER_DRAIN_MAX)
        .all<QueueRow>()
    ).results;
    if (!items.length) return null;

    const acq = await this.acquireBrowser();
    if ("defer" in acq) return Date.now() + acq.defer; // launch spacing or rate-limit backoff
    const browser = acq.browser;

    const start = Date.now();
    let ok = 0;
    let failed = 0;
    let sibling = 0;
    try {
      const page = await browser.newPage();
      for (const it of items) {
        if ((await this.budgetRemainingMs()) <= 0) break;
        // A station-labelled sibling (authorName-trust) may have named this code since it was queued.
        if (await stationNameForCode(this.env.DB, it.code)) {
          await this.del(it.code);
          sibling++;
          continue;
        }
        const title = await renderTitleOnPage(page, it.viewer_url).catch(() => null);
        const name = stationNameFromTitle(title);
        if (name) {
          await upsertStationName(this.env.DB, it.code, name, Date.now(), it.attempts + 1); // count this attempt
          await this.del(it.code);
          ok++;
        } else {
          await this.bump(it.code);
          failed++;
        }
      }
      await page.close().catch(() => {});
    } finally {
      // close() (not disconnect()) — a disconnected browser keeps idling for up to 60s and ALL of that
      // time is billed against the 10-min/day quota, which is exactly what tipped us over into 429s.
      await browser.close().catch(() => {});
      await this.addBudget(Date.now() - start);
    }
    console.log(
      `[station-render] drain: ${ok} named, ${failed} failed, ${sibling} sibling-named in ${Date.now() - start}ms; budget left ${Math.round((await this.budgetRemainingMs()) / 1000)}s`,
    );

    if ((await this.pending()) === 0) return null; // queue drained → go idle
    if ((await this.budgetRemainingMs()) <= 0) return nextUtcDay(); // spent the budget → resume tomorrow
    return Date.now() + RESUME_DELAY_MS; // more codes remain → come back soon
  }

  /**
   * Get a browser to render with: launch one, respecting the ≥20s launch spacing AND an exponential
   * backoff after a Cloudflare 429 ("Rate limit exceeded" — typically the 10-min/day quota). Returns
   * the browser, or `{defer}` = ms to wait before the next attempt (so we never hammer the limit). We
   * launch fresh each drain (and close() at the end) rather than reuse a disconnected session, because
   * a lingering session bills idle time against the daily quota.
   */
  private async acquireBrowser(): Promise<{ browser: Browser } | { defer: number }> {
    const br = this.env.BROWSER!;
    const now = Date.now();

    // Hard backoff floor: don't even attempt a launch while rate-limited (poke/enqueue can't override).
    const blockedUntil = (await this.ctx.storage.get<number>("launchBlockedUntil")) ?? 0;
    if (now < blockedUntil) return { defer: blockedUntil - now };

    const lastLaunch = (await this.ctx.storage.get<number>("lastLaunchAt")) ?? 0;
    const spacing = lastLaunch + MIN_LAUNCH_SPACING_MS - now;
    if (spacing > 0) return { defer: spacing }; // respect 1-new-browser/20s

    try {
      const browser = await puppeteer.launch(br);
      await this.ctx.storage.put("lastLaunchAt", Date.now());
      await this.ctx.storage.put("launchFailures", 0);
      await this.ctx.storage.put("launchBlockedUntil", 0);
      return { browser };
    } catch (e) {
      const fails = ((await this.ctx.storage.get<number>("launchFailures")) ?? 0) + 1;
      const backoff = Math.min(LAUNCH_BACKOFF_BASE_MS * 2 ** (fails - 1), LAUNCH_BACKOFF_MAX_MS);
      await this.ctx.storage.put("launchFailures", fails);
      await this.ctx.storage.put("lastLaunchAt", Date.now()); // the failed attempt still counts for spacing
      await this.ctx.storage.put("launchBlockedUntil", Date.now() + backoff);
      console.warn(
        `[station-render] puppeteer.launch failed (${fails}x): ${String(e)} — backing off ${Math.round(backoff / 1000)}s`,
      );
      return { defer: backoff };
    }
  }

  private async del(code: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM render_queue WHERE code = ?").bind(code).run();
  }

  private async bump(code: string): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE render_queue SET attempts = attempts + 1, last_attempt_at = ? WHERE code = ?",
    )
      .bind(Date.now(), code)
      .run();
  }

  // --- daily browser-time budget, reset per UTC day ---
  private async budgetRemainingMs(): Promise<number> {
    const day = Math.floor(Date.now() / DAY_MS);
    const b = (await this.ctx.storage.get<Budget>("budget")) ?? { day, usedMs: 0 };
    const usedMs = b.day === day ? b.usedMs : 0;
    return DAILY_BUDGET_MS - usedMs;
  }

  private async addBudget(ms: number): Promise<void> {
    const day = Math.floor(Date.now() / DAY_MS);
    const b = (await this.ctx.storage.get<Budget>("budget")) ?? { day, usedMs: 0 };
    const usedMs = (b.day === day ? b.usedMs : 0) + Math.max(0, ms);
    await this.ctx.storage.put("budget", { day, usedMs });
  }
}

/** Epoch ms at the start of the next UTC day — when the daily browser-time budget resets. */
function nextUtcDay(): number {
  return (Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS;
}
