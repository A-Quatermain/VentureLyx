/**
 * Venturelyx :: Grow worker.
 *
 * The piece routes/grow.ts's own header comment said was "not built here":
 * this is what actually plans, claims, and sends grow_messages. Runs as its
 * own container (infra/docker-compose.workers.yml, service grow-worker),
 * same image as the api service, different command — see the Dockerfile
 * and compose file for how it's deployed.
 *
 * Three independent loops in one process, mirroring the standalone
 * CampusPath engine's split of tick.js (planning) from sender.js (sending)
 * at /opt/outreach/src, just combined here rather than run as separate
 * systemd services:
 *
 *   planning pass  — every PLANNER_INTERVAL_MS, calls growScheduler.ts's
 *                    planTick() for every org's every running campaign.
 *   sending pass   — every SENDER_POLL_MS, calls claimDue() for every org
 *                    with at least one grow_mailbox, sends what it claims.
 *   polling pass   — every POLLER_INTERVAL_MS, the IMAP reply/bounce
 *                    classification this file's own header used to call
 *                    "deliberately NOT built here" (growPoller.ts) — now
 *                    built, and wired straight into growScheduler.ts's
 *                    existing bounce/complaint/reply handling and
 *                    growPromote.ts's Operate CRM bridge.
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
import { pollMailbox, matchGrowMessage, type MailboxCreds } from '../lib/growPoller.js';
import { promoteOnReply } from '../lib/growPromote.js';
import { classifyReply } from '../lib/growClassify.js';
import { wrapClickableLinks } from '../lib/growClickTracking.js';
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
const POLLER_INTERVAL_MS = Number(process.env.GROW_POLLER_INTERVAL_MS ?? 2 * 60_000);
const MAX_ATTEMPTS = 3;

// (o.modules->>'grow')::boolean IS DISTINCT FROM false — lib/moduleAccess.ts's
// same "missing key defaults to enabled, only an explicit false disables"
// rule, expressed in SQL: a NULL (key absent) or true both count as
// enabled, only a literal false excludes the org. This worker runs
// entirely outside the HTTP API (withTenant/withPlatform straight against
// Postgres), so moduleWriteGate's preHandler never sees these writes —
// without this, toggling Grow off in the admin console would stop new API
// calls but not the already-running planner/sender loops from continuing
// to queue and send real mail for that org.
const GROW_ENABLED = `(o.modules->>'grow')::boolean IS DISTINCT FROM false`;

async function orgIdsWithRunningCampaigns(): Promise<string[]> {
  const rows = await withPlatform((q) =>
    q.rows<{ org_id: string }>(
      `SELECT DISTINCT gc.org_id
         FROM grow_campaigns gc
         JOIN organizations o ON o.id = gc.org_id
        WHERE gc.status = 'running' AND ${GROW_ENABLED}`,
    ),
  );
  return rows.map((r) => r.org_id);
}

async function orgIdsWithMailboxes(): Promise<string[]> {
  const rows = await withPlatform((q) =>
    q.rows<{ org_id: string }>(
      `SELECT DISTINCT gm.org_id
         FROM grow_mailboxes gm
         JOIN organizations o ON o.id = gm.org_id
        WHERE ${GROW_ENABLED}`,
    ),
  );
  return rows.map((r) => r.org_id);
}

async function orgIdsWithImapMailboxes(): Promise<string[]> {
  const rows = await withPlatform((q) =>
    q.rows<{ org_id: string }>(
      `SELECT DISTINCT gm.org_id
         FROM grow_mailboxes gm
         JOIN organizations o ON o.id = gm.org_id
        WHERE gm.imap_host IS NOT NULL AND gm.status <> 'disabled' AND ${GROW_ENABLED}`,
    ),
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

  // Checked on the raw template body first, before link-wrapping or the
  // footer — wrapClickableLinks writes real grow_link_clicks rows (live,
  // resolvable /c/ redirects) as a side effect, which must not happen for a
  // message that's about to be refused and never sent.
  const refusalPlaceholder = (subject: string, body: string) =>
    hasUnrenderedPlaceholder(subject) || hasUnrenderedPlaceholder(body)
      ? firstUnrenderedPlaceholder(hasUnrenderedPlaceholder(subject) ? subject : body)
      : null;

  const earlyPlaceholder = refusalPlaceholder(message.subject, message.body);
  if (earlyPlaceholder) {
    await q.exec(
      `UPDATE grow_messages SET status = 'failed', error = $2 WHERE id = $1`,
      [message.id, `refused to send: unrendered placeholder ${earlyPlaceholder}`],
    );
    log.error({ messageId: message.id, placeholder: earlyPlaceholder }, 'refused to send: unrendered template placeholder');
    return;
  }

  const senderProfile = await getSenderProfile(q);
  const unsubscribeUrl = `${GROW_BASE_URL}/u/${message.unsubscribe_token}`;
  // Before the footer, not after — the unsubscribe link gets its own
  // dedicated /u/ flow and must never be wrapped a second time here.
  const clickableBody = await wrapClickableLinks(q, message.org_id, message.id, message.body, GROW_BASE_URL);
  const body = renderUnsubscribeFooter(clickableBody, {
    mailingAddress: senderProfile.mailing_address ?? '',
    unsubscribeUrl,
  });

  // Re-checked post-footer: the one thing the early check above can't see
  // is the footer render itself silently failing to fill
  // {{unsubscribe_footer}} — still refused, same as before this reordering.
  const latePlaceholder = refusalPlaceholder(message.subject, body);
  if (latePlaceholder) {
    await q.exec(
      `UPDATE grow_messages SET status = 'failed', error = $2 WHERE id = $1`,
      [message.id, `refused to send: unrendered placeholder ${latePlaceholder}`],
    );
    log.error({ messageId: message.id, placeholder: latePlaceholder }, 'refused to send: unrendered footer placeholder');
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

interface ImapMailboxRow {
  id: string; address: string; imap_host: string; imap_port: number | null;
  username: string; integration_id: string; imap_last_uid: number | null;
}

async function pollOneMailbox(q: Querier, orgId: string, mailbox: ImapMailboxRow): Promise<void> {
  const cred = await q.one<{ credential_enc: Buffer; credential_iv: Buffer; credential_tag: Buffer }>(
    `SELECT credential_enc, credential_iv, credential_tag FROM integrations WHERE id = $1`,
    [mailbox.integration_id],
  );
  if (!cred?.credential_enc) {
    log.warn({ orgId, mailbox: mailbox.address }, 'no stored credential for mailbox, skipping poll');
    return;
  }
  const creds: MailboxCreds = {
    id: mailbox.id, address: mailbox.address, imap_host: mailbox.imap_host,
    imap_port: mailbox.imap_port ?? 993, username: mailbox.username,
    password: decryptSecret(cred.credential_enc, cred.credential_iv, cred.credential_tag),
    imap_last_uid: mailbox.imap_last_uid,
  };

  const result = await pollMailbox(creds);

  for (const msg of result.messages) {
    try {
      await handleClassifiedMessage(q, orgId, msg);
    } catch (err) {
      log.error({ err, orgId, mailbox: mailbox.address, uid: msg.uid }, 'failed to handle a classified message');
    }
  }

  await q.exec(`UPDATE grow_mailboxes SET imap_last_uid = $2, last_health_at = now() WHERE id = $1`,
    [mailbox.id, result.newLastUid]);

  if (result.messages.length > 0) {
    log.info({ orgId, mailbox: mailbox.address, count: result.messages.length }, 'poll: new messages classified');
  }
}

async function handleClassifiedMessage(
  q: Querier, orgId: string, msg: Awaited<ReturnType<typeof pollMailbox>>['messages'][number],
): Promise<void> {
  // Tier 1 (trusted In-Reply-To header) before tier 2 (full-source scan,
  // which can pick up a Message-ID quoted or forwarded from an unrelated
  // message) — see growPoller.ts's header for why these are never merged
  // into one candidate pool.
  const match = (msg.primaryMessageIds.length > 0 && await matchGrowMessage(q, msg.primaryMessageIds))
    || await matchGrowMessage(q, msg.fallbackMessageIds);
  if (!match) {
    // A bounce/complaint report whose embedded original Message-ID didn't
    // match anything of ours, or a reply-shaped message with no thread
    // match at all — nothing to attribute this to.
    if (msg.kind === 'bounce_hard' || msg.kind === 'bounce_soft' || msg.kind === 'complaint') {
      log.warn({ orgId, kind: msg.kind, from: msg.fromAddress, subject: msg.subject },
        'unmatched bounce/complaint — could not attribute to a sent message, no suppression added');
    }
    return;
  }

  await q.exec(
    `INSERT INTO grow_events (org_id, message_id, contact_id, type, payload)
     VALUES (app.current_org(), $1, $2, $3, $4)`,
    [match.message_id, match.contact_id, msg.kind,
      JSON.stringify({ from: msg.fromAddress, subject: msg.subject })],
  );

  if (msg.kind === 'bounce_hard' || msg.kind === 'bounce_soft') {
    await q.exec(`UPDATE grow_messages SET status = 'bounced' WHERE id = $1`, [match.message_id]);
    if (match.enrollment_id) {
      await q.exec(`UPDATE grow_enrollments SET state = 'bounced' WHERE id = $1 AND state = 'active'`,
        [match.enrollment_id]);
    }
    if (msg.kind === 'bounce_hard') {
      await q.exec(
        `INSERT INTO grow_suppressions (org_id, email, reason, campaign_id)
         VALUES (app.current_org(), $1, 'hard_bounce', $2)
         ON CONFLICT (org_id, email) DO NOTHING`,
        [match.email, match.campaign_id],
      );
    }
    return;
  }

  if (msg.kind === 'complaint') {
    await q.exec(
      `INSERT INTO grow_suppressions (org_id, email, reason, campaign_id)
       VALUES (app.current_org(), $1, 'complaint', $2)
       ON CONFLICT (org_id, email) DO NOTHING`,
      [match.email, match.campaign_id],
    );
    if (match.enrollment_id) {
      await q.exec(`UPDATE grow_enrollments SET state = 'unsubscribed' WHERE id = $1 AND state = 'active'`,
        [match.enrollment_id]);
    }
    return;
  }

  if (msg.kind === 'auto_reply') {
    // Logged (grow_events row above) but not an engagement signal — no
    // enrollment change, no promotion. Per spec: "separates real replies
    // from auto-responders."
    return;
  }

  // A real reply.
  if (match.enrollment_id) {
    await q.exec(`UPDATE grow_enrollments SET state = 'replied' WHERE id = $1 AND state = 'active'`,
      [match.enrollment_id]);
  }

  const tag = await classifyReply(q, orgId, msg.bodyText).catch((err) => {
    log.error({ err, orgId }, 'reply classification failed, promoting without a tag');
    return null;
  });

  await promoteOnReply(q, {
    orgId,
    email: match.email,
    nameHint: match.contact_name ?? match.first_name ?? null,
    campaignId: match.campaign_id,
    campaignName: match.campaign_name,
    stepNo: match.step_no,
    replyText: msg.bodyText,
    tag,
  });
}

async function runPollingPass(): Promise<void> {
  for (const orgId of await orgIdsWithImapMailboxes()) {
    await withTenant({ orgId, userId: null, isStaff: false }, async (q) => {
      const mailboxes = await q.rows<ImapMailboxRow>(
        `SELECT id, address, imap_host, imap_port, username, integration_id, imap_last_uid
           FROM grow_mailboxes
          WHERE imap_host IS NOT NULL AND status <> 'disabled'`,
      );
      for (const mailbox of mailboxes) {
        try {
          await pollOneMailbox(q, orgId, mailbox);
        } catch (err) {
          log.error({ err, orgId, mailbox: mailbox.address }, 'mailbox poll failed');
        }
      }
    });
  }
}

let planning = false;
let sending = false;
let polling = false;

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

async function tickPoller(): Promise<void> {
  if (polling) return;
  polling = true;
  try { await runPollingPass(); } catch (err) { log.error({ err }, 'polling pass failed'); }
  finally { polling = false; }
}

async function main(): Promise<void> {
  log.info({ PLANNER_INTERVAL_MS, SENDER_POLL_MS, SENDER_BATCH_SIZE, POLLER_INTERVAL_MS, GROW_BASE_URL },
    'grow-worker starting');

  await tickPlanner();
  await tickSender();
  await tickPoller();

  const plannerTimer = setInterval(tickPlanner, PLANNER_INTERVAL_MS);
  const senderTimer = setInterval(tickSender, SENDER_POLL_MS);
  const pollerTimer = setInterval(tickPoller, POLLER_INTERVAL_MS);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down');
    clearInterval(plannerTimer);
    clearInterval(senderTimer);
    clearInterval(pollerTimer);
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
