/**
 * Venturelyx :: create the first user.
 *
 *   docker compose ... exec api node dist/bootstrap.js
 *
 * Interactive. Creates a platform-staff user and attaches them as owner of
 * every existing organization, so you can sign in and see the seeded sites.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { withPlatform, shutdown } from './lib/db.js';
import { hashPassword } from './lib/auth.js';

const rl = createInterface({ input: stdin, output: stdout });

async function secret(prompt: string): Promise<string> {
  // Suppress echo so the password never appears on screen or in scrollback.
  stdout.write(prompt);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  let out = '';
  for await (const chunk of stdin) {
    const s = chunk.toString();
    if (s === '\r' || s === '\n' || s === '\u0004') break;
    if (s === '\u0003') { stdout.write('\n'); process.exit(130); }
    if (s === '\u007f') { out = out.slice(0, -1); continue; }
    out += s;
  }
  stdin.setRawMode?.(wasRaw ?? false);
  stdout.write('\n');
  return out;
}

const email = (await rl.question('Email: ')).trim().toLowerCase();
const name = (await rl.question('Full name: ')).trim();
const pw = await secret('Password (min 12 chars, will not echo): ');
const pw2 = await secret('Confirm password: ');
rl.close();

if (pw.length < 12) { console.error('\nPassword must be at least 12 characters.'); process.exit(1); }
if (pw !== pw2) { console.error('\nPasswords do not match.'); process.exit(1); }

const hashed = await hashPassword(pw);

await withPlatform(async (q) => {
  const existing = await q.one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  let userId: string;
  if (existing) {
    await q.exec(
      `UPDATE users SET password_hash = $2, full_name = $3, is_platform_staff = true,
                        failed_logins = 0, locked_until = NULL
        WHERE id = $1`,
      [existing.id, hashed, name],
    );
    userId = existing.id;
    console.log(`\nUpdated existing user ${email}`);
  } else {
    const u = await q.one<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, is_platform_staff, email_verified_at)
       VALUES ($1,$2,$3,true, now()) RETURNING id`,
      [email, name, hashed],
    );
    if (!u) throw new Error('failed to create user');
    userId = u.id;
    console.log(`\nCreated user ${email}`);
  }

  const orgs = await q.rows<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE deleted_at IS NULL ORDER BY name`,
  );
  for (const o of orgs) {
    await q.exec(
      `INSERT INTO memberships (org_id, user_id, role, accepted_at)
       VALUES ($1,$2,'owner', now())
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner'`,
      [o.id, userId],
    );
  }
  console.log(`Owner of ${orgs.length} business(es): ${orgs.map((o) => o.name).join(', ')}`);
});

console.log('\nDone. Sign in at https://app.venturelyx.com');
console.log('Set up two-factor from Settings once you are in.\n');
await shutdown();
