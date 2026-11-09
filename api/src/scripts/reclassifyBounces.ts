/**
 * Venturelyx :: one-off backfill — re-classify existing grow_messages
 * bounce rows against the fixed lib/growBounceClassify.ts (the DKIM-
 * Signature quoted-header false positive, fixed 2026-11-09:
 * classifyBounce() used to keyword-match the FULL bounce text, which
 * always includes the quoted original message we sent — and every
 * message we send carries our own DKIM-Signature header, so "dkim" was
 * always found regardless of what the receiving server actually said).
 *
 * category/explanation/action are recomputed at read time already, never
 * stored (that file's own header explains why) — fixing the classifier
 * alone already corrects how every past bounce DISPLAYS. The one thing
 * that needed a real backfill is bounce_type itself, which IS stored,
 * set once at capture time, by whichever version of the classifier was
 * live that day.
 *
 * Any row that reclassifies to 'hard' for the FIRST time gets the exact
 * same auto-remove treatment worker/growWorker.ts's own
 * autoRemoveHardBounce() gives a live hard bounce — suppress + cancel
 * queued steps — so a retroactive reclassification can't leave a
 * genuinely-dead address unsuppressed. A row moving AWAY from 'hard' is
 * never un-suppressed automatically; undoing a suppression is a human
 * decision, not this script's to make.
 *
 *   node dist/scripts/reclassifyBounces.ts --dry-run   (report only, default)
 *   node dist/scripts/reclassifyBounces.ts --apply     (write the changes)
 */
import { withPlatform, withTenant, type Querier } from '../lib/db.js';
import { classifyBounce } from '../lib/growBounceClassify.js';

const APPLY = process.argv.includes('--apply');

interface BounceRow {
  id: string; org_id: string; campaign_id: string; contact_id: string;
  bounce_code: string | null; bounce_type: string | null; bounce_reason_raw: string | null; email: string;
}

async function reclassifyOrg(q: Querier, orgId: string, rows: BounceRow[]): Promise<{ changed: number; newlyHard: number; newlySuppressed: number }> {
  let changed = 0, newlyHard = 0, newlySuppressed = 0;

  for (const r of rows) {
    const result = classifyBounce(r.bounce_reason_raw ?? '', r.bounce_code);
    if (result.type === r.bounce_type) continue;

    changed++;
    console.log(`  ${r.email}: ${r.bounce_type ?? '(none)'} -> ${result.type} (${result.category})`);
    if (!APPLY) continue;

    await q.exec(`UPDATE grow_messages SET bounce_type = $2 WHERE id = $1`, [r.id, result.type]);

    if (result.type === 'hard' && r.bounce_type !== 'hard') {
      newlyHard++;
      const campaign = await q.one<{ auto_remove_hard_bounces: boolean }>(
        `SELECT auto_remove_hard_bounces FROM grow_campaigns WHERE id = $1`, [r.campaign_id],
      );
      if (campaign?.auto_remove_hard_bounces === false) {
        console.log(`    (auto-remove is off for this campaign — reclassified but left for manual review)`);
        continue;
      }
      const inserted = await q.exec(
        `INSERT INTO grow_suppressions (org_id, email, reason, campaign_id)
         VALUES ($1, $2, 'hard_bounce', $3) ON CONFLICT (org_id, email) DO NOTHING`,
        [orgId, r.email, r.campaign_id],
      );
      if (inserted > 0) {
        newlySuppressed++;
        console.log(`    suppressed (was not already)`);
      }
      await q.exec(
        `UPDATE grow_enrollments SET state = 'bounced' WHERE campaign_id = $1 AND contact_id = $2 AND state = 'active'`,
        [r.campaign_id, r.contact_id],
      );
      await q.exec(
        `UPDATE grow_messages SET status = 'cancelled' WHERE campaign_id = $1 AND contact_id = $2 AND status = 'queued'`,
        [r.campaign_id, r.contact_id],
      );
    }
  }

  return { changed, newlyHard, newlySuppressed };
}

async function main() {
  console.log(`Bounce reclassification — ${APPLY ? 'APPLYING CHANGES' : 'dry run (pass --apply to write)'}\n`);

  const rows = await withPlatform((q) => q.rows<BounceRow>(
    `SELECT m.id, m.org_id, m.campaign_id, m.contact_id, m.bounce_code, m.bounce_type, m.bounce_reason_raw, c.email
       FROM grow_messages m JOIN grow_contacts c ON c.id = m.contact_id
      WHERE m.status = 'bounced'`,
  ));
  console.log(`Scanning ${rows.length} bounced messages across all orgs...\n`);

  const byOrg = new Map<string, BounceRow[]>();
  for (const r of rows) {
    if (!byOrg.has(r.org_id)) byOrg.set(r.org_id, []);
    byOrg.get(r.org_id)!.push(r);
  }

  let totalChanged = 0, totalNewlyHard = 0, totalNewlySuppressed = 0;
  for (const [orgId, orgRows] of byOrg) {
    const result = await withTenant({ orgId, userId: null, isStaff: true }, (q) => reclassifyOrg(q, orgId, orgRows));
    totalChanged += result.changed;
    totalNewlyHard += result.newlyHard;
    totalNewlySuppressed += result.newlySuppressed;
  }

  console.log(`\n${totalChanged} message(s) reclassified. ${totalNewlyHard} newly 'hard'; ${totalNewlySuppressed} newly suppressed.`);
  if (!APPLY) console.log('(dry run — nothing written; re-run with --apply)');
}

main().catch((err) => { console.error(err); process.exit(1); });
