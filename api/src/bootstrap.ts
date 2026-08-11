/**
 * Venturelyx :: create or update a platform-staff user.
 *
 * Reads from the environment so it never touches stdin. The earlier readline
 * version consumed the stream on the first hidden prompt and crashed on the
 * second. Drive it from the shell:
 *
 *   docker exec -i -e VX_EMAIL=... -e VX_NAME=... -e VX_PW=... \\
 *     vx-api node dist/bootstrap.js
 */
import { withPlatform, shutdown } from './lib/db.js';
import { hashPassword } from './lib/auth.js';

const email = (process.env.VX_EMAIL ?? '').trim().toLowerCase();
const name = (process.env.VX_NAME ?? '').trim();
const pw = process.env.VX_PW ?? '';

if (!email || !name || pw.length < 12) {
  console.error('Set VX_EMAIL, VX_NAME and VX_PW (12+ chars).');
  process.exit(1);
}

const hashed = await hashPassword(pw);

await withPlatform(async (q) => {
  const existing = await q.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  let userId: string;

  if (existing) {
    await q.exec(
      `UPDATE users SET password_hash=$2, full_name=$3, is_platform_staff=true,
                        failed_logins=0, locked_until=NULL, email_verified_at=now()
        WHERE id=$1`,
      [existing.id, hashed, name]);
    userId = existing.id;
    console.log(`Updated user ${email}`);
  } else {
    const u = await q.one<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, is_platform_staff, email_verified_at)
       VALUES ($1,$2,$3,true,now()) RETURNING id`,
      [email, name, hashed]);
    if (!u) throw new Error('failed to create user');
    userId = u.id;
    console.log(`Created user ${email}`);
  }

  const orgs = await q.rows<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE deleted_at IS NULL ORDER BY name');
  for (const o of orgs) {
    await q.exec(
      `INSERT INTO memberships (org_id, user_id, role, accepted_at)
       VALUES ($1,$2,'owner', now())
       ON CONFLICT (org_id, user_id) DO UPDATE SET role='owner'`,
      [o.id, userId]);
  }
  console.log(`Owner of ${orgs.length}: ${orgs.map((o) => o.name).join(', ')}`);
});

await shutdown();
