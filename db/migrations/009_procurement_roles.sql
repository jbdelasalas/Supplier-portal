-- 009_procurement_roles.sql — procurement staff and procurement manager.
--
-- Staff do the day-to-day work: read and comment on supplier applications,
-- see suppliers and their price lists, and raise purchase orders. The manager
-- holds the decisions on top of that: accrediting (approving or rejecting) a
-- supplier, approving submitted price lists, and editing supplier records.
-- Neither touches payables — approving and paying invoices stays with AP — but
-- the manager can see invoices to follow up a disputed match.

SET LOCAL search_path = supplier, public, extensions;

INSERT INTO supplier.roles (code, name, description) VALUES
  ('procurement_staff',   'Procurement staff',
   'Review supplier applications, view suppliers and prices, raise purchase orders'),
  ('procurement_manager', 'Procurement manager',
   'Everything procurement staff can do, plus approve suppliers and price lists')
ON CONFLICT (code) DO NOTHING;

INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r JOIN supplier.permissions p ON p.code = ANY (ARRAY[
  'application.view','application.review',
  'supplier.view','pricing.view',
  'po.view','po.issue'
]) WHERE r.code = 'procurement_staff'
ON CONFLICT DO NOTHING;

INSERT INTO supplier.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM supplier.roles r JOIN supplier.permissions p ON p.code = ANY (ARRAY[
  'application.view','application.review','application.approve',
  'supplier.view','supplier.manage',
  'pricing.view','pricing.approve',
  'po.view','po.issue',
  'bill.view'
]) WHERE r.code = 'procurement_manager'
ON CONFLICT DO NOTHING;

-- Staff must never hold a decision; neither role may move money or manage users.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM supplier.role_permissions rp
      JOIN supplier.roles r       ON r.id = rp.role_id
      JOIN supplier.permissions p ON p.id = rp.permission_id
     WHERE (r.code = 'procurement_staff'
            AND p.code IN ('application.approve','pricing.approve','supplier.manage'))
        OR (r.code IN ('procurement_staff','procurement_manager')
            AND p.code IN ('bill.approve','bill.pay','user.manage','settings.manage','form.manage'))
  ) THEN
    RAISE EXCEPTION 'procurement role holds a permission it must not have';
  END IF;
END$$;
