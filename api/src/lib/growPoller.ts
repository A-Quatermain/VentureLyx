/**
 * Venturelyx :: Grow reply/bounce poller.
 *
 * The piece growWorker.ts's own header comment called "deliberately NOT
 * built here" — this is it. Connects to each grow_mailbox's real IMAP
 * inbox (imapflow; already a dependency, used until now only for the
 * mailbox setup connectivity check in growMailboxTest.ts) and classifies
 * every new message as one of grow_events.type's existing values: a real
 * reply, an auto-responder, a hard/soft bounce, or a complaint.
 *
 * Matching a message back to the grow_message it's replying to (and from
 * there to the contact/campaign/step) is the part classification can't
 * skip — an inbox the mailbox also receives other mail on must not treat
 * every unrelated email as a "reply." The match is a single regex scan of
 * the raw source for any Message-ID-shaped token (`<...@...>`), checked
 * against grow_messages.smtp_message_id. This deliberately covers both the
 * normal case (a mail client sets In-Reply-To/References to the original
 * Message-ID) and the DSN/bounce case (most MTAs embed the original
 * message's headers, Message-ID included, inside the delivery-status or
 * rfc822-headers part of the bounce) with one mechanism instead of two.
 */
import { ImapFlow } from 'imapflow';
import type { Querier } from './db.js';

export type ClassifiedKind = 'reply' | 'auto_reply' | 'bounce_hard' | 'bounce_soft' | 'complaint';

export interface ClassifiedMessage {
  uid: number;
  kind: ClassifiedKind;
  fromAddress: string | null;
  subject: string | null;
  bodyText: string;
  matchedMessageIds: string[];
}

const CONNECT_TIMEOUT_MS = 15_000;
// Bounded: classification only needs headers and the DSN/rfc822-headers
// part, never a full multi-megabyte message, and this is scanned per
// message on every poll.
const SOURCE_SCAN_MAX_BYTES = 80_000;
// Response bodies get stored (truncated) on the resulting timeline event for
// a real reply — bounded for the same reason response_excerpt is bounded in
// db/migrations/017: transparency without pasting an unbounded blob.
const BODY_EXCERPT_MAX_CHARS = 4000;

const MESSAGE_ID_RE = /<[^<>\s]+@[^<>\s]+>/g;

const AUTO_REPLY_SUBJECT_RE =
  /^(out of office|automatic reply|auto-?reply|autoresponder|away from (my|the) (desk|office))/i;
const BOUNCE_SUBJECT_RE =
  /^(undeliverable|undelivered mail|delivery status notification|mail delivery (failed|system)|returned mail|failure notice|delivery has failed)/i;
const BOUNCE_SENDER_RE = /^(mailer-daemon|postmaster|mail delivery system)@/i;

function headerBlobIncludes(headers: Buffer | undefined, needle: RegExp): boolean {
  return !!headers && needle.test(headers.toString('utf8'));
}

function extractText(source: Buffer): string {
  // Not a MIME parser — this is a deliberately crude plain-text extraction
  // (strip boundaries/headers lines) good enough for an excerpt and for the
  // bounce/complaint report-type sniff below; real HTML body rendering was
  // never a goal here.
  const text = source.toString('utf8');
  const bodyStart = text.indexOf('\r\n\r\n');
  const body = bodyStart >= 0 ? text.slice(bodyStart + 4) : text;
  return body
    .replace(/^--.*$/gm, '')
    .replace(/^(Content-[A-Za-z-]+|MIME-Version):.*$/gim, '')
    .trim();
}

function classifyKind(opts: {
  fromAddress: string | null;
  subject: string | null;
  contentType: string | null;
  autoSubmitted: string | null;
  xAutoreply: string | null;
}): ClassifiedKind | null {
  const contentType = (opts.contentType ?? '').toLowerCase();
  const subject = opts.subject ?? '';

  // DSN (RFC 3464) and ARF (RFC 5965) reports are the two standards-based
  // signals here — checked before the looser heuristics below, since a
  // bounce's own Auto-Submitted header would otherwise fall through to the
  // generic auto_reply bucket.
  if (contentType.includes('report-type=feedback-report')) return 'complaint';
  if (contentType.includes('report-type=delivery-status')) {
    return /status:\s*5\./i.test(contentType) ? 'bounce_hard' : 'bounce_soft';
  }
  if (BOUNCE_SENDER_RE.test(opts.fromAddress ?? '') || BOUNCE_SUBJECT_RE.test(subject)) {
    return 'bounce_hard';
  }
  if (
    /auto-replied|auto-generated/i.test(opts.autoSubmitted ?? '') ||
    opts.xAutoreply ||
    AUTO_REPLY_SUBJECT_RE.test(subject)
  ) {
    return 'auto_reply';
  }
  return null; // candidate reply — caller decides based on a thread match
}

