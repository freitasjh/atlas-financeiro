-- 0076_tenant_quota_status_first.sql — subscription-access / F6 / ADR-002 §16.1 (A5/A6).
--
-- Motivo: `0063` resolve o tenant e vai direto ao plano/limite/lock/override. O
-- `0054`/`0075` já negam por status via trigger `aa_subscription_readonly`, mas
-- a ordem status→quota hoje depende só do nome do trigger (ordinal alfabético).
-- A5 exige que `enforce_tenant_quota` também negue por status, ANTES de ler
-- `plan_limits`, do `pg_advisory_xact_lock` e de `plan_quota_overrides` — é
-- defesa em profundidade e garante que nenhum token de override é queimado por
-- negação de status.
--
-- Entrega: `CREATE OR REPLACE public.enforce_tenant_quota()` com o corpo de
-- `0063` + bloco de status imediatamente após a resolução de `v_tenant`:
--   • `v_tenant` nulo continua `quota-tenant-missing` ANTES do status (D3);
--   • `subscription_access(v_tenant) = 'readonly'` ⇒ rótulo do estado daquele
--     tenant: `past_due` ⇒ subscription-past-due-grace-expired; senão
--     subscription-canceled-readonly;
--   • os 7 rótulos de quota e `plan_quota_*` ficam byte a byte (A6).
--
-- Nenhum trigger é recriado (mesmo nome, mesma função). Assinatura intacta
-- (`RETURNS trigger`). `plan_limits`/`plan_quota_overrides`/`get_tenant_usage`
-- intocados. Sem `current_user`. Nenhum valor monetário tocado.
-- Idempotente-safe: guard de pré-condição + CREATE OR REPLACE + REVOKE.
-- Migrations 0001–0075 e 0077–0081 intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regprocedure('public.enforce_tenant_quota()') IS NULL
    OR to_regprocedure('private.subscription_access(uuid)') IS NULL
    OR to_regprocedure('private.resolve_writable_tenant(uuid)') IS NULL
    OR to_regclass('public.tenants') IS NULL
    OR to_regclass('public.plan_limits') IS NULL THEN
    RAISE EXCEPTION 'subscription-access-precondition-missing';
  END IF;
END $$;

-- ============ 1. enforce_tenant_quota com status no topo ============

CREATE OR REPLACE FUNCTION public.enforce_tenant_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant uuid;
  v_status_label text;
  v_plan text;
  v_limit integer;
  v_exceeded boolean := false;
  v_token uuid;
  v_is_members boolean := false;
BEGIN
  v_is_members := TG_TABLE_NAME = 'tenant_members';

  IF v_is_members THEN
    -- PK `(tenant_id, user_id)`: o tenant é a coluna líder, nunca derivado.
    v_tenant := NEW.tenant_id;
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'quota-tenant-missing';
    END IF;
  ELSE
    NEW.created_at := pg_catalog.now();

    v_tenant := private.resolve_writable_tenant(NEW.user_id);
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'quota-tenant-missing';
    END IF;
    NEW.tenant_id := v_tenant;
  END IF;

  -- ===== A5: status antes de plano/limite/lock/override (defesa em profundidade) =====
  IF private.subscription_access(v_tenant) = 'readonly' THEN
    SELECT CASE
             WHEN t.subscription_status = 'past_due'
               THEN 'subscription-past-due-grace-expired'
             ELSE 'subscription-canceled-readonly'
           END
      INTO v_status_label
    FROM public.tenants AS t
    WHERE t.id = v_tenant;

    RAISE EXCEPTION USING MESSAGE = v_status_label;
  END IF;

  SELECT t.plan_id INTO v_plan
  FROM public.tenants AS t
  WHERE t.id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota-tenant-missing';
  END IF;

  SELECT CASE TG_TABLE_NAME
           WHEN 'transactions' THEN pl.max_transactions_month
           WHEN 'accounts' THEN pl.max_accounts
           WHEN 'credit_cards' THEN pl.max_credit_cards
           WHEN 'budgets' THEN pl.max_budgets
           WHEN 'tenant_members' THEN pl.max_members
         END
    INTO v_limit
  FROM public.plan_limits AS pl
  WHERE pl.plan_slug = v_plan;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan-limits-missing';
  END IF;

  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_tenant::text, 0));

  IF v_limit = 0 THEN
    v_exceeded := true;
  ELSIF TG_TABLE_NAME = 'transactions' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.transactions AS tx
      WHERE tx.tenant_id = v_tenant
        AND tx.created_at >= private.sp_month_start()
      OFFSET (v_limit - 1)
    ) INTO v_exceeded;
  ELSIF TG_TABLE_NAME = 'accounts' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.accounts AS acc
      WHERE acc.tenant_id = v_tenant
      OFFSET (v_limit - 1)
    ) INTO v_exceeded;
  ELSIF TG_TABLE_NAME = 'credit_cards' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.credit_cards AS cc
      WHERE cc.tenant_id = v_tenant
      OFFSET (v_limit - 1)
    ) INTO v_exceeded;
  ELSIF TG_TABLE_NAME = 'budgets' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.budgets AS bg
      WHERE bg.tenant_id = v_tenant
      OFFSET (v_limit - 1)
    ) INTO v_exceeded;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.tenant_members AS tm
      WHERE tm.tenant_id = v_tenant
      OFFSET (v_limit - 1)
    ) INTO v_exceeded;
  END IF;

  IF NOT v_exceeded THEN
    RETURN NEW;
  END IF;

  -- `members` não é overridable (REQ-24): nenhum token é consultado nem
  -- consumido nesse ramo.
  IF NOT v_is_members THEN
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
  END IF;

  IF TG_TABLE_NAME = 'transactions' THEN
    RAISE EXCEPTION 'quota-transactions-exceeded';
  ELSIF TG_TABLE_NAME = 'accounts' THEN
    RAISE EXCEPTION 'quota-accounts-exceeded';
  ELSIF TG_TABLE_NAME = 'credit_cards' THEN
    RAISE EXCEPTION 'quota-credit-cards-exceeded';
  ELSIF TG_TABLE_NAME = 'budgets' THEN
    RAISE EXCEPTION 'quota-budgets-exceeded';
  ELSE
    RAISE EXCEPTION 'quota-members-exceeded';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.enforce_tenant_quota() IS
  'Quota por tenant (ADR-002 A5/A6): status primeiro (subscription_access) apos resolver v_tenant e antes de plan_limits/lock/override — readonly -> subscription-past-due-grace-expired (past_due) ou subscription-canceled-readonly, sem consumir token. Depois: 4 recursos com tenant derivado + tenant_members por NEW.tenant_id; sem tenant -> quota-tenant-missing; plano sem linha -> plan-limits-missing; no limite -> quota-<recurso>-exceeded (members: quota-members-exceeded). Advisory lock por tenant; override one-shot so nos 4 recursos.';

REVOKE ALL ON FUNCTION public.enforce_tenant_quota()
  FROM PUBLIC, anon, authenticated, service_role;
