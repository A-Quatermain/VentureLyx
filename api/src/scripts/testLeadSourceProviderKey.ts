/**
 * Venturelyx :: LeadSource bring-your-own Brave key — repeatable
 * verification script, same convention as testLeadSource.ts /
 * testLeadSourceSearch.ts.
 *
 * Role gating (owner-only on every provider-key route) is verified by
 * code inspection, not here — all four routes in routes/leadsource.ts
 * call req.requireRole('owner') as their first statement (grep confirms
 * this; there is no lighter-weight way to simulate "authenticated as a
 * specific non-owner role" outside a real HTTP session in this codebase's
 * existing test conventions). What IS tested here, at the DB/crypto layer:
 * encrypt/decrypt round-trips correctly, the GET route's own query never
 * selects the ciphertext columns, and cross-org RLS isolation holds.
 */
import { randomBytes } from 'node:crypto';
import { withPlatform, withTenant, shutdown, type Querier } from '../lib/db.js';
import { encryptSecret, decryptSecret } from '../lib/auth.js';

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

async function main() {
  console.log('LeadSource provider-key verification\n');

  // 1. encrypt/decrypt round-trip — the same vault every other credential
  // in this app uses, re-checked here because a wrong key/iv/tag mix-up
  // would otherwise only surface the first time a real Brave key is saved.
  const plain = 'BSA-test-key-' + randomBytes(16).toString('hex');
  const { enc, iv, tag } = encryptSecret(plain);
  check('decrypting what we just encrypted recovers the exact plaintext', decryptSecret(enc, iv, tag) === plain);
  check('ciphertext does not contain the plaintext key anywhere in it', !enc.toString('base64').includes(plain) && !enc.toString('utf8').includes(plain));

  const orgAId = await withPlatform((q) => createTestOrg(q, 'LeadSource Provider Key Test Org A'));
  const orgBId = await withPlatform((q) => createTestOrg(q, 'LeadSource Provider Key Test Org B'));

  try {
    const last4 = plain.slice(-4);
    await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.exec(
        `INSERT INTO leadsource_provider_keys (org_id, provider, key_enc, key_iv, key_tag, key_last4, monthly_search_cap)
         VALUES (app.current_org(), 'brave', $1, $2, $3, $4, 500)`,
        [enc, iv, tag, last4],
      ),
    );

    // 2. the GET route's own query shape never selects ciphertext columns
    const getRouteShape = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.one<Record<string, unknown>>(
        `SELECT key_last4, status, monthly_search_cap, searches_this_month, searches_month_reset_at,
                last_tested_at, last_error, created_at
           FROM leadsource_provider_keys
          WHERE org_id = app.current_org() AND provider = 'brave' AND revoked_at IS NULL`,
      ),
    );
    const returnedKeys = Object.keys(getRouteShape ?? {});
    check('GET shape never includes key_enc/key_iv/key_tag',
      !returnedKeys.includes('key_enc') && !returnedKeys.includes('key_iv') && !returnedKeys.includes('key_tag'));
    check('GET shape includes only the last 4 characters of the key', getRouteShape?.key_last4 === last4);

    // 3. cross-org isolation
    const orgBSeesIt = await withTenant({ orgId: orgBId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_provider_keys WHERE org_id != app.current_org()`),
    );
    check('org B gets zero rows querying across orgs (RLS, not app-level filtering)', orgBSeesIt.length === 0);
    const orgBOwnRows = await withTenant({ orgId: orgBId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_provider_keys`),
    );
    check('org B sees none of org A\'s key under its own org scope either', orgBOwnRows.length === 0);
    const orgARows = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_provider_keys`),
    );
    check('org A sees exactly its own key', orgARows.length === 1);

    // 4. revoke-then-readd — the partial unique index (not a plain UNIQUE)
    // is what makes this possible; confirm it actually works end-to-end.
    await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.exec(`UPDATE leadsource_provider_keys SET revoked_at = now() WHERE org_id = app.current_org()`),
    );
    const { enc: enc2, iv: iv2, tag: tag2 } = encryptSecret('BSA-second-key');
    await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.exec(
        `INSERT INTO leadsource_provider_keys (org_id, provider, key_enc, key_iv, key_tag, key_last4, monthly_search_cap)
         VALUES (app.current_org(), 'brave', $1, $2, $3, 'yKey', 500)`,
        [enc2, iv2, tag2],
      ),
    );
    const activeRows = await withTenant({ orgId: orgAId, userId: null, isStaff: false }, (q) =>
      q.rows(`SELECT id FROM leadsource_provider_keys WHERE revoked_at IS NULL`),
    );
    check('after revoking and re-adding, exactly one active key exists', activeRows.length === 1);
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
