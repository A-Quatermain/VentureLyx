/**
 * Venturelyx :: Grow alternate-channel follow-up drafting.
 *
 * Two entry points, one shared pipeline (generateDraftContent below —
 * same prompt, same Outreach Writer feature, same validation either way,
 * so "the manual path calls the same code as the automatic one" is true
 * by construction, not just by similar-looking duplicated code):
 *
 *   maybeAutoDraftFallback()   — docs/specs/grow-recoverable-bucket.md
 *                                Part C's automatic half. Called from
 *                                worker/growWorker.ts the moment a
 *                                recoverable bounce is classified. Gated
 *                                on grow_alternate_channel_settings
 *                                (enabled + trigger_bounce_types) — a
 *                                no-op unless the org opted in.
 *   generateFallbackDraft()    — the manual half, added back after the
 *                                automatic-only version shipped: the 79
 *                                already-recoverable bounces sitting in
 *                                the bucket before an org ever enables
 *                                the automatic path have no other way to
 *                                ever get a draft. Explicit sender
 *                                (mailbox or an ad-hoc address) passed in
 *                                by the caller — does NOT require
 *                                grow_alternate_channel_settings to exist
 *                                at all, since the whole point is this
 *                                still has to work when an org never
 *                                configured or enabled the automatic side.
 *
 * Both respect the same one-attempt-per-contact-per-campaign rule
 * (UNIQUE(contact_id, campaign_id) on grow_fallback_drafts) and the same
 * "never a hard bounce" rule — a manual generate on a hard-bounced
 * message is refused, not silently allowed just because a human asked.
 *
 * maybeAutoDraftFallback() swallows its own errors (AI provider down,
 * spend cap hit) rather than throwing — a draft that failed to
 * auto-generate must never take down bounce processing. generateFallbackDraft()
 * is called from an HTTP route instead, so it reports failure back to the
 * caller rather than swallowing it — a human asked for this one, they
 * need to know if it didn't work.
 */
import type { Querier } from './db.js';
import { resolveAIContext, streamAI, logAiUsage, type Feature } from './ai.js';
import { getSenderProfile } from './growTemplate.js';

const FEATURE: Feature = 'sequence_writing';

interface DraftContentInput {
  orgId: string;
  campaignName: string;
  originalSubject: string;
  businessContext: string | null;
}

/** The actual AI call — same prompt regardless of which path triggered
 *  it. Returns null and NEVER throws — a spend-cap refusal, an empty
 *  model response, or the AI provider itself failing (rate limit, out of
 *  credits, timeout) all collapse to "no draft right now," so neither
 *  caller's loop over a batch of ids ever aborts partway through because
 *  one row's AI call blew up. Found live: Anthropic returned a 400
 *  "credit balance too low" mid-verification here, and before this fix
 *  that propagated as an uncaught rejection — a 500 for the whole
 *  request, not a clean per-row failure. */
async function generateDraftContent(
  q: Querier, input: DraftContentInput,
): Promise<{ subject: string; introBody: string } | null> {
  try {
    const ctx = await resolveAIContext(q, input.orgId, FEATURE);
    if (ctx.capExceeded) return null;

    const senderProfile = await getSenderProfile(q);
    const system = `You are the Outreach Writer, drafting a short introductory passage for a Venturelyx client's outreach tool. This passage is placed ABOVE an original email, because the contact is now being reached through a DIFFERENT, warmer channel than before. Write 2-4 plain-English sentences that:
- Say briefly who is reaching out and on behalf of which business.
- Give a light, honest reason for using a different address (e.g. "wanted to make sure this reached you") — never mention bounces, blocks, spam filters, or any technical delivery problem.
- This is for reaching a known contact through a warmer channel — it must never read as a way to get around a block or a retry-until-it-lands pitch.
- Body text only — no subject line, no merge-field placeholders, no markdown.
Return ONLY the passage text, nothing else.`;
    const user = `Business context: ${input.businessContext ?? senderProfile.sender_name ?? 'this business'}.
These contacts were originally part of the "${input.campaignName}" sequence (original subject: "${input.originalSubject}").
Write the introductory passage now.`;

    let acc = '';
    const gen = streamAI({
      orgId: input.orgId, feature: FEATURE, system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 400,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => logAiUsage(q, { orgId: input.orgId, feature: FEATURE, ...usage }),
    });
    for await (const event of gen) {
      if (event.type === 'delta') acc += event.text;
    }
    const introBody = acc.trim();
    if (!introBody) return null;
    return { subject: `Re: ${input.originalSubject}`, introBody };
  } catch (err) {
    console.error({ err, orgId: input.orgId }, 'generateDraftContent: AI call failed — reporting as no draft, not a 500');
    return null;
  }
}

