-- backoffice-p1-adr001.spec.sql — P1 ADR-001 (migration 0033_plan_limits.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backoffice-p1-adr001.spec.sql
-- Rerunnable: fixtures (users/tenants/accounts/transactions/tokens/audit) apagados no início e no fim.
--
-- Prova em banco real (nunca mock — mock não avalia trigger/policy/grant), `SET ROLE authenticated` + ROLLBACK:
--   T00 estrutura: plan_limits + seed, RLS sem leitura/escrita p/ client, RPCs SECURITY DEFINER/search_path='',
--       trigger BEFORE INSERT nas 4 tabelas, audit action quota_override, reject reafirmado, sem float.
--   T-Q1 bloqueia NO limite: 20 lançamentos no mês SP, 21º -> quota-transactions-exceeded, 0 linhas.
--   T-Q2 libera ANTES: 19 -> 20º passa, 21º bloqueia (fronteira exata).
--   T-Q3 full NULL libera: 25 lançamentos + contas acima de qualquer número.
--   T-Q4 override grava 1x e expira: admin (motivo>=10) grava 1 linha audit + libera 1 criação; 2ª bloqueia.
--   T-Q5 direct INSERT em plan_limits -> 42501; non-admin override -> not-admin (sem escrita).
--   T-C1 data forjada: created_at normalizado -> forjada conta no mês vigente (21ª bloqueia).
--   T-C1b UPDATE forjado: BEFORE UPDATE OF created_at -> created_at-immutable (4 tabelas), count intacto.
--   T-C2 consumo do token sob concorrência: FOR UPDATE no trigger (estrutural + T-Q4d sequencial 1x).
--   T-A1 trilha legível: list_admin_audit_page aceita 'quota_override', bogus -> tenant-audit-action-invalid.
--   T-Q6/T-Q7/T-Q8 fronteiras free: contas 2, cartões 1, orçamentos 3 (libera antes, bloqueia no limite).
--   T-Q9 limites exatos via RPC: standard 500·5·2·10, pro 5000·10·5·20.
-- Erros por rótulo fixo, sem PII (SEC-G3).

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
DELETE FROM private.plan_quota_overrides
WHERE tenant_id IN (
  'c2000000-0000-4000-8000-0000000000a1',
  'c2000000-0000-4000-8000-0000000000b2',
  'c2000000-0000-4000-8000-0000000000c3',
  'c2000000-0000-4000-8000-0000000000d4'
);

DELETE FROM public.admin_audit
WHERE tenant_id IN (
  'c2000000-0000-4000-8000-0000000000a1',
  'c2000000-0000-4000-8000-0000000000b2',
  'c2000000-0000-4000-8000-0000000000c3',
  'c2000000-0000-4000-8000-0000000000d4'
)
OR target_id IN (
  'c2000000-0000-4000-8000-0000000000a1',
  'c2000000-0000-4000-8000-0000000000b2',
  'c2000000-0000-4000-8000-0000000000c3',
  'c2000000-0000-4000-8000-0000000000d4'
);

ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
SELECT set_config('app.card_purge', 'on', false);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'c1000000-0000-4000-8000-0000000000a1',
  'c1000000-0000-4000-8000-0000000000b2',
  'c1000000-0000-4000-8000-0000000000c3',
  'c1000000-0000-4000-8000-0000000000d4',
  'c1000000-0000-4000-8000-0000000000e5'
);

DELETE FROM auth.users
WHERE id IN (
  'c1000000-0000-4000-8000-0000000000a1',
  'c1000000-0000-4000-8000-0000000000b2',
  'c1000000-0000-4000-8000-0000000000c3',
  'c1000000-0000-4000-8000-0000000000d4',
  'c1000000-0000-4000-8000-0000000000e5'
);

SELECT set_config('app.card_purge', 'off', false);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

INSERT INTO auth.users (id, email) VALUES
  ('c1000000-0000-4000-8000-0000000000a1', 'p1-q1@example.com'),
  ('c1000000-0000-4000-8000-0000000000b2', 'p1-q2@example.com'),
  ('c1000000-0000-4000-8000-0000000000c3', 'p1-q3@example.com'),
  ('c1000000-0000-4000-8000-0000000000d4', 'p1-q4@example.com'),
  ('c1000000-0000-4000-8000-0000000000e5', 'p1-admin@example.com');

-- Promoção via DBA: 0035 remove o 'admin' legado — o ator de quota é super_admin
-- (is_admin() = alias super_only, herdando a gate de quota).
UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'c1000000-0000-4000-8000-0000000000e5';

-- SEC-03 (0051): o super_admin de fixture precisa de operador ATIVO para o
-- caminho feliz das RPCs admin_* (o gate global em is_super_admin() herdou
-- operator-inactive). Bootstrap de fixture, como o seed de dev.
INSERT INTO public.internal_operators (user_id, active)
SELECT p.id, true FROM public.profiles AS p
WHERE p.role = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
  );