export interface MailboxCreds {
  id: string;
  address: string;
  imap_host: string;
  imap_port: number;
  username: string;
  password: string;
  imap_last_uid: number | null;
}

export interface PollResult {
  newLastUid: number;
  messages: ClassifiedMessage[];
}

/** One mailbox, one IMAP connection, one pass. Never throws on a per-message
 *  problem (a single malformed message must not stop the whole mailbox's
 *  poll) — only a connection-level failure propagates. */
export async function pollMailbox(creds: MailboxCreds): Promise<PollResult> {
  const client = new ImapFlow({
    host: creds.imap_host,
    port: creds.imap_port,
    secure: creds.imap_port === 993,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidNext = client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.uidNext : 1;

      // First poll ever for this mailbox: record the current watermark
      // without processing anything older — see this file's header.
      if (creds.imap_last_uid === null) {
        return { newLastUid: Math.max(0, uidNext - 1), messages: [] };
      }

      const from = creds.imap_last_uid + 1;
      if (from >= uidNext) {
        return { newLastUid: creds.imap_last_uid, messages: [] };
      }

      const messages: ClassifiedMessage[] = [];
      let newLastUid = creds.imap_last_uid;

      for await (const msg of client.fetch(
        `${from}:*`,
        { envelope: true, headers: ['auto-submitted', 'x-autoreply', 'x-autorespond', 'content-type'],
          source: { maxLength: SOURCE_SCAN_MAX_BYTES } },
        { uid: true },
      )) {
        newLastUid = Math.max(newLastUid, msg.uid);
        try {
          const headerText = msg.headers?.toString('utf8') ?? '';
          const contentType = /content-type:\s*(.+)/i.exec(headerText)?.[1]?.trim() ?? null;
          const autoSubmitted = /auto-submitted:\s*(.+)/i.exec(headerText)?.[1]?.trim() ?? null;
          const xAutoreply = headerBlobIncludes(msg.headers, /^x-autoreply:/im) ||
            headerBlobIncludes(msg.headers, /^x-autorespond:/im);
          const fromAddress = msg.envelope?.from?.[0]?.address ?? null;
          const subject = msg.envelope?.subject ?? null;

          const explicit = classifyKind({
            fromAddress, subject, contentType, autoSubmitted,
            xAutoreply: xAutoreply ? 'yes' : null,
          });

          const source = msg.source ?? Buffer.alloc(0);
          const candidates = new Set<string>();
          if (msg.envelope?.inReplyTo) candidates.add(msg.envelope.inReplyTo);
          for (const m of source.toString('utf8').matchAll(MESSAGE_ID_RE)) candidates.add(m[0]);

          const kind = explicit ?? (candidates.size > 0 ? 'reply' : null);
          if (!kind) continue; // unrelated inbox mail — not Grow's concern

          messages.push({
            uid: msg.uid,
            kind,
            fromAddress,
            subject,
            bodyText: extractText(source).slice(0, BODY_EXCERPT_MAX_CHARS),
            matchedMessageIds: [...candidates],
          });
        } catch {
          // Malformed/unparseable single message — skip it, keep polling.
          continue;
        }
      }

      return { newLastUid, messages };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => { client.close(); });
  }
}

/** Resolves a classified message's Message-ID candidates to the real
 *  grow_message (and from there contact/campaign/step) it answers, scoped
 *  to this org by RLS like every other query here. */
export async function matchGrowMessage(q: Querier, candidates: string[]): Promise<{
  message_id: string; contact_id: string; campaign_id: string; step_no: number; email: string;
  first_name: string | null; contact_name: string | null; campaign_name: string;
  enrollment_id: string | null;
} | null> {
  if (candidates.length === 0) return null;
  return q.one(
    `SELECT m.id AS message_id, m.contact_id, m.campaign_id, m.step_no,
            c.email, c.first_name, c.contact_name, gc.name AS campaign_name,
            e.id AS enrollment_id
       FROM grow_messages m
       JOIN grow_contacts c ON c.id = m.contact_id
       JOIN grow_campaigns gc ON gc.id = m.campaign_id
  LEFT JOIN grow_enrollments e ON e.campaign_id = m.campaign_id AND e.contact_id = m.contact_id
      WHERE m.smtp_message_id = ANY($1)
      ORDER BY m.sent_at DESC NULLS LAST
      LIMIT 1`,
    [candidates],
  );
}
