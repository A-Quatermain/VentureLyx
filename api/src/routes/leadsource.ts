/**
 * Venturelyx :: LeadSource — Florida Sunbiz public-filing leads.
 *
 * Reads are gated here too, not just writes — unlike every other module
 * (moduleAccess.ts's own header explains why "missing key = enabled" is
 * safe for those: an installed base predates the gate). Nothing predates
 * LeadSource; it ships default-disabled, so there's no "protect existing
 * access" reason to let a disabled org keep reading leads it was never
 * granted. requireLeadSourceEnabled() below is this file's own gate,
 * checked explicitly rather than relying on moduleWriteGate (which only
 * ever inspects write methods).
 *
 * Every route reads from leadsource_lead_detail (040_leadsource.sql), a
 * security_invoker view — never leadsource_raw_records directly, which
 * would bypass the one column list this file is allowed to show (no
 * officer names/addresses, ever — see the view's own header).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/auth.js';
import { HttpError, requireProvisioned } from '../plugins/context.js';
import { isModuleEnabled } from '../lib/moduleAccess.js';

async function requireLeadSourceEnabled(req: FastifyRequest): Promise<void> {
  const row = await req.db((q) =>
    q.one<{ modules: Record<string, boolean> | null }>(`SELECT modules FROM organizations WHERE id = $1`, [req.ctx.orgId]),
  );
  if (!isModuleEnabled(row?.modules, 'leadsource', false)) {
    throw new HttpError(403, 'LeadSource is turned off for this business. Ask your account team to turn it on.', 'module_disabled');
  }
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const settingsInput = z.object({
  counties: z.array(z.string().trim().min(1).max(40)).max(20),
  filing_types: z.array(z.string().trim().min(1).max(10)).max(20),
  file_date_window_days: z.number().int().min(1).max(365),
  include_dba: z.boolean(),
});

export default async function leadSourceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireProvisioned);

  app.get('/leadsource/settings', async (req) => {
    req.requireRole('viewer');
    await requireLeadSourceEnabled(req);
    return req.db(async (q) => {
      const row = await q.one(
        `SELECT counties, filing_types, file_date_window_days, include_dba, updated_at
           FROM leadsource_settings WHERE org_id = app.current_org()`,
      );
      // Defaults mirror the column defaults in 040_leadsource.sql — an org
      // that's never saved settings yet still gets a sane starting point
      // to edit, not a blank form.
      return row ?? {
        counties: ['BROWARD', 'PALM BEACH'], filing_types: ['DOMP', 'FLAL', 'FORP', 'FORL'],
        file_date_window_days: 7, include_dba: false, updated_at: null,
      };
    });
  });

  app.patch('/leadsource/settings', async (req) => {
    req.requireRole('owner');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);
    const body = settingsInput.parse(req.body);

    return req.db(async (q) => {
      const row = await q.one(
        `INSERT INTO leadsource_settings (org_id, counties, filing_types, file_date_window_days, include_dba, updated_by)
         VALUES (app.current_org(), $1, $2, $3, $4, $5)
         ON CONFLICT (org_id) DO UPDATE SET
           counties = EXCLUDED.counties, filing_types = EXCLUDED.filing_types,
           file_date_window_days = EXCLUDED.file_date_window_days, include_dba = EXCLUDED.include_dba,
           updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING counties, filing_types, file_date_window_days, include_dba, updated_at`,
        [body.counties.map((c) => c.toUpperCase()), body.filing_types.map((t) => t.toUpperCase()),
          body.file_date_window_days, body.include_dba, sess.user_id],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.settings.update', ip: req.ip, diff: body,
      });
      return row;
    });
  });

  const leadsQuery = z.object({
    enrichment_status: z.enum(['new', 'enriching', 'enriched', 'skipped']).optional(),
    source: z.enum(['fl_sunbiz_cor', 'fl_sunbiz_fic']).optional(),
  });

  app.get('/leadsource/leads', async (req) => {
    req.requireRole('viewer');
    await requireLeadSourceEnabled(req);
    const { enrichment_status, source } = leadsQuery.parse(req.query);

    return req.db((q) =>
      q.rows(
        `SELECT id, source, source_id, enrichment_status, business_name, business_type,
                principal_address, principal_city, principal_state, principal_zip,
                file_date, registered_agent_name, registered_agent_type, phone, email,
                first_seen_at, last_seen_at
           FROM leadsource_lead_detail
          WHERE ($1::text IS NULL OR enrichment_status = $1)
            AND ($2::text IS NULL OR source = $2)
          ORDER BY first_seen_at DESC
          LIMIT 1000`,
        [enrichment_status ?? null, source ?? null],
      ),
    );
  });

  app.patch('/leadsource/leads/:id', async (req) => {
    req.requireRole('manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { enrichment_status } = z.object({ enrichment_status: z.enum(['new', 'enriching', 'enriched', 'skipped']) }).parse(req.body);
    await requireLeadSourceEnabled(req);

    return req.db(async (q) => {
      const updated = await q.one<{ id: string }>(
        `UPDATE leadsource_leads SET enrichment_status = $2 WHERE id = $1 RETURNING id`,
        [id, enrichment_status],
      );
      if (!updated) throw new HttpError(404, 'Lead not found', 'not_found');
      return { ok: true };
    });
  });

  // Owner-only, audited — this is the one place officer data could
  // theoretically leak if the view's own column list were ever widened by
  // mistake, so the export path gets the strictest role of anything in
  // this file, on top of the view already never projecting it.
  app.get('/leadsource/leads/export.csv', async (req, reply) => {
    req.requireRole('owner');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);

    const rows = await req.db(async (q) => {
      await audit(q, { orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.leads.export', ip: req.ip });
      return q.rows<{
        business_name: string | null; principal_address: string | null; principal_city: string | null;
        principal_state: string | null; principal_zip: string | null; phone: string | null;
        email: string | null; business_type: string | null;
      }>(
        `SELECT business_name, principal_address, principal_city, principal_state, principal_zip,
                phone, email, business_type
           FROM leadsource_lead_detail ORDER BY first_seen_at DESC`,
      );
    });

    // Exactly the 5 fields asked for — principal address is one combined
    // field (street, city, state zip), never split into its own columns
    // here even though the view has them separately for the on-screen
    // list's filters.
    const header = ['business_name', 'principal_address', 'phone', 'email', 'business_type'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const combinedAddress = [r.principal_address, r.principal_city, [r.principal_state, r.principal_zip].filter(Boolean).join(' ')]
        .filter(Boolean).join(', ');
      lines.push([
        csvEscape(r.business_name), csvEscape(combinedAddress), csvEscape(r.phone), csvEscape(r.email), csvEscape(r.business_type),
      ].join(','));
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="leadsource-${new Date().toISOString().slice(0, 10)}.csv"`);
    return lines.join('\n');
  });
}
