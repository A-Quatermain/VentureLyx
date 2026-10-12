-- Venturelyx :: 027_grow_enrollment_batch
--
-- Tags an enrollment with which contacts-import upload created it
-- (lib/growEnroll.ts's importBatch option) — null for enrollments created
-- by the bulk "enroll all" action, which isn't tied to any one upload.

BEGIN;

ALTER TABLE grow_enrollments ADD COLUMN import_batch text;

COMMIT;
