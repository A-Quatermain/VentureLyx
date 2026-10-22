/**
 * Venturelyx :: guided setup checklist.
 *
 * Seven of the nine steps are derived live from real data (a site exists, a
 * city is served, a service is sold, a customer/invoice/job is on file, GSC
 * is connected) — no stored "done" flag to drift out of sync, and if the
 * one piece of data that made a step true later disappears, the step
 * honestly goes back to not-done. Two steps aren't data-shaped — "confirm
 * your business details" and "review your first scan" are actions, not
 * records — so those two live as explicit flags in organizations.settings,
 * set by the real action itself (PATCH /orgs/current, and this file's
 * mark-reviewed) rather than a separate "pretend to confirm" button.
 *
 * "Import customers / invoices / jobs" are the one family of steps that can
 * also be explicitly SKIPPED (settings.setup_skipped, a plain array of step
 * keys) — a client importing a customer list with no invoice or job history
 * yet is not stuck looking at two permanently-incomplete checklist items.
 * `done` on those three steps is `hasRealData || skipped`; every other step
 * keeps its original all-or-nothing meaning.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/auth.js';

export type SetupStepKey =
  | 'website' | 'business' | 'cities' | 'services' | 'gsc' | 'customers' | 'review' | 'invoices' | 'jobs';

export interface SetupStep {
  key: SetupStepKey;
  done: boolean;
  skipped: boolean;
}

const SKIPPABLE_STEPS: SetupStepKey[] = ['customers', 'invoices', 'jobs'];

export default async function setupRoutes(app: FastifyInstance) {

  app.get('/setup/progress', async (req) => {
    req.requireRole('viewer');
    return req.db(async (q) => {
      const row = await q.one<{
        settings: Record<string, unknown> | null;
        sites: number; locations: number; services: number; customers: number; gsc: number;
        invoices: number; jobs: number;
      }>(
        `SELECT o.settings,
                (SELECT count(*) FROM seo_sites WHERE org_id = o.id)::int AS sites,
                (SELECT count(*) FROM locations WHERE org_id = o.id AND is_active)::int AS locations,
                (SELECT count(*) FROM catalog_items WHERE org_id = o.id AND is_active)::int AS services,
                (SELECT count(*) FROM parties WHERE org_id = o.id AND is_customer AND deleted_at IS NULL)::int AS customers,
                (SELECT count(*) FROM integrations WHERE org_id = o.id AND provider = 'google_search_console'
                   AND status = 'connected')::int AS gsc,
                (SELECT count(*) FROM invoices WHERE org_id = o.id)::int AS invoices,
                (SELECT count(*) FROM work_orders WHERE org_id = o.id)::int AS jobs
           FROM organizations o WHERE o.id = app.current_org()`,
      );
      const s = row?.settings ?? {};
      const skipped = new Set(Array.isArray(s.setup_skipped) ? (s.setup_skipped as string[]) : []);

      const rawSteps: Array<{ key: SetupStepKey; done: boolean }> = [
        { key: 'website', done: (row?.sites ?? 0) > 0 },
        { key: 'business', done: s.setup_confirmed_profile === true },
        { key: 'cities', done: (row?.locations ?? 0) > 0 },
        { key: 'services', done: (row?.services ?? 0) > 0 },
        { key: 'gsc', done: (row?.gsc ?? 0) > 0 },
        { key: 'customers', done: (row?.customers ?? 0) > 0 },
        { key: 'invoices', done: (row?.invoices ?? 0) > 0 },
        { key: 'jobs', done: (row?.jobs ?? 0) > 0 },
        { key: 'review', done: s.setup_scan_reviewed === true },
      ];
      const steps: SetupStep[] = rawSteps.map((st) => ({
        key: st.key,
        skipped: skipped.has(st.key),
        done: st.done || skipped.has(st.key),
      }));
      const done = steps.filter((st) => st.done).length;

      return { steps, done, total: steps.length, dismissed: s.setup_dismissed === true };
    });
  });

  // Marks one of the skippable import steps as "not doing this one" — the
  // step still has real data behind `done` if any shows up later (a party
  // or invoice or work_order appearing un-skips nothing; it just makes
  // `done` true for the data reason instead of the skip reason).
  app.post('/setup/skip', async (req) => {
    req.requireRole('viewer');
    const sess = req.requireAuth();
    const { key } = z.object({ key: z.enum(SKIPPABLE_STEPS as [SetupStepKey, ...SetupStepKey[]]) }).parse(req.body);
    return req.db(async (q) => {
      const current = await q.one<{ settings: Record<string, unknown> | null }>(
        `SELECT settings FROM organizations WHERE id = app.current_org()`,
      );
      const existing = Array.isArray(current?.settings?.setup_skipped) ? (current!.settings!.setup_skipped as string[]) : [];
      const merged = { ...(current?.settings ?? {}), setup_skipped: [...new Set([...existing, key])] };
      await q.exec(`UPDATE organizations SET settings = $1 WHERE id = app.current_org()`, [JSON.stringify(merged)]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'setup.skip', ip: req.ip, diff: { key },
      });
      return { ok: true };
    });
  });

  // Hides the checklist for everyone in the org — hiding is a real,
  // org-visible change (not "my own view"), so it's gated one grade above
  // viewer, same as the other org-wide UI/ops toggles in this app.
  app.post('/setup/dismiss', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    return req.db(async (q) => {
      const current = await q.one<{ settings: Record<string, unknown> | null }>(
        `SELECT settings FROM organizations WHERE id = app.current_org()`,
      );
      const merged = { ...(current?.settings ?? {}), setup_dismissed: true };
      await q.exec(`UPDATE organizations SET settings = $1 WHERE id = app.current_org()`, [JSON.stringify(merged)]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'setup.dismiss', ip: req.ip,
      });
      return { ok: true };
    });
  });

  // Marking the first scan reviewed is just "I looked at this" — no
  // destructive or org-wide-hiding effect, so any signed-in member can do it.
  app.post('/setup/mark-reviewed', async (req) => {
    req.requireRole('viewer');
    const sess = req.requireAuth();
    return req.db(async (q) => {
      const current = await q.one<{ settings: Record<string, unknown> | null }>(
        `SELECT settings FROM organizations WHERE id = app.current_org()`,
      );
      const merged = { ...(current?.settings ?? {}), setup_scan_reviewed: true };
      await q.exec(`UPDATE organizations SET settings = $1 WHERE id = app.current_org()`, [JSON.stringify(merged)]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'setup.mark_reviewed', ip: req.ip,
      });
      return { ok: true };
    });
  });
}
