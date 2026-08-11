/**
 * Venturelyx :: authentication primitives.
 */
import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { TOTP, Secret } from 'otpauth';
import type { Querier } from './db.js';

// --- Passwords: argon2id at OWASP-recommended parameters -------------------
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string) => argonHash(plain, ARGON);

export async function verifyPassword(hashStr: string | null, plain: string): Promise<boolean> {
  // Spend the work even when the user does not exist, so response time never
  // reveals which emails are registered.
  if (!hashStr) {
    await argonHash('dummy-password-for-constant-time', ARGON);
    return false;
  }
  try { return await argonVerify(hashStr, plain); } catch { return false; }
}

// --- Sessions: opaque token out, only its SHA-256 stored -------------------
export const SESSION_COOKIE = 'vx_session';
export const SESSION_TTL_DAYS = 14;

export const newSessionToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface SessionRow {
  id: string;
  user_id: string;
  org_id: string | null;
  mfa_satisfied: boolean;
  expires_at: Date;
  is_platform_staff: boolean;
  email: string;
  full_name: string;
}

export async function loadSession(q: Querier, token: string): Promise<SessionRow | null> {
  return q.one<SessionRow>(
    `SELECT s.id, s.user_id, s.org_id, s.mfa_satisfied, s.expires_at,
            u.is_platform_staff, u.email, u.full_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.deleted_at IS NULL`,
    [hashToken(token)],
  );
}

// --- TOTP ------------------------------------------------------------------
export function makeTotp(secretBase32: string, email: string): TOTP {
  return new TOTP({
    issuer: 'Venturelyx', label: email, algorithm: 'SHA1',
    digits: 6, period: 30, secret: Secret.fromBase32(secretBase32),
  });
}

export const newTotpSecret = () => new Secret({ size: 20 }).base32;

export function verifyTotp(secretBase32: string, email: string, code: string): boolean {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== 6) return false;
  return makeTotp(secretBase32, email).validate({ token: clean, window: 1 }) !== null;
}

// --- Vault: AES-256-GCM for third-party credentials ------------------------
function vaultKey(): Buffer {
  const hex = process.env.VAULT_KEY ?? '';
  if (hex.length !== 64) throw new Error('VAULT_KEY must be 64 hex characters (32 bytes)');
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', vaultKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { enc, iv, tag: c.getAuthTag() };
}

export function decryptSecret(enc: Buffer, iv: Buffer, tag: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', vaultKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// --- Audit: append-only ----------------------------------------------------
export async function audit(
  q: Querier,
  entry: {
    orgId: string | null; actorUser: string | null; action: string;
    entityType?: string; entityId?: string; staffMode?: boolean;
    ip?: string; diff?: unknown;
  },
): Promise<void> {
  await q.exec(
    `INSERT INTO audit_log (org_id, actor_user, actor_type, action, entity_type,
                            entity_id, staff_mode, ip, diff)
     VALUES ($1,$2,'user',$3,$4,$5,$6,$7,$8)`,
    [
      entry.orgId, entry.actorUser, entry.action,
      entry.entityType ?? null, entry.entityId ?? null,
      entry.staffMode ?? false, entry.ip ?? null,
      entry.diff ? JSON.stringify(entry.diff) : null,
    ],
  );
}

// --- Roles -----------------------------------------------------------------
export type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
const RANK: Record<Role, number> = { owner: 5, admin: 4, manager: 3, staff: 2, viewer: 1 };
export const atLeast = (role: Role, needed: Role) => RANK[role] >= RANK[needed];
