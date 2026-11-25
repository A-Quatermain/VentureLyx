/**
 * Venturelyx :: LeadSource location defaults.
 *
 * Derives a default saved search from the org's own service area
 * (organizations.service_area_mode/region/postal_code + locations,
 * 008_service_area.sql) rather than asking the owner to configure
 * LeadSource from scratch. No geocoding provider exists in this app
 * (008's own header is explicit about never fabricating that) — so a
 * 'radius' org's area is approximated by the single zip its home base
 * sits in, and a 'cities' org's area comes only from whatever zips it
 * actually listed per city. A city with no zips contributes nothing
 * concrete here; the owner can always widen the saved search by hand.
 */
import type { Querier } from './db.js';
import { countiesForZip } from './flZipCounty.js';
import type { Filters } from '../routes/leadsource.js';

const DEFAULT_FILING_TYPES = ['DOMP', 'FLAL', 'FORP', 'FORL'];

interface OrgServiceArea {
  org_region: string | null;
  org_postal_code: string | null;
  locations: Array<{ region: string | null; postal_codes: string[] }>;
}

async function loadServiceArea(q: Querier, orgId: string): Promise<OrgServiceArea> {
  const org = await q.one<{ region: string | null; postal_code: string | null }>(
    `SELECT region, postal_code FROM organizations WHERE id = $1`, [orgId],
  );
  const locations = await q.rows<{ region: string | null; postal_codes: string[] }>(
    `SELECT region, postal_codes FROM locations WHERE org_id = $1 AND is_active = true`, [orgId],
  );
  return { org_region: org?.region ?? null, org_postal_code: org?.postal_code ?? null, locations };
}

/** The set of 2-letter state codes this org's service area touches, as
 *  best as can be told without a geocoder — used only to decide whether
 *  to show the normal search UI or the "not yet available" state catalog. */
export async function orgServiceAreaStates(q: Querier, orgId: string): Promise<string[]> {
  const area = await loadServiceArea(q, orgId);
  const states = new Set<string>();
  if (area.org_region) states.add(area.org_region.toUpperCase());
  for (const loc of area.locations) {
    if (loc.region) states.add(loc.region.toUpperCase());
  }
  return [...states];
}

/** Returns null when nothing FL-derivable exists at all (the caller
 *  should not create a default search in that case — see state-support
 *  gating in routes/leadsource.ts). */
export async function buildDefaultFilters(q: Querier, orgId: string): Promise<Filters | null> {
  const area = await loadServiceArea(q, orgId);
  const counties = new Set<string>();
  const zips: string[] = [];
  let touchesFl = area.org_region?.toUpperCase() === 'FL';

  for (const loc of area.locations) {
    if ((loc.region || '').toUpperCase() !== 'FL') continue;
    touchesFl = true;
    for (const z of loc.postal_codes ?? []) {
      zips.push(z);
      for (const c of countiesForZip(z)) counties.add(c);
    }
  }

  // Radius mode (and any 'cities' org that never filled in per-city zips)
  // leaves zips/counties empty above — fall back to the single zip the
  // business itself sits in, which is as honest an approximation as this
  // app can make without a geocoding provider.
  if (zips.length === 0 && touchesFl && area.org_postal_code) {
    zips.push(area.org_postal_code);
    for (const c of countiesForZip(area.org_postal_code)) counties.add(c);
  }

  if (!touchesFl) return null;
  return {
    counties: [...counties], zips, filing_types: DEFAULT_FILING_TYPES,
    file_date_window_days: 30, name_keywords: [], include_dba: false,
  };
}
