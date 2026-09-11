/**
 * Venturelyx :: Grow template rendering.
 *
 * render(), renderUnsubscribeFooter(), hasUnrenderedPlaceholder(), and
 * firstUnrenderedPlaceholder() are ported verbatim (logic unchanged) from
 * the standalone CampusPath engine — scheduler.js's render() and
 * sender.js's renderUnsubscribeFooter()/hasUnrenderedPlaceholder(), at
 * /opt/outreach/src. Those are tested and live in production, so what a
 * contact's preview shows for those parts matches exactly what the
 * (not-yet-built) worker would produce.
 *
 * renderSenderFields() is new to Venturelyx — the standalone engine never
 * had a per-org sender identity, only a single deployment-wide
 * MAILING_ADDRESS env var. It follows the exact same pattern
 * renderUnsubscribeFooter() already established: resolved after render(),
 * and if a field can't be resolved (the org hasn't filled it in, or a
 * product_url references a label the org never defined), the token is
 * left in place rather than blanked — so hasUnrenderedPlaceholder() catches
 * it and the send refuses, the same guardrail {{unsubscribe_footer}} gets.
 */

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
const RESERVED_KEYS = new Set(['unsubscribe_footer', 'sender_website', 'sender_phone']);

// Any {{...}} left in a body after every known substitution has run —
// widened from the ported [\w.]+ to also match {{product_url:Label}}'s
// colon, so an unresolved product link (unknown label, or no product_urls
// configured at all) is caught by hasUnrenderedPlaceholder() exactly like
// every other unresolved reserved token.
const PLACEHOLDER_RE = /\{\{\s*[\w.:]+\s*\}\}/;

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

/** Ported from sender.js's renderUnsubscribeFooter(). */
export function renderUnsubscribeFooter(
  body: string,
  { mailingAddress, unsubscribeUrl }: { mailingAddress: string; unsubscribeUrl: string },
): string {
  return body.replace(
    /\{\{\s*unsubscribe_footer\s*\}\}/g,
    `${mailingAddress}\nUnsubscribe: ${unsubscribeUrl}`,
  );
}

export interface SenderProfile {
  website_url: string | null;
  phone: string | null;
  product_urls: Array<{ label: string; url: string }>;
}

const SENDER_WEBSITE_RE = /\{\{\s*sender_website\s*\}\}/g;
const SENDER_PHONE_RE = /\{\{\s*sender_phone\s*\}\}/g;
const PRODUCT_URL_RE = /\{\{\s*product_url:([^{}]+?)\s*\}\}/g;

/** Resolves {{sender_website}}, {{sender_phone}}, and named
 *  {{product_url:Label}} tokens against this org's own sender profile.
 *  Deliberately does NOT fall back to blanking an unresolved field the way
 *  an unknown contact field does in render() — a field the org hasn't
 *  filled in, or a product_url whose label doesn't match anything in
 *  product_urls, is left as a literal {{...}} token so
 *  hasUnrenderedPlaceholder() catches it below. Runs on subject and body
 *  both — unlike renderUnsubscribeFooter(), which is body-only. */
export function renderSenderFields(text: string, profile: SenderProfile): string {
  let out = text;
  if (profile.website_url) {
    out = out.replace(SENDER_WEBSITE_RE, profile.website_url);
  }
  if (profile.phone) {
    out = out.replace(SENDER_PHONE_RE, profile.phone);
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
