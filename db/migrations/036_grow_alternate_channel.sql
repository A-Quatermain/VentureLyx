-- Venturelyx :: 036_grow_alternate_channel
--
-- Revises Part C of docs/specs/grow-recoverable-bucket.md: the alternate-
-- channel follow-up is now automatic up to the send — a draft is generated
-- the moment a recoverable bounce is classified, not when a human selects
-- contacts and asks for one. That changes the shape of the data: a draft
-- now needs to exist on its own, before any human has acted, rather than
-- being created at send time. grow_fallback_sends/grow_fallback_send_recipients
-- (035_grow_recoverable_bounce.sql) assumed the opposite order and have
-- zero rows in production (confirmed before writing this migration) — safe
-- to drop and replace outright rather than carry a dead shape forward.
--
-- grow_alternate_channel_settings: one row per org (upserted), the config
-- surface Part C's own CONFIG section describes. trigger_bounce_types is
-- CHECK-constrained to {'block','soft'} at the DATABASE level — 'unknown'
-- can never be configured as a trigger even by a direct SQL edit, matching
-- "unknown is review-only, never auto-drafted" as a hard rule, not a
-- toggle default that happens to start unticked.
--
-- grow_fallback_drafts: one row per (contact, campaign) — UNIQUE on that
-- pair is "ONE alternate-channel attempt per contact per campaign" enforced
-- as a constraint, not application logic that could be gotten wrong twice.
-- status starts 'draft' (AI-written, pre-selected sender, zero human steps
-- yet) and only ever moves to 'sent'/'failed'/'skipped_adhoc' on an
-- explicit human Send click (routes/grow.ts's POST /grow/fallback-drafts/send).

BEGIN;

DROP TABLE grow_fallback_send_recipients;
DROP TABLE grow_fallback_sends;

CREATE TABLE grow_alternate_channel_settings (
  org_id               uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  sender_mailbox_id    uuid REFERENCES grow_mailboxes(id) ON DELETE SET NULL,
  sender_adhoc_address text,
  trigger_bounce_types text[] NOT NULL DEFAULT ARRAY['block']::text[]
                        CHECK (trigger_bounce_types <@ ARRAY['block', 'soft']::text[]),
  business_context     text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE grow_fallback_drafts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  original_message_id uuid NOT NULL REFERENCES grow_messages(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES grow_contacts(id) ON DELETE CASCADE,
  campaign_id          uuid NOT NULL REFERENCES grow_campaigns(id) ON DELETE CASCADE,
  sender_mailbox_id    uuid REFERENCES grow_mailboxes(id) ON DELETE SET NULL,
  sender_address       text NOT NULL,
  subject              text NOT NULL,
  intro_body           text NOT NULL,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'sent', 'failed', 'skipped_adhoc', 'discarded')),
  generated_at         timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  sent_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  unsubscribe_token    text NOT NULL DEFAULT encode(gen_random_bytes(18), 'hex'),
  error                text,
  UNIQUE (contact_id, campaign_id)
);
CREATE INDEX grow_fallback_drafts_status_idx ON grow_fallback_drafts (org_id, status);

CALL app.apply_tenant_rls();

COMMIT;
