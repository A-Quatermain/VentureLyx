/**
 * Venturelyx :: market_targets sync.
 *
 * market_targets is catalog_items x locations — the SEO opportunity matrix
 * (migration 002's docstring on the table). Two things keep it populated
 * rather than the owner having to build the matrix by hand:
 *
 *   1. Whenever the service area changes (routes/locations.ts).
 *   2. Whenever the catalog changes (routes/operate.ts's catalog handlers).
 *
 * Call this after either kind of write, inside the same transaction. It is
 * pure upkeep — no new information originates here, it only keeps the
 * cross-product in sync with the two tables it is a product of.
 */
import type { Querier } from './db.js';

export async function syncMarketTargets(q: Querier): Promise<void> {
  // Every active service x active location combination gets a row if it
  // doesn't have one yet. Never overwrites an existing row — a target that
  // already progressed to 'building' or 'published' keeps that status even
  // if the location or catalog item is briefly toggled off and back on.
  await q.exec(
    `INSERT INTO market_targets (org_id, catalog_item_id, location_id, is_served)
       SELECT ci.org_id, ci.id, l.id, true
         FROM catalog_items ci
         JOIN locations l ON l.org_id = ci.org_id
        WHERE ci.is_active AND ci.kind = 'service' AND l.is_active
     ON CONFLICT (org_id, catalog_item_id, location_id) DO NOTHING`,
  );

  // A target whose service or location has since gone inactive stops
  // counting as "served" (so it drops out of the coverage-gap report and
  // stops implying the business still works there) without deleting the
  // row — any content or ranking history already attached to it survives.
  await q.exec(
    `UPDATE market_targets mt
        SET is_served = EXISTS (
              SELECT 1 FROM catalog_items ci
               WHERE ci.id = mt.catalog_item_id AND ci.is_active AND ci.kind = 'service'
            ) AND EXISTS (
              SELECT 1 FROM locations l
               WHERE l.id = mt.location_id AND l.is_active
            )
      WHERE mt.is_served <> (
              EXISTS (SELECT 1 FROM catalog_items ci
                       WHERE ci.id = mt.catalog_item_id AND ci.is_active AND ci.kind = 'service')
              AND EXISTS (SELECT 1 FROM locations l
                       WHERE l.id = mt.location_id AND l.is_active)
            )`,
  );
}
