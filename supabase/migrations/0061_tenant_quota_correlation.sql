-- 0061_tenant_quota_correlation.sql — tenant-quota / F3 / ADR-002 (BE-34).
--
-- Motivo: `0033` conta quota por `NEW.user_id` e libera quando o usuário não
-- tem tenant (`RETURN NEW`). A quota é do TENANT (RF-QT-02/RN-01): o pool é
-- compartilhado por todos os logins do tenant, e "sem tenant" é erro de
-- provisionamento — nunca caminho livre, em nenhum plano.
--
-- Entrega (server-side; nenhuma escrita direta de `authenticated`):
--   1) `tenant_id uuid NULL REFERENCES public.tenants(id) ON DELETE RESTRICT`
--      nas 4 tabelas de recurso (constraint `<tabela>_tenant_id_fkey`).
--      NULL = estado de legado; NOT NULL é decisão B3 (fora desta fatia).
--   2) 4 índices novos (e só eles): `idx_transactions_tenant_created
--      (tenant_id, created_at)`, `idx_accounts_tenant`, `idx_credit_cards_tenant`,
--      `idx_budgets_tenant`. Criados ANTES do backfill (O-F3-6/R3).
--   3) `private.sp_month_start()` — janela mensal SP sargável, uma única
--      definição para o gate e (0064) `get_tenant_usage`.
--   4) Backfill em uma passada pela MESMA função do gate
--      (`private.resolve_user_tenant`), com `aa_subscription_readonly`
--      desabilitado/reabilitado dentro do bloco (O-F3-1: usuário com todos os
--      tenants `canceled` abortaria a migration em `0054:136-138`). Só casa
--      linha de usuário COM membership (`EXISTS tenant_members`): usuário órfão
--      fica intocado e o rerun é NO-OP de verdade (antes o `UPDATE` regravava
--      `NULL -> NULL` e bumpava `updated_at` a cada execução). Resíduo emitido
--      em NOTICE por contagem, sem PII.
--   5) `private.resolve_writable_tenant(uuid)` — atribuição x status (I1): o
--      guard `aa_subscription_readonly` decide pelo CONJUNTO de memberships
--      (C1: owner de tenant `canceled` que também é membro de um tenant
--      gravável segue gravando), então `NEW.tenant_id` tem que sair do MESMO
--      sujeito. Prefere tenant com `subscription_status <> 'canceled'`; dentro
--      de cada classe a ordem é a do base (owner → `created_at` → `tenant_id`).
--      Sem nenhum gravável devolve o derivado base (o guard de status já barrou
--      antes; com `aa_` desabilitado a quota ainda cai no tenant certo — T05).
--   6) `public.tenant_id_immutable()` + 4 triggers `BEFORE UPDATE OF tenant_id`
--      — instalados DEPOIS do backfill (O-F3-6: com o trigger ativo o próprio
--      backfill levantaria `tenant-id-immutable`). Sem `current_user`, sem GUC.
--   7) `public.enforce_tenant_quota()` — substitui `enforce_plan_quota`:
--      deriva `tenant_id` de `NEW.user_id` por `resolve_writable_tenant`
--      (valor do cliente é SOBRESCRITO), `quota-tenant-missing` sem tenant
--      (qualquer plano), plano por `tenants.plan_id` (espelho),
--      `plan-limits-missing` sem linha em `plan_limits`, advisory lock por
--      tenant só com limite (`hashtextextended`, 2 args: menos colisão entre
--      tenants), probe por `tenant_id` (janela SP em transactions), override
--      one-shot (tenant+recurso) e rótulo POR RECURSO.
--   8) Triggers `plan_quota_*` recriados com o MESMO nome (um único
--      `BEFORE INSERT` por tabela) apontando para a função nova; depois
--      `DROP FUNCTION public.enforce_plan_quota()`.
--
-- Erros por rótulo fixo, sem PII/id: quota-tenant-missing, plan-limits-missing,
-- quota-transactions-exceeded, quota-accounts-exceeded,
-- quota-credit-cards-exceeded, quota-budgets-exceeded, tenant-id-immutable.
-- `plan-quota-exceeded` fica APOSENTADO (nenhum caminho o emite; sem alias).
-- Nenhum valor monetário tocado; limites são integer (quota, não dinheiro).
-- Idempotente-safe: guard de pré-condição (fail-closed) + ADD COLUMN IF NOT
-- EXISTS + constraint condicional + CREATE INDEX IF NOT EXISTS +
-- CREATE OR REPLACE + DROP TRIGGER IF EXISTS + REVOKE repetíveis.
-- Migrations 0001–0060 e 0077–0081 intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regprocedure('private.resolve_user_tenant(uuid)') IS NULL
    OR to_regprocedure('private.assert_subscription_writable()') IS NULL
    OR to_regprocedure('public.created_at_immutable()') IS NULL
    OR to_regclass('public.tenants') IS NULL
    OR to_regclass('public.tenant_members') IS NULL
    OR to_regclass('public.plan_limits') IS NULL
    OR to_regclass('public.transactions') IS NULL
    OR to_regclass('public.accounts') IS NULL
    OR to_regclass('public.credit_cards') IS NULL
    OR to_regclass('public.budgets') IS NULL THEN
    RAISE EXCEPTION 'tenant-quota-precondition-missing';
  END IF;
