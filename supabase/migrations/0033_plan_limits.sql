-- 0033_plan_limits.sql — backoffice P1 / BE-01+BE-02 (ADR-001).
--
-- Motivo: quota de plano só existia em regra de cliente; escrita direta
-- (console/outro cliente) nunca seria bloqueada. ADR-001 exige bloqueio no
-- banco + override auditado de uso único.
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `public.plan_limits` — limites por plano (NULL = sem limite), seed
--      free 20·2·1·3 / standard 500·5·2·10 / pro 5000·10·5·20 / full 4x NULL.
--      RLS sem policy + REVOKE ALL: leitura só via `get_plan_limit`.
--   2) `get_plan_limit(p_slug)` — leitura SECURITY DEFINER; slug bogus ->
--      `tenant-plan-invalid` (nunca silencia para `free`).
--   3) `enforce_plan_quota()` BEFORE INSERT em transactions/accounts/
--      credit_cards/budgets: normaliza `NEW.created_at := now()` (C1: sem
--      created_at forjado que escape do mês SP), tenant dono (membership owner
--      primeiro) -> plano vigente -> limite vs uso (lançamentos: mês SP por
--      created_at já normalizado; demais: total vigente); no limite ->
--      `plan-quota-exceeded`, 0 linhas. Token de override consumido com
--      `FOR UPDATE ... SKIP LOCKED` + `UPDATE ... WHERE consumed_at IS NULL`
--      (C2: 1 token libera 1 criação mesmo sob concorrência). Sem
--      `current_user`: vale para cliente, console e RPC. Sem tenant ou limite
--      NULL => libera (legado P0 sem tenant segue funcionando).
--   4) `admin_register_override(tenant, recurso, motivo)` — SECURITY DEFINER,
--      `is_admin()` InitPlan, motivo>=10, 1 linha `admin_audit`
--      (action `quota_override`) + 1 token one-shot em
--      `private.plan_quota_overrides` (consumido pelo trigger; não é trilha,
--      é credencial de uma única criação). `tenants_audit_reject` reafirmado.
--   5) `list_admin_audit_page` redefine a whitelist 0032 para incluir
--      `quota_override` (A1: trilha do override legível via RPC; bogus ->
--      `tenant-audit-action-invalid`).
--   6) `created_at_immutable()` BEFORE UPDATE OF created_at nas 4 tabelas
--      cotadas -> `created_at-immutable` (C1b: só o INSERT era normalizado; o
--      UPDATE voltava a linha p/ mês anterior e liberava INSERT no limite —
--      quota contornável por UPDATE). Sem `current_user`, sem escape GUC:
--      created_at é NOT NULL e nenhuma cascata SET NULL o toca.
--
-- Erros por rótulo fixo, sem PII/id: plan-quota-exceeded, not-admin,
-- override-reason-too-short, override-resource-invalid, tenant-not-found,
-- created_at-immutable.
-- Limites são integer (quota, não dinheiro); nenhum float/double.
-- Idempotente: CREATE IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS / ON CONFLICT DO NOTHING / REVOKE-GRANT repetíveis.
-- Migrations 0001-0032 intocadas.

-- ============ 1. Tabela plan_limits + seed ============

CREATE TABLE IF NOT EXISTS public.plan_limits (
  plan_slug text PRIMARY KEY
    CHECK (plan_slug IN ('free', 'standard', 'pro', 'full')),
  max_transactions_month integer NULL
    CHECK (max_transactions_month IS NULL OR max_transactions_month >= 0),
  max_accounts integer NULL
    CHECK (max_accounts IS NULL OR max_accounts >= 0),
  max_credit_cards integer NULL
    CHECK (max_credit_cards IS NULL OR max_credit_cards >= 0),
  max_budgets integer NULL
    CHECK (max_budgets IS NULL OR max_budgets >= 0)
);

COMMENT ON TABLE public.plan_limits IS
  'Verdade de quota por plano (ADR-001). NULL = sem limite. Leitura só via get_plan_limit; escrita só DBA/migration.';

INSERT INTO public.plan_limits
  (plan_slug, max_transactions_month, max_accounts, max_credit_cards, max_budgets)
