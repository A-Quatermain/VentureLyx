/**
 * Venturelyx :: Grow one-click unsubscribe.
 *
 * grow.ts's own comment said this route "doesn't exist yet" — every
 * unsubscribe link rendered into a preview, a test send, or a real send was
 * cosmetic. This is that route's logic, registered at the top level in
 * server.ts (GET and POST /u/:token, matching RFC 8058's List-Unsubscribe /
 * List-Unsubscribe-Post: One-Click convention, and the bare
 * `${GROW_BASE_URL}/u/${token}` every render path already builds).
 *
 * Looks the token up with withPlatform (lib/db.ts) rather than withTenant:
 * a recipient clicking this link carries no session and no org context —
 * the token itself, unique across every org (grow_messages_unsub_idx), is
 * the only thing identifying which org's suppression list to write to.
 * Once the owning org is known, the actual writes run through withTenant
 * for that org so RLS still applies to them like everything else.
 *
 * Second source as of 036_grow_alternate_channel.sql: an alternate-channel
 * draft's own grow_fallback_drafts.unsubscribe_token — reusing this one
 * handler for both rather than standing up a second unsubscribe route, per
 * that migration's own header.
 */
import { withPlatform, withTenant } from './db.js';
import { promoteOnUnsubscribe } from './growPromote.js';

export interface UnsubscribeResult {
  found: boolean;
  alreadyUnsubscribed: boolean;
  email: string | null;
}

interface UnsubscribeTarget {
  org_id: string;
  contact_id: string;
  email: string;
  message_id: string | null;
}

async function findUnsubscribeTarget(token: string): Promise<UnsubscribeTarget | null> {
  const fromMessage = await withPlatform((q) =>
    q.one<{ org_id: string; contact_id: string; email: string; message_id: string }>(
      `SELECT m.org_id, m.contact_id, c.email, m.id AS message_id
         FROM grow_messages m
         JOIN grow_contacts c ON c.id = m.contact_id
        WHERE m.unsubscribe_token = $1`,
      [token],
    ),
  );
  if (fromMessage) return fromMessage;

  return withPlatform((q) =>
    q.one<{ org_id: string; contact_id: string; email: string; message_id: string | null }>(
      `SELECT d.org_id, d.contact_id, c.email, d.original_message_id AS message_id
         FROM grow_fallback_drafts d
         JOIN grow_contacts c ON c.id = d.contact_id
        WHERE d.unsubscribe_token = $1`,
      [token],
    ),
  );
}

export async function processUnsubscribe(token: string): Promise<UnsubscribeResult> {
  const hit = await findUnsubscribeTarget(token);
  if (!hit) return { found: false, alreadyUnsubscribed: false, email: null };

  const alreadyUnsubscribed = await withTenant(
    { orgId: hit.org_id, userId: null, isStaff: false },
    async (q) => {
      const existing = await q.one(
        `SELECT 1 FROM grow_suppressions WHERE email = $1`,
        [hit.email],
      );
      await q.exec(
        `INSERT INTO grow_suppressions (org_id, email, reason)
         VALUES (app.current_org(), $1, 'unsubscribed')
         ON CONFLICT (org_id, email) DO NOTHING`,
        [hit.email],
      );
      await q.exec(
        `UPDATE grow_enrollments SET state = 'unsubscribed'
          WHERE contact_id = $1 AND state = 'active'`,
        [hit.contact_id],
      );
      await q.exec(
        `UPDATE grow_messages SET status = 'cancelled'
          WHERE contact_id = $1 AND status = 'queued'`,
        [hit.contact_id],
      );
      if (!existing) {
        await q.exec(
          `INSERT INTO grow_events (org_id, message_id, contact_id, type, payload)
           VALUES (app.current_org(), $2, $1, 'unsubscribe', '{}'::jsonb)`,
          [hit.contact_id, hit.message_id],
        );
        await promoteOnUnsubscribe(q, { orgId: hit.org_id, email: hit.email });
      }
      return !!existing;
    },
  );

  return { found: true, alreadyUnsubscribed, email: hit.email };
}
