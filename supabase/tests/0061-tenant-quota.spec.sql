-- 0061-tenant-quota.spec.sql — tenant-quota / F3 / ADR-002 (BE-33).
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0061-tenant-quota.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova em banco real (mock não avalia trigger, SECURITY DEFINER, search_path,
-- RLS, claims, FK nem backfill):
--   T00 estrutura: `tenant_id uuid NULL` + FK `ON DELETE RESTRICT` nas 4
--       tabelas; 4 índices (incl. `transactions(tenant_id, created_at)`);
--       `private.sp_month_start()` STABLE/search_path vazio sem GRANT;
--       `public.enforce_tenant_quota()` DEFINER/search_path vazio, rótulos por
--       recurso + `quota-tenant-missing`/`plan-limits-missing`, contagem sem
--       `user_id`, sem EXECUTE para client; `public.tenant_id_immutable()` +
--       4 triggers BEFORE UPDATE OF tenant_id; 4 triggers `plan_quota_*`
--       BEFORE INSERT apontando para a função nova; `enforce_plan_quota`
--       ausente e `plan-quota-exceeded` fora de todo `pg_proc.prosrc`;
--       `aa_subscription_readonly` reabilitado (`tgenabled='O'`) nas 5 tabelas;
--       `private.resolve_user_tenant` com 1 assinatura e COM o pin (0070 —
--       re-point do F4: a ordem antiga sem pin é provada em
--       `0069-0071-active-tenant.spec.sql` T-pin-05);
--       `plan_limits` continua fechada para `authenticated`.
--   T01 pool do tenant (accounts): tenant `free` (limite 2) com 3 logins —
--       2 contas em logins distintos; 3ª tentativa, em QUALQUER login ->
--       `quota-accounts-exceeded`, count = 2.
--   T01b pool do tenant (transactions): 20 lançamentos do mês SP; 21ª
--       tentativa por outro login -> `quota-transactions-exceeded`, count = 20.
--   T02 tenant obrigatório: usuário sem membership -> `quota-tenant-missing`
--       nas 4 tabelas, 0 linhas, mesmo com um plano `full` presente; com
--       membership no tenant `full` o mesmo INSERT passa (o bloqueio é a
--       ausência de tenant, nunca o plano).
--   T03 `tenant_id` nunca vem do cliente: INSERT com tenant forjado grava o
--       tenant DERIVADO; UPDATE de `tenant_id` -> `tenant-id-immutable`, 0
--       linhas; UPDATE de outra coluna passa.
--   T03b rótulo por recurso (contraprova R9-i): accounts/credit_cards/
--       budgets/transactions no limite emitem cada um SEU rótulo, 0 linhas.
--   T04 backfill (REQ-07/08): linhas legadas (`tenant_id NULL`) recebem o
--       tenant derivado; 2ª passada = 0 UPDATE.
--   T04b O-F3-1: backfill de usuário cujo tenant é `canceled` aborta com
--       `subscription-canceled-readonly` com o trigger de status ativo e
--       conclui com o `DISABLE` escopado na MESMA transação.
--   T05 ordem status->quota (REQ-29): tenant `canceled` com quota estourada
--       devolve `subscription-canceled-readonly`. Desabilitado o trigger de
--       status na mesma transação, o mesmo INSERT continua devolvendo o rótulo
--       de STATUS — agora do `enforce_tenant_quota` (0076, defesa em
--       profundidade). A ordem é estrutural (ordinal alfabético `aa_` <
--       `plan_quota_*`); a contraprova de quota é não-vácua: a fixture grava
--       `tenant_id` explícito (2 contas, free = 2) e, com o 0076 neutralizado
--       (tenant gravável), o INSERT devolve `quota-accounts-exceeded`.
--   T06 I1 (atribuição x status): owner do tenant T1 `canceled` que também é
--       membro do tenant T2 `active` — o guard libera (conjunto) e a linha é
--       gravada em T2 (o GRAVÁVEL), nunca em T1; a quota conta em T2 (3ª conta
--       -> `quota-accounts-exceeded`), 0 linhas em T1.
--   T06b I1: usuário com TODOS os tenants `canceled` -> guard
--       `subscription-canceled-readonly`, 0 escrita; a resolução devolve o
--       derivado base (fallback declarado no COMMENT).
--   T07 I5: backfill com usuário órfão (sem membership) -> 0 UPDATE no rerun e
--       `updated_at` intacto; contraprova: o predicado ANTIGO (só `IS NULL`)
--       casa a mesma linha e bumpa `updated_at`.
--   T08 `private.resolve_writable_tenant`: determinística, DEFINER +
--       search_path vazio, sujeito é o parâmetro (sem `auth.uid()`) e sem
--       EXECUTE para client (REVOKE ALL).
--
-- Erros por rótulo fixo, sem PII/id. Rerunnable: fixtures (c61*) apagadas no
-- início e no fim; cenários mutáveis vivem em transação com ROLLBACK.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
BEGIN;
SET LOCAL app.card_purge = 'on';
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.transactions
WHERE user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000a2',
  'c6100000-0000-4000-8000-0000000000a3',
  'c6100000-0000-4000-8000-0000000000b1',
  'c6100000-0000-4000-8000-0000000000c1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.credit_cards
WHERE user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000a2',
  'c6100000-0000-4000-8000-0000000000a3',
  'c6100000-0000-4000-8000-0000000000b1',
  'c6100000-0000-4000-8000-0000000000c1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.budgets
WHERE user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000a2',
  'c6100000-0000-4000-8000-0000000000a3',
  'c6100000-0000-4000-8000-0000000000b1',
  'c6100000-0000-4000-8000-0000000000c1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.accounts
WHERE user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000a2',
  'c6100000-0000-4000-8000-0000000000a3',
  'c6100000-0000-4000-8000-0000000000b1',
  'c6100000-0000-4000-8000-0000000000c1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1',
  'c6100000-0000-4000-8000-0000000000f4'
);
DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c6100000-0000-4000-8000-0000000000a1',
    'c6100000-0000-4000-8000-0000000000d1',
    'c6100000-0000-4000-8000-0000000000e1'
  )
);
DELETE FROM public.contract_acceptances
WHERE user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.tenant_members
WHERE user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000a2',
  'c6100000-0000-4000-8000-0000000000a3',
  'c6100000-0000-4000-8000-0000000000b1',
  'c6100000-0000-4000-8000-0000000000c1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.admin_audit
WHERE actor_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.tenants
WHERE owner_user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM auth.users
WHERE id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000a2',
  'c6100000-0000-4000-8000-0000000000a3',
  'c6100000-0000-4000-8000-0000000000b1',
  'c6100000-0000-4000-8000-0000000000c1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1',
  'c6100000-0000-4000-8000-0000000000f4'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

INSERT INTO auth.users (id, email) VALUES
  ('c6100000-0000-4000-8000-0000000000a1', 'quota-a1-0061@example.com'),
  ('c6100000-0000-4000-8000-0000000000a2', 'quota-a2-0061@example.com'),
  ('c6100000-0000-4000-8000-0000000000a3', 'quota-a3-0061@example.com'),
  ('c6100000-0000-4000-8000-0000000000b1', 'quota-b1-0061@example.com'),
  ('c6100000-0000-4000-8000-0000000000c1', 'quota-c1-0061@example.com'),
  ('c6100000-0000-4000-8000-0000000000d1', 'quota-d1-0061@example.com'),
  ('c6100000-0000-4000-8000-0000000000e1', 'quota-e1-0061@example.com');

