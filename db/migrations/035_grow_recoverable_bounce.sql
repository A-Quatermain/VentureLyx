-- Venturelyx :: 035_grow_recoverable_bounce
--
-- Backs the recoverable-bounce bucket, resend, and fallback-send-channel
-- feature (docs/specs/grow-recoverable-bucket.md). No existing grow_*
-- table or column changes — hard-bounce auto-remove, suppression, cap
-- enforcement, the fair-share allocator, and the circuit breaker read
-- nothing added here and are untouched.
--
-- grow_message_resends: one row per ACTUAL resend. UNIQUE(original_message_id)
-- IS the "never resend twice for the same bounce event" rule — enforced by
-- the constraint, not application logic that could be gotten wrong. The
-- 2-per-contact-per-campaign cap is a COUNT query against this table, not
-- a stored counter, so it's always correct even if a row is ever deleted.
--
-- grow_fallback_sends / grow_fallback_send_recipients: a human-approved
-- batch sent outside the campaign scheduler entirely — sender_mailbox_id
-- is nullable because "an address the user supplies" has no grow_mailboxes
-- row at all (see the spec's "Fallback-send mechanics" for why that path
-- never actually sends anything itself).

BEGIN;

CREATE TABLE grow_message_resends (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  original_message_id uuid NOT NULL REFERENCES grow_messages(id) ON DELETE CASCADE,
  resend_message_id    uuid NOT NULL REFERENCES grow_messages(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES grow_contacts(id) ON DELETE CASCADE,
  campaign_id          uuid NOT NULL REFERENCES grow_campaigns(id) ON DELETE CASCADE,
  requested_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (original_message_id)
);
CREATE INDEX grow_message_resends_contact_campaign_idx ON grow_message_resends (contact_id, campaign_id);

CREATE TABLE grow_fallback_sends (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sender_mailbox_id uuid REFERENCES grow_mailboxes(id) ON DELETE SET NULL,
  sender_address    text NOT NULL,
  subject           text NOT NULL,
  intro_body        text NOT NULL,
  recipient_count   int NOT NULL,
  approved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE grow_fallback_send_recipients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fallback_send_id     uuid NOT NULL REFERENCES grow_fallback_sends(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES grow_contacts(id) ON DELETE CASCADE,
  original_message_id  uuid REFERENCES grow_messages(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','sent','failed','skipped_adhoc')),
  unsubscribe_token    text NOT NULL DEFAULT encode(gen_random_bytes(18),'hex'),
  sent_at              timestamptz,
  error                text
);
CREATE INDEX grow_fallback_send_recipients_send_idx ON grow_fallback_send_recipients (fallback_send_id);

CALL app.apply_tenant_rls();

COMMIT;
