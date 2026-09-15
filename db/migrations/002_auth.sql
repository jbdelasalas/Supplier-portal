-- 002_auth.sql — users, roles, permissions, sessions.
--
-- Two populations share one users table, separated by `user_type`:
--   'supplier' — self-signed-up portal users, scoped to ONE supplier
--   'staff'    — internal purchasing/finance reviewers, scoped to companies
-- One table means one login path and one session model; the user_type check
-- plus supplier_id scoping is what keeps them apart.
--
-- Note this is supplier.users, NOT public.users. A firm that is both a
-- supplier and a customer signs up separately in each portal; the accounts
-- are unrelated by design.

SET LOCAL search_path = supplier, public;

CREATE TABLE IF NOT EXISTS supplier.users (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email             citext NOT NULL UNIQUE,
  password_hash     text   NOT NULL,
  full_name         varchar(160) NOT NULL,
  phone             varchar(40),
  user_type         varchar(10) NOT NULL CHECK (user_type IN ('supplier', 'staff')),

  -- Supplier users only: set once their application is approved.
  supplier_id       uuid,

  is_active         boolean NOT NULL DEFAULT true,
  is_superadmin     boolean NOT NULL DEFAULT false,

  email_verified_at timestamptz,
  last_login_at     timestamptz,

  -- A staff-issued temporary password must not become a permanent one: the
  -- user can sign in with it but cannot go anywhere until they set their own.
  must_change_password boolean NOT NULL DEFAULT false,

  -- Throttling / lockout
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- A staff user must never carry a supplier_id.
  CONSTRAINT sp_users_supplier_scope CHECK (
    user_type = 'supplier' OR supplier_id IS NULL
  )
);
SELECT supplier.attach_updated_at('supplier.users');

CREATE INDEX IF NOT EXISTS idx_sp_users_supplier
  ON supplier.users (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sp_users_type
  ON supplier.users (user_type, is_active);

-- ============================================================================
-- Roles & permissions (staff side; suppliers get access via supplier_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.roles (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        varchar(40) NOT NULL UNIQUE,
  name        varchar(120) NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier.permissions (
  id      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code    varchar(80) NOT NULL UNIQUE,
  module  varchar(40) NOT NULL,
  action  varchar(40) NOT NULL,
  name    varchar(160) NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier.role_permissions (
  role_id       uuid NOT NULL REFERENCES supplier.roles(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES supplier.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS supplier.user_roles (
  user_id uuid NOT NULL REFERENCES supplier.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES supplier.roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Staff may be limited to specific companies. No rows = all companies.
CREATE TABLE IF NOT EXISTS supplier.user_companies (
  user_id    uuid NOT NULL REFERENCES supplier.users(id)     ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES supplier.companies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, company_id)
);

-- ============================================================================
-- Sessions — refresh tokens stored hashed so a DB leak cannot mint sessions
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.sessions (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            uuid NOT NULL REFERENCES supplier.users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  user_agent         text,
  ip_address         inet,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_sessions_user
  ON supplier.sessions (user_id) WHERE revoked_at IS NULL;

-- ============================================================================
-- One-time tokens: email verification, password reset, staff invites
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.auth_tokens (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid NOT NULL REFERENCES supplier.users(id) ON DELETE CASCADE,
  purpose     varchar(30) NOT NULL
              CHECK (purpose IN ('verify_email', 'reset_password', 'invite')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_auth_tokens_user
  ON supplier.auth_tokens (user_id, purpose) WHERE consumed_at IS NULL;

-- ============================================================================
-- Seed roles & permissions — purchasing-side, not sales-side
-- ============================================================================
INSERT INTO supplier.roles (code, name, description) VALUES
  ('superadmin',    'Superadmin',            'Full access to everything'),
  ('portal_admin',  'Portal admin',          'Manage portal users, suppliers and settings'),
  ('accreditation', 'Accreditation officer', 'Review and approve supplier applications'),
  ('purchasing',    'Purchasing',            'Issue purchase orders and manage quoted prices'),
  ('receiving',     'Receiving',             'Confirm goods received against purchase orders'),
  ('payables',      'Accounts payable',      'Process supplier invoices and record payments'),
  ('viewer',        'Viewer',                'Read-only access')
ON CONFLICT (code) DO NOTHING;

INSERT INTO supplier.permissions (code, module, action, name) VALUES
  ('application.view',    'application', 'view',    'View supplier applications'),
  ('application.review',  'application', 'review',  'Review and comment on applications'),
  ('application.approve', 'application', 'approve', 'Approve or reject applications'),
  ('form.manage',         'form',        'manage',  'Create and edit form definitions'),
  ('supplier.view',       'supplier',    'view',    'View suppliers'),
  ('supplier.manage',     'supplier',    'manage',  'Create and edit suppliers'),
  ('pricing.view',        'pricing',     'view',    'View supplier price lists'),
  ('pricing.approve',     'pricing',     'approve', 'Approve submitted price lists'),
  ('po.view',             'po',          'view',    'View purchase orders'),
  ('po.issue',            'po',          'issue',   'Create and issue purchase orders'),
  ('po.receive',          'po',          'receive', 'Record receipts against purchase orders'),
  ('bill.view',           'bill',        'view',    'View supplier invoices'),
  ('bill.approve',        'bill',        'approve', 'Approve supplier invoices for payment'),
  ('bill.pay',            'bill',        'pay',     'Record payments to suppliers'),
  ('user.manage',         'user',        'manage',  'Manage portal and staff users'),
  ('settings.manage',     'settings',    'manage',  'Manage company and portal settings')
ON CONFLICT (code) DO NOTHING;

-- Superadmin gets everything, including permissions added by later migrations.
INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r CROSS JOIN supplier.permissions p
 WHERE r.code = 'superadmin'
ON CONFLICT DO NOTHING;

INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r JOIN supplier.permissions p ON p.code = ANY (ARRAY[
  'application.view','application.review','application.approve','form.manage',
  'supplier.view','supplier.manage','pricing.view','pricing.approve',
  'po.view','po.issue','po.receive','bill.view','bill.approve','bill.pay',
  'user.manage','settings.manage'
]) WHERE r.code = 'portal_admin'
ON CONFLICT DO NOTHING;

INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r JOIN supplier.permissions p ON p.code = ANY (ARRAY[
  'application.view','application.review','application.approve',
  'supplier.view','supplier.manage'
]) WHERE r.code = 'accreditation'
ON CONFLICT DO NOTHING;

INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r JOIN supplier.permissions p ON p.code = ANY (ARRAY[
  'supplier.view','pricing.view','pricing.approve','po.view','po.issue','application.view'
]) WHERE r.code = 'purchasing'
ON CONFLICT DO NOTHING;

INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r JOIN supplier.permissions p ON p.code = ANY (ARRAY[
  'po.view','po.receive','supplier.view'
]) WHERE r.code = 'receiving'
ON CONFLICT DO NOTHING;

INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r JOIN supplier.permissions p ON p.code = ANY (ARRAY[
  'bill.view','bill.approve','bill.pay','supplier.view','po.view'
]) WHERE r.code = 'payables'
ON CONFLICT DO NOTHING;

INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r JOIN supplier.permissions p ON p.code = ANY (ARRAY[
  'application.view','supplier.view','po.view','bill.view','pricing.view'
]) WHERE r.code = 'viewer'
ON CONFLICT DO NOTHING;
