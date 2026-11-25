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
import { guessBusinessType } from '../lib/businessTypeGuess.js';
import { assistSearchFilters } from '../lib/leadSourceSearchAssist.js';
import { zipMatchesCounties } from '../lib/flZipCounty.js';
import { encryptSecret, decryptSecret } from '../lib/auth.js';
import { testBraveKey } from '../lib/braveProviderKey.js';
import { buildDefaultFilters, orgServiceAreaStates } from '../lib/leadSourceDefaults.js';
import { STATE_CATALOG, SUPPORTED_STATES } from '../lib/leadSourceStateCatalog.js';

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

const filtersInput = z.object({
  counties: z.array(z.string().trim().max(40)).max(67).default([]),
  zips: z.array(z.string().trim().max(10)).max(200).default([]),
  filing_types: z.array(z.string().trim().max(10)).max(20).default([]),
  file_date_window_days: z.number().int().min(1).max(365).default(30),
  name_keywords: z.array(z.string().trim().max(60)).max(20).default([]),
  include_dba: z.boolean().default(false),
});
export type Filters = z.infer<typeof filtersInput>;

interface RawRecordRow { source: string; source_id: string; raw: Record<string, unknown> }

/** Runs a filter set against leadsource_raw_records directly — read-only
 *  (the app role only has SELECT on this table by design, 040_leadsource.sql),
 *  in-memory rather than pushed into SQL: at this data volume (low
 *  thousands of rows) that's simpler and exactly as correct as a bigger
 *  query, and county-matching for corporate records has to happen in code
 *  either way (no County column on that source — see flZipCounty.ts). */
