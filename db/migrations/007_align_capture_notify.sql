-- 007_align_capture_notify.sql — reconcile three tables with what the ported
-- routes actually write.
--
-- The application, document, signature and notification routes came across from
-- the customer portal, where these tables had grown a few extra columns in a
-- later migration (its 007) than the shape 004 here first described. Rather
-- than edit the routes away from proven code, the schema meets them:
--
--   * application_documents gains the full camera-capture column set
--     (capture_source / captured_at / latitude / longitude /
--     location_accuracy_m / capture_meta) in place of the narrower
--     source / captured_lat / captured_lng that 004 defined.
--   * application_signatures uses signature_key + signature_data + method,
--     with the image allowed to live in storage for anything large.
--   * notifications uses category + link_url, with a CHECK covering the
--     supplier-side categories.
--
-- Written as an idempotent reconciliation rather than by editing 004, because
-- 004 may already have been applied.

SET LOCAL search_path = supplier, public, extensions;

-- ============================================================================
-- application_documents — camera captures
-- ============================================================================
ALTER TABLE supplier.application_documents
  ADD COLUMN IF NOT EXISTS capture_source varchar(20)
    CHECK (capture_source IN ('camera', 'upload')),
  ADD COLUMN IF NOT EXISTS captured_at    timestamptz,
  ADD COLUMN IF NOT EXISTS latitude       numeric(10, 7),
  ADD COLUMN IF NOT EXISTS longitude      numeric(10, 7),
  ADD COLUMN IF NOT EXISTS location_accuracy_m numeric(10, 2),
  -- Free-form notes from the capture UI (device, facing mode, etc).
  ADD COLUMN IF NOT EXISTS capture_meta   jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Carry across anything 004's narrower columns already captured, then drop
-- them so there is exactly one place each fact lives.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'supplier' AND table_name = 'application_documents'
       AND column_name = 'captured_lat'
  ) THEN
    UPDATE supplier.application_documents
       SET latitude  = COALESCE(latitude,  captured_lat),
           longitude = COALESCE(longitude, captured_lng)
     WHERE captured_lat IS NOT NULL OR captured_lng IS NOT NULL;

    ALTER TABLE supplier.application_documents
      DROP COLUMN captured_lat,
      DROP COLUMN captured_lng;
  END IF;

  -- 004's `source` becomes `capture_source`, same meaning, wider name.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'supplier' AND table_name = 'application_documents'
       AND column_name = 'source'
  ) THEN
    UPDATE supplier.application_documents
       SET capture_source = COALESCE(capture_source, source);

    ALTER TABLE supplier.application_documents DROP COLUMN source;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_sp_application_documents_captures
  ON supplier.application_documents (application_id, capture_source)
  WHERE capture_source = 'camera';

-- ============================================================================
-- application_signatures — align to the signature route
-- ============================================================================
ALTER TABLE supplier.application_signatures
  ADD COLUMN IF NOT EXISTS signature_key  varchar(60) NOT NULL DEFAULT 'applicant',
  ADD COLUMN IF NOT EXISTS signature_data text,
  ADD COLUMN IF NOT EXISTS storage_path   text,
  ADD COLUMN IF NOT EXISTS method         varchar(20) NOT NULL DEFAULT 'drawn',
  ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  -- Move 004's sig_key / image_data onto the names the route uses.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'supplier' AND table_name = 'application_signatures'
       AND column_name = 'sig_key'
  ) THEN
    UPDATE supplier.application_signatures SET signature_key = sig_key
     WHERE sig_key IS NOT NULL;
    -- The UNIQUE from 004 was on (application_id, sig_key); drop it with the
    -- column and re-add on the new name below.
    ALTER TABLE supplier.application_signatures DROP COLUMN sig_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'supplier' AND table_name = 'application_signatures'
       AND column_name = 'image_data'
  ) THEN
    UPDATE supplier.application_signatures
       SET signature_data = COALESCE(signature_data, image_data);
    ALTER TABLE supplier.application_signatures DROP COLUMN image_data;
  END IF;

  -- The image may now live inline or in storage, but one of them must exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sp_signature_has_image'
  ) THEN
    ALTER TABLE supplier.application_signatures
      ADD CONSTRAINT sp_signature_has_image
      CHECK (signature_data IS NOT NULL OR storage_path IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sp_signature_method_check'
  ) THEN
    ALTER TABLE supplier.application_signatures
      ADD CONSTRAINT sp_signature_method_check CHECK (method IN ('drawn', 'typed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sp_signature_key_unique'
  ) THEN
    ALTER TABLE supplier.application_signatures
      ADD CONSTRAINT sp_signature_key_unique UNIQUE (application_id, signature_key);
  END IF;
END$$;

-- ============================================================================
-- notifications — align to category / link_url
-- ============================================================================
ALTER TABLE supplier.notifications
  ADD COLUMN IF NOT EXISTS category varchar(30) NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS link_url text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'supplier' AND table_name = 'notifications'
       AND column_name = 'kind'
  ) THEN
    UPDATE supplier.notifications SET category = kind WHERE kind IS NOT NULL;
    ALTER TABLE supplier.notifications DROP COLUMN kind;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'supplier' AND table_name = 'notifications'
       AND column_name = 'link'
  ) THEN
    UPDATE supplier.notifications SET link_url = COALESCE(link_url, link);
    ALTER TABLE supplier.notifications DROP COLUMN link;
  END IF;

  -- The supplier-side categories: 'po' and 'bill' replace 'order'/'invoice'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sp_notifications_category_check'
  ) THEN
    ALTER TABLE supplier.notifications
      ADD CONSTRAINT sp_notifications_category_check
      CHECK (category IN ('general', 'application', 'po', 'bill', 'payment',
                          'pricing', 'accreditation', 'account'));
  END IF;
END$$;

-- ============================================================================
-- application_events — the capture and signature events the routes record
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'applications_events_event_type_check'
        OR conname = 'application_events_event_type_check'
  ) THEN
    ALTER TABLE supplier.application_events
      DROP CONSTRAINT IF EXISTS application_events_event_type_check;
  END IF;

  ALTER TABLE supplier.application_events
    ADD CONSTRAINT application_events_event_type_check
    CHECK (event_type IN ('created', 'saved', 'submitted', 'assigned',
                          'commented', 'info_requested', 'info_provided',
                          'approved', 'rejected', 'withdrawn', 'reopened',
                          'document_uploaded', 'signed', 'photo_captured'));
END$$;
