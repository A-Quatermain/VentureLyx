/**
 * Venturelyx :: Grow template rendering.
 *
 * render(), hasUnrenderedPlaceholder(), and firstUnrenderedPlaceholder()
 * are ported verbatim (logic unchanged) from the standalone CampusPath
 * engine — scheduler.js's render() and sender.js's
 * hasUnrenderedPlaceholder(), at /opt/outreach/src. Those are tested and
 * live in production, so what a contact's preview shows for those parts
 * matches exactly what the (not-yet-built) worker would produce.
 *
 * renderUnsubscribeFooter() started as a verbatim port of the same file's
 * renderUnsubscribeFooter() too, but the first real test send showed the
 * bare address line getting auto-linkified with no context by the
 * receiving mail client — "1234 Main St..." read as a stray hyperlink, not
 * a business address. Now prefixed with a plain-text label so it reads as
 * one, which the standalone version never needed since CAN-SPAM footers
 * weren't being read in a real inbox during its own development.
 *
 * renderSenderFields() is new to Venturelyx — the standalone engine never
 * had a per-org sender identity, only a single deployment-wide
 * MAILING_ADDRESS env var. It follows the exact same pattern
 * renderUnsubscribeFooter() already established: resolved after render(),
 * and if a field can't be resolved (the org hasn't filled it in, or a
 * product_url references a label the org never defined), the token is
 * left in place rather than blanked — so hasUnrenderedPlaceholder() catches
 * it and the send refuses, the same guardrail {{unsubscribe_footer}} gets.
 *
 * getSenderProfile() moved here from routes/grow.ts so the (now built)
 * worker (src/worker/growWorker.ts) and growScheduler.ts's planTick() read
 * the exact same row the preview/test-send routes always have, rather than
 * a second copy of this query drifting from it.
 */
import type { Querier } from './db.js';

export interface RenderableContact {
  [key: string]: unknown;
  attrs?: Record<string, unknown> | null;
}

// Tokens render() leaves untouched because something else resolves them
// later, once data render() doesn't have access to exists (the message's
// own unsubscribe_token; the org's sender profile). Treating one of these
// as an unknown contact field would blank it to '' — which for
// unsubscribe_footer ships a message with no unsubscribe link and no way
// to catch it, and for a sender field ships a sentence with a silently
// vanished website/phone reference instead of a visible, catchable gap.
const RESERVED_KEYS = new Set(['unsubscribe_footer', 'sender_website', 'sender_phone', 'sender_name', 'sender_email']);

// Any {{...}} left in a body after every known substitution has run —
// widened from the ported [\w.]+ to also match {{product_url:Label}}'s
// colon, so an unresolved product link (unknown label, or no product_urls
// configured at all) is caught by hasUnrenderedPlaceholder() exactly like
// every other unresolved reserved token.
const PLACEHOLDER_RE = /\{\{\s*[\w.:]+\s*\}\}/;

// Smart punctuation -> ASCII, belt-and-suspenders against mojibake. The
// MIME layer (growWorker.ts's sendMail call) already declares and encodes
// UTF-8 correctly, so this isn't needed to make the bytes transmit right —
// it's here so a render that reaches an intermediary that mishandles
// multi-byte UTF-8 (a relay, a client's own charset-sniffing) degrades to
// a plain straight quote/dash instead of a garbled multi-char sequence.
const SMART_PUNCTUATION_RE = /[‘’“”–—]/g;
const SMART_PUNCTUATION_MAP: Record<string, string> = {
  '‘': "'", '’': "'", // left/right single quote
  '“': '"', '”': '"', // left/right double quote
  '–': '-', '—': '-', // en dash, em dash
};

/** Run on subject and body right before handing either to the SMTP
 *  transport — not at template-save time, so previews and the editor keep
 *  showing the author's actual typography. */
export function normalizeSmartPunctuation(text: string): string {
  return text.replace(SMART_PUNCTUATION_RE, (ch) => SMART_PUNCTUATION_MAP[ch]!);
}

