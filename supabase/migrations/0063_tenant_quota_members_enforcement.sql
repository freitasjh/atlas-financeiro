-- 0063_tenant_quota_members_enforcement.sql — tenant-quota / F3 / ADR-002 (BE-38).
--
-- Motivo: `0062` entregou `plan_limits.max_members`, mas nenhum caminho o
-- aplica. Sem o ramo de `tenant_members` o convite ignora o limite de seats
-- (RF-QT-05) e o rótulo `quota-members-exceeded` não existe. `0061` deixou
-- `enforce_tenant_quota()` com 4 ramos; esta migration acrescenta o 5º sem
-- duplicar função nem trigger (I6).
--
-- Entrega (server-side; nenhuma escrita de `authenticated`):
--   1) `public.enforce_tenant_quota()` recriada com o ramo `tenant_members`:
--      a contagem usa `NEW.tenant_id` — a coluna líder da PK
--      `(tenant_id, user_id)` (`0022:112`, index-only scan) — e NÃO deriva
--      tenant (a linha só nasce por RPC DEFINER; o cliente não tem INSERT).
--      Limite lido de `plan_limits.max_members` pelo plano do próprio tenant;
--      `full` (NULL) nunca bloqueia; `plan_limits` sem linha continua
--      `plan-limits-missing` (I9). Bootstrap do tenant (`0077`/`0079` inserem
--      a membership owner com `count = 0 < 1`) nunca é bloqueado (I13).
--      `members` NÃO consome override one-shot (REQ-24: recurso fora do CHECK
--      de `private.plan_quota_overrides`); o probe é `EXISTS … OFFSET
--      (v_limit - 1)` e `v_limit = 0` é excedido antes do probe (REQ-13).
--      Rótulo: `quota-members-exceeded`, 0 membership.
--   2) Trigger `plan_quota_tenant_members` BEFORE INSERT em `tenant_members`,
--      nome alfabeticamente depois de `aa_subscription_readonly` — a ordem
--      status→quota continua sendo do NOME do trigger (I7), sem reavaliar
--      status no corpo.
--
-- O restante do corpo (transactions/accounts/credit_cards/budgets) é
-- idêntico ao de `0061` (derivação por `resolve_writable_tenant`, advisory
-- lock por tenant, override por recurso). Nenhuma coluna nova, nenhum valor
-- monetário tocado.
-- Erros por rótulo fixo, sem PII/id. Idempotente-safe: CREATE OR REPLACE +
-- DROP TRIGGER IF EXISTS + REVOKE repetíveis.
-- Migrations 0001–0062 e 0077–0081 intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regprocedure('public.enforce_tenant_quota()') IS NULL
    OR to_regclass('public.tenant_members') IS NULL
    OR to_regclass('public.plan_limits') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_attribute AS a
      WHERE a.attrelid = 'public.plan_limits'::regclass
        AND a.attname = 'max_members'
        AND NOT a.attisdropped
    ) THEN
    RAISE EXCEPTION 'tenant-quota-precondition-missing';
  END IF;
END $$;

-- ============ 1. enforce_tenant_quota com o ramo de members ============

CREATE OR REPLACE FUNCTION public.enforce_tenant_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant uuid;
  v_plan text;
  v_limit integer;
  v_exceeded boolean := false;
  v_token uuid;
  v_is_members boolean := false;
BEGIN
  v_is_members := TG_TABLE_NAME = 'tenant_members';

  IF v_is_members THEN
    -- PK `(tenant_id, user_id)`: o tenant é a coluna líder, nunca derivado.
    -- `created_at` NÃO é normalizado: é a chave de ordenação da derivação
    -- (`resolve_user_tenant`) e do desempate provado em `0054` T07; a
    -- membership só nasce por RPC DEFINER, logo não há valor de cliente a
    -- forjar.
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
  'Quota por tenant (ADR-002): 4 recursos com tenant derivado (resolve_writable_tenant, valor do cliente sobrescrito) + tenant_members por NEW.tenant_id (coluna líder da PK, não deriva). Sem tenant -> quota-tenant-missing; plano sem linha -> plan-limits-missing; no limite -> quota-<recurso>-exceeded (members: quota-members-exceeded), 0 linhas. Advisory lock por tenant; override one-shot só nos 4 recursos (members não é overridable).';

REVOKE ALL ON FUNCTION public.enforce_tenant_quota()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 2. Trigger de members (ordinal depois de aa_) ============

DROP TRIGGER IF EXISTS plan_quota_tenant_members ON public.tenant_members;
CREATE TRIGGER plan_quota_tenant_members
  BEFORE INSERT ON public.tenant_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_quota();
