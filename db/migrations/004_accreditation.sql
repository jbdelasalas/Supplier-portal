-- 004_accreditation.sql — the supplier accreditation (application) flow.
--
-- Forms are DATA, not code: a form_versions row holds a JSON schema of
-- sections and fields, and the UI renders whatever it finds there. When the
-- business changes the form we publish a new version; in-flight applications
-- keep rendering and validating against the version they started on.
--
-- Changing the accreditation form is therefore a seed edit plus db:seed, never
-- a component rewrite.

SET LOCAL search_path = supplier, public;

-- ============================================================================
-- Form definitions
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.forms (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  uuid REFERENCES supplier.companies(id) ON DELETE CASCADE,  -- null = global
  code        varchar(60) NOT NULL,
  name        varchar(200) NOT NULL,
  description text,
  kind        varchar(30) NOT NULL DEFAULT 'supplier_accreditation'
              CHECK (kind IN ('supplier_accreditation', 'renewal', 'update_request', 'other')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
SELECT supplier.attach_updated_at('supplier.forms');

-- One immutable row per published revision.
--
-- `schema` shape:
-- {
--   "sections": [
--     { "key": "business_info",
--       "title": "Business Information",
--       "description": "...",
--       "fields": [
--         { "key": "legal_name",
--           "label": "Registered business name",
--           "type": "text",            -- text|textarea|number|email|phone|date|
--                                      -- url|select|multiselect|radio|checkbox|
--                                      -- file|section_note
--           "required": true,
--           "placeholder": "...",
--           "help": "...",
--           "maxLength": 200,
--           "options": [{ "value": "vat", "label": "VAT registered" }],
--           "showIf": { "field": "supplier_type", "equals": "corporate" },
--           "mapsTo": "suppliers.legal_name"   -- optional: auto-fill on approval
--         }
--       ]
--     }
--   ],
--   "documents": [
--     { "key": "sec_reg", "label": "SEC/DTI Registration", "required": true,
--       "accept": ["application/pdf","image/*"], "maxSizeMb": 10 }
--   ]
-- }
CREATE TABLE IF NOT EXISTS supplier.form_versions (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  form_id      uuid NOT NULL REFERENCES supplier.forms(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  schema       jsonb NOT NULL,
  changelog    text,
  status       varchar(20) NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'published', 'retired')),
  published_at timestamptz,
  published_by uuid REFERENCES supplier.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_id, version)
);

CREATE INDEX IF NOT EXISTS idx_sp_form_versions_published
  ON supplier.form_versions (form_id, version DESC) WHERE status = 'published';

-- ============================================================================
-- Applications — one per prospective supplier submission
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.applications (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       uuid NOT NULL REFERENCES supplier.companies(id) ON DELETE RESTRICT,
  form_version_id  uuid NOT NULL REFERENCES supplier.form_versions(id) ON DELETE RESTRICT,

  reference_no     varchar(30) NOT NULL UNIQUE,

  -- The applicant's account. Null while the form is filled anonymously.
  applicant_user_id uuid REFERENCES supplier.users(id) ON DELETE SET NULL,
  applicant_email   citext NOT NULL,
  applicant_name    varchar(160),
  applicant_phone   varchar(40),

  -- Denormalised for the review queue, pulled from `data` on submit.
  business_name    varchar(200),
  -- What they are applying to supply. Lets the queue be split by buyer.
  category         varchar(120),

  -- The filled form. Keys match form_versions.schema field keys.
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,

  status           varchar(20) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'submitted', 'under_review',
                                     'info_requested', 'approved', 'rejected', 'withdrawn')),

  submitted_at     timestamptz,
  reviewed_by      uuid REFERENCES supplier.users(id),
  reviewed_at      timestamptz,
  decided_by       uuid REFERENCES supplier.users(id),
  decided_at       timestamptz,
  decision_notes   text,

  -- How many times this application has been sent back and revised. Drives the
  -- "Attempt 2" label for reviewers, and makes a serial reapplier visible.
  revision         integer NOT NULL DEFAULT 1,

  -- Set once approved.
  supplier_id      uuid REFERENCES supplier.suppliers(id) ON DELETE SET NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT supplier.attach_updated_at('supplier.applications');

CREATE INDEX IF NOT EXISTS idx_sp_applications_queue
  ON supplier.applications (company_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_sp_applications_applicant
  ON supplier.applications (applicant_user_id) WHERE applicant_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sp_applications_email
  ON supplier.applications (applicant_email);

-- Close the loop from suppliers back to the application that created it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sp_suppliers_application_id_fkey'
  ) THEN
    ALTER TABLE supplier.suppliers
      ADD CONSTRAINT sp_suppliers_application_id_fkey
      FOREIGN KEY (application_id) REFERENCES supplier.applications(id) ON DELETE SET NULL;
  END IF;
END$$;

