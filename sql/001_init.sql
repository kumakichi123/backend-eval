-- テナント分離用の基本スキーマ
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY,
  email text UNIQUE,
  display_name text,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text NOT NULL,
  staff_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff(tenant_id);

CREATE TABLE IF NOT EXISTS templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL,
  title text NOT NULL,
  max_score int NOT NULL CHECK (max_score >= 1),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant_role ON templates(tenant_id, role);

CREATE TABLE IF NOT EXISTS template_items (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL,
  weight numeric NOT NULL DEFAULT 1,
  display_order int NOT NULL DEFAULT 0,
  UNIQUE(template_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_titems_tenant ON template_items(tenant_id);

CREATE TABLE IF NOT EXISTS evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  period text NOT NULL,
  evaluator_role text NOT NULL,
  evaluator_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evals_tenant_period ON evaluations(tenant_id, period);

CREATE TABLE IF NOT EXISTS evaluation_items (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  evaluation_id uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  score int NOT NULL,
  UNIQUE(evaluation_id, staff_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_eval_items_tenant ON evaluation_items(tenant_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid,
  action text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id);

-- サンプルデータ
INSERT INTO tenants(id, name) VALUES(
  '11111111-1111-1111-1111-111111111111', 'Sample園')
ON CONFLICT DO NOTHING;

INSERT INTO staff(tenant_id, name, role, staff_code) VALUES
  ('11111111-1111-1111-1111-111111111111','山田花子','保育士','S001'),
  ('11111111-1111-1111-1111-111111111111','佐藤太郎','保育士','S002'),
  ('11111111-1111-1111-1111-111111111111','鈴木一郎','看護師','N001')
ON CONFLICT DO NOTHING;

-- 2ロール分のテンプレ雛形
WITH t AS (
  INSERT INTO templates(tenant_id, role, title, max_score)
  VALUES
    ('11111111-1111-1111-1111-111111111111','保育士','基本評価',5),
    ('11111111-1111-1111-1111-111111111111','看護師','基本評価',5)
  ON CONFLICT DO NOTHING
  RETURNING id, role
)
INSERT INTO template_items(tenant_id, template_id, item_key, label, description, weight, display_order)
SELECT '11111111-1111-1111-1111-111111111111', id,
  x.item_key, x.label, x.description, x.weight, x.display_order
FROM t
CROSS JOIN LATERAL (
  VALUES
    ('initiative','主体性','自主的に行動する',1,1),
    ('communication','連携','周囲と協力できる',1,2)
) AS x(item_key,label,description,weight,display_order);