DELETE FROM public.admin_audit
WHERE target_id = 'c1000000-0000-4000-8000-0000000000e5';

-- Tenants + memberships owner + aceite (postgres; aceite na mesma transação
-- para satisfazer a trigger diferida `tenant_acceptance_required` 0024).
BEGIN;

INSERT INTO public.tenants (id, kind, owner_user_id, cpf, razao_social, plan_id) VALUES
  ('c2000000-0000-4000-8000-0000000000a1', 'pf', 'c1000000-0000-4000-8000-0000000000a1', '90000000001', 'P1 Q1', 'free'),
  ('c2000000-0000-4000-8000-0000000000b2', 'pf', 'c1000000-0000-4000-8000-0000000000b2', '90000000002', 'P1 Q2', 'free'),
  ('c2000000-0000-4000-8000-0000000000c3', 'pf', 'c1000000-0000-4000-8000-0000000000c3', '90000000003', 'P1 Q3', 'full'),
  ('c2000000-0000-4000-8000-0000000000d4', 'pf', 'c1000000-0000-4000-8000-0000000000d4', '90000000004', 'P1 Q4', 'free');

INSERT INTO public.tenant_members (tenant_id, user_id, role) VALUES
  ('c2000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-0000000000a1', 'owner'),
  ('c2000000-0000-4000-8000-0000000000b2', 'c1000000-0000-4000-8000-0000000000b2', 'owner'),
  ('c2000000-0000-4000-8000-0000000000c3', 'c1000000-0000-4000-8000-0000000000c3', 'owner'),
  ('c2000000-0000-4000-8000-0000000000d4', 'c1000000-0000-4000-8000-0000000000d4', 'owner');

INSERT INTO public.contract_acceptances (tenant_id, contract_version, user_id) VALUES
  ('c2000000-0000-4000-8000-0000000000a1', 'test-v1', 'c1000000-0000-4000-8000-0000000000a1'),
  ('c2000000-0000-4000-8000-0000000000b2', 'test-v1', 'c1000000-0000-4000-8000-0000000000b2'),
  ('c2000000-0000-4000-8000-0000000000c3', 'test-v1', 'c1000000-0000-4000-8000-0000000000c3'),
  ('c2000000-0000-4000-8000-0000000000d4', 'test-v1', 'c1000000-0000-4000-8000-0000000000d4');

COMMIT;

INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000a1', 'Q1 Conta', 'checking', 0, 0),
  ('a1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-0000000000b2', 'Q2 Conta', 'checking', 0, 0),
  ('a1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-0000000000c3', 'Q3 Conta', 'checking', 0, 0),
  ('a1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-0000000000d4', 'Q4 Conta', 'checking', 0, 0);

-- Seed: A=20 (no limite), B=19 (um antes), C=25 (full NULL), D=20 (limite do override).
INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
SELECT 'c1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001',
  'P1 Q1 seed ' || g, 100, CURRENT_DATE
FROM generate_series(1, 20) AS g;

INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
SELECT 'c1000000-0000-4000-8000-0000000000b2', 'a1000000-0000-4000-8000-000000000002',
  'P1 Q2 seed ' || g, 100, CURRENT_DATE
FROM generate_series(1, 19) AS g;

INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
SELECT 'c1000000-0000-4000-8000-0000000000c3', 'a1000000-0000-4000-8000-000000000003',
  'P1 Q3 seed ' || g, 100, CURRENT_DATE
FROM generate_series(1, 25) AS g;

INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
SELECT 'c1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-000000000004',
  'P1 Q4 seed ' || g, 100, CURRENT_DATE
FROM generate_series(1, 20) AS g;

-- ============ T00 — estrutura ============
DO $$
DECLARE
  v_rls boolean;
  v_count int;
  v_proc pg_proc;
  v_trg text;
