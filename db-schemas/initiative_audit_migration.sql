-- Adds manager review and president completion fields to existing initiatives_db databases.
-- The Worker also performs this migration lazily before initiative write actions.

ALTER TABLE initiatives ADD COLUMN executedOnTime BOOLEAN DEFAULT NULL;
ALTER TABLE initiatives ADD COLUMN successNote TEXT;
ALTER TABLE initiatives ADD COLUMN completedAt DATETIME;
ALTER TABLE initiatives ADD COLUMN completedBy TEXT;
ALTER TABLE initiatives ADD COLUMN managerNote TEXT;
ALTER TABLE initiatives ADD COLUMN reviewedBy TEXT;
ALTER TABLE initiatives ADD COLUMN dateReviewed TEXT;
