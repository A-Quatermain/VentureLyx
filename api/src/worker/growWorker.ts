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
import { classifyBounce } from '../lib/growBounceClassify.js';
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

  // {{unsubscribe_footer}} is a send-time token BY DESIGN (growScheduler.ts's
  // own comment on why: the message's own unsubscribe_token doesn't exist
  // until this row was created) — message.body legitimately still contains
  // that literal placeholder here for every message, not just a broken one.
  // A prior version of this check tested message.body directly and failed
  // EVERY send, unsubscribe_footer included — caught live, from real
  // production sends, when this exact bug blocked the campaign it's named
  // after no differently than a real typo would have. Stripping just that
  // one expected token before testing catches a genuine typo (or an
  // org-profile field left unfilled, which renderSenderFields() leaves
  // unresolved on purpose — see growTemplate.ts) without ever flagging the
  // one placeholder that's supposed to still be there.
  const withoutFooterToken = message.body.replace(/\{\{\s*unsubscribe_footer\s*\}\}/g, '');
  if (hasUnrenderedPlaceholder(message.subject) || hasUnrenderedPlaceholder(withoutFooterToken)) {
    const placeholder = firstUnrenderedPlaceholder(
      hasUnrenderedPlaceholder(message.subject) ? message.subject : withoutFooterToken);
    await q.exec(
      `UPDATE grow_messages SET status = 'failed', error = $2 WHERE id = $1`,
      [message.id, `refused to send: unrendered placeholder ${placeholder}`],
    );
    log.error({ messageId: message.id, placeholder }, 'refused to send: unrendered template placeholder');
    return;
  }

  // wrapClickableLinks runs on the PRE-footer body — the unsubscribe URL
  // doesn't exist in it yet, so it can never become a wrapping candidate;
  // renderUnsubscribeFooter runs after, appending the real, untouched
  // unsubscribe URL last. Order matters here for exactly that reason, not
  // just style: swapping it would make the unsubscribe link itself get
  // wrapped into a second, unnecessary /c/ redirect.
  const senderProfile = await getSenderProfile(q);
  const unsubscribeUrl = `${GROW_BASE_URL}/u/${message.unsubscribe_token}`;
  const clickableBody = await wrapClickableLinks(q, message.org_id, message.id, message.body, GROW_BASE_URL);
  const body = renderUnsubscribeFooter(clickableBody, {
    mailingAddress: senderProfile.mailing_address ?? '',
    unsubscribeUrl,
  });

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

    if (permanent) {
      // A permanent (5xx) SMTP rejection IS a bounce — the recipient's own
      // server just told us, synchronously, that this will never deliver.
      // Previously this landed in the undifferentiated 'failed' bucket
      // with nothing but errMessage; now it goes through the same
      // classifier the async DSN path uses (lib/growBounceClassify.ts),
      // so "why did this bounce" reads the same regardless of which path
      // caught it. Raw SMTP response text (nodemailer's err.response, the
      // literal server reply line — e.g. "550 5.1.1 User unknown") is
      // preferred over the generic error message when present, since it
      // carries the actual enhanced status code to extract.
      const rawText = (err as { response?: string }).response ?? errMessage;
      const classified = classifyBounce(rawText);
      await q.exec(
        `UPDATE grow_messages SET
           status = 'bounced', error = $2,
           bounce_code = $3, bounce_type = $4, bounce_reason_raw = $5, bounced_at = now()
         WHERE id = $1`,
        [message.id, errMessage, classified.code, classified.type, rawText],
      );
      // Only a genuine hard bounce (not a policy/reputation block, which
      // says nothing about whether the address itself is real) suppresses
      // permanently — same rule the async DSN path now follows below.
      if (classified.type === 'hard') {
        const msgRow = await q.one<{ contact_id: string; campaign_id: string }>(
          `SELECT contact_id, campaign_id FROM grow_messages WHERE id = $1`, [message.id],
        );
        if (msgRow) {
          await q.exec(
            `INSERT INTO grow_suppressions (org_id, email, reason, campaign_id)
             VALUES (app.current_org(), $1, 'hard_bounce', $2)
             ON CONFLICT (org_id, email) DO NOTHING`,
            [contact.email, msgRow.campaign_id],
          );
          await q.exec(
            `UPDATE grow_enrollments SET state = 'bounced'
              WHERE campaign_id = $1 AND contact_id = $2 AND state = 'active'`,
            [msgRow.campaign_id, msgRow.contact_id],
          );
        }
      }
      log.warn({ messageId: message.id, err: errMessage, bounceType: classified.type }, 'bounced (synchronous)');
    } else if (attempts >= MAX_ATTEMPTS) {
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
    // msg.kind's own hard/soft split comes from a crude Content-Type-header
    // sniff in growPoller.ts's classifyKind() — good enough to route "is
    // this worth classifying as a bounce at all," not precise enough to
    // decide whether to permanently suppress. The real answer comes from
    // running the actual DSN body text through the shared classifier
    // (lib/growBounceClassify.ts) — the same one the synchronous SMTP
    // rejection path above uses — which can tell a genuine bad-address
    // hard bounce apart from a policy/reputation block that happened to
    // arrive as a 5.x DSN (a block says nothing about whether the address
    // is real, so it must never suppress it).
    const classified = classifyBounce(msg.bodyText);
    await q.exec(
      `UPDATE grow_messages SET
         status = 'bounced',
         bounce_code = $2, bounce_type = $3, bounce_reason_raw = $4, bounced_at = now()
       WHERE id = $1`,
      [match.message_id, classified.code, classified.type, msg.bodyText],
    );
    if (match.enrollment_id) {
      await q.exec(`UPDATE grow_enrollments SET state = 'bounced' WHERE id = $1 AND state = 'active'`,
        [match.enrollment_id]);
    }
    if (classified.type === 'hard') {
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
