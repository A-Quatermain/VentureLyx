/**
 * Venturelyx :: LeadSource — repeatable verification script.
 *
 *   node dist/scripts/testLeadSource.js
 *
 * Same convention as testOperateIntake.ts: no test framework in this
 * codebase, so this follows its existing live-verification style instead
 * of introducing one. Covers the specific claims this feature's design
 * depends on:
 *   1. module off by default (checked against a disposable, never-touched org)
 *   2. an admin grant survives a simulated Stripe webhook sync — the actual
 *      claim at stake: does syncEntitlements() ever clobber modules.leadsource?
 *   3. cross-org isolation — two orgs, two leads with the SAME source_id,
 *      neither can see the other's row
 *   4. dedupe — inserting the same (org, source, source_id) twice only
 *      ever produces one row
 */
import { randomBytes } from 'node:crypto';
import { withPlatform, withTenant, shutdown, type Querier } from '../lib/db.js';
import { isModuleEnabled } from '../lib/moduleAccess.js';
import { syncEntitlements } from '../lib/billingEntitlements.js';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function createTestOrg(q: Querier, name: string): Promise<string> {
  const org = await q.one<{ id: string }>(
    `INSERT INTO organizations (slug, name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`test-${randomBytes(4).toString('hex')}`, name],
  );
  return org!.id;
}

async function main() {
  console.log('LeadSource verification\n');

  const orgAId = await withPlatform((q) => createTestOrg(q, 'LeadSource Test Org A'));
  const orgBId = await withPlatform((q) => createTestOrg(q, 'LeadSource Test Org B'));

  try {
    // 1. default off
    const freshOrg = await withPlatform((q) => q.one<{ modules: Record<string, boolean> }>(`SELECT modules FROM organizations WHERE id = $1`, [orgAId]));
    check('fresh org has leadsource off by default', !isModuleEnabled(freshOrg!.modules, 'leadsource', false));

    // 2. admin grant survives a simulated webhook sync
    await withPlatform((q) => q.exec(`UPDATE organizations SET modules = modules || '{"leadsource": true}'::jsonb WHERE id = $1`, [orgAId]));
    await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      syncEntitlements(q, orgAId, 'active', ['launch_growth_monthly']),
    );
    const afterSync = await withPlatform((q) => q.one<{ modules: Record<string, boolean> }>(`SELECT modules FROM organizations WHERE id = $1`, [orgAId]));
    check('leadsource grant survives syncEntitlements() with a real lookup key', afterSync!.modules.leadsource === true, JSON.stringify(afterSync!.modules));

    // Enable on both orgs for the isolation/dedupe checks below.
    await withPlatform((q) => q.exec(`UPDATE organizations SET modules = modules || '{"leadsource": true}'::jsonb WHERE id = $1`, [orgBId]));

    // A shared raw record both orgs will reference — read an existing one
    // rather than inserting a synthetic one: venturelyx_app (what this
    // script runs as) only has SELECT on leadsource_raw_records, by design
    // (040_leadsource.sql) — trying to INSERT here would just prove the
    // grant restriction works, not test leads/dedupe/isolation.
    const anyRaw = await withPlatform((q) =>
      q.one<{ source_id: string }>(`SELECT source_id FROM leadsource_raw_records WHERE source = 'fl_sunbiz_cor' LIMIT 1`),
    );
    if (!anyRaw) {
      console.log('  SKIP remaining checks — no leadsource_raw_records rows exist yet (run a real ingest first)');
      return;
    }
    const sharedSourceId = anyRaw.source_id;

    // 3. cross-org isolation
    await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.exec(`INSERT INTO leadsource_leads (org_id, source, source_id) VALUES ($1,'fl_sunbiz_cor',$2)`, [orgAId, sharedSourceId]),
    );
    const orgBSeesOrgALead = await withTenant({ orgId: orgBId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_leads WHERE source_id = $1`, [sharedSourceId]),
    );
    check('org B cannot see org A\'s lead row (same source_id)', orgBSeesOrgALead.length === 0);

    const orgASeesOwnLead = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_leads WHERE source_id = $1`, [sharedSourceId]),
    );
    check('org A sees its own lead row', orgASeesOwnLead.length === 1);

    // 4. dedupe — insert the same (org, source, source_id) again
    await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.exec(
        `INSERT INTO leadsource_leads (org_id, source, source_id) VALUES ($1,'fl_sunbiz_cor',$2) ON CONFLICT (org_id, source, source_id) DO NOTHING`,
        [orgAId, sharedSourceId],
      ),
    );
    const countAfterDupeInsert = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.rows<{ n: number }>(`SELECT count(*)::int AS n FROM leadsource_leads WHERE source_id = $1`, [sharedSourceId]),
    );
    check('dedupe: inserting the same (org, source, source_id) twice yields exactly one row', countAfterDupeInsert[0]!.n === 1);
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