-- ============ Fixtures: tenants (RPC atômica como service_role) ============
-- Tenant A (free, pool com 3 logins), Tenant B (full), Tenant D (free, rótulos),
-- Tenant E (free, termina `canceled`).

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54200000164', 'Quota Pool 0061', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54200000245', 'Quota Full 0061', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000d1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000d1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54200000407', 'Quota Rotulos 0061', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000e1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000e1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54200000598', 'Quota Cancelado 0061', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
COMMIT;

-- 2º e 3º login do pool do tenant A. A quota de seats (`0063`, free = 1)
-- não é o objeto desta spec: o trigger é desligado SÓ nesta fixture (bloco
-- atômico; reabilitado antes do COMMIT).
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tenant_members'::regclass
      AND tgname = 'plan_quota_tenant_members'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.tenant_members DISABLE TRIGGER plan_quota_tenant_members;
  END IF;
END $$;
INSERT INTO public.tenant_members (tenant_id, user_id, role)
SELECT t.id, m.user_id, 'member'
FROM public.tenants AS t
CROSS JOIN (VALUES
  ('c6100000-0000-4000-8000-0000000000a2'::uuid),
  ('c6100000-0000-4000-8000-0000000000a3'::uuid)
) AS m(user_id)
WHERE t.owner_user_id = 'c6100000-0000-4000-8000-0000000000a1';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tenant_members'::regclass
      AND tgname = 'plan_quota_tenant_members'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.tenant_members ENABLE TRIGGER plan_quota_tenant_members;
  END IF;
END $$;
COMMIT;

-- Tenant E termina `canceled` (T04b/T05).
UPDATE public.tenants SET subscription_status = 'canceled'
WHERE owner_user_id = 'c6100000-0000-4000-8000-0000000000e1';

-- Ids dos tenants para os cenários.
SELECT
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6100000-0000-4000-8000-0000000000a1') AS ta,
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6100000-0000-4000-8000-0000000000b1') AS tb,
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6100000-0000-4000-8000-0000000000d1') AS td,
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6100000-0000-4000-8000-0000000000e1') AS te
\gset

