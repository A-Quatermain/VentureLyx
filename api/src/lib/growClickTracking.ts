/**
 * Venturelyx :: Grow link click tracking.
 *
 * wrapClickableLinks() runs at send time (growWorker.ts's sendOne(), before
 * the unsubscribe footer is appended — the unsubscribe link has its own
 * dedicated flow and must never be wrapped a second time here) and rewrites
 * every http(s) URL in the body to a per-link redirect token recorded in
 * grow_link_clicks. processClick() is the other end: server.ts's public
 * GET /c/:token resolves a token to its stored destination and redirects —
 * the destination is never taken from the request itself, which is what
 * keeps this from being an open redirect (see migration 019's header).
 */
import { withPlatform, withTenant } from './db.js';
import type { Querier } from './db.js';
import { promoteOnClick } from './growPromote.js';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export async function wrapClickableLinks(
  q: Querier, orgId: string, messageId: string, body: string, baseUrl: string,
): Promise<string> {
  const urls = [...new Set(body.match(URL_RE) ?? [])];
  if (urls.length === 0) return body;

  const tokenByUrl = new Map<string, string>();
  for (const url of urls) {
    const row = await q.one<{ token: string }>(
      `INSERT INTO grow_link_clicks (org_id, message_id, url) VALUES ($1, $2, $3) RETURNING token`,
      [orgId, messageId, url],
    );
    tokenByUrl.set(url, row!.token);
  }
  return body.replace(URL_RE, (match) => {
    const token = tokenByUrl.get(match);
    return token ? `${baseUrl}/c/${token}` : match;
  });
}

export interface ClickResult {
  found: boolean;
  url: string | null;
}

export async function processClick(token: string): Promise<ClickResult> {
  const hit = await withPlatform((q) =>
    q.one<{ org_id: string; url: string; contact_id: string; campaign_id: string; step_no: number }>(
      `SELECT lc.org_id, lc.url, m.contact_id, m.campaign_id, m.step_no
         FROM grow_link_clicks lc
         JOIN grow_messages m ON m.id = lc.message_id
        WHERE lc.token = $1`,
      [token],
    ),
  );
  if (!hit) return { found: false, url: null };

  await withTenant({ orgId: hit.org_id, userId: null, isStaff: false }, async (q) => {
    // Idempotency guard, same shape as processUnsubscribe's `existing`
    // check — a mail-safety scanner or a mail client reloading the message
    // can hit this same token many times for what was really one click;
    // the row only flips from NULL once, so the event/promotion below only
    // ever fire on the first.
    const firstClick = await q.exec(
      `UPDATE grow_link_clicks SET clicked_at = now() WHERE token = $1 AND clicked_at IS NULL`,
      [token],
    );
    if (firstClick === 0) return;

    await q.exec(
      `INSERT INTO grow_events (org_id, message_id, contact_id, type, payload)
       VALUES (app.current_org(), (SELECT message_id FROM grow_link_clicks WHERE token = $2), $1, 'click', $3)`,
      [hit.contact_id, token, JSON.stringify({ url: hit.url })],
    );

    const contact = await q.one<{ email: string; first_name: string | null; contact_name: string | null }>(
      `SELECT email, first_name, contact_name FROM grow_contacts WHERE id = $1`, [hit.contact_id],
    );
    const campaign = await q.one<{ name: string }>(
      `SELECT name FROM grow_campaigns WHERE id = $1`, [hit.campaign_id],
    );
    if (contact && campaign) {
      await promoteOnClick(q, {
        orgId: hit.org_id, email: contact.email,
        nameHint: contact.contact_name ?? contact.first_name ?? null,
        campaignId: hit.campaign_id, campaignName: campaign.name, stepNo: hit.step_no,
      });
    }
  });

  return { found: true, url: hit.url };
}
