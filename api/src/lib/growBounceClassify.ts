/**
 * Venturelyx :: Grow bounce classification — the one place "what does this
 * bounce mean, and what should an owner do about it" is decided. Called
 * from both capture points (worker/growWorker.ts: the synchronous SMTP
 * send-attempt rejection, and the async DSN/bounce-mailbox poller) and
 * from the read side (routes/grow.ts's bounced-list endpoint) — the same
 * module everywhere, so the UI and any report always agree with what was
 * actually stored, and a rule change here updates every past bounce's
 * displayed explanation too, not just new ones.
 *
 * Deliberately NOT persisted as columns beyond bounce_type: category/
 * explanation/action are recomputed from bounce_code + bounce_reason_raw
 * every time they're read, via classifyBounce() below — freezing them at
 * capture time would mean a later fix to this mapping table could never
 * improve how an old bounce reads. bounce_type itself IS persisted
 * (029_grow_bounce_detail.sql) because it drives a real decision made
 * once, at capture time (hard -> permanent suppression, never block or
 * soft) — that decision shouldn't silently change retroactively if this
 * file's rules are later tuned.
 */

export type BounceType = 'hard' | 'soft' | 'block' | 'unknown';

export interface BounceClassification {
  code: string | null;
  type: BounceType;
  category: string;
  explanation: string;
  action: string;
}

// \b[245]\.\d+\.\d+\b per the brief — an RFC 3463 enhanced status code,
// first class (2/4/5) dot subject dot detail.
const CODE_RE = /\b([245])\.\d+\.\d+\b/;

export function extractBounceCode(rawText: string): string | null {
  return CODE_RE.exec(rawText)?.[0] ?? null;
}

interface Entry {
  type: BounceType;
  category: string;
  explanation: string;
  action: string;
}

// Specific, unambiguous codes — checked before any keyword heuristic, so a
// clean 5.1.1 is never second-guessed by incidental wording elsewhere in
// a verbose DSN's boilerplate.
const EXPLICIT_CODES: Record<string, Entry> = {
  '5.1.1': {
    type: 'hard', category: 'Bad address',
    explanation: "The mailbox doesn't exist at that domain.",
    action: "Remove permanently — it'll never deliver.",
  },
  '5.1.2': {
    type: 'hard', category: 'Bad address',
    explanation: "The domain can't receive mail (gone or misconfigured).",
    action: 'Remove.',
  },
  '5.1.3': {
    type: 'hard', category: 'Bad address',
    explanation: 'The address is malformed.',
    action: 'Fix the typo or remove.',
  },
  '5.2.1': {
    type: 'hard', category: 'Bad address',
    explanation: 'The account is disabled or inactive.',
    action: 'Remove.',
  },
  '5.2.2': {
    type: 'soft', category: 'Temporary',
    explanation: 'Mailbox is full.',
    action: 'Auto-retry; remove only if it keeps failing.',
  },
  '4.2.2': {
    type: 'soft', category: 'Temporary',
    explanation: 'Mailbox is full.',
    action: 'Auto-retry; remove only if it keeps failing.',
  },
  '5.7.26': {
    type: 'block', category: 'Auth failure',
    explanation: "Our domain's email authentication didn't pass, so they rejected it.",
    action: 'Fix SPF/DKIM/DMARC on the sending domain — this blocks everything until fixed.',
  },
};

const AUTH_FAILURE_ENTRY: Entry = EXPLICIT_CODES['5.7.26']!;
const BLOCKLIST_ENTRY: Entry = {
  type: 'block', category: 'Blocked',
  explanation: "We're on a blocklist or flagged as spam.",
  action: 'Check domain reputation; pause and fix before resending.',
};
const COMPLAINT_ENTRY: Entry = {
  type: 'block', category: 'Blocked',
  explanation: 'Yahoo/AOL deferred us over complaint rate.',
  action: 'Cut consumer inboxes, warm slower.',
};
const POLICY_BLOCK_ENTRY: Entry = {
  type: 'block', category: 'Blocked',
  explanation: 'The server refused the message on policy — spam filter or reputation.',
  action: 'Deliverability issue, NOT a bad address. Slow down, warm the domain.',
};
const GREYLIST_ENTRY: Entry = {
  type: 'soft', category: 'Temporary',
  explanation: 'The server deferred us for now (greylisting or rate limiting).',
  action: 'Auto-retry later — usually clears itself.',
};
const UNKNOWN_ENTRY: Entry = {
  type: 'unknown', category: 'Other',
  explanation: 'Unrecognized server response.',
  action: 'Read the raw text below.',
};

// Keyword groups, checked in this order — auth failure and named
// blocklists are the most specific signals, so they're tried before the
// broader "policy/not authorized" bucket a lot of other block reasons
// would otherwise fall into.
const AUTH_KEYWORDS = ['dmarc', 'dkim', 'spf'];
const BLOCKLIST_KEYWORDS = ['spamhaus', 'blocklist', 'spam'];
const COMPLAINT_KEYWORDS = ['complaint'];
const POLICY_KEYWORDS = ['not authorized', 'access denied', 'policy', 'blocked', 'reputation'];
const GREYLIST_KEYWORDS = ['greylist', 'greylisting', 'rate limit'];

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

/** The one function every bounce capture/display point calls. `rawText`
 *  is whatever server response text is available (SMTP response line, DSN
 *  body excerpt, ARF report) — the more complete, the better the keyword
 *  pass does. `explicitCode`, if the caller already has one (e.g. a
 *  structured responseCode from the SMTP library), is used as-is;
 *  otherwise this extracts one from rawText itself. */
export function classifyBounce(rawText: string, explicitCode?: string | null): BounceClassification {
  const text = (rawText ?? '').toLowerCase();
  const code = explicitCode ?? extractBounceCode(rawText ?? '');

  const explicit = code ? EXPLICIT_CODES[code] : undefined;
  if (explicit) return { code, ...explicit };

  // Keyword overrides — deliberately checked even for a 5.x code that
  // isn't one of the explicit ones above, per the brief: a block is a
  // policy/reputation decision, not proof of a bad address, and must not
  // be lumped in with a generic hard bounce just because the class digit
  // is 5.
  if (matchesAny(text, AUTH_KEYWORDS)) return { code, ...AUTH_FAILURE_ENTRY };
  if (matchesAny(text, COMPLAINT_KEYWORDS)) return { code, ...COMPLAINT_ENTRY };
  if (matchesAny(text, BLOCKLIST_KEYWORDS)) return { code, ...BLOCKLIST_ENTRY };
  if (code === '5.7.1' || matchesAny(text, POLICY_KEYWORDS)) return { code, ...POLICY_BLOCK_ENTRY };
  if ((code && /^4\.7\./.test(code)) || matchesAny(text, GREYLIST_KEYWORDS)) return { code, ...GREYLIST_ENTRY };

  // Generic class fallback — only once every specific signal above has
  // had a chance to apply.
  if (code?.startsWith('5')) {
    return {
      code, type: 'hard', category: 'Bad address',
      explanation: 'The message was permanently rejected.',
      action: 'Review and likely remove — this address did not accept the message.',
    };
  }
  if (code?.startsWith('4')) {
    return {
      code, type: 'soft', category: 'Temporary',
      explanation: 'The message was temporarily rejected.',
      action: 'Will auto-retry; remove only if it keeps failing.',
    };
  }

  return { code, ...UNKNOWN_ENTRY };
}