-- ============ T00 — estrutura ============
DO $$
DECLARE
  v_proc pg_proc;
  v_table text;
  v_tables text[] := ARRAY['transactions', 'accounts', 'credit_cards', 'budgets'];
  v_idx text;
  v_cols text[];
  v_attnum smallint;
  v_fk record;
  v_tg pg_trigger;
  v_n integer;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    -- coluna uuid NULL
    SELECT a.attnum INTO v_attnum
    FROM pg_attribute AS a
    WHERE a.attrelid = format('public.%I', v_table)::regclass
      AND a.attname = 'tenant_id'
      AND NOT a.attisdropped;
    IF v_attnum IS NULL THEN
      RAISE EXCEPTION '0061 T00 falhou: coluna tenant_id ausente em %', v_table;
    END IF;
    IF (SELECT a.attnotnull FROM pg_attribute AS a
        WHERE a.attrelid = format('public.%I', v_table)::regclass
          AND a.attname = 'tenant_id') THEN
      RAISE EXCEPTION '0061 T00 falhou: tenant_id NOT NULL antecipado em %', v_table;
    END IF;
    IF (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_attribute AS a
        WHERE a.attrelid = format('public.%I', v_table)::regclass
          AND a.attname = 'tenant_id') <> 'uuid' THEN
      RAISE EXCEPTION '0061 T00 falhou: tenant_id nao e uuid em %', v_table;
    END IF;

    -- FK -> tenants ON DELETE RESTRICT
    SELECT c.conname, c.confdeltype, c.confrelid,
           c.conkey[1] AS attnum
      INTO v_fk
    FROM pg_constraint AS c
    WHERE c.conrelid = format('public.%I', v_table)::regclass
      AND c.contype = 'f'
      AND c.conkey = ARRAY[v_attnum];
    IF NOT FOUND THEN
      RAISE EXCEPTION '0061 T00 falhou: FK de tenant_id ausente em %', v_table;
    END IF;
    IF v_fk.confdeltype <> 'r' THEN
      RAISE EXCEPTION '0061 T00 falhou: FK de % nao e RESTRICT (%)', v_table, v_fk.confdeltype;
    END IF;
    IF v_fk.confrelid <> 'public.tenants'::regclass THEN
      RAISE EXCEPTION '0061 T00 falhou: FK de % nao referencia tenants', v_table;
    END IF;
    IF v_fk.conname <> v_table || '_tenant_id_fkey' THEN
      RAISE EXCEPTION '0061 T00 falhou: nome da FK de % inesperado (%)', v_table, v_fk.conname;
    END IF;
  END LOOP;

  -- 4 índices, colunas na ordem do contrato
  SELECT pg_catalog.array_agg(a.attname ORDER BY k.ord)
    INTO v_cols
  FROM pg_index AS i
  JOIN pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indexrelid = to_regclass('public.idx_transactions_tenant_created');
  IF v_cols IS DISTINCT FROM ARRAY['tenant_id', 'created_at'] THEN
    RAISE EXCEPTION '0061 T00 falhou: idx_transactions_tenant_created divergente (%)', v_cols;
  END IF;

  FOREACH v_idx IN ARRAY ARRAY['idx_accounts_tenant', 'idx_credit_cards_tenant', 'idx_budgets_tenant'] LOOP
    SELECT pg_catalog.array_agg(a.attname ORDER BY k.ord)
      INTO v_cols
    FROM pg_index AS i
    JOIN pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE i.indexrelid = to_regclass('public.' || v_idx);
    IF v_cols IS DISTINCT FROM ARRAY['tenant_id'] THEN
      RAISE EXCEPTION '0061 T00 falhou: % divergente (%)', v_idx, v_cols;
    END IF;
  END LOOP;

  -- sp_month_start: STABLE + search_path vazio + sem GRANT
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('private.sp_month_start()');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0061 T00 falhou: private.sp_month_start ausente';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION '0061 T00 falhou: sp_month_start nao e STABLE';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0061 T00 falhou: sp_month_start sem search_path vazio';
  END IF;
  IF v_proc.prosrc NOT LIKE '%America/Sao_Paulo%' THEN
    RAISE EXCEPTION '0061 T00 falhou: sp_month_start sem fuso SP';
  END IF;
  IF has_function_privilege('authenticated', 'private.sp_month_start()', 'EXECUTE')
     OR has_function_privilege('anon', 'private.sp_month_start()', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.sp_month_start()', 'EXECUTE') THEN
    RAISE EXCEPTION '0061 T00 falhou: sp_month_start executavel por client';
  END IF;

  -- enforce_tenant_quota: DEFINER + search_path vazio + rótulos + sem user_id na contagem
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('public.enforce_tenant_quota()');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0061 T00 falhou: enforce_tenant_quota ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0061 T00 falhou: enforce_tenant_quota sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0061 T00 falhou: enforce_tenant_quota sem search_path vazio';
  END IF;
  IF v_proc.prosrc NOT LIKE '%quota-tenant-missing%'
     OR v_proc.prosrc NOT LIKE '%plan-limits-missing%'
     OR v_proc.prosrc NOT LIKE '%quota-transactions-exceeded%'
     OR v_proc.prosrc NOT LIKE '%quota-accounts-exceeded%'
     OR v_proc.prosrc NOT LIKE '%quota-credit-cards-exceeded%'
     OR v_proc.prosrc NOT LIKE '%quota-budgets-exceeded%' THEN
    RAISE EXCEPTION '0061 T00 falhou: rótulos ausentes em enforce_tenant_quota';
  END IF;
  IF v_proc.prosrc LIKE '%plan-quota-exceeded%' THEN
    RAISE EXCEPTION '0061 T00 falhou: enforce_tenant_quota ainda emite plan-quota-exceeded';
  END IF;
  IF v_proc.prosrc LIKE '%tx.user_id%' OR v_proc.prosrc LIKE '%a.user_id%'
     OR v_proc.prosrc LIKE '%c.user_id%' OR v_proc.prosrc LIKE '%b.user_id%' THEN
    RAISE EXCEPTION '0061 T00 falhou: contagem ainda por user_id';
  END IF;
  IF v_proc.prosrc NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION '0061 T00 falhou: sem advisory lock por tenant';
  END IF;
  IF has_function_privilege('authenticated', 'public.enforce_tenant_quota()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.enforce_tenant_quota()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.enforce_tenant_quota()', 'EXECUTE') THEN
    RAISE EXCEPTION '0061 T00 falhou: enforce_tenant_quota executavel por client';
  END IF;

  -- enforce_plan_quota removida; rótulo aposentado fora de todo prosrc
  IF to_regprocedure('public.enforce_plan_quota()') IS NOT NULL THEN
    RAISE EXCEPTION '0061 T00 falhou: enforce_plan_quota ainda existe';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc WHERE prosrc LIKE '%plan-quota-exceeded%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0061 T00 falhou: plan-quota-exceeded ainda em % funcoes', v_n;
  END IF;

  -- tenant_id_immutable: DEFINER + search_path vazio + sem GRANT
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('public.tenant_id_immutable()');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0061 T00 falhou: tenant_id_immutable ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0061 T00 falhou: tenant_id_immutable sem SECURITY DEFINER';
  END IF;
  IF v_proc.prosrc NOT LIKE '%tenant-id-immutable%' THEN
    RAISE EXCEPTION '0061 T00 falhou: tenant_id_immutable sem rotulo';
  END IF;
  IF v_proc.prosrc LIKE '%current_user%'
     OR v_proc.prosrc LIKE '%current_setting%' THEN
    RAISE EXCEPTION '0061 T00 falhou: tenant_id_immutable com escape';
  END IF;
  IF has_function_privilege('authenticated', 'public.tenant_id_immutable()', 'EXECUTE') THEN
    RAISE EXCEPTION '0061 T00 falhou: tenant_id_immutable executavel por client';
  END IF;

  -- triggers: 4 plan_quota_* BEFORE INSERT -> enforce_tenant_quota
  SELECT count(*) INTO v_n FROM pg_trigger
  WHERE tgrelid IN ('public.transactions'::regclass, 'public.accounts'::regclass,
                    'public.credit_cards'::regclass, 'public.budgets'::regclass)
    AND tgname IN ('plan_quota_transactions', 'plan_quota_accounts',
                   'plan_quota_credit_cards', 'plan_quota_budgets')
    AND tgfoid = 'public.enforce_tenant_quota()'::regprocedure
    -- 7 = ROW(1) + BEFORE(2) + INSERT(4)
    AND tgtype = 7
    AND NOT tgisinternal;
  IF v_n <> 4 THEN
    RAISE EXCEPTION '0061 T00 falhou: plan_quota_* divergentes (%)', v_n;
  END IF;

  -- triggers: 4 tenant_id_immutable BEFORE UPDATE OF tenant_id
  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT * INTO v_tg FROM pg_trigger
    WHERE tgrelid = format('public.%I', v_table)::regclass
      AND tgname = 'tenant_id_immutable'
      AND NOT tgisinternal;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0061 T00 falhou: tenant_id_immutable ausente em %', v_table;
    END IF;
    -- 19 = ROW(1) + BEFORE(2) + UPDATE(16); tgattr aponta a coluna tenant_id
    IF v_tg.tgtype <> 19 THEN
      RAISE EXCEPTION '0061 T00 falhou: tgtype % em tenant_id_immutable/%', v_tg.tgtype, v_table;
    END IF;
    IF NOT (SELECT a.attnum = ANY (v_tg.tgattr)
            FROM pg_attribute AS a
            WHERE a.attrelid = format('public.%I', v_table)::regclass
              AND a.attname = 'tenant_id') THEN
      RAISE EXCEPTION '0061 T00 falhou: tenant_id_immutable sem coluna em %', v_table;
    END IF;

    -- created_at_immutable intacto (0033)
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = format('public.%I', v_table)::regclass
        AND tgname = 'created_at_immutable'
        AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION '0061 T00 falhou: created_at_immutable perdido em %', v_table;
    END IF;
  END LOOP;

  -- aa_subscription_readonly reabilitado nas 5 tabelas (O-F3-1)
  SELECT count(*) INTO v_n FROM pg_trigger
  WHERE tgrelid IN ('public.transactions'::regclass, 'public.accounts'::regclass,
                    'public.credit_cards'::regclass, 'public.budgets'::regclass,
                    'public.tenant_members'::regclass)
    AND tgname = 'aa_subscription_readonly'
    AND tgenabled = 'O'
    AND NOT tgisinternal;
  IF v_n <> 5 THEN
    RAISE EXCEPTION '0061 T00 falhou: aa_subscription_readonly nao reabilitado (%)', v_n;
  END IF;

  -- resolve_user_tenant: 1 assinatura + pin presente (0070). Re-point do F4:
  -- a asserção antiga (`prosrc NOT LIKE '%user_active_tenants%'`) foi
  -- substituída pela contraprova; a ordem SEM pin continua provada em
  -- 0069-0071-active-tenant.spec.sql T-pin-05 (0054/0061 byte-a-byte).
  SELECT count(*) INTO v_n FROM pg_proc
  WHERE proname = 'resolve_user_tenant' AND pronamespace = 'private'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0061 T00 falhou: resolve_user_tenant com % assinaturas', v_n;
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('private.resolve_user_tenant(uuid)'))
     NOT LIKE '%user_active_tenants%' THEN
    RAISE EXCEPTION '0061 T00 falhou: resolve_user_tenant sem o pin (0070)';
  END IF;

  -- plan_limits continua fechada (REQ-22 base)
  IF has_table_privilege('authenticated', 'public.plan_limits', 'SELECT') THEN
    RAISE EXCEPTION '0061 T00 falhou: plan_limits legivel por authenticated';
  END IF;

  RAISE NOTICE '0061 T00 ok: coluna+FK RESTRICT+4 índices+sp_month_start+enforce_tenant_quota+rótulos+tenant_id_immutable+aa reabilitado';
END $$;

-- ============ T01 — pool do tenant (accounts) ============
BEGIN;
SELECT set_config('c61.ta', :'ta', true), set_config('c61.tb', :'tb', true);

-- 2 contas em logins distintos (limite free = 2)
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c6100000-0000-4000-8000-0000000000a1', 'c6100000-0000-4000-8000-0000000000a1', 'Pool 1 0061', 'checking', 0, 0),
  ('c6100000-0000-4000-8000-0000000000a2', 'c6100000-0000-4000-8000-0000000000a2', 'Pool 2 0061', 'checking', 0, 0);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000a3', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c6100000-0000-4000-8000-0000000000a3', 'Pool 3 0061', 'checking');
    RAISE EXCEPTION '0061 T01 falhou: 3ª conta (login a3) passou no limite do tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T01 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-accounts-exceeded' THEN
      RAISE EXCEPTION '0061 T01 falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c6100000-0000-4000-8000-0000000000a1', 'Pool 3b 0061', 'checking');
    RAISE EXCEPTION '0061 T01 falhou: 3ª conta (login owner) passou no limite do tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T01 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-accounts-exceeded' THEN
      RAISE EXCEPTION '0061 T01 falhou: rotulo errado no owner (%)', SQLERRM;
    END IF;
  END;
END $$;

RESET ROLE;
DO $$
DECLARE v_n int; v_tenant uuid := current_setting('c61.ta')::uuid;
BEGIN
  SELECT count(*) INTO v_n FROM public.accounts WHERE tenant_id = v_tenant;
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0061 T01 falhou: pool do tenant tem % contas (esperado 2)', v_n;
  END IF;
  RAISE NOTICE '0061 T01 ok: 3º login bloqueado, pool do tenant = 2';