-- ============================================================================
-- Uploaded documents
--
-- Supplier accreditation is document-heavy: permits, tax clearance, insurance,
-- and for a feed or medication supplier the FDA/BAI licence. `expires_at` is
-- the difference from the customer side — a certificate that has lapsed is
-- worse than a missing one, because it looks complete on file.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.application_documents (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id uuid NOT NULL REFERENCES supplier.applications(id) ON DELETE CASCADE,
  -- Matches a `documents[].key` in the form schema; free-form for extras.
  doc_key        varchar(60) NOT NULL,
  file_name      varchar(255) NOT NULL,
  content_type   varchar(120),
  size_bytes     bigint,
  storage_path   text NOT NULL,
  checksum_sha256 varchar(64),
  uploaded_by    uuid REFERENCES supplier.users(id),
  uploaded_at    timestamptz NOT NULL DEFAULT now(),

  -- Set for certificates that lapse, so accreditation renewal can be chased.
  expires_at     date,

  -- Camera captures share this table, as they share storage and review flow.
  -- 'upload' = chosen from the filesystem, 'camera' = captured live.
  source         varchar(10) NOT NULL DEFAULT 'upload'
                 CHECK (source IN ('upload', 'camera')),
  captured_lat   numeric(10,7),
  captured_lng   numeric(10,7),

  status         varchar(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'rejected')),
  reject_reason  text
);

CREATE INDEX IF NOT EXISTS idx_sp_application_documents
  ON supplier.application_documents (application_id, doc_key);
CREATE INDEX IF NOT EXISTS idx_sp_application_docs_expiry
  ON supplier.application_documents (expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================================
-- E-signatures
--
-- A signature is only worth as much as the evidence around it. "They ticked a
-- box" is weak; "they drew this signature at this time, from this IP, on this
-- device, against this exact wording, and the record has not changed since" is
-- defensible. So each signature stores the image, the declaration text as
-- shown, the request context, and a hash over all of it.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.application_signatures (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id uuid NOT NULL REFERENCES supplier.applications(id) ON DELETE CASCADE,
  sig_key        varchar(60) NOT NULL,

  signatory_name     varchar(160) NOT NULL,
  signatory_position varchar(120),

  -- The drawn signature, stored as a PNG data URL.
  image_data     text NOT NULL,
  -- The declaration exactly as displayed when they signed. Stored verbatim
  -- because the schema may change afterwards and this must not.
  declaration_text text NOT NULL,

  -- Request context at signing time.
  ip_address     inet,
  user_agent     text,
  signed_by      uuid REFERENCES supplier.users(id),
  signed_at      timestamptz NOT NULL DEFAULT now(),

  -- sha256 over name + declaration + image + signed_at. Recomputed on read to
  -- detect tampering.
  evidence_hash  varchar(64) NOT NULL,

  UNIQUE (application_id, sig_key)
);

CREATE INDEX IF NOT EXISTS idx_sp_application_signatures
  ON supplier.application_signatures (application_id);

-- ============================================================================
-- Review trail — every status change and comment, append-only
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.application_events (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id uuid NOT NULL REFERENCES supplier.applications(id) ON DELETE CASCADE,
  event_type     varchar(30) NOT NULL
                 CHECK (event_type IN ('created', 'saved', 'submitted', 'assigned',
                                       'commented', 'info_requested', 'info_provided',
                                       'approved', 'rejected', 'withdrawn', 'reopened',
                                       'document_uploaded', 'signed')),
  from_status    varchar(20),
  to_status      varchar(20),
  message        text,
  -- Visible to the applicant in the portal? Internal notes stay false.
  is_public      boolean NOT NULL DEFAULT false,
  actor_user_id  uuid REFERENCES supplier.users(id),
  actor_label    varchar(160),
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_application_events
  ON supplier.application_events (application_id, created_at DESC);

-- ============================================================================
-- Reference numbers: SUP-YYYY-000123, restarting each year
--
-- Skips past any value already taken, so a restored backup or a hand-inserted
-- row cannot wedge a public-facing path behind a unique violation.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.application_ref_seq (
  year       integer PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION supplier.next_application_ref()
RETURNS varchar AS $$
DECLARE
  v_year integer := EXTRACT(YEAR FROM now())::integer;
  v_next integer;
  v_ref  varchar(30);
BEGIN
  INSERT INTO supplier.application_ref_seq (year, last_value)
  VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE
    SET last_value = supplier.application_ref_seq.last_value + 1
  RETURNING last_value INTO v_next;

  LOOP
    v_ref := 'SUP-' || v_year::text || '-' || lpad(v_next::text, 6, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM supplier.applications WHERE reference_no = v_ref
    );
    v_next := v_next + 1;
    UPDATE supplier.application_ref_seq SET last_value = v_next WHERE year = v_year;
  END LOOP;

  RETURN v_ref;
END;
$$ LANGUAGE plpgsql;