BEGIN
  IF to_regclass('public.plan_limits') IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: plan_limits ausente';
  END IF;
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.plan_limits'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RLS desligada em plan_limits';
  END IF;

  -- Sem policy p/ client: leitura/escrita só via função (direct -> 42501).
  SELECT count(*) INTO v_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'plan_limits';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: policy inesperada em plan_limits';
  END IF;
  IF has_table_privilege('authenticated', 'public.plan_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.plan_limits', 'INSERT')
     OR has_table_privilege('anon', 'public.plan_limits', 'SELECT')
     OR has_table_privilege('anon', 'public.plan_limits', 'INSERT') THEN
    RAISE EXCEPTION 'T00 falhou: client com privilégio em plan_limits';
  END IF;

  -- Seed: free 20.2.1.3 / standard 500.5.2.10 / pro 5000.10.5.20 / full 4x NULL.
  SELECT count(*) INTO v_count FROM public.plan_limits
  WHERE (plan_slug = 'free' AND max_transactions_month = 20 AND max_accounts = 2 AND max_credit_cards = 1 AND max_budgets = 3)
     OR (plan_slug = 'standard' AND max_transactions_month = 500 AND max_accounts = 5 AND max_credit_cards = 2 AND max_budgets = 10)
     OR (plan_slug = 'pro' AND max_transactions_month = 5000 AND max_accounts = 10 AND max_credit_cards = 5 AND max_budgets = 20)
     OR (plan_slug = 'full' AND max_transactions_month IS NULL AND max_accounts IS NULL AND max_credit_cards IS NULL AND max_budgets IS NULL);
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'T00 falhou: seed de plan_limits divergente (%)', v_count;
  END IF;

  -- Sem float p/ quota: colunas de limite são integer.
  SELECT count(*) INTO v_count FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'plan_limits'
    AND column_name IN ('max_transactions_month', 'max_accounts', 'max_credit_cards', 'max_budgets')
    AND data_type = 'integer';
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'T00 falhou: limite de plan_limits não é integer';
  END IF;

  -- get_plan_limit / admin_register_override / enforce_tenant_quota: SECURITY DEFINER + search_path='' (0061).
  FOREACH v_trg IN ARRAY ARRAY['public.get_plan_limit(text)', 'public.admin_register_override(uuid, text, text)', 'public.enforce_tenant_quota()'] LOOP
    SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure(v_trg);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'T00 falhou: função ausente %', v_trg;
    END IF;
    IF v_proc.prosecdef IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'T00 falhou: sem SECURITY DEFINER em %', v_trg;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION 'T00 falhou: sem search_path travado em %', v_trg;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.get_plan_limit(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_register_override(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated sem EXECUTE nas RPCs';
  END IF;
  IF has_function_privilege('anon', 'public.get_plan_limit(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_register_override(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_tenant_quota()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: EXECUTE indevido (anon ou função do trigger)';
  END IF;

  -- Trigger BEFORE INSERT nas 4 tabelas.
  SELECT count(*) INTO v_count FROM pg_trigger
  WHERE tgrelid IN ('public.transactions'::regclass, 'public.accounts'::regclass,
                    'public.credit_cards'::regclass, 'public.budgets'::regclass)
    AND tgname IN ('plan_quota_transactions', 'plan_quota_accounts', 'plan_quota_credit_cards', 'plan_quota_budgets')
    AND tgfoid = 'public.enforce_tenant_quota()'::regprocedure
    AND NOT tgisinternal;
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'T00 falhou: triggers de quota ausentes (%)', v_count;
  END IF;

  -- admin_audit: action quota_override no CHECK + reject reafirmado.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_audit_action_check'
      AND conrelid = 'public.admin_audit'::regclass
      AND pg_get_constraintdef(oid) LIKE '%quota_override%'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: CHECK admin_audit sem quota_override';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.admin_audit'::regclass
      AND tgname = 'tenants_audit_reject'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T00 falhou: tenants_audit_reject ausente em admin_audit';
  END IF;

  RAISE NOTICE 'T00 ok: plan_limits + seed + RPCs SECURITY DEFINER + triggers x4 + audit';
END $$;

-- ============ T-Q1 — bloqueia NO limite (21º) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_before int; v_after int;
BEGIN
  SELECT count(*) INTO v_before FROM public.transactions
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000a1';
  IF v_before <> 20 THEN
    RAISE EXCEPTION 'T-Q1 falhou: seed não ficou no limite (%)', v_before;
  END IF;

  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001',
      'T-Q1 tentativa 21', 100, CURRENT_DATE);
    RAISE EXCEPTION 'T-Q1 falhou: 21º lançamento passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q1 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-transactions-exceeded' THEN
      RAISE EXCEPTION 'T-Q1 falhou: rótulo errado no limite (%)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_after FROM public.transactions
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000a1';
  IF v_after <> 20 THEN
    RAISE EXCEPTION 'T-Q1 falhou: tentativa bloqueada persistiu linha';
  END IF;

  RAISE NOTICE 'T-Q1 ok: quota-transactions-exceeded no limite, 0 linhas';
END $$;
ROLLBACK;

-- ============ T-Q2 — libera ANTES (19 -> 20 passa, 21 bloqueia) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000b2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000b2","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_count int;
BEGIN
  INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
  VALUES ('c1000000-0000-4000-8000-0000000000b2', 'a1000000-0000-4000-8000-000000000002',
    'T-Q2 20th', 100, CURRENT_DATE);

  SELECT count(*) INTO v_count FROM public.transactions
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000b2';
  IF v_count <> 20 THEN
    RAISE EXCEPTION 'T-Q2 falhou: 20º lançamento não passou';
  END IF;

  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c1000000-0000-4000-8000-0000000000b2', 'a1000000-0000-4000-8000-000000000002',
      'T-Q2 21st', 100, CURRENT_DATE);
    RAISE EXCEPTION 'T-Q2 falhou: 21º lançamento passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q2 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-transactions-exceeded' THEN
      RAISE EXCEPTION 'T-Q2 falhou: rótulo errado após liberar (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE 'T-Q2 ok: libera antes do limite e bloqueia no limite';
END $$;
ROLLBACK;

-- ============ T-Q3 — full NULL libera ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000c3', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000c3","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_count int;
BEGIN
  INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
  VALUES ('c1000000-0000-4000-8000-0000000000c3', 'a1000000-0000-4000-8000-000000000003',
    'T-Q3 tx full', 100, CURRENT_DATE);

  SELECT count(*) INTO v_count FROM public.transactions
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000c3';
  IF v_count <> 26 THEN
    RAISE EXCEPTION 'T-Q3 falhou: full bloqueou lançamento (%)', v_count;
  END IF;

  INSERT INTO public.accounts (user_id, name, type) VALUES
    ('c1000000-0000-4000-8000-0000000000c3', 'T-Q3 conta 2', 'checking'),
    ('c1000000-0000-4000-8000-0000000000c3', 'T-Q3 conta 3', 'checking'),
    ('c1000000-0000-4000-8000-0000000000c3', 'T-Q3 conta 4', 'checking'),
    ('c1000000-0000-4000-8000-0000000000c3', 'T-Q3 conta 5', 'checking');

  SELECT count(*) INTO v_count FROM public.accounts
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000c3';
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'T-Q3 falhou: full bloqueou contas (%)', v_count;
  END IF;

  RAISE NOTICE 'T-Q3 ok: full=NULL libera lançamentos e contas';
END $$;
ROLLBACK;

-- ============ T-Q4 — override grava 1x e expira ============

-- T-Q4a: não-admin no limite é bloqueado (antes de qualquer override).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000d4', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000d4","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-000000000004',
      'T-Q4a direto no limite', 100, CURRENT_DATE);
    RAISE EXCEPTION 'T-Q4a falhou: direto no limite passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q4a falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-transactions-exceeded' THEN
      RAISE EXCEPTION 'T-Q4a falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE 'T-Q4a ok: INSERT direto no limite é bloqueado no banco';
