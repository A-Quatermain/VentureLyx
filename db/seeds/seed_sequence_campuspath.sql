-- seed_sequence_campuspath.sql
--
-- Ported from /opt/outreach/seeds/seed_sequence_campuspath.sql for the Grow
-- module. Changes from the standalone version: tenant_id -> org_id,
-- campaigns/sequence_steps -> grow_campaigns/grow_sequence_steps, and the
-- GUC is app.current_org (matching 001_platform_core.sql /
-- 006_fix_apply_tenant_rls.sql), not app.tenant_id. Campaign starts in
-- 'draft' — same as the standalone version; nothing here flips it live.
--
-- One campaign, six steps: three for directors (rank 1) and three for
-- administrators (rank 2). Rank 2 only enters the queue once rank 1's
-- enrollment reaches a terminal state, so the same school is never hit twice
-- in a week.
--
-- Merge fields resolve against the grow_contacts row: first_name,
-- contact_name, entity_name, region, city, enrollment, role. A blank
-- first_name falls back to "there" in growTemplate.ts's render().
--
-- {{unsubscribe_footer}} is NOT resolved here — see the note at the bottom.
--
-- Variable convention: pass every -v value bare (no embedded quotes) and
-- always reference it as :'name' (psql's quote-as-literal form), :: cast
-- where needed. The standalone version mixed :tenant (relying on the shell
-- having pre-quoted the value) with :'tenant'/:'campaign_id' in the same
-- file, which only works if every caller passes -v exactly the way each
-- particular reference expects. One convention, used everywhere below,
-- removes that foot-gun.
--
-- Usage:
--   psql "$DATABASE_URL" -v org=<org-uuid> -f seed_sequence_campuspath.sql

BEGIN;

SET LOCAL app.current_org = :'org';

INSERT INTO grow_campaigns
    (org_id, name, status, timezone, window_start, window_end,
     weekdays_only, daily_target)
VALUES
    (:'org'::uuid, 'CampusPath — South Florida private schools', 'draft',
     'America/New_York', '08:30', '15:00', true, 100)
RETURNING id \gset campaign_

-- ---------------------------------------------------------------------------
-- Rank 1 — Director. Front-office angle: dismissal is the visible daily pain.
-- ---------------------------------------------------------------------------

INSERT INTO grow_sequence_steps
    (org_id, campaign_id, step_no, delay_days, applies_to_rank,
     subject_tmpl, body_tmpl)
VALUES
(:'org'::uuid, :'campaign_id', 1, 0, 1,
 'Dismissal at {{entity_name}}',
 E'Hi {{first_name}},\n\n'
 'I build CampusPath, a school operations platform that started as a '
 'dismissal system for one campus and now runs in a live production pilot.\n\n'
 'Most front offices I talk to are still running dismissal on a radio, a '
 'clipboard, and a box of car tags. CampusPath replaces that with digital '
 'car tags, a pickup queue every staff member can see on their phone, and '
 'parent-side check-in — with gradebook, calendar, and student and teacher '
 'portals in the same system instead of three subscriptions.\n\n'
 'Happy to send a two-page capabilities sheet, or walk you through it in '
 '15 minutes around your bell schedule. Which is more useful?\n\n'
 'Alan\nCampusPath\n{{unsubscribe_footer}}'),

(:'org'::uuid, :'campaign_id', 2, 5, 1,
 'Re: Dismissal at {{entity_name}}',
 E'Hi {{first_name}},\n\n'
 'Following up on my note about dismissal.\n\n'
 'One thing worth mentioning: schools on the state scholarship programs '
 'tell me the reporting burden is what actually eats their week — '
 'attendance records, rosters, and documentation pulled from four places. '
 'CampusPath keeps those in one system, so the reporting is an export '
 'rather than an afternoon.\n\n'
 'If it would be easier to just look at it, I can send the capabilities '
 'sheet and you can decide from there. No call needed.\n\n'
 'Alan\nCampusPath\n{{unsubscribe_footer}}'),

(:'org'::uuid, :'campaign_id', 3, 7, 1,
 'Closing the loop — {{entity_name}}',
 E'Hi {{first_name}},\n\n'
 'I have not heard back, so I will assume this is not a priority right now '
 'and stop reaching out.\n\n'
 'If dismissal, gradebook, or scholarship reporting becomes a problem worth '
 'solving later, my details are below and I am local to South Florida.\n\n'
 'Best of luck with the year.\n\n'
 'Alan\nCampusPath\n{{unsubscribe_footer}}');

-- ---------------------------------------------------------------------------
-- Rank 2 — Administrator. Self-hosted and TestGuard angle: whoever owns the
-- technology cares about where student data lives, not about car lines.
-- ---------------------------------------------------------------------------

INSERT INTO grow_sequence_steps
    (org_id, campaign_id, step_no, delay_days, applies_to_rank,
     subject_tmpl, body_tmpl)
VALUES
(:'org'::uuid, :'campaign_id', 1, 0, 2,
 'School software that runs on your own hardware',
 E'Hi {{first_name}},\n\n'
 'Quick one for you as the person who would own this at {{entity_name}}.\n\n'
 'CampusPath is a K-12 operations platform — dismissal, gradebook, calendar, '
 'student and teacher portals, role-based access, and two-factor. TestGuard '
 'is the companion Chrome extension that locks devices during testing, with '
 'three enforcement levels and single sign-on back to CampusPath.\n\n'
 'The part most people in your seat care about: it ships as an OVA. You run '
 'it on your own hardware and student data never leaves your network. No '
 'per-seat cloud contract, no vendor holding your roster.\n\n'
 'Want the trial appliance and the admin guide to stand up in a lab?\n\n'
 'Alan\nCampusPath\n{{unsubscribe_footer}}'),

(:'org'::uuid, :'campaign_id', 2, 5, 2,
 'Re: School software that runs on your own hardware',
 E'Hi {{first_name}},\n\n'
 'Circling back on the self-hosted appliance.\n\n'
 'On the testing side specifically: TestGuard imports rosters straight from '
 'a CSV or Excel export with a column-mapping step, so you are not '
 'reformatting spreadsheets the night before a test window. Soft, medium, '
 'and hard lockdown depending on how strict the assessment is.\n\n'
 'It works standalone if dismissal and gradebook are not your problem.\n\n'
 'I can send the download link today — no call, no demo required.\n\n'
 'Alan\nCampusPath\n{{unsubscribe_footer}}'),

(:'org'::uuid, :'campaign_id', 3, 7, 2,
 'Last note — {{entity_name}}',
 E'Hi {{first_name}},\n\n'
 'No reply, so I will stop here rather than keep filling your inbox.\n\n'
 'If you end up evaluating dismissal, gradebook, or test lockdown down the '
 'road, the trial appliance is self-serve and my details are below.\n\n'
 'Alan\nCampusPath\n{{unsubscribe_footer}}');

COMMIT;

\echo Campaign id: :campaign_id

-- ---------------------------------------------------------------------------
-- Before this campaign leaves 'draft'
-- ---------------------------------------------------------------------------
--
-- 1. RESOLVED — api/src/lib/growTemplate.ts's renderUnsubscribeFooter() is
--    ported from sender.js and substitutes {{unsubscribe_footer}} at send
--    time. The preview endpoint (GET /v1/grow/contacts/:id/preview) applies
--    the same hasUnrenderedPlaceholder() refusal check the real sender will.
--
-- 2. A real physical postal address (GROW_MAILING_ADDRESS) and send-time
--    base URL (GROW_BASE_URL) are required before any real send path exists
--    — neither is built yet (grow.ts is read/preview only).
--
-- 3. Run seed_enrollments_campuspath.sql next: it sets priority so Tier A
--    sends first and sets gated_on_contact_id on every rank-2 enrollment to
--    the rank-1 contact at the same school.
