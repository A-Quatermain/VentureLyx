/**
 * Venturelyx :: transactional email.
 *
 * One shared SMTP transport for account/billing mail (password reset,
 * verification, team invites, billing receipts, waitlist confirmation) —
 * deliberately separate from Grow's per-org mailbox pool
 * (lib/growTemplate.ts, worker/growWorker.ts). A marketing-campaign
 * deliverability problem (a bounce storm, a domain getting flagged) must
 * never take down password resets, so this sends from its own dedicated
 * address/domain, configured independently.
 *
 * Every call logs to email_log regardless of outcome — sendEmail() never
 * throws on an SMTP failure (a password-reset request must still return
 * its generic "if that email exists..." response even if the send itself
 * failed); callers that need to know get the return value's `ok` flag,
 * nobody is forced to catch.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { withPlatform, type Querier } from './db.js';
import { decryptSecret } from './auth.js';

// Env vars remain a working bootstrap fallback (so an existing
// docker-compose deploy keeps sending mail with no admin action needed),
// but db/migrations/026_smtp_admin_config.sql's platform_smtp_config table
// takes precedence the moment staff save anything through
// /admin/settings/smtp — see resolveTransport() below.
const ENV_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'no-reply@venturelyx.com';
const ENV_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Venturelyx';

interface ResolvedSmtp {
  transporter: Transporter | null;
  fromAddress: string;
  fromName: string;
}

// Cached briefly, not re-read on every send — this changes only when
// staff edit it through the admin UI, not per-request. invalidateSmtpCache()
// (called by the PUT /admin/settings/smtp route) clears it immediately so
// a saved change takes effect on the very next send, not after the TTL.
let cache: { resolved: ResolvedSmtp; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

export function invalidateSmtpCache(): void {
  cache = null;
}

async function resolveTransport(): Promise<ResolvedSmtp> {
  if (cache && cache.expiresAt > Date.now()) return cache.resolved;

  const row = await withPlatform((q) =>
    q.one<{
      host: string | null; port: number; username: string | null;
      from_address: string | null; from_name: string | null;
      credential_enc: Buffer | null; credential_iv: Buffer | null; credential_tag: Buffer | null;
    }>(`SELECT host, port, username, from_address, from_name, credential_enc, credential_iv, credential_tag
          FROM platform_smtp_config WHERE id = 1`),
  );

  let resolved: ResolvedSmtp;
  if (row?.host) {
    const password = row.credential_enc && row.credential_iv && row.credential_tag
      ? decryptSecret(row.credential_enc, row.credential_iv, row.credential_tag)
      : undefined;
    resolved = {
      transporter: nodemailer.createTransport({
        host: row.host, port: row.port, secure: row.port === 465,
        auth: row.username ? { user: row.username, pass: password } : undefined,
      }),
      fromAddress: row.from_address || ENV_FROM_ADDRESS,
      fromName: row.from_name || ENV_FROM_NAME,
    };
  } else if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT ?? 465);
    resolved = {
      transporter: nodemailer.createTransport({
        host: process.env.SMTP_HOST, port, secure: port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      }),
      fromAddress: ENV_FROM_ADDRESS,
      fromName: ENV_FROM_NAME,
    };
  } else {
    resolved = { transporter: null, fromAddress: ENV_FROM_ADDRESS, fromName: ENV_FROM_NAME };
  }

  cache = { resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  return resolved;
}

export type EmailTemplate =
  | 'password_reset' | 'email_verification' | 'org_invite'
  | 'billing_receipt' | 'billing_payment_failed' | 'waitlist_confirmation'
  | 'growth_scan_report' | 'payment_link' | 'onboarding_welcome' | 'smtp_test';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  template: EmailTemplate;
  userId?: string | null;
  orgId?: string | null;
}

export interface SendEmailResult {
  ok: boolean;
  error?: string;
}

/** withPlatform-style raw Querier is accepted, not fetched internally —
 *  callers already have one open (a webhook handler's withTenant, say) and
 *  this never opens a second, competing transaction of its own. */
export async function sendEmail(q: Querier, input: SendEmailInput): Promise<SendEmailResult> {
  const { transporter, fromAddress, fromName } = await resolveTransport();
  if (!transporter) {
    const error = 'SMTP is not configured — set it in Admin → Settings or via SMTP_HOST';
    await logEmail(q, input, 'failed', null, error);
    return { ok: false, error };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    await logEmail(q, input, 'sent', info.messageId || null, null);
    return { ok: true };
  } catch (err) {
    // Never the full error object or SMTP response into the log — those can
    // carry provider-side detail (sometimes including partial credential
    // echoes in auth failures), and this table is readable from the admin
    // console. message only.
    const error = err instanceof Error ? err.message : String(err);
    await logEmail(q, input, 'failed', null, error);
    return { ok: false, error };
  }
}

async function logEmail(
  q: Querier, input: SendEmailInput, status: 'sent' | 'failed',
  providerMessageId: string | null, error: string | null,
): Promise<void> {
  await q.exec(
    `INSERT INTO email_log (to_address, template, status, provider_message_id, error, user_id, org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.to, input.template, status, providerMessageId, error, input.userId ?? null, input.orgId ?? null],
  );
}
