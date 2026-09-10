-- Venturelyx :: 008_service_area
--
-- The business's own address (needed as the center point when the owner
-- defines their service area as a radius rather than a list of cities) plus
-- the mode flag itself. `locations` (migration 002) already models each
-- served place; this just adds where "home base" is and how the owner chose
-- to describe coverage from it.
--
-- Deliberately no latitude/longitude requirement and no derived city list for
-- radius mode — there is no geocoding provider configured, and inventing
-- "cities within N miles" without one would be exactly the fabricated data
-- this build is supposed to avoid. Radius mode instead becomes a single
-- `locations` row (see api/src/lib/marketTargets.ts) carrying the address and
-- radius_miles as stated, honest intent.

BEGIN;

ALTER TABLE organizations
  ADD COLUMN address_line1 text,
  ADD COLUMN address_line2 text,
  ADD COLUMN city           text,
  ADD COLUMN region         text,
  ADD COLUMN postal_code    text,
  ADD COLUMN country        char(2) NOT NULL DEFAULT 'US',
  ADD COLUMN service_area_mode   text NOT NULL DEFAULT 'cities'
    CHECK (service_area_mode IN ('cities', 'radius')),
  ADD COLUMN service_radius_miles numeric(6,2);

COMMIT;