END $$;
ROLLBACK;

-- T-Q4b: override não-admin / recurso inválido / motivo curto não escrevem nada.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000d4', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000d4","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_register_override('c2000000-0000-4000-8000-0000000000d4', 'transactions', 'motivo longo suficiente');
    RAISE EXCEPTION 'T-Q4b falhou: não-admin registrou override';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q4b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' THEN
      RAISE EXCEPTION 'T-Q4b falhou: rótulo errado p/ não-admin (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE 'T-Q4b ok: not-admin sem escrita';
END $$;
ROLLBACK;

DO $$
DECLARE v_audit bigint; v_tokens bigint;
BEGIN
  SELECT count(*) INTO v_audit FROM public.admin_audit
  WHERE tenant_id = 'c2000000-0000-4000-8000-0000000000d4' AND action = 'quota_override';
  SELECT count(*) INTO v_tokens FROM private.plan_quota_overrides
  WHERE tenant_id = 'c2000000-0000-4000-8000-0000000000d4';
  IF v_audit <> 0 OR v_tokens <> 0 THEN
    RAISE EXCEPTION 'T-Q4b falhou: não-admin escreveu audit/token';
  END IF;

  RAISE NOTICE 'T-Q4b ok: audit/token intactos após not-admin';
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000e5', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000e5","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_register_override('c2000000-0000-4000-8000-0000000000d4', 'invoices', 'motivo longo suficiente');
    RAISE EXCEPTION 'T-Q4c falhou: recurso inválido aceito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q4c falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'override-resource-invalid' THEN
      RAISE EXCEPTION 'T-Q4c falhou: rótulo errado p/ recurso (%)', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.admin_register_override('c2000000-0000-4000-8000-0000000000d4', 'transactions', 'curto');
    RAISE EXCEPTION 'T-Q4c falhou: motivo curto aceito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q4c falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'override-reason-too-short' THEN
      RAISE EXCEPTION 'T-Q4c falhou: rótulo errado p/ motivo (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE 'T-Q4c ok: override-resource-invalid + override-reason-too-short';
END $$;
ROLLBACK;

-- T-Q4d: admin grava 1x + libera 1 criação; 2ª bloqueia (expirou).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000e5', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000e5","role":"authenticated","aal":"aal2"}', false);

SELECT public.admin_register_override('c2000000-0000-4000-8000-0000000000d4', 'transactions', 'suporte ao cliente ativo');

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000d4', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000d4","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_count int;
BEGIN
  INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
  VALUES ('c1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-000000000004',
    'T-Q4d com override', 100, CURRENT_DATE);

  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c1000000-0000-4000-8000-0000000000d4', 'a1000000-0000-4000-8000-000000000004',
      'T-Q4d segunda sem override', 100, CURRENT_DATE);
    RAISE EXCEPTION 'T-Q4d falhou: segunda criação sem override passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q4d falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-transactions-exceeded' THEN
      RAISE EXCEPTION 'T-Q4d falhou: rótulo errado após expiração (%)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_count FROM public.transactions
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000d4';
  IF v_count <> 21 THEN
    RAISE EXCEPTION 'T-Q4d falhou: tx=% (esperado 21)', v_count;
  END IF;

  RAISE NOTICE 'T-Q4d ok: override liberou 1 e expirou';
