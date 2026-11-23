/**
 * Venturelyx :: LeadSource AI filter-assist — plain English in, a
 * structured filter object out. Never runs a search itself and never
 * streams prose to the user: the whole point is a short JSON object the
 * UI renders as editable chips BEFORE anything runs (per the v2 spec —
 * "shown as editable chips before anything runs, never silently").
 * Same non-streaming-collect pattern as growClassify.ts's
 * classifyReply() — a one-shot structured answer, not a conversation.
 */
import { resolveAIContext, streamAI, logAiUsage, type AIStreamEvent } from './ai.js';
import { FL_ZIP_COUNTY } from './flZipCounty.js';
import type { Querier } from './db.js';

const FEATURE = 'leadsource_search_assist' as const;

const VALID_FILING_TYPES = ['DOMP', 'FLAL', 'FORP', 'FORL', 'DOMNP', 'FORNP', 'FORLP', 'DOMLP'];
const VALID_COUNTIES = [...new Set(Object.values(FL_ZIP_COUNTY).flat())].sort();

export interface AssistedFilters {
  counties: string[];
  zips: string[];
  filing_types: string[];
  file_date_window_days: number;
  name_keywords: string[];
  include_dba: boolean;
}

const SYSTEM_PROMPT =
  `You turn a plain-English lead-search request into a strict JSON filter object — nothing else, ` +
  `no prose, no markdown fences. Venturelyx only has Florida Sunbiz data today, so every result is implicitly FL. ` +
  `Output exactly these keys: ` +
  `{"counties": string[], "zips": string[], "filing_types": string[], "file_date_window_days": number, ` +
  `"name_keywords": string[], "include_dba": boolean}. ` +
  `Valid filing_types: DOMP (domestic for-profit), FLAL (Florida LLC), FORP (foreign for-profit), FORL (foreign LLC), ` +
  `DOMNP (domestic non-profit), FORNP (foreign non-profit), DOMLP/FORLP (limited partnership). If the request doesn't ` +
  `name a structure, default to ["DOMP","FLAL","FORP","FORL"] (the common for-profit set). ` +
  `Valid FL county names (uppercase, no "COUNTY" suffix): ${VALID_COUNTIES.join(', ')}. ` +
  `Only use county names from that exact list — never invent one. If the request names a city, map it to its real ` +
  `county if you're confident, otherwise leave counties empty and let zips or name_keywords carry the request. ` +
  `file_date_window_days defaults to 30 if nothing is said about recency. name_keywords are plain words to match ` +
  `against the business name (e.g. "plumbing", "roofing") — never invent a keyword the user didn't imply. ` +
  `include_dba is true only if fictitious names / DBAs were explicitly asked for.`;

function parseFilters(text: string): AssistedFilters | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const countySet = new Set(VALID_COUNTIES);
    return {
      counties: Array.isArray(parsed.counties) ? parsed.counties.filter((c: unknown) => typeof c === 'string' && countySet.has(c)) : [],
      zips: Array.isArray(parsed.zips) ? parsed.zips.filter((z: unknown) => typeof z === 'string') : [],
      filing_types: Array.isArray(parsed.filing_types)
        ? parsed.filing_types.filter((t: unknown) => typeof t === 'string' && VALID_FILING_TYPES.includes(t))
        : [],
      file_date_window_days: Number.isFinite(parsed.file_date_window_days) ? Math.max(1, Math.min(365, parsed.file_date_window_days)) : 30,
      name_keywords: Array.isArray(parsed.name_keywords) ? parsed.name_keywords.filter((k: unknown) => typeof k === 'string') : [],
      include_dba: parsed.include_dba === true,
    };
  } catch {
    return null;
  }
}

/** Returns null on any failure (cap exceeded, model error, unparseable
 *  output) — the caller falls back to an empty/default filter set for the
 *  owner to edit by hand, never a thrown error over what's explicitly an
 *  assist, not a requirement. */
export async function assistSearchFilters(q: Querier, orgId: string, request: string): Promise<AssistedFilters | null> {
  const ctx = await resolveAIContext(q, orgId, FEATURE);
  if (ctx.capExceeded) return null;

  let text = '';
  try {
    const gen = streamAI({
      orgId,
      feature: FEATURE,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: request }],
      maxTokens: 500,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => logAiUsage(q, { orgId, feature: FEATURE, ...usage }),
    });
    for await (const event of gen as AsyncGenerator<AIStreamEvent>) {
      if (event.type === 'delta') text += event.text;
    }
  } catch {
    return null;
  }
  return parseFilters(text);
}