END $$;

-- ============ 1. Coluna tenant_id + FK RESTRICT (4 tabelas) ============
-- NULL = legado (o backfill abaixo preenche o que tem membership). O gate
-- sobrescreve o valor em todo INSERT novo, então o cliente nunca escolhe.

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.credit_cards ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS tenant_id uuid;

DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY['transactions', 'accounts', 'credit_cards', 'budgets'];
  v_fk text;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    v_fk := v_table || '_tenant_id_fkey';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint AS c
      WHERE c.conname = v_fk
        AND c.conrelid = format('public.%I', v_table)::regclass
        AND c.contype = 'f'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) '
        'REFERENCES public.tenants (id) ON DELETE RESTRICT',
        v_table, v_fk
      );
    END IF;
  END LOOP;
END $$;

-- ============ 2. Índices (antes do backfill; O-F3-6/R3) ============

CREATE INDEX IF NOT EXISTS idx_transactions_tenant_created
  ON public.transactions (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant
  ON public.accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_credit_cards_tenant
  ON public.credit_cards (tenant_id);
CREATE INDEX IF NOT EXISTS idx_budgets_tenant
  ON public.budgets (tenant_id);

-- ============ 3. Janela mensal SP (uma definição) ============
-- forma sargável: comparação `created_at >= <timestamptz>`, nunca
-- `(created_at AT TIME ZONE ...) >= <timestamp>` (0033:210-214).

CREATE OR REPLACE FUNCTION private.sp_month_start()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.date_trunc(
           'month',
           pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo'
         ) AT TIME ZONE 'America/Sao_Paulo';
$$;

COMMENT ON FUNCTION private.sp_month_start() IS
  'Início do mês corrente em America/Sao_Paulo como timestamptz (ADR-002): janela única do gate e de get_tenant_usage.';

REVOKE ALL ON FUNCTION private.sp_month_start()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 3b. Tenant GRAVÁVEL (atribuição x status; I1) ============
-- O guard de status decide pelo CONJUNTO de memberships; a atribuição precisa
-- usar o mesmo sujeito, senão a linha (e a quota) cai num tenant `canceled`
-- enquanto o guard liberou por causa de outro tenant gravável. Ordem:
-- gravável primeiro (`subscription_status <> 'canceled'`, mesma definição do
-- guard 0054:129); dentro de cada classe, exatamente a do base — owner,
-- membership mais antiga, `tenant_id`. Logo, quando não há nenhum gravável o
-- resultado é idêntico ao derivado base (fallback declarado, não acidental).

CREATE OR REPLACE FUNCTION private.resolve_writable_tenant(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT tm.tenant_id
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE tm.user_id = p_user
  ORDER BY (t.subscription_status <> 'canceled') DESC,
           (tm.role = 'owner') DESC,
           tm.created_at ASC,
           tm.tenant_id ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION private.resolve_writable_tenant(uuid) IS
  'ADR-002 I1 (atribuicao x status): tenant GRAVAVEL do usuario para NEW.tenant_id — prefere subscription_status <> canceled; empate na ordem do base (owner, created_at, tenant_id). Sem nenhum gravavel devolve o derivado base (o guard de status ja barrou antes). Deterministica, DEFINER, search_path vazio, sem EXECUTE para client.';

REVOKE ALL ON FUNCTION private.resolve_writable_tenant(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 4. Backfill (uma passada; mesma função do gate) ============
-- `aa_subscription_readonly` é desligado SÓ neste bloco e religado antes de
-- sair: usuário cujos tenants são todos `canceled` abortaria a migration
-- (0054:136-138) e não teria como cumprir D5. O bloco é atômico (DO), logo o
-- DISABLE/ENABLE não tem janela observável. `tenant_id_immutable` ainda não
-- existe neste ponto (ele é criado no passo 5); num rerun ele já existe, mas o
-- predicado exige membership e o estado pós-0061 não tem linha `NULL` de
-- usuário com membership — 0 linhas tentadas, nada a barrar (I5).

DO $$
DECLARE
  v_tables text[] := ARRAY['transactions', 'accounts', 'credit_cards', 'budgets'];
  v_table text;
  v_n bigint;
  v_total bigint := 0;
  v_residue bigint;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER aa_subscription_readonly', v_table);
  END LOOP;

  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format(
      'UPDATE public.%I AS r SET tenant_id = private.resolve_user_tenant(r.user_id) '
      'WHERE r.tenant_id IS NULL '
      '  AND EXISTS (SELECT 1 FROM public.tenant_members AS tm WHERE tm.user_id = r.user_id)',
      v_table
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
  END LOOP;

  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER aa_subscription_readonly', v_table);
  END LOOP;

  SELECT count(*) INTO v_residue FROM (
    SELECT 1 FROM public.transactions WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM public.accounts WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM public.credit_cards WHERE tenant_id IS NULL
    UNION ALL SELECT 1 FROM public.budgets WHERE tenant_id IS NULL
  ) AS r;

  RAISE NOTICE 'tenant-quota/0061: backfill correlacionou % linhas; resíduo sem membership = %', v_total, v_residue;
END $$;

-- ============ 5. tenant_id imutável (depois do backfill) ============
-- Sem `current_user`, sem GUC de escape: a FK é RESTRICT e nenhuma cascata
-- toca a coluna. `IS DISTINCT FROM` cobre NULL -> valor (só o backfill, que
-- já rodou) e valor -> outro valor.

CREATE OR REPLACE FUNCTION public.tenant_id_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant-id-immutable';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tenant_id_immutable() IS
  'tenant_id imutável (ADR-002 D9): qualquer UPDATE que mude tenant_id -> tenant-id-immutable, 0 linhas.';

REVOKE ALL ON FUNCTION public.tenant_id_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenant_id_immutable ON public.transactions;
CREATE TRIGGER tenant_id_immutable
  BEFORE UPDATE OF tenant_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.tenant_id_immutable();

DROP TRIGGER IF EXISTS tenant_id_immutable ON public.accounts;
CREATE TRIGGER tenant_id_immutable
  BEFORE UPDATE OF tenant_id ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tenant_id_immutable();

DROP TRIGGER IF EXISTS tenant_id_immutable ON public.credit_cards;
CREATE TRIGGER tenant_id_immutable
  BEFORE UPDATE OF tenant_id ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.tenant_id_immutable();

DROP TRIGGER IF EXISTS tenant_id_immutable ON public.budgets;
CREATE TRIGGER tenant_id_immutable
  BEFORE UPDATE OF tenant_id ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.tenant_id_immutable();

-- ============ 6. enforce_tenant_quota (substitui enforce_plan_quota) ============
-- Ordem interna: created_at normalizado -> tenant GRAVÁVEL derivado (cliente é
-- sobrescrito; NULL -> quota-tenant-missing) -> plano de `tenants` -> limite
-- (`plan_limits` ausente -> plan-limits-missing; NULL -> ilimitado) ->
-- advisory lock por tenant -> probe (`tenant_id`, janela SP) -> override
-- (1 token) -> rótulo do recurso. Status da assinatura NÃO é avaliado aqui:
-- a ordem status->quota é do nome do trigger (`aa_` < `plan_quota_*`, 0054).
-- A atribuição usa `resolve_writable_tenant` (I1): guard e quota precisam do
-- MESMO sujeito, senão a linha cai no tenant `canceled` que o guard perdoou.

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
BEGIN
  NEW.created_at := pg_catalog.now();

  v_tenant := private.resolve_writable_tenant(NEW.user_id);
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'quota-tenant-missing';
  END IF;
  NEW.tenant_id := v_tenant;

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
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.budgets AS bg
      WHERE bg.tenant_id = v_tenant
      OFFSET (v_limit - 1)
    ) INTO v_exceeded;
  END IF;

  IF NOT v_exceeded THEN
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

  IF TG_TABLE_NAME = 'transactions' THEN
    RAISE EXCEPTION 'quota-transactions-exceeded';
  ELSIF TG_TABLE_NAME = 'accounts' THEN
    RAISE EXCEPTION 'quota-accounts-exceeded';
  ELSIF TG_TABLE_NAME = 'credit_cards' THEN
    RAISE EXCEPTION 'quota-credit-cards-exceeded';
  ELSE
    RAISE EXCEPTION 'quota-budgets-exceeded';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.enforce_tenant_quota() IS
  'Quota por tenant (ADR-002): tenant GRAVAVEL derivado (resolve_writable_tenant) e sobrescrito no INSERT; sem tenant -> quota-tenant-missing; plano sem linha -> plan-limits-missing; no limite -> quota-<recurso>-exceeded, 0 linhas. Advisory lock por tenant (hashtextextended). Override one-shot por tenant+recurso.';

REVOKE ALL ON FUNCTION public.enforce_tenant_quota()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 7. Triggers homônimos apontando para a função nova ============

DROP TRIGGER IF EXISTS plan_quota_transactions ON public.transactions;
CREATE TRIGGER plan_quota_transactions
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_quota();

DROP TRIGGER IF EXISTS plan_quota_accounts ON public.accounts;
CREATE TRIGGER plan_quota_accounts
  BEFORE INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_quota();

DROP TRIGGER IF EXISTS plan_quota_credit_cards ON public.credit_cards;
CREATE TRIGGER plan_quota_credit_cards
  BEFORE INSERT ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_quota();

DROP TRIGGER IF EXISTS plan_quota_budgets ON public.budgets;
CREATE TRIGGER plan_quota_budgets
  BEFORE INSERT ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_quota();

-- ============ 8. Aposenta enforce_plan_quota (sem alias) ============
-- Sem chamador fora dos próprios triggers (0033:263-281 → recriados acima).

DROP FUNCTION IF EXISTS public.enforce_plan_quota();