export interface MaybeAutoDraftInput {
  orgId: string;
  originalMessageId: string;
  contactId: string;
  campaignId: string;
  bounceType: 'block' | 'soft';
}

interface Settings {
  enabled: boolean;
  sender_mailbox_id: string | null;
  sender_adhoc_address: string | null;
  trigger_bounce_types: string[];
  business_context: string | null;
}

export async function maybeAutoDraftFallback(q: Querier, input: MaybeAutoDraftInput): Promise<void> {
  try {
    const settings = await q.one<Settings>(
      `SELECT enabled, sender_mailbox_id, sender_adhoc_address, trigger_bounce_types, business_context
         FROM grow_alternate_channel_settings WHERE org_id = $1`,
      [input.orgId],
    );
    if (!settings?.enabled) return;
    if (!settings.trigger_bounce_types.includes(input.bounceType)) return;
    if (!settings.sender_mailbox_id && !settings.sender_adhoc_address) return;

    // ONE alternate-channel attempt per contact per campaign — the UNIQUE
    // constraint on grow_fallback_drafts(contact_id, campaign_id) is the
    // real enforcement; this pre-check only avoids a wasted AI call on the
    // common case of a contact that already has one.
    const existing = await q.one(
      `SELECT 1 FROM grow_fallback_drafts WHERE contact_id = $1 AND campaign_id = $2`,
      [input.contactId, input.campaignId],
    );
    if (existing) return;

    const suppressed = await q.one<{ email: string }>(
      `SELECT c.email FROM grow_contacts c
        LEFT JOIN grow_suppressions s ON s.org_id = c.org_id AND s.email = c.email
       WHERE c.id = $1 AND s.email IS NULL`,
      [input.contactId],
    );
    if (!suppressed) return; // either the contact vanished or is suppressed — suppression always wins

    const original = await q.one<{ subject: string }>(`SELECT subject FROM grow_messages WHERE id = $1`, [input.originalMessageId]);
    if (!original) return;
    const campaign = await q.one<{ name: string }>(`SELECT name FROM grow_campaigns WHERE id = $1`, [input.campaignId]);

    let senderAddress: string;
    if (settings.sender_mailbox_id) {
      const mb = await q.one<{ address: string }>(`SELECT address FROM grow_mailboxes WHERE id = $1`, [settings.sender_mailbox_id]);
      if (!mb) return;
      senderAddress = mb.address;
    } else {
      senderAddress = settings.sender_adhoc_address!;
    }

    const content = await generateDraftContent(q, {
      orgId: input.orgId, campaignName: campaign?.name ?? 'outreach',
      originalSubject: original.subject, businessContext: settings.business_context,
    });
    if (!content) return;

    await q.exec(
      `INSERT INTO grow_fallback_drafts
         (org_id, original_message_id, contact_id, campaign_id, sender_mailbox_id, sender_address, subject, intro_body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (contact_id, campaign_id) DO NOTHING`,
      [
        input.orgId, input.originalMessageId, input.contactId, input.campaignId,
        settings.sender_mailbox_id, senderAddress, content.subject, content.introBody,
      ],
    );
  } catch (err) {
    console.error({ err, input }, 'maybeAutoDraftFallback: failed to auto-generate a fallback draft — bounce handling continues regardless');
  }
}