END $$;
ROLLBACK;

-- ============ T01b — pool do tenant (transactions) ============
BEGIN;
SELECT set_config('c61.ta', :'ta', true);

INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c6100000-0000-4000-8000-0000000001a1', 'c6100000-0000-4000-8000-0000000000a1', 'Pool Tx 0061', 'checking', 0, 0);

INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
SELECT 'c6100000-0000-4000-8000-0000000000a1',
       'c6100000-0000-4000-8000-0000000001a1',
       'Pool Tx ' || g, 100, CURRENT_DATE
FROM generate_series(1, 20) AS g;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000a2', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c6100000-0000-4000-8000-0000000000a2',
            'c6100000-0000-4000-8000-0000000001a1', 'Pool Tx 21 0061', 100, CURRENT_DATE);
    RAISE EXCEPTION '0061 T01b falhou: 21º lançamento (outro login) passou no limite do tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T01b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-transactions-exceeded' THEN
      RAISE EXCEPTION '0061 T01b falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
END $$;

RESET ROLE;
DO $$
DECLARE v_n int; v_tenant uuid := current_setting('c61.ta')::uuid;
BEGIN
  SELECT count(*) INTO v_n FROM public.transactions WHERE tenant_id = v_tenant;
  IF v_n <> 20 THEN
    RAISE EXCEPTION '0061 T01b falhou: pool do tenant tem % lançamentos (esperado 20)', v_n;
  END IF;
  RAISE NOTICE '0061 T01b ok: pool do tenant = 20 no mês SP, 21º bloqueado em outro login';
END $$;
ROLLBACK;

-- ============ T02 — tenant obrigatório (inclusive com plano full presente) ============
BEGIN;
SELECT set_config('c61.tb', :'tb', true);

-- conta e categoria de apoio (FK); usuário c1 não tem tenant.
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c6100000-0000-4000-8000-0000000000f1', 'c6100000-0000-4000-8000-0000000000a1', 'Apoio 0061', 'checking', 0, 0);
INSERT INTO public.categories (id, user_id, name, type) VALUES
  ('c6100000-0000-4000-8000-0000000000f2', 'c6100000-0000-4000-8000-0000000000c1', 'Apoio Cat 0061', 'expense');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000c1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_stmt text;
  v_label text;
  v_stmts text[] := ARRAY[
    'accounts',
    'credit_cards',
    'transactions',
    'budgets'
  ];
BEGIN
  FOREACH v_label IN ARRAY v_stmts LOOP
    BEGIN
      IF v_label = 'accounts' THEN
        INSERT INTO public.accounts (user_id, name, type)
        VALUES ('c6100000-0000-4000-8000-0000000000c1', 'Sem Tenant 0061', 'checking');
      ELSIF v_label = 'credit_cards' THEN
        INSERT INTO public.credit_cards (user_id, account_id, name, limit_cents, closing_day, due_day)
        VALUES ('c6100000-0000-4000-8000-0000000000c1',
                'c6100000-0000-4000-8000-0000000000f1', 'Sem Tenant CC 0061', 1000, 10, 20);
      ELSIF v_label = 'transactions' THEN
        INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
        VALUES ('c6100000-0000-4000-8000-0000000000c1',
                'c6100000-0000-4000-8000-0000000000f1', 'Sem Tenant Tx 0061', 100, CURRENT_DATE);
      ELSE
        INSERT INTO public.budgets (user_id, category_id, month, limit_cents)
        VALUES ('c6100000-0000-4000-8000-0000000000c1',
                'c6100000-0000-4000-8000-0000000000f2', date_trunc('month', CURRENT_DATE)::date, 1000);
      END IF;
      RAISE EXCEPTION '0061 T02 falhou: INSERT em % passou sem tenant', v_label;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '0061 T02 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'quota-tenant-missing' THEN
        RAISE EXCEPTION '0061 T02 falhou: rotulo errado em % (%)', v_label, SQLERRM;
      END IF;
    END;
  END LOOP;
END $$;

RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE user_id = 'c6100000-0000-4000-8000-0000000000c1';
  IF v_n <> 0 THEN RAISE EXCEPTION '0061 T02 falhou: conta persistiu'; END IF;
  SELECT count(*) INTO v_n FROM public.credit_cards
  WHERE user_id = 'c6100000-0000-4000-8000-0000000000c1';
  IF v_n <> 0 THEN RAISE EXCEPTION '0061 T02 falhou: cartao persistiu'; END IF;
  SELECT count(*) INTO v_n FROM public.transactions
  WHERE user_id = 'c6100000-0000-4000-8000-0000000000c1';
  IF v_n <> 0 THEN RAISE EXCEPTION '0061 T02 falhou: lancamento persistiu'; END IF;
  SELECT count(*) INTO v_n FROM public.budgets
  WHERE user_id = 'c6100000-0000-4000-8000-0000000000c1';
  IF v_n <> 0 THEN RAISE EXCEPTION '0061 T02 falhou: orcamento persistiu'; END IF;

  -- o plano não é a causa: com membership no tenant `full` o mesmo INSERT passa
  IF (SELECT t.plan_id FROM public.tenants AS t
      WHERE t.id = current_setting('c61.tb')::uuid) <> 'full' THEN
    RAISE EXCEPTION '0061 T02 falhou: tenant B nao esta em full';
  END IF;
  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (current_setting('c61.tb')::uuid, 'c6100000-0000-4000-8000-0000000000c1', 'member');
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000c1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', true);

INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c6100000-0000-4000-8000-0000000000c1', 'c6100000-0000-4000-8000-0000000000c1', 'Com Full 0061', 'checking', 0, 0);

RESET ROLE;
DO $$
DECLARE v_tenant uuid; v_expected uuid := current_setting('c61.tb')::uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.accounts
  WHERE id = 'c6100000-0000-4000-8000-0000000000c1';
  IF v_tenant IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION '0061 T02 falhou: tenant derivado incorreto com plano full (%)', v_tenant;
  END IF;
  RAISE NOTICE '0061 T02 ok: sem tenant -> quota-tenant-missing nas 4 tabelas; com tenant full passa';
END $$;
ROLLBACK;

-- ============ T03 — tenant_id nunca vem do cliente ============
BEGIN;
SELECT set_config('c61.ta', :'ta', true), set_config('c61.tb', :'tb', true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000a2', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', true);

-- tenant forjado (tenant B) descartado: grava o derivado (tenant A)
INSERT INTO public.accounts (id, user_id, tenant_id, name, type, initial_balance_cents, current_balance_cents)
VALUES ('c6100000-0000-4000-8000-000000000301', 'c6100000-0000-4000-8000-0000000000a2', :'tb',
        'Forjada 0061', 'checking', 0, 0);

DO $$
DECLARE v_tenant uuid;
BEGIN
  BEGIN
    UPDATE public.accounts SET tenant_id = current_setting('c61.tb')::uuid
    WHERE id = 'c6100000-0000-4000-8000-000000000301';
    RAISE EXCEPTION '0061 T03 falhou: UPDATE de tenant_id passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T03 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'tenant-id-immutable' THEN
      RAISE EXCEPTION '0061 T03 falhou: rotulo errado no UPDATE (%)', SQLERRM;
    END IF;
  END;

  UPDATE public.accounts SET name = 'Renomeada 0061'
  WHERE id = 'c6100000-0000-4000-8000-000000000301';

  SELECT tenant_id INTO v_tenant FROM public.accounts
  WHERE id = 'c6100000-0000-4000-8000-000000000301';
  IF v_tenant IS DISTINCT FROM current_setting('c61.ta')::uuid THEN
    RAISE EXCEPTION '0061 T03 falhou: tenant gravado nao e o derivado (%)', v_tenant;
  END IF;
  IF v_tenant = current_setting('c61.tb')::uuid THEN
    RAISE EXCEPTION '0061 T03 falhou: cliente escolheu o tenant';
  END IF;
