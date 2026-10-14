-- Venturelyx :: 028_grow_domain_enable
--
-- Reversible pause for a sending domain, independent of any one mailbox's
-- own status — a domain can hold several mailboxes, and "stop sending
-- from this domain entirely" should not require pausing each one by hand.
-- Default true: every domain that exists today keeps sending exactly as
-- it does now; this is purely additive.

BEGIN;

ALTER TABLE grow_sending_domains ADD COLUMN enabled boolean NOT NULL DEFAULT true;

COMMIT;
