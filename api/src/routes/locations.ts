/**
 * Venturelyx :: service-area routes.
 *
 * `locations` is the served-place list (migration 002); this module is the
 * only writer of it. The owner describes coverage one of two ways — a list
 * of cities, or a radius from their business address — and either one
 * collapses to the same `locations` rows so market_targets (catalog_items x
 * locations) and everything downstream (Coverage tab, page builder) never
 * needs to know which mode produced them.
 *
 * Radius mode is honest about what it is: ONE `locations` row carrying the
 * stated address and radius_miles. There's no geocoding provider configured
 * here, so it does not attempt to derive or invent a list of nearby cities —
 * that would be exactly the fabricated data this build exists to avoid.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/auth.js';
import { syncMarketTargets } from '../lib/marketTargets.js';
import { slugify } from '../lib/slug.js';
import { HttpError, requireProvisioned } from '../plugins/context.js';

const RADIUS_SLUG = 'service-radius';

const cityInput = z.object({
  name: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).nullable().optional(),
  isPrimary: z.boolean().default(false),
});

const serviceAreaInput = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('cities'),
    cities: z.array(cityInput).min(1, 'Add at least one city').max(200),
  }),
  z.object({
    mode: z.literal('radius'),
    address_line1: z.string().trim().min(1).max(200),
    address_line2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().max(120).nullable().optional(),
    postal_code: z.string().trim().max(20).nullable().optional(),
    country: z.string().length(2).default('US'),
    radiusMiles: z.number().positive().max(500),
  }),
]);

export default async function locationsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireProvisioned);

  // ---- current coverage, however it was defined ----------------------------
  app.get('/service-area', async (req) => {
    req.requireRole('viewer');
    return req.db(async (q) => {
      const org = await q.one<{
        service_area_mode: 'cities' | 'radius'; service_radius_miles: string | null;
        address_line1: string | null; address_line2: string | null; city: string | null;
        region: string | null; postal_code: string | null; country: string;
      }>(
        `SELECT service_area_mode, service_radius_miles::text, address_line1, address_line2,
                city, region, postal_code, country
           FROM organizations WHERE id = app.current_org()`,
      );
      const locations = await q.rows(
        `SELECT id, name, slug, region, country, radius_miles::text, is_primary, priority
           FROM locations
          WHERE is_active
          ORDER BY priority, name`,
      );
      return { ...org, locations };
    });
  });

  // ---- list every served place (Coverage tab, catalog x location UI) -------
  app.get('/locations', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT id, name, slug, region, country, radius_miles::text, is_primary, is_active, priority
           FROM locations
          WHERE is_active
          ORDER BY priority, name`,
      ),
    );
  });

  // ---- set the service area, replacing whatever was there before -----------
  // Business-identity change, same grade as PATCH /orgs/current.
  app.put('/service-area', async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const body = serviceAreaInput.parse(req.body);

    return req.db(async (q) => {
      if (body.mode === 'cities') {
        const seen = new Map<string, { name: string; region: string | null; isPrimary: boolean }>();
        for (const city of body.cities) {
          const slug = slugify(city.name);
          if (slug) seen.set(slug, { name: city.name, region: city.region ?? null, isPrimary: city.isPrimary });
        }
        if (seen.size === 0) {
          throw new HttpError(400, 'Enter at least one real city name', 'invalid_input');
        }
        const slugs = [...seen.keys()];

        await q.exec(
          `UPDATE organizations
              SET service_area_mode = 'cities', service_radius_miles = NULL
            WHERE id = app.current_org()`,
        );
        await q.exec(
          `UPDATE locations SET is_active = false
            WHERE NOT (slug = ANY($1::text[]))`,
          [slugs],
        );
        for (const [slug, city] of seen) {
          await q.exec(
            `INSERT INTO locations (org_id, name, slug, region, is_active, radius_miles, is_primary)
             VALUES (app.current_org(), $1, $2, $3, true, NULL, $4)
             ON CONFLICT (org_id, slug) DO UPDATE
               SET name = EXCLUDED.name, region = EXCLUDED.region,
                   is_active = true, radius_miles = NULL, is_primary = EXCLUDED.is_primary`,
            [city.name, slug, city.region, city.isPrimary],
          );
        }
      } else {
        await q.exec(
          `UPDATE organizations
              SET address_line1 = $1, address_line2 = $2, city = $3, region = $4,
                  postal_code = $5, country = $6,
                  service_area_mode = 'radius', service_radius_miles = $7
            WHERE id = app.current_org()`,
          [
            body.address_line1, body.address_line2 ?? null, body.city, body.region ?? null,
            body.postal_code ?? null, body.country, body.radiusMiles,
          ],
        );
        await q.exec(`UPDATE locations SET is_active = false WHERE slug <> $1`, [RADIUS_SLUG]);
        await q.exec(
          `INSERT INTO locations (org_id, name, slug, region, is_active, radius_miles, is_primary)
           VALUES (app.current_org(), $1, $2, $3, true, $4, true)
           ON CONFLICT (org_id, slug) DO UPDATE
             SET name = EXCLUDED.name, region = EXCLUDED.region,
                 is_active = true, radius_miles = EXCLUDED.radius_miles, is_primary = true`,
          [`${body.radiusMiles} mi around ${body.city}`, RADIUS_SLUG, body.region ?? null, body.radiusMiles],
        );
      }

      await syncMarketTargets(q);

      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'service_area.update',
        entityType: 'organizations', entityId: req.ctx.orgId ?? undefined, ip: req.ip, diff: body,
      });

      const org = await q.one(
        `SELECT service_area_mode, service_radius_miles::text, address_line1, address_line2,
                city, region, postal_code, country
           FROM organizations WHERE id = app.current_org()`,
      );
      const locations = await q.rows(
        `SELECT id, name, slug, region, country, radius_miles::text, is_primary, priority
           FROM locations WHERE is_active ORDER BY priority, name`,
      );
      return { ...org, locations };
    });
  });
}