END $$;
ROLLBACK;

-- ============ T03b — rótulo por recurso (contraprova R9-i) ============
BEGIN;
SELECT set_config('c61.td', :'td', true);

INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c6100000-0000-4000-8000-0000000003d1', 'c6100000-0000-4000-8000-0000000000d1', 'Rot 1 0061', 'checking', 0, 0),
  ('c6100000-0000-4000-8000-0000000003d2', 'c6100000-0000-4000-8000-0000000000d1', 'Rot 2 0061', 'checking', 0, 0);
INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day) VALUES
  ('c6100000-0000-4000-8000-0000000003d3', 'c6100000-0000-4000-8000-0000000000d1',
   'c6100000-0000-4000-8000-0000000003d1', 'Rot CC 0061', 1000, 10, 20);
INSERT INTO public.categories (id, user_id, name, type) VALUES
  ('c6100000-0000-4000-8000-0000000003d4', 'c6100000-0000-4000-8000-0000000000d1', 'Rot C1 0061', 'expense'),
  ('c6100000-0000-4000-8000-0000000003d5', 'c6100000-0000-4000-8000-0000000000d1', 'Rot C2 0061', 'expense'),
  ('c6100000-0000-4000-8000-0000000003d6', 'c6100000-0000-4000-8000-0000000000d1', 'Rot C3 0061', 'expense'),
  ('c6100000-0000-4000-8000-0000000003d7', 'c6100000-0000-4000-8000-0000000000d1', 'Rot C4 0061', 'expense');
INSERT INTO public.budgets (user_id, category_id, month, limit_cents) VALUES
  ('c6100000-0000-4000-8000-0000000000d1', 'c6100000-0000-4000-8000-0000000003d4', date_trunc('month', CURRENT_DATE)::date, 1000),
  ('c6100000-0000-4000-8000-0000000000d1', 'c6100000-0000-4000-8000-0000000003d5', date_trunc('month', CURRENT_DATE)::date, 1000),
  ('c6100000-0000-4000-8000-0000000000d1', 'c6100000-0000-4000-8000-0000000003d6', date_trunc('month', CURRENT_DATE)::date, 1000);
INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
SELECT 'c6100000-0000-4000-8000-0000000000d1',
       'c6100000-0000-4000-8000-0000000003d1',
       'Rot Tx ' || g, 100, CURRENT_DATE
FROM generate_series(1, 20) AS g;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000d1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000d1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_label text;
  v_resources text[] := ARRAY['accounts', 'credit_cards', 'budgets', 'transactions'];
  v_expected text[] := ARRAY['quota-accounts-exceeded', 'quota-credit-cards-exceeded',
                             'quota-budgets-exceeded', 'quota-transactions-exceeded'];
  v_i int;
BEGIN
  FOR v_i IN 1..4 LOOP
    v_label := v_expected[v_i];
    BEGIN
      IF v_resources[v_i] = 'accounts' THEN
        INSERT INTO public.accounts (user_id, name, type)
        VALUES ('c6100000-0000-4000-8000-0000000000d1', 'Rot 3 0061', 'checking');
      ELSIF v_resources[v_i] = 'credit_cards' THEN
        INSERT INTO public.credit_cards (user_id, account_id, name, limit_cents, closing_day, due_day)
        VALUES ('c6100000-0000-4000-8000-0000000000d1',
                'c6100000-0000-4000-8000-0000000003d1', 'Rot CC2 0061', 1000, 10, 20);
      ELSIF v_resources[v_i] = 'budgets' THEN
        INSERT INTO public.budgets (user_id, category_id, month, limit_cents)
        VALUES ('c6100000-0000-4000-8000-0000000000d1',
                'c6100000-0000-4000-8000-0000000003d7', date_trunc('month', CURRENT_DATE)::date, 1000);
      ELSE
        INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
        VALUES ('c6100000-0000-4000-8000-0000000000d1',
                'c6100000-0000-4000-8000-0000000003d1', 'Rot Tx 21 0061', 100, CURRENT_DATE);
      END IF;
      RAISE EXCEPTION '0061 T03b falhou: INSERT em % passou no limite', v_resources[v_i];
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '0061 T03b falhou%' THEN RAISE; END IF;
      IF SQLERRM <> v_label THEN
        RAISE EXCEPTION '0061 T03b falhou: rotulo % (esperado %)', SQLERRM, v_label;
      END IF;
    END;
  END LOOP;
  RAISE NOTICE '0061 T03b ok: 4 rótulos distintos, um por recurso';
END $$;
ROLLBACK;

-- ============ T04 — backfill correlaciona o legado ============
BEGIN;
SELECT set_config('c61.ta', :'ta', true);

ALTER TABLE public.accounts DISABLE TRIGGER plan_quota_accounts;
ALTER TABLE public.accounts DISABLE TRIGGER tenant_id_immutable;
ALTER TABLE public.transactions DISABLE TRIGGER plan_quota_transactions;
ALTER TABLE public.transactions DISABLE TRIGGER tenant_id_immutable;

-- legado: linhas escritas antes de 0061 (tenant_id NULL)
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents, tenant_id) VALUES
  ('c6100000-0000-4000-8000-0000000004a1', 'c6100000-0000-4000-8000-0000000000a1', 'Legado 1 0061', 'checking', 0, 0, NULL),
  ('c6100000-0000-4000-8000-0000000004a2', 'c6100000-0000-4000-8000-0000000000a2', 'Legado 2 0061', 'checking', 0, 0, NULL);
INSERT INTO public.transactions (id, user_id, account_id, description, amount_cents, date, tenant_id) VALUES
  ('c6100000-0000-4000-8000-0000000004a3', 'c6100000-0000-4000-8000-0000000000a2',
   'c6100000-0000-4000-8000-0000000004a2', 'Legado Tx 0061', 100, CURRENT_DATE, NULL);

DO $$
DECLARE
  v_n int;
  v_tenant uuid := current_setting('c61.ta')::uuid;