export interface GenerateDraftInput {
  orgId: string;
  originalMessageId: string;
  senderMailboxId: string | null;
  senderAdhocAddress: string | null;
}

export type GenerateDraftResult =
  | { ok: true; draftId: string }
  | { ok: false; reason: string };

/** The manual half (routes/grow.ts's POST /grow/fallback-drafts/generate).
 *  Deliberately does NOT read grow_alternate_channel_settings at all — a
 *  human explicitly asking for a draft, right now, on a specific bounce,
 *  bypasses the automatic path's enable/trigger-type gating entirely by
 *  design; the sender comes from this call's own input, not settings. */
export async function generateFallbackDraft(q: Querier, input: GenerateDraftInput): Promise<GenerateDraftResult> {
  const msg = await q.one<{
    org_id: string; contact_id: string; campaign_id: string; subject: string; bounce_type: string | null; email: string;
  }>(
    `SELECT m.org_id, m.contact_id, m.campaign_id, m.subject, m.bounce_type, c.email
       FROM grow_messages m JOIN grow_contacts c ON c.id = m.contact_id
      WHERE m.id = $1`,
    [input.originalMessageId],
  );
  if (!msg) return { ok: false, reason: 'Message not found.' };
  // Same defensive re-check every other guard chain in this spec uses —
  // a hard bounce must never reach this flow, manual request or not.
  if (msg.bounce_type === 'hard' || msg.bounce_type === null) {
    return { ok: false, reason: 'Not eligible — hard bounces never reach this flow.' };
  }

  const suppressed = await q.one(`SELECT 1 FROM grow_suppressions WHERE org_id = $1 AND email = $2`, [msg.org_id, msg.email]);
  if (suppressed) return { ok: false, reason: 'Suppressed org-wide — suppression always wins.' };

  const existing = await q.one(
    `SELECT 1 FROM grow_fallback_drafts WHERE contact_id = $1 AND campaign_id = $2`,
    [msg.contact_id, msg.campaign_id],
  );
  if (existing) return { ok: false, reason: 'This contact already has an alternate-channel draft or send for this campaign — one attempt per contact per campaign.' };

  let senderAddress: string;
  if (input.senderMailboxId) {
    const mb = await q.one<{ address: string }>(`SELECT address FROM grow_mailboxes WHERE id = $1`, [input.senderMailboxId]);
    if (!mb) return { ok: false, reason: 'Sending mailbox not found.' };
    senderAddress = mb.address;
  } else if (input.senderAdhocAddress) {
    senderAddress = input.senderAdhocAddress;
  } else {
    return { ok: false, reason: 'Pick an alternate sender.' };
  }

  const campaign = await q.one<{ name: string }>(`SELECT name FROM grow_campaigns WHERE id = $1`, [msg.campaign_id]);
  // Settings aren't required for the manual path, but if an org already
  // saved a business-context line, the draft is better for reusing it —
  // "use them as defaults" extends to this, not just the sender.
  const settings = await q.one<{ business_context: string | null }>(
    `SELECT business_context FROM grow_alternate_channel_settings WHERE org_id = $1`, [msg.org_id],
  );
  const content = await generateDraftContent(q, {
    orgId: msg.org_id, campaignName: campaign?.name ?? 'outreach',
    originalSubject: msg.subject, businessContext: settings?.business_context ?? null,
  });
  if (!content) return { ok: false, reason: 'Could not generate a draft right now — the AI provider may be unavailable. Try again.' };

  const row = await q.one<{ id: string }>(
    `INSERT INTO grow_fallback_drafts
       (org_id, original_message_id, contact_id, campaign_id, sender_mailbox_id, sender_address, subject, intro_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (contact_id, campaign_id) DO NOTHING
     RETURNING id`,
    [msg.org_id, input.originalMessageId, msg.contact_id, msg.campaign_id, input.senderMailboxId, senderAddress, content.subject, content.introBody],
  );
  if (!row) return { ok: false, reason: 'This contact already has an alternate-channel draft or send for this campaign.' };
  return { ok: true, draftId: row.id };
}
