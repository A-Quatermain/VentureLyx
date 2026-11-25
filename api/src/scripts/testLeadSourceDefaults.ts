/**
 * Venturelyx :: LeadSource location-default verification script, same
 * convention as the other testLeadSource*.ts scripts. Covers:
 *   - a radius-mode FL org (no location zips) falls back to its own
 *     home-base zip -> the correct county
 *   - a cities-mode FL org with real per-city zips derives those counties
 *   - an org with no FL signal anywhere gets null (the "not yet
 *     available" path), never a fabricated default
 *   - the lazy auto-create on first GET only ever creates ONE default
 *     search, never duplicates it on a second call
 */
import { randomBytes } from 'node:crypto';
import { withPlatform, withTenant, shutdown, type Querier } from '../lib/db.js';
import { buildDefaultFilters, orgServiceAreaStates } from '../lib/leadSourceDefaults.js';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function createOrg(q: Querier, opts: { region?: string | null; postal_code?: string | null }): Promise<string> {
  const org = await q.one<{ id: string }>(
    `INSERT INTO organizations (slug, name, status, modules, region, postal_code)
     VALUES ($1, $2, 'active', '{"leadsource": true}'::jsonb, $3, $4) RETURNING id`,
    [`test-${randomBytes(4).toString('hex')}`, 'LeadSource Defaults Test Org', opts.region ?? null, opts.postal_code ?? null],
  );
  return org!.id;
}

async function main() {
  console.log('LeadSource location-defaults verification\n');

  const radiusOrgId = await withPlatform((q) => createOrg(q, { region: 'FL', postal_code: '33067' })); // Parkland, FL -> Broward
  const citiesOrgId = await withPlatform((q) => createOrg(q, { region: 'FL', postal_code: null }));
  const outOfStateOrgId = await withPlatform((q) => createOrg(q, { region: 'GA', postal_code: '30301' }));

  try {
    await withPlatform((q) => q.exec(
      `INSERT INTO locations (org_id, name, slug, region, postal_codes, is_active) VALUES ($1, 'radius', 'radius', 'FL', '{}', true)`,
      [radiusOrgId],
    ));
    await withPlatform((q) => q.exec(
      `INSERT INTO locations (org_id, name, slug, region, postal_codes, is_active)
       VALUES ($1, 'West Palm Beach', 'wpb', 'FL', ARRAY['33401'], true)`,
      [citiesOrgId],
    ));

    const radiusFilters = await withTenant({ orgId: radiusOrgId, userId: null, isStaff: false }, (q) => buildDefaultFilters(q, radiusOrgId));
    check('radius-mode org with no location zips falls back to its own postal_code', radiusFilters?.zips.includes('33067') ?? false);
    check('that fallback zip resolves to BROWARD county', radiusFilters?.counties.includes('BROWARD') ?? false);

    const citiesFilters = await withTenant({ orgId: citiesOrgId, userId: null, isStaff: false }, (q) => buildDefaultFilters(q, citiesOrgId));
    check('cities-mode org derives counties from its own location zips', citiesFilters?.counties.includes('PALM BEACH') ?? false);

    const outOfStateFilters = await withTenant({ orgId: outOfStateOrgId, userId: null, isStaff: false }, (q) => buildDefaultFilters(q, outOfStateOrgId));
    check('an org with no FL signal anywhere gets null, never a fabricated default', outOfStateFilters === null);

    const outOfStateStates = await withTenant({ orgId: outOfStateOrgId, userId: null, isStaff: false }, (q) => orgServiceAreaStates(q, outOfStateOrgId));
    check('orgServiceAreaStates reports GA for the out-of-state org', outOfStateStates.includes('GA') && !outOfStateStates.includes('FL'));

    // Lazy auto-create: simulate two consecutive "first GET" calls using
    // the exact same insert-if-none-exists logic the route uses.
    for (let i = 0; i < 2; i++) {
      await withTenant({ orgId: radiusOrgId, userId: null, isStaff: false }, async (q) => {
        const existing = await q.rows(`SELECT id FROM leadsource_saved_searches WHERE org_id = app.current_org()`);
        if (existing.length === 0) {
          const defaults = await buildDefaultFilters(q, radiusOrgId);
          if (defaults) {
            await q.exec(
              `INSERT INTO leadsource_saved_searches (org_id, name, counties, zips, filing_types, file_date_window_days, name_keywords, include_dba)
               VALUES (app.current_org(), 'Your service area', $1, $2, $3, $4, $5, $6)`,
              [defaults.counties, defaults.zips, defaults.filing_types, defaults.file_date_window_days, defaults.name_keywords, defaults.include_dba],
            );
          }
        }
      });
    }
    const createdSearches = await withTenant({ orgId: radiusOrgId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_saved_searches WHERE org_id = app.current_org()`),
    );
    check('two consecutive first-GET calls create exactly one default search, never two', createdSearches.length === 1);
  } finally {
    await withPlatform(async (q) => {
      await q.exec(`DELETE FROM organizations WHERE id = $1`, [radiusOrgId]);
      await q.exec(`DELETE FROM organizations WHERE id = $1`, [citiesOrgId]);
      await q.exec(`DELETE FROM organizations WHERE id = $1`, [outOfStateOrgId]);
    });
    await shutdown();
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
