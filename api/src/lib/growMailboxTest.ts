/**
 * Venturelyx :: Grow mailbox setup check — real SMTP send + IMAP
 * connectivity, one mailbox at a time.
 *
 * Both take the mailbox's decrypted password as a plain argument and never
 * do anything with it beyond handing it to nodemailer/imapflow for this
 * one connection — never logged, never included in a returned result,
 * never persisted anywhere beyond the integrations row it was decrypted
 * from.
 *
 * The IMAP check is connectivity only: it proves the credentials the
 * (future) reply-poller would use actually work — auth succeeds, INBOX is
 * selectable. It is NOT a round-trip reply-received check; that would mean
 * waiting on the test recipient to actually reply, which nothing here can
 * force or wait for synchronously. Callers must not present this as "a
 * reply was received."
 */
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

const CONNECT_TIMEOUT_MS = 10_000;

export interface SmtpTestResult {
  ok: boolean;
  messageId: string | null;
  response: string | null;
  error: string | null;
}

export async function sendTestEmail(
  mailbox: {
    smtp_host: string; smtp_port: number; username: string;
    address: string; from_name: string; reply_to: string | null;
  },
  password: string,
  to: string,
): Promise<SmtpTestResult> {
  const transporter = nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_port === 465,
    auth: { user: mailbox.username, pass: password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
  });
  try {
    const info = await transporter.sendMail({
      from: `"${mailbox.from_name}" <${mailbox.address}>`,
      replyTo: mailbox.reply_to || undefined,
      to,
      subject: 'Venturelyx Grow — test send',
      text: `This is a test message from ${mailbox.address}, sent from Venturelyx Grow's mailbox setup check.`,
    });
    return {
      ok: true,
      messageId: info.messageId || null,
      response: typeof info.response === 'string' ? info.response : null,
      error: null,
    };
  } catch (err) {
    return { ok: false, messageId: null, response: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    transporter.close();
  }
}

export interface ImapTestResult {
  ok: boolean;
  messageCount: number | null;
  error: string | null;
}

export async function checkImapConnectivity(
  mailbox: { imap_host: string | null; imap_port: number | null; username: string },
  password: string,
): Promise<ImapTestResult> {
  if (!mailbox.imap_host) {
    return { ok: false, messageCount: null, error: 'No IMAP host configured for this mailbox.' };
  }

  const port = mailbox.imap_port ?? 993;
  const client = new ImapFlow({
    host: mailbox.imap_host,
    port,
    secure: port === 993,
    auth: { user: mailbox.username, pass: password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailboxStatus = client.mailbox;
      return {
        ok: true,
        messageCount: mailboxStatus ? mailboxStatus.exists : null,
        error: null,
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { ok: false, messageCount: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.logout().catch(() => { client.close(); });
  }
}