BEGIN
  UPDATE public.accounts SET tenant_id = private.resolve_user_tenant(user_id)
  WHERE tenant_id IS NULL
    AND user_id IN ('c6100000-0000-4000-8000-0000000000a1', 'c6100000-0000-4000-8000-0000000000a2');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0061 T04 falhou: backfill de accounts atualizou % (esperado 2)', v_n;
  END IF;

  UPDATE public.transactions SET tenant_id = private.resolve_user_tenant(user_id)
  WHERE tenant_id IS NULL
    AND user_id = 'c6100000-0000-4000-8000-0000000000a2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0061 T04 falhou: backfill de transactions atualizou % (esperado 1)', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.accounts
  WHERE id IN ('c6100000-0000-4000-8000-0000000004a1', 'c6100000-0000-4000-8000-0000000004a2')
    AND tenant_id = v_tenant;
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0061 T04 falhou: contas legadas sem o tenant derivado (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.transactions
  WHERE id = 'c6100000-0000-4000-8000-0000000004a3' AND tenant_id = v_tenant;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0061 T04 falhou: lancamento legado sem o tenant derivado';
  END IF;

  -- segunda passada = no-op (idempotente; nenhuma linha casa `IS NULL`)
  UPDATE public.accounts SET tenant_id = private.resolve_user_tenant(user_id)
  WHERE tenant_id IS NULL
    AND user_id IN ('c6100000-0000-4000-8000-0000000000a1', 'c6100000-0000-4000-8000-0000000000a2');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0061 T04 falhou: 2ª passada atualizou % linhas', v_n;
  END IF;
END $$;

ALTER TABLE public.accounts ENABLE TRIGGER tenant_id_immutable;
ALTER TABLE public.transactions ENABLE TRIGGER tenant_id_immutable;
ALTER TABLE public.accounts ENABLE TRIGGER plan_quota_accounts;
ALTER TABLE public.transactions ENABLE TRIGGER plan_quota_transactions;

-- trigger recriado barraria o próprio backfill (ordem da migration)
DO $$
BEGIN
  BEGIN
    UPDATE public.accounts SET tenant_id = NULL
    WHERE id = 'c6100000-0000-4000-8000-0000000004a1';
    RAISE EXCEPTION '0061 T04 falhou: tenant_id_immutable nao ativo apos o backfill';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T04 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'tenant-id-immutable' THEN
      RAISE EXCEPTION '0061 T04 falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0061 T04 ok: backfill correlaciona legado, 2ª passada no-op, immutable só depois';
END $$;
ROLLBACK;

-- ============ T04b — O-F3-1: tenant canceled não aborta o backfill ============
BEGIN;
SELECT set_config('c61.te', :'te', true);

ALTER TABLE public.accounts DISABLE TRIGGER plan_quota_accounts;
ALTER TABLE public.accounts DISABLE TRIGGER tenant_id_immutable;
-- a linha é de legado: nasceu antes de 0054/0061, logo nenhum dos guardas vale
ALTER TABLE public.accounts DISABLE TRIGGER aa_subscription_readonly;
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents, tenant_id) VALUES
  ('c6100000-0000-4000-8000-0000000004b1', 'c6100000-0000-4000-8000-0000000000e1', 'Legado Cancelado 0061', 'checking', 0, 0, NULL);
ALTER TABLE public.accounts ENABLE TRIGGER aa_subscription_readonly;
ALTER TABLE public.accounts ENABLE TRIGGER plan_quota_accounts;

-- com `aa_subscription_readonly` ativo o backfill aborta (medido)
DO $$
BEGIN
  BEGIN
    UPDATE public.accounts SET tenant_id = private.resolve_user_tenant(user_id)
    WHERE tenant_id IS NULL AND user_id = 'c6100000-0000-4000-8000-0000000000e1';
    RAISE EXCEPTION '0061 T04b falhou: backfill passou com aa_subscription_readonly ativo';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T04b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0061 T04b falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
END $$;

-- DISABLE/ENABLE escopado na mesma transação (caminho da migration)
ALTER TABLE public.accounts DISABLE TRIGGER aa_subscription_readonly;
DO $$
DECLARE v_n int; v_tenant uuid := current_setting('c61.te')::uuid;
BEGIN
  UPDATE public.accounts SET tenant_id = private.resolve_user_tenant(user_id)
  WHERE tenant_id IS NULL AND user_id = 'c6100000-0000-4000-8000-0000000000e1';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0061 T04b falhou: backfill escopado atualizou % (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE id = 'c6100000-0000-4000-8000-0000000004b1' AND tenant_id = v_tenant;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0061 T04b falhou: linha legada de tenant canceled sem tenant';
  END IF;
  RAISE NOTICE '0061 T04b ok: sem o disable o backfill aborta; com disable escopado conclui';
END $$;
ALTER TABLE public.accounts ENABLE TRIGGER aa_subscription_readonly;
ALTER TABLE public.accounts ENABLE TRIGGER tenant_id_immutable;
ROLLBACK;

-- ============ T05 — ordem status -> quota continua (REQ-29) ============
BEGIN;
SELECT set_config('c61.te', :'te', true);

-- quota estourada no tenant E (free = 2 contas) enquanto ainda é gravável.
-- Fixture: o tenant E já está `canceled`; com o 0076 o INSERT com apenas o
-- `aa_` desligado ainda bateria na checagem de status da quota, então o
-- `plan_quota_accounts` também é desligado só para montar a fixture. Como é
-- esse trigger quem deriva/grava `tenant_id`, a fixture grava o `tenant_id`
-- EXPLICITAMENTE (`c61.te`) — senão as contas nascem com `tenant_id NULL`, a
-- probe da quota (`WHERE tenant_id = ...`) conta 0 e a contraprova fica vácua.
ALTER TABLE public.accounts DISABLE TRIGGER aa_subscription_readonly;
ALTER TABLE public.accounts DISABLE TRIGGER plan_quota_accounts;
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents, tenant_id) VALUES
  ('c6100000-0000-4000-8000-0000000005e1', 'c6100000-0000-4000-8000-0000000000e1', 'Cancelado 1 0061', 'checking', 0, 0, current_setting('c61.te')::uuid),
  ('c6100000-0000-4000-8000-0000000005e2', 'c6100000-0000-4000-8000-0000000000e1', 'Cancelado 2 0061', 'checking', 0, 0, current_setting('c61.te')::uuid);
ALTER TABLE public.accounts ENABLE TRIGGER plan_quota_accounts;
ALTER TABLE public.accounts ENABLE TRIGGER aa_subscription_readonly;

-- Trava anti-vacuidade: a probe da quota filtra por `tenant_id`; se a fixture
-- voltar a gravar NULL, a contraprova passa sem nunca estourar o limite.
DO $$
DECLARE
  v_n int;
  v_null int;
BEGIN
  SELECT count(*) FILTER (WHERE a.tenant_id = current_setting('c61.te')::uuid),
         count(*) FILTER (WHERE a.id IN (
           'c6100000-0000-4000-8000-0000000005e1',
           'c6100000-0000-4000-8000-0000000005e2'
         ) AND a.tenant_id IS NULL)
    INTO v_n, v_null
  FROM public.accounts AS a
  WHERE a.user_id = 'c6100000-0000-4000-8000-0000000000e1';
  IF v_n <> 2 OR v_null <> 0 THEN
    RAISE EXCEPTION '0061 T05 falhou: fixture vacua — contadas=% tenant_id_nulo=% (esperado 2/0)', v_n, v_null;
  END IF;
  RAISE NOTICE '0061 T05 ok (fixture): 2 contas com tenant_id derivado (quota free=2 armada)';
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000e1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c6100000-0000-4000-8000-0000000000e1', 'Ordem 0061', 'checking');
    RAISE EXCEPTION '0061 T05 falhou: INSERT passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T05 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0061 T05 falhou: status deveria vir antes da quota (%)', SQLERRM;
    END IF;
  END;
END $$;

