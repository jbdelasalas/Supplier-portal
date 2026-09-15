-- 008_align_audit_password.sql — the last of the columns the ported routes
-- expect: the audit log's own column names, the staff-issued password reset
-- trail, and the reopen counter.
--
-- Same reasoning as 007: these routes are proven code from the customer
-- portal, so the schema meets them rather than the other way round.

SET LOCAL search_path = supplier, public;

-- ============================================================================
-- audit_log — 006 named these actor_user_id / entity_type / before_data /
-- after_data; the routes write actor_id / entity / before / after.
-- ============================================================================
ALTER TABLE supplier.audit_log
  ADD COLUMN IF NOT EXISTS actor_id    uuid REFERENCES supplier.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_email citext,
  ADD COLUMN IF NOT EXISTS entity      varchar(60),
  ADD COLUMN IF NOT EXISTS before      jsonb,
  ADD COLUMN IF NOT EXISTS after       jsonb,
  ADD COLUMN IF NOT EXISTS user_agent  text;

DO $$
BEGIN
  -- Migrate anything already written under the old names, then drop them so a
  -- reader cannot pick the empty one of a pair.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'supplier' AND table_name = 'audit_log'
       AND column_name = 'actor_user_id'
  ) THEN
    UPDATE supplier.audit_log
       SET actor_id    = COALESCE(actor_id, actor_user_id),
           actor_email = COALESCE(actor_email, actor_label::citext),
           entity      = COALESCE(entity, entity_type),
           before      = COALESCE(before, before_data),
           after       = COALESCE(after, after_data);

    ALTER TABLE supplier.audit_log
      DROP COLUMN actor_user_id,
      DROP COLUMN actor_label,
      DROP COLUMN entity_type,
      DROP COLUMN before_data,
      DROP COLUMN after_data;
  END IF;

  -- `entity` is required, but only once the backfill above has run.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'supplier' AND table_name = 'audit_log'
       AND column_name = 'entity' AND is_nullable = 'YES'
  ) AND NOT EXISTS (SELECT 1 FROM supplier.audit_log WHERE entity IS NULL) THEN
    ALTER TABLE supplier.audit_log ALTER COLUMN entity SET NOT NULL;
  END IF;
END$$;

DROP INDEX IF EXISTS supplier.idx_sp_audit_entity;
CREATE INDEX IF NOT EXISTS idx_sp_audit_entity
  ON supplier.audit_log (entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sp_audit_actor
  ON supplier.audit_log (actor_id, created_at DESC);

-- ============================================================================
-- users — the staff-issued password reset trail.
--
-- `must_change_password` (already in 002) is what stops a temporary password
-- becoming a permanent one. These record who issued it and when, so a reset
-- remains attributable after audit_log is pruned.
-- ============================================================================
ALTER TABLE supplier.users
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS password_reset_by   uuid REFERENCES supplier.users(id),
  ADD COLUMN IF NOT EXISTS password_reset_at   timestamptz;

-- Existing accounts chose their own password at creation.
UPDATE supplier.users
   SET password_changed_at = created_at
 WHERE password_changed_at IS NULL;

-- ============================================================================
-- applications — how many times this one has been sent back and revised.
--
-- Drives the "Attempt 2" label for reviewers and makes a serial reapplier
-- visible. Distinct from `revision` in 004, which counts info-request rounds;
-- this counts full reopen-after-rejection cycles.
-- ============================================================================
ALTER TABLE supplier.applications
  ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0;