END $$;
COMMIT;

DO $$
DECLARE v_audit int; v_pending int; v_consumed int;
BEGIN
  SELECT count(*) INTO v_audit FROM public.admin_audit
  WHERE tenant_id = 'c2000000-0000-4000-8000-0000000000d4' AND action = 'quota_override';
  SELECT count(*) INTO v_pending FROM private.plan_quota_overrides
  WHERE tenant_id = 'c2000000-0000-4000-8000-0000000000d4' AND consumed_at IS NULL;
  SELECT count(*) INTO v_consumed FROM private.plan_quota_overrides
  WHERE tenant_id = 'c2000000-0000-4000-8000-0000000000d4' AND consumed_at IS NOT NULL;
  IF v_audit <> 1 OR v_pending <> 0 OR v_consumed <> 1 THEN
    RAISE EXCEPTION 'T-Q4d falhou: audit=% pending=% consumed=% (esperado 1/0/1)', v_audit, v_pending, v_consumed;
  END IF;

  RAISE NOTICE 'T-Q4d ok: 1 linha audit + token consumido';
END $$;

-- ============ T-C1 — created_at forjado não contorna quota (C1) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000b2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000b2","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_id uuid;
  v_created_at timestamptz;
  v_month_start timestamp;
  v_count int;
BEGIN
  -- B tem 19 no mês; INSERT forjado (2 meses atrás em SP) deve ser normalizado
  -- para agora e contar no mês vigente. Sem normalização, o forjado contorna
  -- a quota ao infinito (mês da linha não incrementa no mês vigente).
  INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date, created_at)
  VALUES ('c1000000-0000-4000-8000-0000000000b2', 'a1000000-0000-4000-8000-000000000002',
    'T-C1 forjada', 100, CURRENT_DATE,
    ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')
      - interval '2 months') AT TIME ZONE 'America/Sao_Paulo'))
  RETURNING id, created_at INTO v_id, v_created_at;

  v_month_start := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo');
  IF (v_created_at AT TIME ZONE 'America/Sao_Paulo') < v_month_start THEN
    RAISE EXCEPTION 'T-C1 falhou: created_at forjado persistiu (%)', v_created_at;
  END IF;

  SELECT count(*) INTO v_count FROM public.transactions
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000b2';
  IF v_count <> 20 THEN
    RAISE EXCEPTION 'T-C1 falhou: count=% (esperado 20 após normalizar)', v_count;
  END IF;

  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date, created_at)
    VALUES ('c1000000-0000-4000-8000-0000000000b2', 'a1000000-0000-4000-8000-000000000002',
      'T-C1 segunda forjada', 100, CURRENT_DATE,
      ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')
        - interval '2 months') AT TIME ZONE 'America/Sao_Paulo'));
    RAISE EXCEPTION 'T-C1 falhou: segunda forjada passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-C1 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-transactions-exceeded' THEN
      RAISE EXCEPTION 'T-C1 falhou: rótulo errado na segunda forjada (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE 'T-C1 ok: created_at forjado normalizado para o mês vigente';
END $$;
ROLLBACK;

-- ============ T-C1b — UPDATE de created_at não contorna quota (C1b) ============
-- C1 só normalizava o INSERT. O UPDATE seguia livre: voltar o created_at de
-- um lançamento para 2 meses atrás tirava a linha da contagem do mês SP e
-- liberava um INSERT novo no limite (quota contornável via UPDATE).
-- B tem 19 no mês (T-C1 fez ROLLBACK): 20º passa, UPDATE forjado -> created_at-
-- immutable + created_at intacto + count intacto; 21º segue bloqueado.
-- Estrutural: trigger BEFORE UPDATE OF created_at nas 4 tabelas + função
-- SECURITY DEFINER/search_path='' sem EXECUTE p/ authenticated (028-style).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000b2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000b2","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_count int;
  v_tx_id uuid;
  v_before timestamptz;
  v_after timestamptz;
  v_proc pg_proc;
  v_trg text;
