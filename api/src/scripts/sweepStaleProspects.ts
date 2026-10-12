/**
 * Venturelyx :: stale prospect sweep.
 *
 *   node dist/scripts/sweepStaleProspects.js
 *
 * Archives (prospect_archived_at = now()), never deletes — the org row,
 * every ScaleSEO scan, every deal/party record all stay exactly as they
 * are. Staff can restore any of these with a single PATCH
 * (/admin/growth-scans/:dealId/restore), which just nulls the column back
 * out. Nothing here ever touches deleted_at.
 *
 * Threshold is platform_settings.stale_prospect_days (default 90, staff-
 * editable), not hardcoded — "no deal-stage movement" is measured off the
 * deal's own updated_at, which advances on every stage change (approve for
 * intake, checkout created, etc.), so an actively-worked lead is never
 * swept just because it's old.
 *
 * Not wired to a crontab by this change — same posture as
 * scripts/crawl.py --all-due, which also isn't scheduled today (checked:
 * no crontab entry on this host for either). Run it manually, or add
 * `0 3 * * * cd /opt/venturelyx && docker compose -f infra/docker-compose.app.yml
 * run --rm api node dist/scripts/sweepStaleProspects.js` to crontab when
 * ready for it to run nightly.
 */
import { withPlatform, shutdown } from '../lib/db.js';

async function main() {
  const swept = await withPlatform(async (q) => {
    const setting = await q.one<{ value: number }>(`SELECT value FROM platform_settings WHERE key = 'stale_prospect_days'`);
    const days = setting?.value ?? 90;

    const rows = await q.rows<{ id: string; name: string }>(
      `UPDATE organizations o SET prospect_archived_at = now()
         WHERE o.status = 'prospect'
           AND o.prospect_archived_at IS NULL
           AND o.deleted_at IS NULL
           AND NOT EXISTS (
                 SELECT 1 FROM deals d
                  WHERE d.org_id = o.id AND d.updated_at > now() - ($1 || ' days')::interval
               )
           AND o.created_at <= now() - ($1 || ' days')::interval
         RETURNING o.id, o.name`,
      [days],
    );
    return rows;
  });

  console.log(`Archived ${swept.length} stale prospect(s):`);
  for (const r of swept) console.log(`  ${r.name} (${r.id})`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => shutdown());
