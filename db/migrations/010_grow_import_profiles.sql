-- Venturelyx :: 010_grow_import_profiles
--
-- One saved column-mapping profile per org for the Grow contacts upload
-- flow (POST /v1/grow/contacts/import/*). The mapping itself — format
-- ('long'|'wide'), shared/org-level field->column assignments, and the
-- per-slot person-level assignments for wide files — is exactly the
-- MappingConfig shape api/src/lib/growContactImportMapping.ts builds and
-- consumes; stored as jsonb rather than normalized columns because it's
-- opaque to SQL (the API is the only reader/writer) and its shape is still
-- expected to evolve as the mapping screen grows.
--
-- UNIQUE(org_id): "a reusable profile per org", singular — committing an
-- import with a new mapping overwrites the org's saved one rather than
-- accumulating a library of named profiles nobody asked for.

BEGIN;

CREATE TABLE grow_import_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  format      text NOT NULL CHECK (format IN ('long', 'wide')),
  mapping     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id)
);

CALL app.apply_tenant_rls();

CREATE TRIGGER grow_import_profiles_touch BEFORE UPDATE ON grow_import_profiles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMIT;