export async function runFilters(q: import('../lib/db.js').Querier, filters: Filters) {
  const rows = await q.rows<RawRecordRow>(
    `SELECT source, source_id, raw FROM leadsource_raw_records WHERE source = 'fl_sunbiz_cor'`,
  );
  const today = new Date();
  const wantedFilingTypes = filters.filing_types.length > 0 ? new Set(filters.filing_types) : null;
  const wantedZips = filters.zips.length > 0 ? new Set(filters.zips.map((z) => z.slice(0, 5))) : null;
  const keywords = filters.name_keywords.map((k) => k.toUpperCase());

  const matchesCor = (raw: Record<string, unknown>): boolean => {
    if (raw.status !== 'A') return false;
    if (wantedFilingTypes && !wantedFilingTypes.has(raw.filing_type as string)) return false;
    const fileDate = typeof raw.file_date === 'string' ? raw.file_date : '';
    if (fileDate.length === 8) {
      const mm = Number(fileDate.slice(0, 2)), dd = Number(fileDate.slice(2, 4)), yyyy = Number(fileDate.slice(4, 8));
      const d = new Date(yyyy, mm - 1, dd);
      const ageDays = Math.round((today.getTime() - d.getTime()) / 86_400_000);
      if (ageDays > filters.file_date_window_days) return false;
    }
    const zip = typeof raw.zip === 'string' ? raw.zip : '';
    if (filters.counties.length > 0 && !zipMatchesCounties(zip, filters.counties)) return false;
    if (wantedZips && !wantedZips.has(zip.slice(0, 5))) return false;
    if (keywords.length > 0) {
      const name = ((raw.corp_name as string) || '').toUpperCase();
      if (!keywords.some((k) => name.includes(k))) return false;
    }
    return true;
  };

  const matched = rows.filter((r) => matchesCor(r.raw));

  let matchedFic: RawRecordRow[] = [];
  if (filters.include_dba) {
    const ficRows = await q.rows<RawRecordRow>(
      `SELECT source, source_id, raw FROM leadsource_raw_records WHERE source = 'fl_sunbiz_fic'`,
    );
    const wantedCounties = new Set(filters.counties.map((c) => c.toUpperCase()));
    matchedFic = ficRows.filter((r) => {
      const county = ((r.raw.county as string) || '').toUpperCase();
      if (filters.counties.length > 0 && county !== 'MULTIPLE' && !wantedCounties.has(county)) return false;
      if (keywords.length > 0) {
        const name = ((r.raw.name as string) || '').toUpperCase();
        if (!keywords.some((k) => name.includes(k))) return false;
      }
      return true;
    });
  }

  return [...matched, ...matchedFic].slice(0, 500).map((r) => ({
    source: r.source,
    source_id: r.source_id,
    business_name: (r.raw.corp_name as string) ?? (r.raw.name as string) ?? null,
    business_type: (r.raw.filing_type as string) ?? null,
    principal_city: (r.raw.city as string) ?? null,
    principal_zip: (r.raw.zip as string) ?? null,
    county: (r.raw.county as string) ?? null,
    file_date: (r.raw.file_date as string) ?? null,
    ...guessBusinessType((r.raw.corp_name as string) ?? (r.raw.name as string)),
  }));
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

    const rows = await req.db((q) =>
      q.rows<{ business_name: string | null; [k: string]: unknown }>(
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
    // business_type (above) is the real recorded legal filing type — this
    // is a SEPARATE, genuinely guessed field, always labeled as such.
    return rows.map((r) => ({ ...r, ...guessBusinessType(r.business_name) }));
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

    // The original 5 fields, plus one more: business_type_guess_(guessed)
    // — a separate, genuinely-guessed industry field (from the name, not
    // the recorded filing type), labeled as guessed right in the column
    // header itself so it can't be read as fact in a spreadsheet with no
    // other context.
    const header = ['business_name', 'principal_address', 'phone', 'email', 'business_type', 'business_type_guess_(guessed)'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const combinedAddress = [r.principal_address, r.principal_city, [r.principal_state, r.principal_zip].filter(Boolean).join(' ')]
        .filter(Boolean).join(', ');
      const guess = guessBusinessType(r.business_name).business_type_guess;
      lines.push([
        csvEscape(r.business_name), csvEscape(combinedAddress), csvEscape(r.phone), csvEscape(r.email),
        csvEscape(r.business_type), csvEscape(guess),
      ].join(','));
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="leadsource-${new Date().toISOString().slice(0, 10)}.csv"`);
    return lines.join('\n');
  });

  // --- Self-serve saved search (Phase 2.5) --------------------------------

  app.get('/leadsource/saved-searches', async (req) => {
    req.requireRole('viewer');
    await requireLeadSourceEnabled(req);
    return req.db(async (q) => {
      const existing = await q.rows(
        `SELECT id, name, states, counties, zips, filing_types, file_date_window_days,
                name_keywords, include_dba, created_at, updated_at
           FROM leadsource_saved_searches WHERE org_id = app.current_org() ORDER BY created_at DESC`,
      );
      // First time this org looks at Search since turning LeadSource on
      // (no saved search exists yet): pre-fill one from its own service
      // area rather than showing a blank slate. Lazy, not hooked to
      // whichever admin action flipped the module flag, so it works no
      // matter how the module got turned on.
      if (existing.length === 0) {
        const defaults = await buildDefaultFilters(q, req.ctx.orgId!);
        if (defaults) {
          const created = await q.one(
            `INSERT INTO leadsource_saved_searches (org_id, name, counties, zips, filing_types, file_date_window_days, name_keywords, include_dba)
             VALUES (app.current_org(), 'Your service area', $1, $2, $3, $4, $5, $6)
             RETURNING id, name, states, counties, zips, filing_types, file_date_window_days, name_keywords, include_dba, created_at, updated_at`,
            [defaults.counties, defaults.zips, defaults.filing_types, defaults.file_date_window_days, defaults.name_keywords, defaults.include_dba],
          );
          return created ? [created] : existing;
        }
      }
      return existing;
    });
  });

  // Separate from the search UI itself: lets the Search tab decide, before
  // rendering anything, whether to show the normal search experience or
  // "LeadSource isn't in your state yet" with the real state catalog —
  // never an empty list with no explanation.
  app.get('/leadsource/state-support', async (req) => {
    req.requireRole('viewer');
    await requireLeadSourceEnabled(req);
    const states = await req.db((q) => orgServiceAreaStates(q, req.ctx.orgId!));
    const supported = states.some((s) => SUPPORTED_STATES.has(s));
    return { org_in_supported_state: supported, org_states: states, catalog: STATE_CATALOG };
  });

  app.post('/leadsource/saved-searches', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).and(filtersInput).parse(req.body);

    return req.db(async (q) => {
      const row = await q.one(
        `INSERT INTO leadsource_saved_searches
           (org_id, name, counties, zips, filing_types, file_date_window_days, name_keywords, include_dba, created_by)
         VALUES (app.current_org(), $1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, states, counties, zips, filing_types, file_date_window_days, name_keywords, include_dba, created_at`,
        [body.name, body.counties.map((c) => c.toUpperCase()), body.zips, body.filing_types.map((t) => t.toUpperCase()),
          body.file_date_window_days, body.name_keywords, body.include_dba, sess.user_id],
      );
      await audit(q, { orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.saved_search.create', ip: req.ip, diff: body });
      return row;
    });
  });

  app.patch('/leadsource/saved-searches/:id', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).and(filtersInput).parse(req.body);

    return req.db(async (q) => {
      const row = await q.one<{ id: string }>(
        `UPDATE leadsource_saved_searches SET
           name = $2, counties = $3, zips = $4, filing_types = $5,
           file_date_window_days = $6, name_keywords = $7, include_dba = $8, updated_at = now()
         WHERE id = $1 RETURNING id`,
        [id, body.name, body.counties.map((c) => c.toUpperCase()), body.zips, body.filing_types.map((t) => t.toUpperCase()),
          body.file_date_window_days, body.name_keywords, body.include_dba],
      );
      if (!row) throw new HttpError(404, 'Saved search not found', 'not_found');
      await audit(q, { orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.saved_search.update', ip: req.ip, diff: body });
      return row;
    });
  });

  app.delete('/leadsource/saved-searches/:id', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      await q.exec(`DELETE FROM leadsource_saved_searches WHERE id = $1`, [id]);
      await audit(q, { orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.saved_search.delete', ip: req.ip });
      return { ok: true };
    });
  });

  // Ad-hoc preview — takes a filter object directly, not tied to a saved
  // search id. This is what the AI-assist chip editor calls to show
  // results for the CURRENT (possibly just-edited, possibly never-saved)
  // chips, before the owner decides whether to save them as a search.
  app.post('/leadsource/search/preview', async (req) => {
    req.requireRole('viewer');
    await requireLeadSourceEnabled(req);
    const filters = filtersInput.parse(req.body);
    return req.db((q) => runFilters(q, filters));
  });

  app.post('/leadsource/saved-searches/:id/run', async (req) => {
    req.requireRole('viewer');
    await requireLeadSourceEnabled(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const search = await q.one<Filters & { id: string }>(
        `SELECT counties, zips, filing_types, file_date_window_days, name_keywords, include_dba
           FROM leadsource_saved_searches WHERE id = $1 AND org_id = app.current_org()`,
        [id],
      );
      if (!search) throw new HttpError(404, 'Saved search not found', 'not_found');
      return runFilters(q, search);
    });
  });

  // Plain English -> filter chips. Returns the parsed filters only — never
  // runs a search itself, never shown to the owner as anything but
  // editable chips they still have to explicitly run (see
  // leadSourceSearchAssist.ts's own header).
  app.post('/leadsource/search/assist', async (req) => {
    req.requireRole('viewer');
    await requireLeadSourceEnabled(req);
    const { request } = z.object({ request: z.string().trim().min(1).max(500) }).parse(req.body);

    const filters = await req.db((q) => assistSearchFilters(q, req.ctx.orgId!, request));
    if (!filters) {
      // Assist failed or the usage cap was hit — hand back defaults for
      // the owner to edit by hand rather than erroring over an assist.
      return { counties: [], zips: [], filing_types: ['DOMP', 'FLAL', 'FORP', 'FORL'], file_date_window_days: 30, name_keywords: [], include_dba: false, assist_failed: true };
    }
    return { ...filters, assist_failed: false };
  });

  // Add specific search-result rows (by source + source_id) to this org's
  // tracked leads — the explicit second click after previewing a search,
  // same dedupe-by-(org,source,source_id) as the daily auto-ingest fan-out.
  app.post('/leadsource/leads/import', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);
    const { items } = z.object({
      items: z.array(z.object({ source: z.enum(['fl_sunbiz_cor', 'fl_sunbiz_fic']), source_id: z.string().min(1) })).min(1).max(500),
    }).parse(req.body);

    return req.db(async (q) => {
      let imported = 0;
      for (const item of items) {
        imported += await q.exec(
          `INSERT INTO leadsource_leads (org_id, source, source_id) VALUES (app.current_org(), $1, $2)
           ON CONFLICT (org_id, source, source_id) DO NOTHING`,
          [item.source, item.source_id],
        );
      }
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.leads.import', ip: req.ip,
        diff: { requested: items.length, imported },
      });
      return { requested: items.length, imported };
    });
  });

  // --- Bring-your-own Brave Search key (Phase 3) --------------------------
  // Owner-only throughout, per the v2 design — this is a billing-relevant
  // credential (Brave charges the org directly) and a search-cost control
  // (monthly_search_cap), not an operational setting a manager should
  // change on their own. Never returns the plaintext key — same discipline
  // settings.ts's AI bring-your-own-key routes already established.

  app.get('/leadsource/provider-key', async (req) => {
    req.requireRole('owner');
    await requireLeadSourceEnabled(req);
    return req.db((q) =>
      q.one(
        `SELECT key_last4, status, monthly_search_cap, searches_this_month, searches_month_reset_at,
                last_tested_at, last_error, created_at
           FROM leadsource_provider_keys
          WHERE org_id = app.current_org() AND provider = 'brave' AND revoked_at IS NULL`,
      ),
    );
  });

  app.put('/leadsource/provider-key', async (req) => {
    req.requireRole('owner');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);
    const { key, monthly_search_cap } = z.object({
      key: z.string().trim().min(20).max(300),
      monthly_search_cap: z.number().int().min(1).max(100_000).default(500),
    }).parse(req.body);

    const { enc, iv, tag } = encryptSecret(key);
    const last4 = key.slice(-4);

    return req.db(async (q) => {
      await q.exec(
        `INSERT INTO leadsource_provider_keys
           (org_id, provider, key_enc, key_iv, key_tag, key_last4, monthly_search_cap, created_by)
         VALUES (app.current_org(), 'brave', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, provider) WHERE revoked_at IS NULL DO UPDATE SET
           key_enc = $1, key_iv = $2, key_tag = $3, key_last4 = $4, monthly_search_cap = $5,
           status = 'untested', last_tested_at = NULL, last_error = NULL, created_by = $6, created_at = now()`,
        [enc, iv, tag, last4, monthly_search_cap, sess.user_id],
      );
      await audit(q, { orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.provider_key.save', ip: req.ip, diff: { key_last4: last4, monthly_search_cap } });
      return { ok: true };
    });
  });

  app.post('/leadsource/provider-key/test', async (req) => {
    req.requireRole('owner');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);

    const row = await req.db((q) =>
      q.one<{ key_enc: Buffer; key_iv: Buffer; key_tag: Buffer }>(
        `SELECT key_enc, key_iv, key_tag FROM leadsource_provider_keys
          WHERE org_id = app.current_org() AND provider = 'brave' AND revoked_at IS NULL`,
      ),
    );
    if (!row) throw new HttpError(404, 'No Brave key saved yet', 'not_found');

    const plain = decryptSecret(row.key_enc, row.key_iv, row.key_tag);
    const { result, detail } = await testBraveKey(plain);

    return req.db(async (q) => {
      await q.exec(
        `UPDATE leadsource_provider_keys SET status = $1, last_tested_at = now(), last_error = $2
          WHERE org_id = app.current_org() AND provider = 'brave' AND revoked_at IS NULL`,
        [result, detail],
      );
      await audit(q, { orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.provider_key.test', ip: req.ip, diff: { result } });
      return { result, detail };
    });
  });

  app.delete('/leadsource/provider-key', async (req) => {
    req.requireRole('owner');
    const sess = req.requireAuth();
    await requireLeadSourceEnabled(req);

    return req.db(async (q) => {
      const row = await q.one<{ id: string }>(
        `UPDATE leadsource_provider_keys SET revoked_at = now()
          WHERE org_id = app.current_org() AND provider = 'brave' AND revoked_at IS NULL
        RETURNING id`,
      );
      if (!row) throw new HttpError(404, 'No Brave key saved yet', 'not_found');
      await audit(q, { orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'leadsource.provider_key.remove', ip: req.ip });
      return { ok: true };
    });
  });
}
