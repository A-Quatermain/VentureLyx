/**
 * Venturelyx :: staff admin console API.
 *
 * Every route here is staff-only, and "staff-only" means invisible to
 * everyone else — a non-staff caller gets reply.callNotFound() (Fastify's
 * own 404, byte-identical to hitting a route that was never registered),
 * never 401/403. A 403 would confirm this surface exists to anyone probing
 * it; 404 doesn't. The frontend's admin/layout.tsx does the same thing
 * server-side with Next's notFound() — this is the API-side half of that,
 * necessary in its own right since these routes are reachable directly.
 *
 * requireStaffOrNotFound() checks req.session.is_platform_staff directly,
 * not req.ctx.isStaff — ctx.isStaff (lib/db.ts's TenantContext, set by
 * plugins/context.ts) is only true when a staff user has NO org selected;
 * it goes false the moment they switch into a client's org, which an admin
 * console must not be gated on.
 *
 * Every route — reads included, not just writes — logs to audit_log with
 * staff_mode true, per the brief: staff impersonating/inspecting client
 * accounts and platform data is exactly the kind of access that needs a
 * trail regardless of whether anything changed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withPlatform, type Querier } from '../lib/db.js';

function requireStaffOrNotFound(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.session?.mfa_satisfied || !req.session.is_platform_staff) {
    reply.callNotFound();
    return false;
  }
  return true;
}

async function auditAdmin(
  q: Querier, req: FastifyRequest, action: string, diff?: unknown,
): Promise<void> {
  await q.exec(
    `INSERT INTO audit_log (org_id, actor_user, actor_type, action, staff_mode, ip, diff)
     VALUES (NULL, $1, 'user', $2, true, $3, $4)`,
    [req.session!.user_id, action, req.ip, diff ? JSON.stringify(diff) : null],
  );
}

// db/migrations/001_platform_core.sql's own comment on organizations.modules:
// '{"scaleseo": true, "operate": true, "ai_team": false}' — this list exists
// to render/validate the toggle UI against that same key convention, not to
// introduce a second one. Kept here rather than shared with
// web/src/lib/modules.ts because that file's keys are hyphenated route
// slugs ('ai-team'), a different, frontend-only concern.
const MODULE_KEYS = ['build', 'source', 'operate', 'scaleseo', 'grow', 'ai_team', 'reviews'] as const;

const WAITLIST_STATUSES = ['new', 'contacted', 'converted'] as const;

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function adminRoutes(app: FastifyInstance) {
  // ---- Dashboard ------------------------------------------------------------
  app.get('/admin/summary', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;

    return withPlatform(async (q) => {
      await auditAdmin(q, req, 'admin.summary.view');
      const [users, orgs, waitlistNew] = await Promise.all([
        q.one<{ n: string | number }>(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`),
        q.one<{ n: string | number }>(`SELECT COUNT(*) AS n FROM organizations WHERE deleted_at IS NULL`),
        q.one<{ n: string | number }>(`SELECT COUNT(*) AS n FROM waitlist WHERE status = 'new'`),
      ]);
      return {
        userCount: Number(users?.n ?? 0),
        orgCount: Number(orgs?.n ?? 0),
        waitlistNewCount: Number(waitlistNew?.n ?? 0),
      };
    });
  });

  // ---- Users ------------------------------------------------------------
  app.get('/admin/users', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;

    return withPlatform(async (q) => {
      await auditAdmin(q, req, 'admin.users.list');
      return q.rows(
        `SELECT id, email, full_name, is_platform_staff,
                (totp_enabled_at IS NOT NULL) AS mfa_enabled,
                last_login_at, created_at
           FROM users
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC`,
      );
    });
  });

  // ---- Organizations ------------------------------------------------------
  app.get('/admin/organizations', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;

    return withPlatform(async (q) => {
      await auditAdmin(q, req, 'admin.organizations.list');
      return q.rows(
        `SELECT o.id, o.name, o.slug, o.status, o.vertical, o.modules, o.created_at,
                owner.email AS owner_email,
                COALESCE(mem.n, 0)::int AS member_count,
                COALESCE(sites.n, 0)::int AS site_count
           FROM organizations o
      LEFT JOIN LATERAL (
                  SELECT u.email FROM memberships m
                    JOIN users u ON u.id = m.user_id
                   WHERE m.org_id = o.id AND m.role = 'owner'
                   ORDER BY m.created_at LIMIT 1
                ) owner ON true
      LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM memberships m WHERE m.org_id = o.id) mem ON true
      LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM seo_sites s WHERE s.org_id = o.id) sites ON true
          WHERE o.deleted_at IS NULL
          ORDER BY o.created_at DESC`,
      );
    });
  });

  app.get('/admin/organizations/:id', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return withPlatform(async (q) => {
      const org = await q.one(
        `SELECT id, name, slug, status, vertical, website_url, modules, created_at
           FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (!org) return reply.callNotFound();

      await auditAdmin(q, req, 'admin.organization.view', { org_id: id });

      const [members, sites] = await Promise.all([
        q.rows(
          `SELECT u.id, u.email, u.full_name, m.role, m.created_at AS member_since
             FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.org_id = $1 ORDER BY m.created_at`,
          [id],
        ),
        q.rows(
          `SELECT id, in_health_score, is_primary FROM seo_sites WHERE org_id = $1`,
          [id],
        ),
      ]);

      return { ...org, members, sites };
    });
  });

  const modulesUpdateInput = z.object({
    modules: z.record(z.enum(MODULE_KEYS), z.boolean()),
  });

  // Manual entitlement toggle for founding clients ahead of Stripe — see
  // the chat response this shipped with for the scope boundary: this
  // records intent in organizations.modules, it does not (yet) gate access
  // anywhere else in the app. Merges into the existing jsonb rather than
  // replacing it, so a partial {grow: false} body only touches that key.
  app.patch('/admin/organizations/:id/modules', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = modulesUpdateInput.parse(req.body);

    return withPlatform(async (q) => {
      const before = await q.one<{ modules: Record<string, boolean> }>(
        `SELECT modules FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (!before) return reply.callNotFound();

      const merged = { ...before.modules, ...body.modules };
      const updated = await q.one(
        `UPDATE organizations SET modules = $2, updated_at = now()
          WHERE id = $1 RETURNING id, modules`,
        [id, JSON.stringify(merged)],
      );

      await auditAdmin(q, req, 'admin.organization.modules_update', {
        org_id: id, before: before.modules, after: merged,
      });

      return updated;
    });
  });

  // ---- Waitlist -----------------------------------------------------------
  const waitlistQuery = z.object({ status: z.enum(WAITLIST_STATUSES).optional() });

  app.get('/admin/waitlist', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { status } = waitlistQuery.parse(req.query);

    return withPlatform(async (q) => {
      await auditAdmin(q, req, 'admin.waitlist.list', { status: status ?? null });
      return q.rows(
        `SELECT id, email, business_name, website_url, phone, interest,
                source_page, status, notes, created_at, updated_at
           FROM waitlist
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY created_at DESC`,
        [status ?? null],
      );
    });
  });

  app.get('/admin/waitlist/export.csv', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;

    const rows = await withPlatform(async (q) => {
      await auditAdmin(q, req, 'admin.waitlist.export');
      return q.rows<Record<string, unknown>>(
        `SELECT email, business_name, website_url, phone, interest,
                source_page, status, notes, created_at
           FROM waitlist ORDER BY created_at DESC`,
      );
    });

    const header = ['email', 'business_name', 'website_url', 'phone', 'interest', 'source_page', 'status', 'notes', 'created_at'];
    const lines = [header.join(',')];
    for (const r of rows) lines.push(header.map((h) => csvEscape(r[h])).join(','));

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="waitlist-${new Date().toISOString().slice(0, 10)}.csv"`);
    return lines.join('\n');
  });

  const waitlistUpdateInput = z.object({
    status: z.enum(WAITLIST_STATUSES).optional(),
    notes: z.string().max(5000).optional(),
  });

  app.patch('/admin/waitlist/:id', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = waitlistUpdateInput.parse(req.body);

    return withPlatform(async (q) => {
      const existing = await q.one(`SELECT id FROM waitlist WHERE id = $1`, [id]);
      if (!existing) return reply.callNotFound();

      const updated = await q.one(
        `UPDATE waitlist SET
           status = COALESCE($2, status),
           notes  = COALESCE($3, notes),
           updated_at = now()
         WHERE id = $1
         RETURNING id, email, status, notes, updated_at`,
        [id, body.status ?? null, body.notes ?? null],
      );

      await auditAdmin(q, req, 'admin.waitlist.update', { waitlist_id: id, ...body });

      return updated;
    });
  });
}