BEGIN
  -- Estrutural: função imutável travada + 4 triggers BEFORE UPDATE OF created_at.
  SELECT * INTO v_proc FROM pg_proc WHERE oid = 'public.created_at_immutable()'::regprocedure;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T-C1b falhou: created_at_immutable() ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-C1b falhou: created_at_immutable() sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T-C1b falhou: created_at_immutable() sem search_path travado';
  END IF;
  IF has_function_privilege('authenticated', 'public.created_at_immutable()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-C1b falhou: authenticated com EXECUTE na função do trigger';
  END IF;
  FOREACH v_trg IN ARRAY ARRAY['public.transactions', 'public.accounts',
                               'public.credit_cards', 'public.budgets'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = v_trg::regclass
        AND tgname = 'created_at_immutable'
        AND tgfoid = 'public.created_at_immutable()'::regprocedure
        AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'T-C1b falhou: trigger de imutabilidade ausente em %', v_trg;
    END IF;
  END LOOP;

  -- 20º lançamento legítimo (B: 19 -> 20).
  INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
  VALUES ('c1000000-0000-4000-8000-0000000000b2', 'a1000000-0000-4000-8000-000000000002',
    'T-C1b 20th', 100, CURRENT_DATE);

  SELECT id, created_at INTO v_tx_id, v_before
  FROM public.transactions
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000b2'
    AND description = 'T-C1b 20th';

  -- UPDATE que tenta tirar a linha do mês vigente -> created_at-immutable.
  BEGIN
    UPDATE public.transactions
    SET created_at = ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')
      - interval '2 months') AT TIME ZONE 'America/Sao_Paulo')
    WHERE id = v_tx_id;
    RAISE EXCEPTION 'T-C1b falhou: UPDATE de created_at passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-C1b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'created_at-immutable' THEN
      RAISE EXCEPTION 'T-C1b falhou: rótulo errado no UPDATE (%)', SQLERRM;
    END IF;
  END;

  -- Valor intacto dentro da mesma transação (UPDATE rejeitado não converte).
  SELECT created_at INTO v_after FROM public.transactions WHERE id = v_tx_id;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'T-C1b falhou: created_at mudou apesar do bloqueio';
  END IF;

  -- Count intacto: segue no limite, próximo INSERT bloqueia normalmente.
  SELECT count(*) INTO v_count FROM public.transactions
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000b2';
  IF v_count <> 20 THEN
    RAISE EXCEPTION 'T-C1b falhou: count=% após UPDATE bloqueado (esperado 20)', v_count;
  END IF;

  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c1000000-0000-4000-8000-0000000000b2', 'a1000000-0000-4000-8000-000000000002',
      'T-C1b 21st', 100, CURRENT_DATE);
    RAISE EXCEPTION 'T-C1b falhou: 21º lançamento passou após UPDATE bloqueado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-C1b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-transactions-exceeded' THEN
      RAISE EXCEPTION 'T-C1b falhou: rótulo errado no 21º (%)', SQLERRM;
    END IF;
  END;

  -- Imutabilidade também nas demais tabelas cotadas (B ainda cabe em contas 2/3).
  BEGIN
    UPDATE public.accounts
    SET created_at = ((pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')
      - interval '2 months') AT TIME ZONE 'America/Sao_Paulo')
    WHERE user_id = 'c1000000-0000-4000-8000-0000000000b2';
    RAISE EXCEPTION 'T-C1b falhou: UPDATE de created_at em accounts passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-C1b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'created_at-immutable' THEN
      RAISE EXCEPTION 'T-C1b falhou: rótulo errado em accounts (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE 'T-C1b ok: UPDATE forjado -> created_at-immutable, count intacto no limite';
END $$;
ROLLBACK;

-- ============ T-C2 — token com FOR UPDATE (C2 estrutural) ============
DO $$
BEGIN
  IF pg_catalog.pg_get_functiondef('public.enforce_tenant_quota()'::regprocedure)
       NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'T-C2 falhou: enforce_tenant_quota sem FOR UPDATE no consumo do token';
  END IF;

  RAISE NOTICE 'T-C2 ok: consumo do token com FOR UPDATE (concorrência serializada por linha)';
END $$;

-- ============ T-A1 — quota_override legível via RPC (A1) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000e5', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000e5","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_n int; v_action text;
BEGIN
  SELECT count(*), max(a.action) INTO v_n, v_action
  FROM public.list_admin_audit_page(
    'c2000000-0000-4000-8000-0000000000d4', 'quota_override', 20, 0) AS a;
  IF v_n <> 1 OR v_action <> 'quota_override' THEN
    RAISE EXCEPTION 'T-A1 falhou: quota_override ausente na trilha legível (%/%)', v_n, v_action;
  END IF;

  BEGIN
    PERFORM * FROM public.list_admin_audit_page(
      'c2000000-0000-4000-8000-0000000000d4', 'acao-bogus', 20, 0);
    RAISE EXCEPTION 'T-A1 falhou: ação bogus aceita';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-A1 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'tenant-audit-action-invalid' THEN
      RAISE EXCEPTION 'T-A1 falhou: rótulo errado p/ ação bogus (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE 'T-A1 ok: quota_override legível via RPC, bogus rejeitado';
END $$;
ROLLBACK;

