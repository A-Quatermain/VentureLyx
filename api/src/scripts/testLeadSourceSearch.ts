/**
 * Venturelyx :: LeadSource Phase 2.5 (saved searches + AI filter-assist)
 * — repeatable verification script.
 *
 *   node dist/scripts/testLeadSourceSearch.js
 *
 * Same convention as testLeadSource.ts: no test framework in this
 * codebase. Exercises the logic directly (runFilters, guessBusinessType,
 * assistSearchFilters) rather than over HTTP — these routes are
 * session-cookie-authenticated, unlike operateIntake's Bearer-key routes,
 * so a standalone script can't easily drive them through Fastify; the
 * route handlers themselves are thin wrappers around this same logic.
 */
import { randomBytes } from 'node:crypto';
import { withPlatform, withTenant, shutdown, type Querier } from '../lib/db.js';
import { runFilters, type Filters } from '../routes/leadsource.js';
import { guessBusinessType } from '../lib/businessTypeGuess.js';
import { assistSearchFilters } from '../lib/leadSourceSearchAssist.js';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function createTestOrg(q: Querier, name: string): Promise<string> {
  const org = await q.one<{ id: string }>(
    `INSERT INTO organizations (slug, name, status, modules) VALUES ($1, $2, 'active', '{"leadsource": true}'::jsonb) RETURNING id`,
    [`test-${randomBytes(4).toString('hex')}`, name],
  );
  return org!.id;
}

const BASE_FILTERS: Filters = {
  counties: [], zips: [], filing_types: [], file_date_window_days: 365, name_keywords: [], include_dba: false,
};

async function main() {
  console.log('LeadSource search verification\n');

  // 1. guessBusinessType — pure function, labeling discipline
  const g1 = guessBusinessType('ACME ROOFING LLC');
  check('name with "ROOFING" guesses Roofing, labeled as a guess', g1.business_type_guess === 'Roofing' && g1.business_type_guess_is_guess === true);
  const g2 = guessBusinessType('ACME HOLDINGS LLC');
  check('name with no matching keyword guesses nothing (never forces a label)', g2.business_type_guess === null && g2.business_type_guess_is_guess === null);

  const orgAId = await withPlatform((q) => createTestOrg(q, 'LeadSource Search Test Org A'));
  const orgBId = await withPlatform((q) => createTestOrg(q, 'LeadSource Search Test Org B'));

  try {
    const anyRaw = await withPlatform((q) =>
      q.one<{ source_id: string; raw: { corp_name: string; zip: string } }>(
        `SELECT source_id, raw FROM leadsource_raw_records WHERE source = 'fl_sunbiz_cor' LIMIT 1`,
      ),
    );
    if (!anyRaw) {
      console.log('  SKIP remaining checks — no leadsource_raw_records rows exist yet (run a real ingest first)');
      return;
    }

    // 2. runFilters — a wide-open filter must find at least the one known row
    const wideOpen = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) => runFilters(q, BASE_FILTERS));
    check('wide-open filter finds at least one real raw record', wideOpen.length > 0, `got ${wideOpen.length}`);
    check('every result carries source + source_id', wideOpen.every((r) => r.source && r.source_id));

    // 3. runFilters — a keyword that cannot match anything returns empty, not an error
    const noMatch = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      runFilters(q, { ...BASE_FILTERS, name_keywords: ['ZZZZ_NO_REAL_BUSINESS_HAS_THIS_ZZZZ'] }),
    );
    check('an impossible keyword returns zero results, not an error', noMatch.length === 0);

    // 4. runFilters — an invalid/unknown county name matches nothing (never silently ignored)
    const badCounty = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      runFilters(q, { ...BASE_FILTERS, counties: ['NOT_A_REAL_FL_COUNTY'] }),
    );
    check('a nonexistent county filters down to zero (not treated as "no filter")', badCounty.length === 0);

    // 5. Saved search CRUD + cross-org isolation
    const created = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.one<{ id: string }>(
        `INSERT INTO leadsource_saved_searches (org_id, name, counties, zips, filing_types, file_date_window_days, name_keywords, include_dba)
         VALUES (app.current_org(), 'test search', '{}', '{}', '{}', 30, '{}', false) RETURNING id`,
      ),
    );
    const orgBSeesIt = await withTenant({ orgId: orgBId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_saved_searches WHERE id = $1`, [created!.id]),
    );
    check('org B cannot see org A\'s saved search', orgBSeesIt.length === 0);
    const orgASeesIt = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_saved_searches WHERE id = $1`, [created!.id]),
    );
    check('org A sees its own saved search', orgASeesIt.length === 1);

    // 6. Import dedupe through the same (org, source, source_id) path
    await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.exec(`INSERT INTO leadsource_leads (org_id, source, source_id) VALUES (app.current_org(), 'fl_sunbiz_cor', $1)
              ON CONFLICT (org_id, source, source_id) DO NOTHING`, [anyRaw.source_id]),
    );
    const importedCount = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.exec(`INSERT INTO leadsource_leads (org_id, source, source_id) VALUES (app.current_org(), 'fl_sunbiz_cor', $1)
              ON CONFLICT (org_id, source, source_id) DO NOTHING`, [anyRaw.source_id]),
    );
    check('re-importing the same source_id inserts zero additional rows', importedCount === 0);

    // 7. AI filter-assist — a real model call, loosely checked (never assert exact wording)
    const assisted = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      assistSearchFilters(q, orgAId, 'new roofing LLCs in Palm Beach County filed in the last 2 weeks'),
    );
    if (assisted === null) {
      console.log('  SKIP AI assist check — model call failed or cap exceeded (not a logic bug)');
    } else {
      check('AI assist picked up "roofing" as a name keyword', assisted.name_keywords.some((k) => k.toLowerCase().includes('roof')));
      check('AI assist picked a real FL county (PALM BEACH) from the request', assisted.counties.includes('PALM BEACH'));
      check('AI assist set a ~14-day window from "last 2 weeks"', assisted.file_date_window_days <= 21);
    }
  } finally {
    await withPlatform(async (q) => {
      await q.exec(`DELETE FROM organizations WHERE id = $1`, [orgAId]);
      await q.exec(`DELETE FROM organizations WHERE id = $1`, [orgBId]);
    });
    await shutdown();
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
