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
import type { Querier } from './db.js';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'no-reply@venturelyx.com';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Venturelyx';

const transporter = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
    })
  : null;

export type EmailTemplate =
  | 'password_reset' | 'email_verification' | 'org_invite'
  | 'billing_receipt' | 'billing_payment_failed' | 'waitlist_confirmation';

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
  if (!transporter) {
    const error = 'SMTP_HOST is not configured';
    await logEmail(q, input, 'failed', null, error);
    return { ok: false, error };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_ADDRESS}>`,
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
