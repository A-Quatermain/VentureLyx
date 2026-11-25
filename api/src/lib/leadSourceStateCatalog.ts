/**
 * Venturelyx :: LeadSource state catalog — DB-backed (044_leadsource_state_catalog.sql).
 *
 * Not a tenant table (no org_id — same reference data for every org), so
 * a plain SELECT via the normal app-role connection is fine regardless of
 * which org's RLS context the caller happens to be in.
 */
import type { Querier } from './db.js';

export interface StateCatalogEntry {
  state: string;
  name: string;
  access: 'available' | 'planned';
  access_type: string | null;
  cadence: string | null;
  format: string | null;
  has_county_field: boolean | null;
  cost_notes: string | null;
  terms_url: string | null;
  confirmed: boolean;
  source_note: string;
}

export async function getStateCatalog(q: Querier): Promise<StateCatalogEntry[]> {
  return q.rows<StateCatalogEntry>(
    `SELECT state, name, access, access_type, cadence, format, has_county_field,
            cost_notes, terms_url, confirmed, source_note
       FROM leadsource_state_catalog ORDER BY access, state`,
  );
}

export async function getSupportedStates(q: Querier): Promise<Set<string>> {
  const rows = await q.rows<{ state: string }>(
    `SELECT state FROM leadsource_state_catalog WHERE access = 'available'`,
  );
  return new Set(rows.map((r) => r.state));
}