RESET ROLE;
-- Contraprova (re-apontada em F6/0076 — O-F6-7): com o `aa_` desabilitado o
-- rótulo de status continua saindo do `enforce_tenant_quota` (0076), porque os
-- dois portões emitem o mesmo rótulo. A ordem status→quota segue provada pelo
-- ordinal alfabético do catálogo (`aa_` < `plan_quota_*`); sem o 0076 este
-- INSERT voltaria a emitir `quota-accounts-exceeded`.
ALTER TABLE public.accounts DISABLE TRIGGER aa_subscription_readonly;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000e1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c6100000-0000-4000-8000-0000000000e1', 'Ordem 2 0061', 'checking');
    RAISE EXCEPTION '0061 T05 falhou: INSERT passou sem o trigger de status';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T05 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0061 T05 falhou: rotulo de status esperado na contraprova (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0061 T05 ok: status antes da quota (aa_ < plan_quota_*); contraprova -> subscription-canceled-readonly (0076)';
END $$;

-- Prova de que a contraprova MORDE (não-vácua): neutraliza o 0076 devolvendo o
-- tenant a um estado gravável (o `aa_` segue desligado, então nenhum portão de
-- status atua) e mantém a quota armada (2 contas no tenant, free = 2). O
-- caminho de quota tem de ser alcançado: `quota-accounts-exceeded`.
RESET ROLE;
UPDATE public.tenants SET subscription_status = 'active'
WHERE id = current_setting('c61.te')::uuid;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000e1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c6100000-0000-4000-8000-0000000000e1', 'Ordem 3 0061', 'checking');
    RAISE EXCEPTION '0061 T05 falhou: INSERT passou com a quota armada';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T05 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-accounts-exceeded' THEN
      RAISE EXCEPTION '0061 T05 falhou: quota nao morde sem o 0076 (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0061 T05 ok: com o 0076 neutralizado a quota armada devolve quota-accounts-exceeded';
END $$;
ROLLBACK;

-- ============ T06 — I1: atribuição usa o tenant GRAVÁVEL ============
-- Owner de T1 (`canceled`) que também é membro de T2 (`active`): o guard decide
-- pelo CONJUNTO (C1) e libera; a atribuição precisa escolher o MESMO sujeito
-- (T2). Fixtures próprias (ids f01/f02/f1/f2) vivem só nesta transação — ROLLBACK
-- garante rerun sem resíduo. Os tenants nascem graváveis porque o guard de
-- `tenant_members` avalia o destino; T1 vira `canceled` depois das memberships.
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c6100000-0000-4000-8000-0000000000f1', 'quota-f1-0061@example.com'),
  ('c6100000-0000-4000-8000-0000000000f2', 'quota-f2-0061@example.com');

INSERT INTO public.tenants (id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status) VALUES
  ('c6100000-0000-4000-8000-0000000f0001', 'pf', 'c6100000-0000-4000-8000-0000000000f1',
   '54200000788', 'Quota T1 Cancelada 0061', 'free', 'active'),
  ('c6100000-0000-4000-8000-0000000f0002', 'pf', 'c6100000-0000-4000-8000-0000000000f2',
   '54200000869', 'Quota T2 Gravavel 0061', 'free', 'active');

-- Fixture de pool: o tenant T2 é `free` (limite de contas 2, objeto do T06) e
-- precisa de 2 logins; a quota de seats (`0063`) não é objeto desta spec, logo
-- o trigger é desligado só nesta fixture e reabilitado na mesma transação.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tenant_members'::regclass
      AND tgname = 'plan_quota_tenant_members'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.tenant_members DISABLE TRIGGER plan_quota_tenant_members;
  END IF;
END $$;

INSERT INTO public.tenant_members (tenant_id, user_id, role) VALUES
  ('c6100000-0000-4000-8000-0000000f0001', 'c6100000-0000-4000-8000-0000000000f1', 'owner'),
  ('c6100000-0000-4000-8000-0000000f0002', 'c6100000-0000-4000-8000-0000000000f2', 'owner'),
  ('c6100000-0000-4000-8000-0000000f0002', 'c6100000-0000-4000-8000-0000000000f1', 'member');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tenant_members'::regclass
      AND tgname = 'plan_quota_tenant_members'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.tenant_members ENABLE TRIGGER plan_quota_tenant_members;
  END IF;
END $$;

UPDATE public.tenants SET subscription_status = 'canceled'
WHERE id = 'c6100000-0000-4000-8000-0000000f0001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000f1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', true);

INSERT INTO public.accounts (id, user_id, name, type) VALUES
  ('c6100000-0000-4000-8000-0000000f0011', 'c6100000-0000-4000-8000-0000000000f1',
   'Gravavel 1 0061', 'checking');

SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000f2', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000f2","role":"authenticated","aal":"aal2"}', true);

INSERT INTO public.accounts (id, user_id, name, type) VALUES
  ('c6100000-0000-4000-8000-0000000f0012', 'c6100000-0000-4000-8000-0000000000f2',
   'Gravavel 2 0061', 'checking');

RESET ROLE;
DO $$
DECLARE
  v_n int;
  v_tenant uuid;
  v_t1 uuid := 'c6100000-0000-4000-8000-0000000f0001';
  v_t2 uuid := 'c6100000-0000-4000-8000-0000000f0002';
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.accounts
  WHERE id = 'c6100000-0000-4000-8000-0000000f0011';
  IF v_tenant IS DISTINCT FROM v_t2 THEN
    RAISE EXCEPTION '0061 T06 falhou: conta gravada em % (esperado o tenant gravavel)', v_tenant;
  END IF;
  IF v_tenant = v_t1 THEN
    RAISE EXCEPTION '0061 T06 falhou: linha caiu no tenant canceled (quota e guard com sujeitos diferentes)';
  END IF;

  SELECT count(*) INTO v_n FROM public.accounts WHERE tenant_id = v_t1;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0061 T06 falhou: tenant canceled recebeu % linhas', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.accounts WHERE tenant_id = v_t2;
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0061 T06 falhou: tenant gravavel tem % contas (esperado 2)', v_n;
  END IF;

  -- determinismo da mesma resolução (owner canceled + member active)
  IF private.resolve_writable_tenant('c6100000-0000-4000-8000-0000000000f1')
     IS DISTINCT FROM private.resolve_writable_tenant('c6100000-0000-4000-8000-0000000000f1') THEN
    RAISE EXCEPTION '0061 T06 falhou: resolve_writable_tenant nao deterministica';
  END IF;
  -- e o base (owner primeiro) continua devolvendo T1: a diferença é o objeto
  IF private.resolve_user_tenant('c6100000-0000-4000-8000-0000000000f1') IS DISTINCT FROM v_t1 THEN
    RAISE EXCEPTION '0061 T06 falhou: base deveria resolver o owner (canceled)';
  END IF;
END $$;

-- a quota conta no tenant onde a linha caiu (T2): 3ª conta estoura
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000f1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c6100000-0000-4000-8000-0000000000f1', 'Gravavel 3 0061', 'checking');
    RAISE EXCEPTION '0061 T06 falhou: 3ª conta do pool gravavel passou no limite';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T06 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-accounts-exceeded' THEN
      RAISE EXCEPTION '0061 T06 falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0061 T06 ok: linha gravada no tenant GRAVAVEL (T2), quota contada em T2, T1 com 0 linhas';
END $$;
ROLLBACK;

-- ============ T06b — I1: todos os tenants canceled -> guard, 0 escrita ============
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c6100000-0000-4000-8000-0000000000f3', 'quota-f3-0061@example.com');

INSERT INTO public.tenants (id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status) VALUES
  ('c6100000-0000-4000-8000-0000000f0003', 'pf', 'c6100000-0000-4000-8000-0000000000f3',
   '54200000941', 'Quota Tudo Cancelado 0061', 'free', 'active');

INSERT INTO public.tenant_members (tenant_id, user_id, role) VALUES
  ('c6100000-0000-4000-8000-0000000f0003', 'c6100000-0000-4000-8000-0000000000f3', 'owner');

UPDATE public.tenants SET subscription_status = 'canceled'
WHERE id = 'c6100000-0000-4000-8000-0000000f0003';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6100000-0000-4000-8000-0000000000f3', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6100000-0000-4000-8000-0000000000f3","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c6100000-0000-4000-8000-0000000000f3', 'Cancelada 0061', 'checking');
    RAISE EXCEPTION '0061 T06b falhou: INSERT passou com todos os tenants canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0061 T06b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0061 T06b falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
END $$;

RESET ROLE;
DO $$
DECLARE
  v_n int;
  v_fallback uuid := private.resolve_writable_tenant('c6100000-0000-4000-8000-0000000000f3');
