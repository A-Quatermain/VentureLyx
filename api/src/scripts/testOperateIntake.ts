/**
 * Venturelyx :: Operate intake — repeatable smoke test.
 *
 *   node dist/scripts/testOperateIntake.js
 *
 * No test framework in this codebase today — every feature this session
 * has been verified live against the real running stack rather than a
 * unit-test suite, and this follows that same convention: real HTTP
 * requests against the real route, the real Redis-backed rate limiter,
 * two disposable orgs created and torn down by this run, never touching
 * Amber Cove / AC of South Florida or any other real org.
 *
 * BASE_URL defaults to the API's own loopback — matches how the
 * container's own healthcheck reaches itself (docker-compose.app.yml).
 * Run this via `docker exec vx-api node dist/scripts/testOperateIntake.js`
 * so it resolves against the real deployed container, not a dev server.
 */
import { randomBytes } from 'node:crypto';
import { withPlatform, shutdown, type Querier } from '../lib/db.js';
import { hashIntakeKey } from '../routes/operateIntake.js';

const BASE_URL = process.env.OPERATE_INTAKE_TEST_BASE_URL ?? 'http://127.0.0.1:3000/v1';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function createTestOrg(q: Querier, name: string): Promise<string> {
  const org = await q.one<{ id: string }>(
    `INSERT INTO organizations (slug, name, status) VALUES ($1, $2, 'onboarding') RETURNING id`,
    [`test-${randomBytes(4).toString('hex')}`, name],
  );
  return org!.id;
}

async function createIntakeKey(q: Querier, orgId: string, label: string): Promise<string> {
  const rawKey = `vxik_${randomBytes(24).toString('base64url')}`;
  await q.exec(
    `INSERT INTO operate_intake_keys (org_id, key_hash, key_prefix, label) VALUES ($1,$2,$3,$4)`,
    [orgId, hashIntakeKey(rawKey), rawKey.slice(0, 12), label],
  );
  return rawKey;
}

async function post(key: string | null, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/operate/intake`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, json };
}

async function main() {
  console.log(`Operate intake smoke test — ${BASE_URL}\n`);

  const setup = await withPlatform(async (q) => {
    const orgAId = await createTestOrg(q, 'Intake Test Org A');
    const orgBId = await createTestOrg(q, 'Intake Test Org B');
    const keyA = await createIntakeKey(q, orgAId, 'smoke-test-a');
    const keyARevoked = await createIntakeKey(q, orgAId, 'smoke-test-a-revoked');
    await q.exec(`UPDATE operate_intake_keys SET revoked_at = now() WHERE key_hash = $1`, [hashIntakeKey(keyARevoked)]);
    const keyB = await createIntakeKey(q, orgBId, 'smoke-test-b');
    return { orgAId, orgBId, keyA, keyARevoked, keyB };
  });
  const { orgAId, orgBId, keyA, keyARevoked, keyB } = setup;

  try {
    // 1. valid request
    const ref1 = `smoke-${randomBytes(4).toString('hex')}`;
    const r1 = await post(keyA, { name: 'Jane Smoke', email: 'jane@smoketest.example', reference: ref1, details: { service: 'inspection' } });
    check('valid request -> 201', r1.status === 201, `got ${r1.status}`);
    check('valid request returns party_id + deal_id', !!r1.json.party_id && !!r1.json.deal_id);

    // 2. revoked key
    const r2 = await post(keyARevoked, { name: 'X', email: 'x@smoketest.example', reference: 'rev-1' });
    check('revoked key -> 401', r2.status === 401, `got ${r2.status}`);

    // 3. bad key / missing auth
    const r3 = await post('not_a_real_key', { name: 'X', email: 'x@smoketest.example', reference: 'bad-1' });
    check('bad key -> 401', r3.status === 401, `got ${r3.status}`);
    const r3b = await post(null, { name: 'X', email: 'x@smoketest.example', reference: 'noauth-1' });
    check('missing Authorization -> 401', r3b.status === 401, `got ${r3b.status}`);

    // 4. dedupe — same reference again returns the SAME party, 200 not 201
    const r4 = await post(keyA, { name: 'Jane Smoke', email: 'jane@smoketest.example', reference: ref1 });
    check('same reference again -> 200', r4.status === 200, `got ${r4.status}`);
    check('dedupe returns the SAME party_id', r4.json.party_id === r1.json.party_id, `${r4.json.party_id} vs ${r1.json.party_id}`);

    // 5. unknown stage
    const r5 = await post(keyA, { name: 'Bad Stage', email: 'badstage@smoketest.example', reference: `stage-${randomBytes(4).toString('hex')}`, stage: 'not_a_real_stage' });
    check('unknown stage -> 400', r5.status === 400, `got ${r5.status}`);

    // 6. oversize details (>8KB)
    const r6 = await post(keyA, { name: 'Big', email: 'big@smoketest.example', reference: `big-${randomBytes(4).toString('hex')}`, details: { blob: 'x'.repeat(9000) } });
    check('oversize details -> 400', r6.status === 400, `got ${r6.status}`);

    // 7. cross-org isolation — the same reference string, under a DIFFERENT
    // org's key, must create its OWN party, never dedupe against org A's
    // row (UNIQUE(org_id, reference), not UNIQUE(reference)).
    const sharedRef = `shared-${randomBytes(4).toString('hex')}`;
    const r7a = await post(keyA, { name: 'Org A Shared-Ref Lead', email: 'orga-shared@smoketest.example', reference: sharedRef });
    const r7b = await post(keyB, { name: 'Org B Shared-Ref Lead', email: 'orgb-shared@smoketest.example', reference: sharedRef });
    check('org A gets 201 for the shared reference', r7a.status === 201, `got ${r7a.status}`);
    check('org B ALSO gets 201 for the same reference (no cross-org dedupe)', r7b.status === 201, `got ${r7b.status}`);
    check('org A and org B get DIFFERENT party_ids', r7a.json.party_id !== r7b.json.party_id);
    const crossCheck = await withPlatform((q) =>
      q.rows<{ org_id: string }>(`SELECT org_id FROM operate_intake_log WHERE reference = $1`, [sharedRef]),
    );
    check('exactly two intake_log rows exist for the shared reference, one per org',
      crossCheck.length === 2 && new Set(crossCheck.map((r) => r.org_id)).size === 2);

    // 8. rate limit — 61st request in the same minute for keyA must 429.
    // Run last/deliberately heavy: burns real rate-limit budget on keyA.
    let rateLimited = false;
    for (let i = 0; i < 61; i++) {
      const r = await post(keyA, { name: 'RL', email: `rl${i}@smoketest.example`, reference: `rl-${i}-${randomBytes(2).toString('hex')}` });
      if (r.status === 429) { rateLimited = true; break; }
    }
    check('61st request in a minute -> 429', rateLimited);
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
