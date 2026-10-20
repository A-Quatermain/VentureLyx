/**
 * Venturelyx :: Grow verify-on-import.
 *
 * Runs on every accepted row BEFORE enrollment (routes/grow.ts's
 * import/preview and import/commit), after growContactImport.ts's own
 * syntax/structural checks (toContact()'s EMAIL_RE) have already run.
 * Three layers, cheapest first:
 *
 *   1. Domain has an MX record at all (one DNS lookup per UNIQUE domain in
 *      the batch, not per row — a school's staff list shares one domain).
 *   2. Domain is a known disposable/junk provider (the disposable-email-
 *      domains package — a maintained list of ~120k domains, not something
 *      worth hand-curating here).
 *   3. If GROW_EMAIL_VERIFY_PROVIDER + GROW_EMAIL_VERIFY_API_KEY are both
 *      set, a real per-mailbox verdict from that provider — the only layer
 *      that can see a dead/disabled mailbox on an otherwise-healthy domain
 *      (an MX/disposable check alone can't). No key configured -> this
 *      layer is skipped entirely and the import proceeds on 1+2 alone;
 *      never fails an import just because verification isn't configured.
 *
 * Only ZeroBounce is actually wired up today. NeverBounce and Bouncer are
 * named in GROW_EMAIL_VERIFY_PROVIDER's type for forward-compatibility but
 * have no implementation yet — selecting either falls back to the same
 * "no provider" path (1+2 only) with a one-time warning log, rather than
 * silently pretending to call something that isn't there.
 *
 * verdict meanings (outcome routing lives in routes/grow.ts):
 *   invalid  — don't enroll; caller moves the row into its rejections list.
 *   risky    — enroll, but flagged (email_verify_verdict persisted).
 *   unknown  — enroll, flagged, same as risky — we just couldn't get a
 *              confident answer (DNS hiccup, provider timeout, provider
 *              genuinely unsure).
 *   valid    — enroll normally.
 *
 * A role address (admin@, office@, info@, ...) is a SEPARATE flag, not a
 * verdict — never excludes on its own (many school contacts are role
 * mailboxes), only surfaced for the UI to show.
 */
import { resolveMx } from 'node:dns/promises';
import { createRequire } from 'node:module';
import type { GrowContactRow, Rejection } from './growContactImport.js';

const require = createRequire(import.meta.url);
const DISPOSABLE_DOMAINS: string[] = require('disposable-email-domains');
const DISPOSABLE_SET = new Set(DISPOSABLE_DOMAINS.map((d) => d.toLowerCase()));

export type VerifyVerdict = 'valid' | 'risky' | 'unknown';

export interface VerifyOutcome {
  /** null means "excluded" — caller routes this to rejections, never inserts the row. */
  verdict: VerifyVerdict | null;
  reason: string | null;
  isRoleAddress: boolean;
}

// Common role/shared mailboxes, not a named individual. Matched against the
// local part only (before '@', and before a '+tag'), case-insensitively.
// Not exhaustive — false negatives here just mean a role address goes
// unflagged, which is harmless (it was never going to be excluded either way).
const ROLE_LOCAL_PARTS = new Set([
  'admin', 'administrator', 'office', 'info', 'team', 'contact', 'support',
  'sales', 'billing', 'help', 'webmaster', 'postmaster', 'abuse', 'noreply',
  'no-reply', 'hello', 'enquiries', 'inquiries', 'frontdesk', 'front-desk',
  'mail', 'hr', 'careers', 'press', 'media', 'marketing', 'accounts',
  'accounting', 'principal', 'superintendent', 'reception', 'general',
]);

export function isRoleAddress(email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase().split('+')[0] ?? '';
  return ROLE_LOCAL_PARTS.has(local);
}

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_SET.has(domain.toLowerCase());
}

/** null = lookup itself failed/timed out — treated as "can't tell," never
 *  as proof the domain is dead. A transient resolver hiccup must not
 *  exclude a real address. */
