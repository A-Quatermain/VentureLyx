/**
 * Venturelyx :: LeadSource state catalog.
 *
 * Static for now — a real leadsource_state_catalog table was proposed
 * (not built) in the v2 design report's Phase 4; this is the minimal
 * stand-in needed so an org outside Florida sees "not yet available"
 * with real context instead of a blank search page. Pricing/access
 * details researched live for the original v2 report (WebSearch, not
 * re-verified here) — treat "access" as informational, not a live feed.
 */
export interface StateCatalogEntry {
  state: string;
  name: string;
  access: 'available' | 'planned';
  note: string;
}

export const STATE_CATALOG: StateCatalogEntry[] = [
  { state: 'FL', name: 'Florida', access: 'available', note: 'Live today — free daily Sunbiz file.' },
  { state: 'CT', name: 'Connecticut', access: 'planned', note: 'Free open-data portal (data.ct.gov) — not yet built.' },
  { state: 'OR', name: 'Oregon', access: 'planned', note: 'Free open-data portal — not yet built.' },
  { state: 'NY', name: 'New York', access: 'planned', note: 'Free open-data portal (data.ny.gov) — not yet built.' },
  { state: 'GA', name: 'Georgia', access: 'planned', note: 'Paid bulk-data subscription — not yet built.' },
  { state: 'KY', name: 'Kentucky', access: 'planned', note: 'Paid bulk-data subscription — not yet built.' },
  { state: 'NC', name: 'North Carolina', access: 'planned', note: 'Paid bulk-data subscription — not yet built.' },
  { state: 'SC', name: 'South Carolina', access: 'planned', note: 'Paid bulk-data subscription — not yet built.' },
  { state: 'TX', name: 'Texas', access: 'planned', note: 'Paid per-day/per-week filing feed — not yet built.' },
  { state: 'AL', name: 'Alabama', access: 'planned', note: 'No official bulk-data path found yet.' },
];

export const SUPPORTED_STATES = new Set(
  STATE_CATALOG.filter((s) => s.access === 'available').map((s) => s.state),
);