-- ============ T-Q5 — leitura por RPC + direct INSERT 42501 ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000d4', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000d4","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tx int; v_ac int; v_cc int; v_bd int;
BEGIN
  SELECT max_transactions_month, max_accounts, max_credit_cards, max_budgets
    INTO v_tx, v_ac, v_cc, v_bd FROM public.get_plan_limit('free');
  IF v_tx <> 20 OR v_ac <> 2 OR v_cc <> 1 OR v_bd <> 3 THEN
    RAISE EXCEPTION 'T-Q5 falhou: get_plan_limit(free) divergente';
  END IF;

  SELECT max_transactions_month, max_accounts, max_credit_cards, max_budgets
    INTO v_tx, v_ac, v_cc, v_bd FROM public.get_plan_limit('full');
  IF v_tx IS NOT NULL OR v_ac IS NOT NULL OR v_cc IS NOT NULL OR v_bd IS NOT NULL THEN
    RAISE EXCEPTION 'T-Q5 falhou: get_plan_limit(full) não é 4x NULL';
  END IF;

  BEGIN
    PERFORM public.get_plan_limit('enterprise');
    RAISE EXCEPTION 'T-Q5 falhou: plano bogus aceito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q5 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'tenant-plan-invalid' THEN
      RAISE EXCEPTION 'T-Q5 falhou: rótulo errado p/ slug bogus (%)', SQLERRM;
    END IF;
  END;

  BEGIN
    INSERT INTO public.plan_limits (plan_slug, max_transactions_month)
    VALUES ('free', 999);
    RAISE EXCEPTION 'T-Q5 falhou: INSERT direto em plan_limits passou';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-Q5 ok: direct INSERT em plan_limits negado (42501)';
  END;

  BEGIN
    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, from_value, reason)
    VALUES ('c1000000-0000-4000-8000-0000000000d4', 'c2000000-0000-4000-8000-0000000000d4',
      'c2000000-0000-4000-8000-0000000000d4', 'quota_override', 'transactions', 'x');
    RAISE EXCEPTION 'T-Q5 falhou: INSERT direto em admin_audit passou';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-Q5 ok: direct INSERT em admin_audit negado (42501)';
  END;

  RAISE NOTICE 'T-Q5 ok: get_plan_limit + 42501 sem leitura/escrita direta';
END $$;
ROLLBACK;

-- ============ T-Q9 — limites exatos standard/pro via RPC (A3) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000d4', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000d4","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tx int; v_ac int; v_cc int; v_bd int;
BEGIN
  SELECT max_transactions_month, max_accounts, max_credit_cards, max_budgets
    INTO v_tx, v_ac, v_cc, v_bd FROM public.get_plan_limit('standard');
  IF v_tx <> 500 OR v_ac <> 5 OR v_cc <> 2 OR v_bd <> 10 THEN
    RAISE EXCEPTION 'T-Q9 falhou: get_plan_limit(standard) divergente';
  END IF;

  SELECT max_transactions_month, max_accounts, max_credit_cards, max_budgets
    INTO v_tx, v_ac, v_cc, v_bd FROM public.get_plan_limit('pro');
  IF v_tx <> 5000 OR v_ac <> 10 OR v_cc <> 5 OR v_bd <> 20 THEN
    RAISE EXCEPTION 'T-Q9 falhou: get_plan_limit(pro) divergente';
  END IF;

  RAISE NOTICE 'T-Q9 ok: standard 500·5·2·10 + pro 5000·10·5·20 exatos';
END $$;
ROLLBACK;

-- ============ T-Q6 — free accounts: 2ª passa, 3ª bloqueia (A3) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_count int;
BEGIN
  -- A free já tem 1 conta fixture; 2ª passa, 3ª bloqueia (free contas = 2).
  INSERT INTO public.accounts (user_id, name, type)
  VALUES ('c1000000-0000-4000-8000-0000000000a1', 'T-Q6 conta 2', 'checking');

  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c1000000-0000-4000-8000-0000000000a1', 'T-Q6 conta 3', 'checking');
    RAISE EXCEPTION 'T-Q6 falhou: 3ª conta passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q6 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-accounts-exceeded' THEN
      RAISE EXCEPTION 'T-Q6 falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_count FROM public.accounts
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000a1';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'T-Q6 falhou: contas=% (esperado 2)', v_count;
  END IF;

  RAISE NOTICE 'T-Q6 ok: free max_accounts=2 (2ª passa, 3ª bloqueia)';
END $$;
ROLLBACK;

-- ============ T-Q7 — free credit_cards: 1º passa, 2º bloqueia (A3) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_count int;
BEGIN
  -- A free não tem cartão fixture; 1º passa, 2º bloqueia (free cartões = 1).
  INSERT INTO public.credit_cards (user_id, account_id, name, limit_cents, closing_day, due_day)
  VALUES ('c1000000-0000-4000-8000-0000000000a1',
          'a1000000-0000-4000-8000-000000000001', 'T-Q7 cartao 1', 10000, 5, 10);

  BEGIN
    INSERT INTO public.credit_cards (user_id, account_id, name, limit_cents, closing_day, due_day)
    VALUES ('c1000000-0000-4000-8000-0000000000a1',
            'a1000000-0000-4000-8000-000000000001', 'T-Q7 cartao 2', 10000, 5, 10);
    RAISE EXCEPTION 'T-Q7 falhou: 2º cartão passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q7 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-credit-cards-exceeded' THEN
      RAISE EXCEPTION 'T-Q7 falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_count FROM public.credit_cards
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000a1';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T-Q7 falhou: cartões=% (esperado 1)', v_count;
  END IF;

  RAISE NOTICE 'T-Q7 ok: free max_credit_cards=1 (1º passa, 2º bloqueia)';