async function domainHasMx(domain: string): Promise<boolean | null> {
  try {
    const records = await resolveMx(domain);
    return records.length > 0;
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return false; // domain (or its MX) genuinely doesn't exist
    console.warn('MX lookup failed — treating as unknown, not invalid', { domain, err: code ?? String(err) });
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type EmailVerifyProvider = 'zerobounce' | 'neverbounce' | 'bouncer';

interface ProviderVerdict {
  verdict: VerifyVerdict | null;
  reason: string;
}

const ZEROBOUNCE_STATUS_MAP: Record<string, ProviderVerdict> = {
  valid: { verdict: 'valid', reason: 'provider:valid' },
  invalid: { verdict: null, reason: 'provider:invalid' },
  spamtrap: { verdict: null, reason: 'provider:spamtrap' },
  'catch-all': { verdict: 'unknown', reason: 'provider:catch_all' },
  unknown: { verdict: 'unknown', reason: 'provider:unknown' },
  abuse: { verdict: 'risky', reason: 'provider:abuse' },
  do_not_mail: { verdict: 'risky', reason: 'provider:do_not_mail' },
};

async function verifyWithZeroBounce(email: string, apiKey: string): Promise<ProviderVerdict | null> {
  try {
    const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      console.warn('ZeroBounce HTTP error — falling back to MX/disposable verdict', { email, status: res.status });
      return null;
    }
    const body = await res.json() as { status?: string };
    const mapped = body.status ? ZEROBOUNCE_STATUS_MAP[body.status] : undefined;
    if (!mapped) {
      console.warn('ZeroBounce returned an unrecognized status — treating as unknown', { email, status: body.status });
      return { verdict: 'unknown', reason: `provider:${body.status ?? 'unrecognized'}` };
    }
    return mapped;
  } catch (err) {
    console.warn('ZeroBounce call failed — falling back to MX/disposable verdict',
      { email, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

let warnedUnimplementedProvider = false;

async function verifyWithProvider(email: string): Promise<ProviderVerdict | null> {
  const provider = process.env.GROW_EMAIL_VERIFY_PROVIDER as EmailVerifyProvider | undefined;
  const apiKey = process.env.GROW_EMAIL_VERIFY_API_KEY;
  if (!provider || !apiKey) return null;

  if (provider === 'zerobounce') return verifyWithZeroBounce(email, apiKey);

  if (!warnedUnimplementedProvider) {
    warnedUnimplementedProvider = true;
    console.warn('GROW_EMAIL_VERIFY_PROVIDER names a provider with no implementation yet — ' +
      'falling back to syntax + MX + disposable only for this import (same as no key configured)', { provider });
  }
  return null;
}

export interface VerifyBatchRow {
  email: string;
  recipient_domain: string;
}

/** One pass over a whole import batch: MX lookups deduped per unique
 *  domain, provider calls (if configured) bounded to a modest concurrency
 *  so a multi-thousand-row file doesn't fire that many requests at once. */
export async function verifyBatch(rows: VerifyBatchRow[]): Promise<Map<string, VerifyOutcome>> {
  const uniqueDomains = [...new Set(rows.map((r) => r.recipient_domain.toLowerCase()))];
  const mxByDomain = new Map<string, boolean | null>();
  await mapWithConcurrency(uniqueDomains, 10, async (domain) => {
    mxByDomain.set(domain, isDisposableDomain(domain) ? false : await domainHasMx(domain));
  });

  const outcomes = new Map<string, VerifyOutcome>();
  await mapWithConcurrency(rows, 5, async (row) => {
    const email = row.email.toLowerCase();
    const domain = row.recipient_domain.toLowerCase();
    const roleAddress = isRoleAddress(row.email);

    if (isDisposableDomain(domain)) {
      outcomes.set(email, { verdict: null, reason: 'disposable_domain', isRoleAddress: roleAddress });
      return;
    }
    const hasMx = mxByDomain.get(domain);
    if (hasMx === false) {
      outcomes.set(email, { verdict: null, reason: 'no_mx_record', isRoleAddress: roleAddress });
      return;
    }

    const base: VerifyOutcome = hasMx === null
      ? { verdict: 'unknown', reason: 'mx_lookup_failed', isRoleAddress: roleAddress }
      : { verdict: 'valid', reason: null, isRoleAddress: roleAddress };

    // No point spending a provider credit on a domain we already can't
    // place any confidence in — only call out when MX genuinely resolved.
    if (hasMx === true) {
      const provider = await verifyWithProvider(row.email);
      if (provider) {
        outcomes.set(email, { verdict: provider.verdict, reason: provider.reason, isRoleAddress: roleAddress });
        return;
      }
    }
    outcomes.set(email, base);
  });

  return outcomes;
}

/** Applies verifyBatch() to an already-structurally-valid accepted list
 *  (growContactImport.ts's processRecords() output) and routes each row by
 *  its verdict: 'invalid' rows move into rejections (same Rejection shape
 *  every other rejection reason already uses, so the existing
 *  rejectionsByCode/download-the-list UI picks them up with no extra
 *  plumbing); everything else survives into the returned accepted list
 *  with its verdict/reason/role flag filled in, ready to insert.
 *
 *  acceptedLines is processRecords()'s own email->line map — needed here
 *  because a row moving from accepted into rejections this late no longer
 *  has its line number attached any other way. */
export async function applyEmailVerification(
  accepted: GrowContactRow[],
  rejections: Rejection[],
  acceptedLines: Map<string, number>,
): Promise<{ accepted: GrowContactRow[]; rejections: Rejection[] }> {
  if (accepted.length === 0) return { accepted, rejections };

  const outcomes = await verifyBatch(accepted.map((c) => ({ email: c.email, recipient_domain: c.recipient_domain })));

  const survivors: GrowContactRow[] = [];
  const allRejections = rejections.slice();

  for (const contact of accepted) {
    const outcome = outcomes.get(contact.email.toLowerCase());
    if (!outcome || outcome.verdict === null) {
      const reason = outcome?.reason ?? 'verification_failed';
      allRejections.push({
        line: acceptedLines.get(contact.email) ?? 0,
        email: contact.email,
        code: `email_invalid_${reason.replace(/:/g, '_')}`,
        detail: `verify-on-import: ${reason.replace(/[:_]/g, ' ')}`,
      });
      continue;
    }
    survivors.push({
      ...contact,
      email_verify_verdict: outcome.verdict,
      email_verify_reason: outcome.reason,
      is_role_address: outcome.isRoleAddress,
    });
  }

  return { accepted: survivors, rejections: allRejections };
}
