/**
 * Venturelyx :: Grow worker.
 *
 * The piece routes/grow.ts's own header comment said was "not built here":
 * this is what actually plans, claims, and sends grow_messages. Runs as its
 * own container (infra/docker-compose.workers.yml, service grow-worker),
 * same image as the api service, different command — see the Dockerfile
 * and compose file for how it's deployed.
 *
 * Two independent loops in one process, mirroring the standalone CampusPath
 * engine's split of tick.js (planning) from sender.js (sending) at
 * /opt/outreach/src, just combined here rather than run as separate
 * systemd services:
 *
 *   planning pass  — every PLANNER_INTERVAL_MS, calls growScheduler.ts's
 *                    planTick() for every org's every running campaign.
 *   sending pass   — every SENDER_POLL_MS, calls claimDue() for every org
 *                    with at least one grow_mailbox, sends what it claims.
 *
 * Deliberately NOT built here: the standalone engine's poller.js (IMAP
 * reply/bounce classification). Without it, grow_messages.status can reach
 * 'sent' or 'failed' (this worker sets both, from the synchronous SMTP
 * result) but never 'bounced', and grow_events never gets a 'complaint' or
 * 'reply' row — so growScheduler.ts's circuitBreaker() has no bounce/
 * complaint data to act on, and a gated enrollment only ever clears by its
 * gate-root finishing its sequence (state='completed'), never early via a
 * detected reply. That's a real gap for a campaign sending at volume over
 * time, not something this build silently papered over — flagging it here
 * for whoever scopes the poller next.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import pino from 'pino';
import { withPlatform, withTenant } from '../lib/db.js';
import { decryptSecret } from '../lib/auth.js';
import {
  GROW_BASE_URL, GROW_BASE_URL_USABLE, getSenderProfile, hasUnrenderedPlaceholder,
  firstUnrenderedPlaceholder, renderUnsubscribeFooter,
} from '../lib/growTemplate.js';
import { claimDue, planTick } from '../lib/growScheduler.js';
import type { Querier } from '../lib/db.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

for (const key of ['DATABASE_URL', 'VAULT_KEY']) {
  if (!process.env[key]) {
    log.fatal(`FATAL: ${key} is not set`);
    process.exit(1);
  }
}
if ((process.env.VAULT_KEY ?? '').length !== 64) {
  log.fatal('FATAL: VAULT_KEY must be 64 hex characters (32 bytes)');
  process.exit(1);
}
if (!GROW_BASE_URL_USABLE) {
  log.fatal(`FATAL: GROW_BASE_URL is "${GROW_BASE_URL}" — set it to this deployment's real public URL. ` +
    'Every unsubscribe link would otherwise be unreachable, which CAN-SPAM does not allow shipping.');
  process.exit(1);
}

const PLANNER_INTERVAL_MS = Number(process.env.GROW_PLANNER_INTERVAL_MS ?? 5 * 60_000);
const SENDER_POLL_MS = Number(process.env.GROW_SENDER_POLL_MS ?? 20_000);
const SENDER_BATCH_SIZE = Number(process.env.GROW_SENDER_BATCH_SIZE ?? 5);
const MAX_ATTEMPTS = 3;

async function orgIdsWithRunningCampaigns(): Promise<string[]> {
  const rows = await withPlatform((q) =>
    q.rows<{ org_id: string }>(`SELECT DISTINCT org_id FROM grow_campaigns WHERE status = 'running'`),
  );
  return rows.map((r) => r.org_id);
}

async function orgIdsWithMailboxes(): Promise<string[]> {
  const rows = await withPlatform((q) =>
    q.rows<{ org_id: string }>(`SELECT DISTINCT org_id FROM grow_mailboxes`),
  );
  return rows.map((r) => r.org_id);
}

async function runPlanningPass(): Promise<void> {
  for (const orgId of await orgIdsWithRunningCampaigns()) {
    await withTenant({ orgId, userId: null, isStaff: false }, async (q) => {
      const campaigns = await q.rows<{ id: string; name: string }>(
        `SELECT id, name FROM grow_campaigns WHERE status = 'running'`,
      );
      for (const campaign of campaigns) {
        try {
          const result = await planTick(q, campaign.id);
          if (result.queued > 0 || result.paused) {
            log.info({ orgId, campaign: campaign.name, ...result }, 'planTick');
          }
        } catch (err) {
          log.error({ err, orgId, campaign: campaign.name }, 'planTick failed');
        }
      }
    });
  }
}

interface ClaimedMessage {
  id: string; org_id: string; campaign_id: string; contact_id: string; mailbox_id: string;
  subject: string; body: string; recipient_domain: string; unsubscribe_token: string;
  attempts: number; smtp_message_id: string | null;
}

interface Mailbox {
  id: string; address: string; from_name: string; reply_to: string | null;
  smtp_host: string; smtp_port: number; username: string; integration_id: string;
}

const transporters = new Map<string, Transporter>();

async function transporterFor(q: Querier, mailboxId: string): Promise<{ transporter: Transporter; mailbox: Mailbox }> {
  const mailbox = await q.one<Mailbox>(
    `SELECT id, address, from_name, reply_to, smtp_host, smtp_port, username, integration_id
       FROM grow_mailboxes WHERE id = $1`,
    [mailboxId],
  );
  if (!mailbox) throw new Error(`mailbox ${mailboxId} not found`);

  const cached = transporters.get(mailboxId);
  if (cached) return { transporter: cached, mailbox };

  const cred = await q.one<{ credential_enc: Buffer; credential_iv: Buffer; credential_tag: Buffer }>(
    `SELECT credential_enc, credential_iv, credential_tag FROM integrations WHERE id = $1`,
    [mailbox.integration_id],
  );
  if (!cred?.credential_enc) throw new Error(`no stored credential for mailbox ${mailbox.address}`);
  const password = decryptSecret(cred.credential_enc, cred.credential_iv, cred.credential_tag);

  const transporter = nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_port === 465,
    auth: { user: mailbox.username, pass: password },
  });
  transporters.set(mailboxId, transporter);
  return { transporter, mailbox };
}

function isPermanentSmtpError(err: unknown): boolean {
  const code = (err as { responseCode?: number } | undefined)?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

async function sendOne(q: Querier, message: ClaimedMessage): Promise<void> {
  // Re-checked here, same as sender.js and the /contacts/:id/preview route:
  // a message can go stale between being queued and being claimed (the
  // contact unsubscribed, or was suppressed for some other reason, in the
  // minutes between).
  const contact = await q.one<{ email: string }>(`SELECT email FROM grow_contacts WHERE id = $1`, [message.contact_id]);
  if (!contact) {
    await q.exec(`UPDATE grow_messages SET status = 'cancelled', error = 'contact deleted' WHERE id = $1`, [message.id]);
    return;
  }
  const suppressed = await q.one(`SELECT 1 FROM grow_suppressions WHERE email = $1`, [contact.email]);
  if (suppressed) {
    await q.exec(`UPDATE grow_messages SET status = 'cancelled' WHERE id = $1`, [message.id]);
    log.info({ messageId: message.id }, 'cancelled: contact suppressed since queueing');
    return;
  }

  const senderProfile = await getSenderProfile(q);
  const unsubscribeUrl = `${GROW_BASE_URL}/u/${message.unsubscribe_token}`;
  const body = renderUnsubscribeFooter(message.body, {
    mailingAddress: senderProfile.mailing_address ?? '',
    unsubscribeUrl,
  });

  if (hasUnrenderedPlaceholder(message.subject) || hasUnrenderedPlaceholder(body)) {
    const placeholder = firstUnrenderedPlaceholder(hasUnrenderedPlaceholder(message.subject) ? message.subject : body);
    await q.exec(
      `UPDATE grow_messages SET status = 'failed', error = $2 WHERE id = $1`,
      [message.id, `refused to send: unrendered placeholder ${placeholder}`],
    );
    log.error({ messageId: message.id, placeholder }, 'refused to send: unrendered template placeholder');
    return;
  }

  let mailbox: Mailbox;
  let transporter: Transporter;
  try {
    ({ mailbox, transporter } = await transporterFor(q, message.mailbox_id));
  } catch (err) {
    await q.exec(
      `UPDATE grow_messages SET status = 'failed', error = $2 WHERE id = $1`,
      [message.id, err instanceof Error ? err.message : String(err)],
    );
    log.error({ err, messageId: message.id }, 'no usable mailbox credential');
    return;
  }

  try {
    const info = await transporter.sendMail({
      from: `"${mailbox.from_name}" <${mailbox.address}>`,
      replyTo: mailbox.reply_to || undefined,
      to: contact.email,
      subject: message.subject,
      text: body,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    await q.exec(
      `UPDATE grow_messages SET status = 'sent', sent_at = now(), smtp_message_id = $2, error = NULL WHERE id = $1`,
      [message.id, info.messageId || null],
    );
    await q.exec(
      `INSERT INTO grow_events (org_id, message_id, contact_id, type, payload)
       VALUES (app.current_org(), $1, $2, 'sent', $3)`,
      [message.id, message.contact_id,
        JSON.stringify({ mailbox: mailbox.address, smtp_message_id: info.messageId || null })],
    );
    log.info({ messageId: message.id, to: contact.email }, 'sent');
  } catch (err) {
    const permanent = isPermanentSmtpError(err);
    const attempts = message.attempts; // already incremented by claimDue()
    const errMessage = err instanceof Error ? err.message : String(err);

    if (permanent || attempts >= MAX_ATTEMPTS) {
      await q.exec(`UPDATE grow_messages SET status = 'failed', error = $2 WHERE id = $1`, [message.id, errMessage]);
      log.warn({ messageId: message.id, err: errMessage, attempts, permanent }, 'failed');
    } else {
      const backoffMinutes = 5 * 2 ** (attempts - 1);
      await q.exec(
        `UPDATE grow_messages SET status = 'queued', scheduled_at = now() + ($2 || ' minutes')::interval, error = $3
          WHERE id = $1`,
        [message.id, String(backoffMinutes), errMessage],
      );
      log.warn({ messageId: message.id, err: errMessage, attempts, backoffMinutes }, 'requeued');
    }
  }
}

async function runSendingPass(): Promise<void> {
  for (const orgId of await orgIdsWithMailboxes()) {
    await withTenant({ orgId, userId: null, isStaff: false }, async (q) => {
      const claimed = await claimDue<ClaimedMessage>(q, SENDER_BATCH_SIZE);
      for (const message of claimed) {
        try {
          await sendOne(q, message);
        } catch (err) {
          log.error({ err, messageId: message.id, orgId }, 'sendOne crashed');
        }
      }
    });
  }
}

let planning = false;
let sending = false;

async function tickPlanner(): Promise<void> {
  if (planning) return;
  planning = true;
  try { await runPlanningPass(); } catch (err) { log.error({ err }, 'planning pass failed'); }
  finally { planning = false; }
}

async function tickSender(): Promise<void> {
  if (sending) return;
  sending = true;
  try { await runSendingPass(); } catch (err) { log.error({ err }, 'sending pass failed'); }
  finally { sending = false; }
}

async function main(): Promise<void> {
  log.info({ PLANNER_INTERVAL_MS, SENDER_POLL_MS, SENDER_BATCH_SIZE, GROW_BASE_URL }, 'grow-worker starting');

  await tickPlanner();
  await tickSender();

  const plannerTimer = setInterval(tickPlanner, PLANNER_INTERVAL_MS);
  const senderTimer = setInterval(tickSender, SENDER_POLL_MS);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down');
    clearInterval(plannerTimer);
    clearInterval(senderTimer);
    for (const t of transporters.values()) t.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  log.fatal({ err }, 'grow-worker crashed at startup');
  process.exit(1);
});