BEGIN
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE user_id = 'c6100000-0000-4000-8000-0000000000f3';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0061 T06b falhou: % linhas escritas em tenant canceled', v_n;
  END IF;
  -- escolha declarada: sem tenant gravavel devolve o derivado base (o guard
  -- barra antes; com `aa_` desabilitado a quota ainda usa o tenant certo)
  IF v_fallback IS DISTINCT FROM 'c6100000-0000-4000-8000-0000000f0003'::uuid THEN
    RAISE EXCEPTION '0061 T06b falhou: fallback deveria ser o derivado base (%)', v_fallback;
  END IF;
  RAISE NOTICE '0061 T06b ok: todos canceled -> subscription-canceled-readonly, 0 escrita, fallback = derivado base';
END $$;
ROLLBACK;

-- ============ T07 — I5: backfill não é no-op para órfão (0 UPDATE no rerun) ============
-- Fixture COMMITADA de propósito: `set_accounts_updated_at` usa `now()`, que é
-- congelado por transação — o bump de `updated_at` só é observável entre
-- transações distintas, que é exatamente o caso do rerun da migration.
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c6100000-0000-4000-8000-0000000000f4', 'quota-f4-0061@example.com');

-- linha legada de usuário SEM membership: nasceu antes de 0061
ALTER TABLE public.accounts DISABLE TRIGGER plan_quota_accounts;
INSERT INTO public.accounts (id, user_id, name, type, tenant_id) VALUES
  ('c6100000-0000-4000-8000-0000000f0041', 'c6100000-0000-4000-8000-0000000000f4',
   'Orfao 0061', 'checking', NULL);
ALTER TABLE public.accounts ENABLE TRIGGER plan_quota_accounts;

COMMIT;

-- rerun (transação nova): predicado da migration, só casa quem tem membership
DO $$
DECLARE
  v_before timestamptz;
  v_after timestamptz;
  v_n int;
  v_tenant uuid;
BEGIN
  SELECT updated_at INTO v_before FROM public.accounts
  WHERE id = 'c6100000-0000-4000-8000-0000000f0041';

  UPDATE public.accounts AS r
  SET tenant_id = private.resolve_user_tenant(r.user_id)
  WHERE r.tenant_id IS NULL
    AND EXISTS (SELECT 1 FROM public.tenant_members AS tm WHERE tm.user_id = r.user_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0061 T07 falhou: backfill atualizou % linhas de orfao', v_n;
  END IF;

  SELECT updated_at, tenant_id INTO v_after, v_tenant FROM public.accounts
  WHERE id = 'c6100000-0000-4000-8000-0000000f0041';
  IF v_tenant IS NOT NULL THEN
    RAISE EXCEPTION '0061 T07 falhou: orfao recebeu tenant (%)', v_tenant;
  END IF;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION '0061 T07 falhou: rerun bumpou updated_at do orfao (nao e no-op)';
  END IF;
END $$;

-- contraprova (outra transação): o predicado ANTIGO (só `IS NULL`) casa e bumpa
DO $$
DECLARE
  v_before timestamptz;
  v_after timestamptz;
  v_n int;
BEGIN
  SELECT updated_at INTO v_before FROM public.accounts
  WHERE id = 'c6100000-0000-4000-8000-0000000f0041';

  UPDATE public.accounts SET tenant_id = private.resolve_user_tenant(user_id)
  WHERE tenant_id IS NULL AND id = 'c6100000-0000-4000-8000-0000000f0041';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0061 T07 falhou: predicado antigo deveria casar o orfao (% linhas)', v_n;
  END IF;

  SELECT updated_at INTO v_after FROM public.accounts
  WHERE id = 'c6100000-0000-4000-8000-0000000f0041';
  IF v_after IS NOT DISTINCT FROM v_before THEN
    RAISE EXCEPTION '0061 T07 falhou: contraprova nao mediu o bump do predicado antigo';
  END IF;

  RAISE NOTICE '0061 T07 ok: predicado novo = 0 UPDATE/updated_at intacto; predicado antigo bumpa (regressao provada)';
END $$;

-- cleanup imediato da fixture commitada (única escrita persistente do bloco)
BEGIN;
SET LOCAL app.card_purge = 'on';
DELETE FROM public.accounts
WHERE user_id = 'c6100000-0000-4000-8000-0000000000f4';
DELETE FROM auth.users
WHERE id = 'c6100000-0000-4000-8000-0000000000f4';
COMMIT;

-- ============ T08 — I1: resolve_writable_tenant determinística e fechada ============
DO $$
DECLARE
  v_proc pg_proc;
  v_a uuid;
  v_b uuid;
  v_base uuid;
BEGIN
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('private.resolve_writable_tenant(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0061 T08 falhou: private.resolve_writable_tenant ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0061 T08 falhou: resolve_writable_tenant sem SECURITY DEFINER';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION '0061 T08 falhou: resolve_writable_tenant nao e STABLE';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0061 T08 falhou: resolve_writable_tenant sem search_path vazio';
  END IF;
  IF v_proc.prosrc LIKE '%auth.uid()%' THEN
    RAISE EXCEPTION '0061 T08 falhou: resolve_writable_tenant le auth.uid (sujeito deve ser o parametro)';
  END IF;
  IF has_function_privilege('authenticated', 'private.resolve_writable_tenant(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.resolve_writable_tenant(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.resolve_writable_tenant(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0061 T08 falhou: resolve_writable_tenant executavel por client';
  END IF;

  -- determinística (2 chamadas) e idêntica ao base quando só há tenant gravável
  v_base := private.resolve_user_tenant('c6100000-0000-4000-8000-0000000000a1');
  v_a := private.resolve_writable_tenant('c6100000-0000-4000-8000-0000000000a1');
  v_b := private.resolve_writable_tenant('c6100000-0000-4000-8000-0000000000a1');
  IF v_a IS NULL OR v_a IS DISTINCT FROM v_b THEN
    RAISE EXCEPTION '0061 T08 falhou: resolucao nao deterministica (%)', v_a;
  END IF;
  IF v_a IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION '0061 T08 falhou: tenant unico gravavel deveria coincidir com o base';
  END IF;

  -- sem membership -> NULL (o gate converte em quota-tenant-missing)
  IF private.resolve_writable_tenant('c6100000-0000-4000-8000-0000000000c1') IS NOT NULL THEN
    RAISE EXCEPTION '0061 T08 falhou: usuario sem membership resolveu tenant';
  END IF;

  RAISE NOTICE '0061 T08 ok: deterministica, DEFINER/search_path vazio, sem EXECUTE para client';
END $$;

-- ============ Fixtures cleanup (fim) ============
BEGIN;
SET LOCAL app.card_purge = 'on';
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c6100000-0000-4000-8000-0000000000a1',
    'c6100000-0000-4000-8000-0000000000d1',
    'c6100000-0000-4000-8000-0000000000e1'
  )
);
DELETE FROM public.contract_acceptances
WHERE user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.tenant_members
WHERE user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000a2',
  'c6100000-0000-4000-8000-0000000000a3',
  'c6100000-0000-4000-8000-0000000000b1',
  'c6100000-0000-4000-8000-0000000000c1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.admin_audit
WHERE actor_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM public.tenants
WHERE owner_user_id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1'
);
DELETE FROM auth.users
WHERE id IN (
  'c6100000-0000-4000-8000-0000000000a1',
  'c6100000-0000-4000-8000-0000000000a2',
  'c6100000-0000-4000-8000-0000000000a3',
  'c6100000-0000-4000-8000-0000000000b1',
  'c6100000-0000-4000-8000-0000000000c1',
  'c6100000-0000-4000-8000-0000000000d1',
  'c6100000-0000-4000-8000-0000000000e1',
  'c6100000-0000-4000-8000-0000000000f4'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
SET LOCAL app.card_purge = 'off';
COMMIT;

\echo '0061 tenant-quota: OK'