VALUES
  ('free', 20, 2, 1, 3),
  ('standard', 500, 5, 2, 10),
  ('pro', 5000, 10, 5, 20),
  ('full', NULL, NULL, NULL, NULL)
ON CONFLICT (plan_slug) DO NOTHING;

-- ============ 2. Leitura: get_plan_limit ============

CREATE OR REPLACE FUNCTION public.get_plan_limit(p_slug text)
RETURNS TABLE (
  max_transactions_month integer,
  max_accounts integer,
  max_credit_cards integer,
  max_budgets integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_slug text := pg_catalog.btrim(COALESCE(p_slug, ''));
BEGIN
  IF v_slug NOT IN ('free', 'standard', 'pro', 'full') THEN
    RAISE EXCEPTION 'tenant-plan-invalid';
  END IF;

  RETURN QUERY
  SELECT pl.max_transactions_month, pl.max_accounts,
         pl.max_credit_cards, pl.max_budgets
  FROM public.plan_limits AS pl
  WHERE pl.plan_slug = v_slug;
END;
$$;

COMMENT ON FUNCTION public.get_plan_limit(text) IS
  'Limites de quota do plano (ADR-001). Slug fora do catálogo -> tenant-plan-invalid.';

REVOKE ALL ON FUNCTION public.get_plan_limit(text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_plan_limit(text) TO authenticated;

-- ============ 3. admin_audit: action quota_override ============

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_audit_action_check'
      AND conrelid = 'public.admin_audit'::regclass
  ) THEN
    ALTER TABLE public.admin_audit
      DROP CONSTRAINT admin_audit_action_check;
  END IF;

  ALTER TABLE public.admin_audit
    ADD CONSTRAINT admin_audit_action_check
    CHECK (action IN (
      'grant_admin', 'revoke_admin', 'change_plan',
      'tenant_status_changed', 'quota_override', 'other'
    ));
END $$;

-- ============ 4. Token one-shot do override (credencial, não trilha) ============

CREATE TABLE IF NOT EXISTS private.plan_quota_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  resource_type text NOT NULL
    CHECK (resource_type IN ('transactions', 'accounts', 'credit_cards', 'budgets')),
  audit_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

COMMENT ON TABLE private.plan_quota_overrides IS
  'Token one-shot do override (ADR-001): uma linha libera uma única criação e é consumida pelo trigger. A prova auditável vive em admin_audit.';
COMMENT ON COLUMN private.plan_quota_overrides.tenant_id IS
  'Tenant liberado. Sem FK: a trilha é a prova; o token é credencial efêmera.';
COMMENT ON COLUMN private.plan_quota_overrides.consumed_at IS
  'Instante do consumo (1 criação). NULL = pendente; pendente não libera fora da quota.';

ALTER TABLE private.plan_quota_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.plan_quota_overrides
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 5. Trigger enforce_plan_quota (4 tabelas) ============
-- SECURITY DEFINER + search_path='' + SEM current_user (ADR-001): qualquer
-- via de INSERT passa pela mesma contagem. C1: NEW.created_at normalizado
-- para now() (created_at de cliente nunca desvia do mês SP; date (negócio)
-- segue livre). C2: token travado por linha (FOR UPDATE SKIP LOCKED) +
-- UPDATE com guarda consumed_at IS NULL (duplo consumo sob concorrência não
-- passa). Sem tenant -> libera (P0 legado).

CREATE OR REPLACE FUNCTION public.enforce_plan_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_plan text;
  v_limit integer;
  v_count bigint := 0;
  v_token uuid;
BEGIN
  NEW.created_at := pg_catalog.now();

  v_user := NEW.user_id;

  SELECT t.id, t.plan_id
    INTO v_tenant, v_plan
  FROM public.tenants AS t
  JOIN public.tenant_members AS tm ON tm.tenant_id = t.id
  WHERE tm.user_id = v_user
  ORDER BY (tm.role = 'owner') DESC, tm.created_at ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT CASE TG_TABLE_NAME
           WHEN 'transactions' THEN pl.max_transactions_month
           WHEN 'accounts' THEN pl.max_accounts
           WHEN 'credit_cards' THEN pl.max_credit_cards
           WHEN 'budgets' THEN pl.max_budgets
         END
    INTO v_limit
  FROM public.plan_limits AS pl
  WHERE pl.plan_slug = v_plan;

  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'transactions' THEN
    SELECT count(*) INTO v_count
    FROM public.transactions AS tx
    WHERE tx.user_id = v_user
      AND (tx.created_at AT TIME ZONE 'America/Sao_Paulo')
          >= pg_catalog.date_trunc(
               'month',
               pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo'
             );
  ELSIF TG_TABLE_NAME = 'accounts' THEN
    SELECT count(*) INTO v_count
    FROM public.accounts AS a
    WHERE a.user_id = v_user;
  ELSIF TG_TABLE_NAME = 'credit_cards' THEN
    SELECT count(*) INTO v_count
    FROM public.credit_cards AS c
    WHERE c.user_id = v_user;
  ELSE
    SELECT count(*) INTO v_count
    FROM public.budgets AS b
    WHERE b.user_id = v_user;
  END IF;

  IF v_count < v_limit THEN
    RETURN NEW;
  END IF;

  SELECT o.id INTO v_token
  FROM private.plan_quota_overrides AS o
  WHERE o.tenant_id = v_tenant
    AND o.resource_type = TG_TABLE_NAME
    AND o.consumed_at IS NULL
  ORDER BY o.created_at ASC, o.id ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_token IS NOT NULL THEN
    UPDATE private.plan_quota_overrides
    SET consumed_at = pg_catalog.now()
    WHERE id = v_token
      AND consumed_at IS NULL;

    IF FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'plan-quota-exceeded';
END;
$$;

COMMENT ON FUNCTION public.enforce_plan_quota() IS
  'Quota (ADR-001): INSERT no limite -> plan-quota-exceeded, 0 linhas. Token de override pendente libera 1 criação e expira.';

REVOKE ALL ON FUNCTION public.enforce_plan_quota()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS plan_quota_transactions ON public.transactions;
CREATE TRIGGER plan_quota_transactions
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_quota();

DROP TRIGGER IF EXISTS plan_quota_accounts ON public.accounts;
CREATE TRIGGER plan_quota_accounts
  BEFORE INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_quota();

DROP TRIGGER IF EXISTS plan_quota_credit_cards ON public.credit_cards;
CREATE TRIGGER plan_quota_credit_cards
  BEFORE INSERT ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_quota();

DROP TRIGGER IF EXISTS plan_quota_budgets ON public.budgets;
CREATE TRIGGER plan_quota_budgets
  BEFORE INSERT ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_quota();

-- ============ 5b. Imutabilidade de created_at (C1b, todas as vias de escrita) ============
-- Fecha o bypass do UPDATE: sem normalização no INSERT, voltar created_at p/
-- mês anterior tirava a linha da contagem do mês SP e liberava INSERT novo.
-- SECURITY DEFINER + search_path='' + sem current_user (ADR-001): vale p/
-- cliente, console e RPC. Sem escape GUC/current_user: created_at é NOT NULL
-- e nenhuma cascata (SET NULL/DELETE) o toca, então nada precisa liberar.
-- UPDATE que não lista created_at no SET não dispara (OF created_at).

CREATE OR REPLACE FUNCTION public.created_at_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at-immutable';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.created_at_immutable() IS
  'created_at imutável (C1b/ADR-001): qualquer UPDATE que mude created_at -> created_at-immutable, 0 linhas.';

REVOKE ALL ON FUNCTION public.created_at_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS created_at_immutable ON public.transactions;
CREATE TRIGGER created_at_immutable
  BEFORE UPDATE OF created_at ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.created_at_immutable();

DROP TRIGGER IF EXISTS created_at_immutable ON public.accounts;
CREATE TRIGGER created_at_immutable
  BEFORE UPDATE OF created_at ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.created_at_immutable();

DROP TRIGGER IF EXISTS created_at_immutable ON public.credit_cards;
CREATE TRIGGER created_at_immutable
  BEFORE UPDATE OF created_at ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.created_at_immutable();

DROP TRIGGER IF EXISTS created_at_immutable ON public.budgets;
CREATE TRIGGER created_at_immutable
  BEFORE UPDATE OF created_at ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.created_at_immutable();

-- ============ 6. RPC admin_register_override ============

CREATE OR REPLACE FUNCTION public.admin_register_override(
  p_tenant_id uuid,
  p_resource_type text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_resource text := pg_catalog.btrim(COALESCE(p_resource_type, ''));
  v_reason text := pg_catalog.btrim(COALESCE(p_reason, ''));
  v_audit uuid;
BEGIN
  IF v_uid IS NULL OR NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF v_resource NOT IN ('transactions', 'accounts', 'credit_cards', 'budgets') THEN
    RAISE EXCEPTION 'override-resource-invalid';
  END IF;

  IF pg_catalog.char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'override-reason-too-short';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenants AS t WHERE t.id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, from_value, reason)
  VALUES (v_uid, p_tenant_id, p_tenant_id, 'quota_override', v_resource, v_reason)
  RETURNING id INTO v_audit;

  INSERT INTO private.plan_quota_overrides (tenant_id, resource_type, audit_id)
  VALUES (p_tenant_id, v_resource, v_audit);
END;
$$;

COMMENT ON FUNCTION public.admin_register_override(uuid, text, text) IS
  'Backoffice (ADR-001): override 1x com motivo>=10. Grava 1 linha audit append-only + 1 token one-shot. Só is_admin().';

REVOKE ALL ON FUNCTION public.admin_register_override(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_register_override(uuid, text, text)
  TO authenticated;

-- ============ 7. admin_audit append-only (reafirmado, dono 0028/0032) ============

CREATE OR REPLACE FUNCTION public.tenants_audit_reject()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('postgres', 'supabase_admin') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit-immutable';
END;
$$;

REVOKE ALL ON FUNCTION public.tenants_audit_reject()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenants_audit_reject ON public.admin_audit;
CREATE TRIGGER tenants_audit_reject
  BEFORE UPDATE OR DELETE ON public.admin_audit
  FOR EACH ROW EXECUTE FUNCTION public.tenants_audit_reject();

-- ============ 7b. list_admin_audit_page: whitelist inclui quota_override ============
-- A1: 0032 whitelist não conhecia quota_override (0033); filtrar overrides via
-- RPC devolvia tenant-audit-action-invalid. Redefinição idêntica à 0032 + a
-- ação nova, sem mudar assinatura, ordem, clamp ou gates.

CREATE OR REPLACE FUNCTION public.list_admin_audit_page(
  p_tenant uuid DEFAULT NULL,
  p_action text DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  actor_id uuid,
  target_id uuid,
  tenant_id uuid,
  action text,
  from_value text,
  to_value text,
  reason text,
  at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action text := NULLIF(pg_catalog.btrim(COALESCE(p_action, '')), '');
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF v_action IS NOT NULL
    AND v_action NOT IN (
      'grant_admin', 'revoke_admin', 'change_plan',
      'tenant_status_changed', 'quota_override', 'other'
    ) THEN
    RAISE EXCEPTION 'tenant-audit-action-invalid';
  END IF;

  RETURN QUERY
  SELECT a.id, a.actor_id, a.target_id, a.tenant_id,
    a.action, a.from_value, a.to_value, a.reason, a.at
  FROM public.admin_audit AS a
  WHERE (p_tenant IS NULL OR a.tenant_id = p_tenant OR a.target_id = p_tenant)
    AND (v_action IS NULL OR a.action = v_action)
  ORDER BY a.at DESC, a.id ASC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.list_admin_audit_page(uuid, text, int, int) IS
  'Backoffice P0 (ADR-006, whitelist 0033): trilha legível sem abrir a tabela. Filtros tenant/ação; limit clamp 1..100; só is_admin(); sem PII.';

REVOKE ALL ON FUNCTION public.list_admin_audit_page(uuid, text, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.list_admin_audit_page(uuid, text, int, int)
  TO authenticated;

-- ============ 8. plan_limits fechada p/ client ============
-- RLS ligada sem policy + REVOKE ALL sem GRANT: direct SELECT/INSERT/UPDATE
-- por anon/authenticated -> 42501 (nunca "salva" policy inexistente).

ALTER TABLE public.plan_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.plan_limits FROM PUBLIC, anon, authenticated;
