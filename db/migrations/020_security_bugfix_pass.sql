-- Venturelyx :: 020_security_bugfix_pass
--
-- From a security/bug review of the Grow -> Operate bridge (018-019):
--
-- party_contacts had no uniqueness on (org_id, channel, value) at all —
-- only (org_id, party_id, channel, value), which two different parties
-- never collide on. Combined with growPromote.ts's findOrCreateParty doing
-- a SELECT-then-INSERT with no lock, two concurrent engagements for the
-- same email (a reply landing on the poller at the same moment as a click
-- on the public /c/:token route, say) could each miss the other's
-- not-yet-committed row and create two permanent duplicate parties for one
-- person — exactly what the dedupe-on-email promise in that file's header
-- comment says can't happen. This index makes it actually can't happen
-- (a unique-violation on the second INSERT, handled in application code),
-- on lower(value) so differently-cased imports of the same address (real
-- data: Grow contacts are only trimmed, not case-normalized, at import)
-- collide too. Verified against live data first — zero existing rows
-- would violate this.

BEGIN;

-- Scoped to email only (not phone/sms/etc) — email is the specific
-- dedupe key growPromote.ts promises and the only one reviewed here; a
-- shared phone line legitimately appearing on more than one party is a
-- real scenario this isn't trying to rule out.
CREATE UNIQUE INDEX party_contacts_org_email_idx
  ON party_contacts (org_id, lower(value))
  WHERE channel = 'email';

COMMIT;
