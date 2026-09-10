/**
 * Venturelyx :: Grow template rendering.
 *
 * Ported verbatim (logic unchanged) from the standalone CampusPath engine —
 * scheduler.js's render() and sender.js's renderUnsubscribeFooter() /
 * hasUnrenderedPlaceholder(), at /opt/outreach/src. Those are tested and
 * live in production; this file translates them to TypeScript without
 * changing behavior, so the campaign preview endpoint shows exactly what
 * the (not-yet-built) worker would send.
 */

export interface RenderableContact {
  [key: string]: unknown;
  attrs?: Record<string, unknown> | null;
}

// Any {{...}} left in a body after every known substitution has run.
// Ported from sender.js's PLACEHOLDER_RE.
const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}/;

/** Ported from scheduler.js's render(). */
export function render(tmpl: string, contact: RenderableContact): string {
  return tmpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    // Reserved, not a contact field: filled in later by sender.js, once the
    // message row (and its unsubscribe_token) exists. Left untouched here —
    // treating it as an unknown merge field would blank it to '', which
    // ships the message with no unsubscribe link and no way to catch it.
    if (key === 'unsubscribe_footer') return match;
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

/** Ported from sender.js's hasUnrenderedPlaceholder(). */
export function hasUnrenderedPlaceholder(body: string): boolean {
  return PLACEHOLDER_RE.test(body);
}

/** The literal placeholder that survived, for the refusal banner. Mirrors
 *  sender.js's `body.match(PLACEHOLDER_RE)[0]` at the refusal call site. */
export function firstUnrenderedPlaceholder(body: string): string | null {
  return body.match(PLACEHOLDER_RE)?.[0] ?? null;
}
