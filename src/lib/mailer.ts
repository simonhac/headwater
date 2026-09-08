import type { Env } from "@/env";

/**
 * Resend mail client.
 *
 * Chosen over Cloudflare Email Sending because Email Sending requires the Workers Paid plan **on the
 * account that owns the sending domain**, which is not necessarily the account running this Worker —
 * so it can mean a second subscription purely to send mail. Resend was already in use with the
 * sending domain verified (DKIM, a bounce subdomain, and SPF), so this route needed no new DNS.
 *
 * Everything here is behind `sendEmail(cfg, msg)`; swapping providers again means editing this file
 * only. The digest, renderer and scheduling know nothing about who delivers the mail.
 */

const API_URL = "https://api.resend.com/emails";
/** Only transient statuses are worth retrying; a 401/422 will never succeed on a retry. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BACKOFF_MS = [500, 2000, 5000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface MailerConfig {
  apiKey: string;
  fromAddress: string;
  fromName: string;
  replyTo?: string;
}

export interface MailResult {
  ok: boolean;
  /** Resend's message id, for correlating with its dashboard. */
  id?: string;
  error?: string;
}

/**
 * Read the mailer config out of the env. Returns a string naming what's missing rather than throwing,
 * so callers (and /health) can report "not configured yet" without a 500.
 */
export function mailerConfig(env: Env): MailerConfig | { error: string } {
  const missing: string[] = [];
  if (!env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!env.DIGEST_FROM) missing.push("DIGEST_FROM");
  if (missing.length) return { error: `missing: ${missing.join(", ")}` };

  return {
    apiKey: env.RESEND_API_KEY!,
    fromAddress: env.DIGEST_FROM!,
    fromName: env.DIGEST_FROM_NAME ?? "Headwater",
    replyTo: env.DIGEST_REPLY_TO,
  };
}

/**
 * Resend wants the From header as a single string. A display name containing a comma or quote would
 * break the header, so it's quoted-escaped rather than interpolated raw.
 */
export function formatFrom(name: string, address: string): string {
  if (!name) return address;
  const safe = name.replace(/[\\"]/g, "\\$&");
  return `"${safe}" <${address}>`;
}

export interface OutboundEmail {
  /** Recipients (one per digest subscriber; the list comes from D1, not env). */
  to: string[];
  subject: string;
  html: string;
  text: string;
  /**
   * Passed to Resend as `Idempotency-Key`. A second send with the same key inside 24h is a no-op,
   * which backstops the `ops_state` day marker: even if the marker write fails after a successful
   * send, the retry cannot deliver a duplicate.
   */
  idempotencyKey?: string;
}

/** Send one email. Retries only transient failures; anything else returns Resend's own message. */
export async function sendEmail(cfg: MailerConfig, msg: OutboundEmail): Promise<MailResult> {
  const body = {
    from: formatFrom(cfg.fromName, cfg.fromAddress),
    to: msg.to,
    ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    subject: msg.subject,
    html: msg.html,
    // Always send a text/plain part: some clients show only text, and its absence worsens spam scoring.
    text: msg.text,
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.apiKey}`,
  };
  if (msg.idempotencyKey) headers["Idempotency-Key"] = msg.idempotencyKey.slice(0, 256);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      if (attempt >= MAX_RETRIES) return { ok: false, error: `network: ${String(e)}` };
      await sleep(BACKOFF_MS[attempt] ?? 5000);
      continue;
    }

    if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
      await sleep(BACKOFF_MS[attempt] ?? 5000);
      continue;
    }

    const data = (await res.json().catch(() => null)) as
      | { id?: string; message?: string; name?: string; statusCode?: number }
      | null;

    if (!res.ok) {
      // Resend errors look like { statusCode, message, name }.
      return { ok: false, error: data?.message ? `${data.name ?? "error"}: ${data.message}` : `http_${res.status}` };
    }
    if (!data?.id) return { ok: false, error: "no message id in response" };

    return { ok: true, id: data.id };
  }
}