/** Ported from scheduler.js's render(). */
export function render(tmpl: string, contact: RenderableContact): string {
  return tmpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    if (RESERVED_KEYS.has(key)) return match;
    const v = contact[key] ?? contact.attrs?.[key];
    if (v === undefined || v === null || v === '') {
      // A blank merge field is a tell. Fall back rather than ship "Hi ,".
      if (key === 'first_name') return 'there';
      return '';
    }
    return String(v);
  });
}

/** Body-only, same as the ported original. mailingAddress now renders on
 *  its own explicitly-labeled line rather than bare — an unlabeled postal
 *  address sitting right above a URL is exactly the shape mail clients'
 *  address-detection auto-linkifies (into a maps link, with none of the
 *  surrounding context that makes it read as "this is our business
 *  address," not a stray link). The label defeats that pattern match. */
export function renderUnsubscribeFooter(
  body: string,
  { mailingAddress, unsubscribeUrl }: { mailingAddress: string; unsubscribeUrl: string },
): string {
  const addressLine = mailingAddress ? `Mailing address: ${mailingAddress}\n` : '';
  return body.replace(
    /\{\{\s*unsubscribe_footer\s*\}\}/g,
    `${addressLine}Unsubscribe: ${unsubscribeUrl}`,
  );
}

export interface SenderProfile {
  sender_name: string | null;
  website_url: string | null;
  phone: string | null;
  contact_email: string | null;
  product_urls: Array<{ label: string; url: string }>;
}

const SENDER_NAME_RE = /\{\{\s*sender_name\s*\}\}/g;
const SENDER_WEBSITE_RE = /\{\{\s*sender_website\s*\}\}/g;
const SENDER_PHONE_RE = /\{\{\s*sender_phone\s*\}\}/g;
const SENDER_EMAIL_RE = /\{\{\s*sender_email\s*\}\}/g;
const PRODUCT_URL_RE = /\{\{\s*product_url:([^{}]+?)\s*\}\}/g;

/** Resolves {{sender_name}}, {{sender_website}}, {{sender_phone}},
 *  {{sender_email}}, and named {{product_url:Label}} tokens against this
 *  org's own sender profile. Deliberately does NOT fall back to blanking
 *  an unresolved field the way an unknown contact field does in render()
 *  — a field the org hasn't filled in, or a product_url whose label
 *  doesn't match anything in product_urls, is left as a literal {{...}}
 *  token so hasUnrenderedPlaceholder() catches it below. Runs on subject
 *  and body both — unlike renderUnsubscribeFooter(), which is body-only. */
export function renderSenderFields(text: string, profile: SenderProfile): string {
  let out = text;
  if (profile.sender_name) {
    out = out.replace(SENDER_NAME_RE, () => profile.sender_name!);
  }
  if (profile.website_url) {
    out = out.replace(SENDER_WEBSITE_RE, () => profile.website_url!);
  }
  if (profile.phone) {
    out = out.replace(SENDER_PHONE_RE, () => profile.phone!);
  }
  if (profile.contact_email) {
    out = out.replace(SENDER_EMAIL_RE, () => profile.contact_email!);
  }
  out = out.replace(PRODUCT_URL_RE, (match, rawLabel: string) => {
    const label = rawLabel.trim();
    const found = profile.product_urls.find((p) => p.label === label);
    return found ? found.url : match;
  });
  return out;
}

/** Ported from sender.js's hasUnrenderedPlaceholder(). */
export function hasUnrenderedPlaceholder(body: string): boolean {
  return PLACEHOLDER_RE.test(body);
}

/** The literal placeholder that survived, for the refusal banner. Mirrors
 *  sender.js's `body.match(PLACEHOLDER_RE)[0]` at the refusal call site. */
export function firstUnrenderedPlaceholder(body: string): string | null {
  return body.match(PLACEHOLDER_RE)?.[0] ?? null;
}

// Exactly growScheduler.ts's contactForRender object, kept in sync by hand
// (not imported from there, to avoid a dependency the other direction) —
// this is the complete set of fields render() can ever actually resolve
// from a contact. A template token that isn't one of these, isn't a
// RESERVED_KEYS send-time/org-profile token, and isn't a valid
// product_url:Label reference is not provably wrong (an org's grow_contacts
// rows can carry arbitrary attrs.* keys this list has no way to know about
// in advance) but is worth surfacing — most of the time it's a typo of one
// of the names below, not a real custom field.
export const KNOWN_CONTACT_FIELDS = [
  'email', 'first_name', 'contact_name', 'role', 'entity_name',
  'recipient_domain', 'is_free_provider', 'contact_rank',
];

