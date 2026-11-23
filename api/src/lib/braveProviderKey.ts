/**
 * Venturelyx :: LeadSource bring-your-own Brave Search key — the "Test
 * key" check only. The actual per-lead transient search call lives in the
 * Python worker (workers/leadsource/enrich.py) since that's where
 * enrichment runs; this is just the live validation behind the Settings
 * UI's "Test key" button, kept here rather than duplicated inline in the
 * route file.
 */

export type BraveKeyTestResult = 'ok' | 'invalid' | 'quota_exceeded' | 'error';

export async function testBraveKey(apiKey: string): Promise<{ result: BraveKeyTestResult; detail: string | null }> {
  try {
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
      headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) return { result: 'invalid', detail: `HTTP ${res.status}` };
    if (res.status === 429) return { result: 'quota_exceeded', detail: 'HTTP 429 — monthly/rate quota exceeded' };
    if (!res.ok) return { result: 'error', detail: `HTTP ${res.status}` };
    return { result: 'ok', detail: null };
  } catch (err) {
    return { result: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}