END $$;
ROLLBACK;

-- ============ T-Q8 — free budgets: 3º passa, 4º bloqueia (A3) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_count int; v_cat uuid;
BEGIN
  -- A free não tem orçamento fixture; 1º-3º passam, 4º bloqueia (free orçamentos = 3).
  INSERT INTO public.categories (user_id, name, type)
  VALUES ('c1000000-0000-4000-8000-0000000000a1', 'T-Q8 cat', 'expense')
  RETURNING id INTO v_cat;

  INSERT INTO public.budgets (user_id, category_id, month, limit_cents)
  VALUES ('c1000000-0000-4000-8000-0000000000a1', v_cat, DATE '2026-01-01', 1000),
         ('c1000000-0000-4000-8000-0000000000a1', v_cat, DATE '2026-02-01', 1000),
         ('c1000000-0000-4000-8000-0000000000a1', v_cat, DATE '2026-03-01', 1000);

  BEGIN
    INSERT INTO public.budgets (user_id, category_id, month, limit_cents)
    VALUES ('c1000000-0000-4000-8000-0000000000a1', v_cat, DATE '2026-04-01', 1000);
    RAISE EXCEPTION 'T-Q8 falhou: 4º orçamento passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-Q8 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-budgets-exceeded' THEN
      RAISE EXCEPTION 'T-Q8 falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_count FROM public.budgets
  WHERE user_id = 'c1000000-0000-4000-8000-0000000000a1';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T-Q8 falhou: orçamentos=% (esperado 3)', v_count;
  END IF;

  RAISE NOTICE 'T-Q8 ok: free max_budgets=3 (3º passa, 4º bloqueia)';
END $$;
ROLLBACK;

-- ============ Limpeza final (rerun não duplica) ============
DELETE FROM private.plan_quota_overrides
WHERE tenant_id IN (
  'c2000000-0000-4000-8000-0000000000a1',
  'c2000000-0000-4000-8000-0000000000b2',
  'c2000000-0000-4000-8000-0000000000c3',
  'c2000000-0000-4000-8000-0000000000d4'
);

DELETE FROM public.admin_audit
WHERE tenant_id IN (
  'c2000000-0000-4000-8000-0000000000a1',
  'c2000000-0000-4000-8000-0000000000b2',
  'c2000000-0000-4000-8000-0000000000c3',
  'c2000000-0000-4000-8000-0000000000d4'
)
OR target_id IN (
  'c2000000-0000-4000-8000-0000000000a1',
  'c2000000-0000-4000-8000-0000000000b2',
  'c2000000-0000-4000-8000-0000000000c3',
  'c2000000-0000-4000-8000-0000000000d4'
);

ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
SELECT set_config('app.card_purge', 'on', false);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'c1000000-0000-4000-8000-0000000000a1',
  'c1000000-0000-4000-8000-0000000000b2',
  'c1000000-0000-4000-8000-0000000000c3',
  'c1000000-0000-4000-8000-0000000000d4',
  'c1000000-0000-4000-8000-0000000000e5'
);

DELETE FROM auth.users
WHERE id IN (
  'c1000000-0000-4000-8000-0000000000a1',
  'c1000000-0000-4000-8000-0000000000b2',
  'c1000000-0000-4000-8000-0000000000c3',
  'c1000000-0000-4000-8000-0000000000d4',
  'c1000000-0000-4000-8000-0000000000e5'
);

SELECT set_config('app.card_purge', 'off', false);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

DO $$
DECLARE v_users int; v_tenants int;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users WHERE id IN (
    'c1000000-0000-4000-8000-0000000000a1',
    'c1000000-0000-4000-8000-0000000000b2',
    'c1000000-0000-4000-8000-0000000000c3',
    'c1000000-0000-4000-8000-0000000000d4',
    'c1000000-0000-4000-8000-0000000000e5'
  );
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE id IN (
    'c2000000-0000-4000-8000-0000000000a1',
    'c2000000-0000-4000-8000-0000000000b2',
    'c2000000-0000-4000-8000-0000000000c3',
    'c2000000-0000-4000-8000-0000000000d4'
  );
  IF v_users <> 0 OR v_tenants <> 0 THEN
    RAISE EXCEPTION 'T-FIM falhou: fixtures sobreviveram à limpeza (users % tenants %)', v_users, v_tenants;
  END IF;

  RAISE NOTICE 'T-FIM ok: cleanup efetiva, próximo run limpo';
END $$;
