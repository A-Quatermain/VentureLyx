-- Venturelyx :: 019_grow_click_tracking
--
-- The other half of "replies or clicks through" (the first bridge pass,
-- 018, only built replies — this closes that gap). Every http(s) link in a
-- sent message's body is rewritten at send time to a per-link redirect
-- token recorded here, resolved and immediately 302'd by GROW_BASE_URL/c/:token
-- (api/src/server.ts). The destination is looked up server-side by this
-- table's own row, never taken from the request — a redirect that trusted
-- a client-supplied destination URL would be an open redirect off a domain
-- recipients are asked to trust.
--
-- Known limitation, worth stating here since it isn't visible in the schema
-- itself: email link clicks are noisier than replies — corporate mail
-- scanners (Microsoft Safe Links and similar) and some mail clients
-- prefetch every link in a message automatically, so a 'click' grow_event
-- can fire with no human involved at all. Replies don't have this problem
-- (nothing prefetches a reply). Promoting on a click is still what was
-- asked for; this comment is so whoever looks at an unexpectedly-promoted
-- lead later knows why, rather than assuming a bug.

BEGIN;

ALTER TABLE grow_events DROP CONSTRAINT grow_events_type_check;
ALTER TABLE grow_events ADD CONSTRAINT grow_events_type_check
  CHECK (type IN ('sent','reply','bounce_hard','bounce_soft','complaint',
                  'unsubscribe','auto_reply','click'));

CREATE TABLE grow_link_clicks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES grow_messages(id) ON DELETE CASCADE,
  url         text NOT NULL,
  -- Looked up directly off this bare token (grow.ts's /c/:token, same
  -- public/no-session shape as the existing /u/:token unsubscribe route) —
  -- unguessable is the whole security property, so it's generated the same
  -- way grow_messages.unsubscribe_token already is.
  token       text NOT NULL DEFAULT encode(gen_random_bytes(18), 'hex'),
  clicked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);
CREATE INDEX ON grow_link_clicks (org_id, message_id);

CALL app.apply_tenant_rls();

COMMIT;