const TOKEN_RE = /\{\{\s*([\w.:]+?)\s*\}\}/g;

export interface TemplateTokenReport {
  /** Every distinct token found, raw (e.g. "first_name", "product_url:Catalog"). */
  tokens: string[];
  /** Provably wrong — a product_url:Label naming a label this org hasn't
   *  configured. Save-time failure material: there's no plausible reading
   *  under which this was meant to resolve to anything. */
  invalid: Array<{ token: string; reason: string }>;
  /** Not one of the known names above, but not provably wrong either — a
   *  real custom attrs.* field or a typo, indistinguishable from the
   *  template text alone. Surfaced as a warning, never blocks a save. */
  unknown: string[];
}

/** Checked at template-save time (routes/grow.ts's PATCH
 *  /grow/campaigns/:id/steps), not just left for send time to discover —
 *  the whole point being a typo'd or mis-cased token (`{{ first_name }}`
 *  with a cased variant render() doesn't recognize, `{{product_url:Pricing}}`
 *  naming a product link that was never added under Sender Profile) is
 *  caught before it can enter the send queue at all, rather than quietly
 *  rendering blank (render()'s own fallback for any unrecognized key) or —
 *  for a RESERVED_KEYS token specifically — correctly surviving as a
 *  literal `{{...}}` all the way to send time, where hasUnrenderedPlaceholder()
 *  is the last line of defense, not the first. */
export function checkTemplateTokens(
  text: string, productUrls: Array<{ label: string }>,
): TemplateTokenReport {
  const tokens = [...new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]!))];
  const invalid: Array<{ token: string; reason: string }> = [];
  const unknown: string[] = [];

  for (const token of tokens) {
    if (RESERVED_KEYS.has(token)) continue; // send-time or org-profile — see growScheduler.ts's own comment on why these survive render()
    if (KNOWN_CONTACT_FIELDS.includes(token)) continue;

    const productMatch = /^product_url:(.+)$/.exec(token);
    if (productMatch) {
      const label = productMatch[1]!.trim();
      if (!productUrls.some((p) => p.label === label)) {
        invalid.push({ token, reason: `No product link named "${label}" — add it under Sender Profile, or fix the label.` });
      }
      continue;
    }

    unknown.push(token);
  }

  return { tokens, invalid, unknown };
}

// GROW_BASE_URL was defaulting to http://localhost:8080 with nothing
// overriding it anywhere in the deployed environment, so every unsubscribe
// link built against it was unreachable for a real recipient. Moved here
// (from routes/grow.ts) so growWorker.ts's real sends refuse under the
// exact same condition the preview/test-send routes already refuse under,
// rather than a second, possibly-diverging localhost check.
export function isDevBaseUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return true; // unparseable is exactly as unusable as localhost
  }
}

export const GROW_BASE_URL = process.env.GROW_BASE_URL || 'http://localhost:8080';
export const GROW_BASE_URL_USABLE = !isDevBaseUrl(GROW_BASE_URL);

/** This org's Grow sender identity (db/migrations/011,014_grow_sender_profiles).
 *  A row is optional — an org that never filled in the sending-setup screen
 *  gets all-null fields, which renderSenderFields() already treats as "leave
 *  the token unresolved" rather than crashing. */
export async function getSenderProfile(
  q: Querier,
): Promise<SenderProfile & { mailing_address: string | null }> {
  const row = await q.one<{
    sender_name: string | null; website_url: string | null; phone: string | null;
    contact_email: string | null; mailing_address: string | null;
    product_urls: Array<{ label: string; url: string }>;
  }>(
    `SELECT sender_name, website_url, phone, contact_email, mailing_address, product_urls
       FROM grow_sender_profiles WHERE org_id = app.current_org()`,
  );
  return {
    sender_name: row?.sender_name ?? null,
    website_url: row?.website_url ?? null,
    phone: row?.phone ?? null,
    contact_email: row?.contact_email ?? null,
    mailing_address: row?.mailing_address ?? null,
    product_urls: row?.product_urls ?? [],
  };
}
