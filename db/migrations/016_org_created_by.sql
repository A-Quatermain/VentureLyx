-- Venturelyx :: 016_org_created_by
--
-- Which user created each organization — needed now that an owner can add
-- a second (third, ...) business from the org switcher, not just the one
-- signup onboarding creates. Billing eventually needs to price
-- multi-business accounts differently; this is the durable, directly
-- queryable record of that ("every org this user owns"), distinct from
-- audit_log's org.create event, which already captures the same fact but
-- as an append-only trail, not a current-state field meant to be joined
-- against from a billing query.
--
-- Nullable: every organization that predates this migration has no known
-- creator on file (the audit log for that era may or may not still have
-- the event) — NULL is the honest answer, not a guess.

BEGIN;

ALTER TABLE organizations
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX organizations_created_by_idx ON organizations (created_by) WHERE created_by IS NOT NULL;

COMMIT;
