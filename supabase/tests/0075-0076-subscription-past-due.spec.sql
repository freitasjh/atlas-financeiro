-- 0075-0076-subscription-past-due.spec.sql — subscription-access / F6 / ADR-002 §16.1.
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0075-0076-subscription-past-due.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova em banco real (mock não avalia SECURITY DEFINER, search_path, grants,
-- RLS, claims, ordinal de trigger nem transação):
--   T00   estrutura: 1 assinatura por função, prosecdef, provolatile='s',
--         proconfig search_path vazio, proacl sem os 4 papéis; prosrc do guard
--         e da quota SEM `tenant_subscriptions`; prosrc de
--         `resolve_writable_tenant` com `subscription_access` no ORDER BY;
--         `NEW.tenant_id` 1x no guard (só no ramo tenant_members); pg_trigger
--         das 5 tabelas = 5 `aa_` (tgtype 23, sem DELETE) + 5 `plan_quota_*`;
--         quota checa status ANTES de plan_limits/lock/override.
--   T-A10 tabela de decisão A2 (10 chamadas, sempre em {ok,grace,readonly}).
--   T-A1  canceled + INSERT accounts ⇒ subscription-canceled-readonly, 0 linhas.
--   T-A2  past_due graça vencida (−8 d) + INSERT transactions ⇒ rótulo, 0 linhas.
--   T-A2b UPDATE accounts ⇒ mesmo rótulo, valor inalterado.
--   T-A3  past_due em graça ⇒ INSERT passa e cai no tenant gravável (D-1).
--   T-A3b graça vigente + quota estourada ⇒ quota-accounts-exceeded (quota armada).
--   T-A3c graça vencida + quota estourada ⇒ rótulo de status (status vence).
--   T-A3d com `aa_` desligado o rótulo de status sai do enforce_tenant_quota.
--   T-A3e com `aa_` e `plan_quota_*` desligados o INSERT passa (nenhum portão).
--   T-A4  past_due_since IS NULL ⇒ passa (linha 8, O-F6-2).
--   T-A5  negação de status não consome token de override.
--   T-A6  sem linha em tenant_subscriptions ⇒ passa (fail-open declarado).
--   T-A7  UPDATE bloqueado, DELETE permitido (O6 aberta).
--   T-A7b tenant_members decide pelo NEW.tenant_id (graça vencida nega, graça passa).
--   T-A8  os 7 rótulos de quota byte a byte + os 2 rótulos de status.
--   T-A9  owner de tenant vencido + membro de tenant active ⇒ grava no active.
--   T-A9b pin da 0070 continua prevalecendo entre tenants graváveis.
--   T-A11 SQLERRM literal sem PII; nenhum numeric/double precision nas tabelas.
--
-- Rerunnable: fixtures (users c750*) são apagadas no início e no fim; cenários
-- mutáveis vivem em transação com ROLLBACK.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.f6_claims(p_uid uuid, p_role text DEFAULT 'authenticated')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', p_uid::text, false);
  PERFORM pg_catalog.set_config('request.jwt.claim.role', p_role, false);
  PERFORM pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal2')::text, false);
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.f6_claims(uuid, text) TO PUBLIC;

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
BEGIN;
SET LOCAL app.card_purge = 'on';
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM private.plan_quota_overrides
WHERE tenant_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c7500000-0000-4000-8000-0000000000a1', 'c7500000-0000-4000-8000-0000000000b1',
    'c7500000-0000-4000-8000-0000000000c1', 'c7500000-0000-4000-8000-0000000000d1',
    'c7500000-0000-4000-8000-0000000000e1', 'c7500000-0000-4000-8000-0000000000f1',
    'c7500000-0000-4000-8000-0000000000a2', 'c7500000-0000-4000-8000-0000000000b2',
    'c7500000-0000-4000-8000-0000000000c2', 'c7500000-0000-4000-8000-0000000000d2',
    'c7500000-0000-4000-8000-0000000000e2', 'c7500000-0000-4000-8000-0000000000a3',
    'c7500000-0000-4000-8000-0000000000b3'
  )
);
DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c7500000-0000-4000-8000-0000000000a1', 'c7500000-0000-4000-8000-0000000000b1',
    'c7500000-0000-4000-8000-0000000000c1', 'c7500000-0000-4000-8000-0000000000d1',
    'c7500000-0000-4000-8000-0000000000e1', 'c7500000-0000-4000-8000-0000000000f1',
    'c7500000-0000-4000-8000-0000000000a2', 'c7500000-0000-4000-8000-0000000000b2',
    'c7500000-0000-4000-8000-0000000000c2', 'c7500000-0000-4000-8000-0000000000d2',
    'c7500000-0000-4000-8000-0000000000e2', 'c7500000-0000-4000-8000-0000000000a3',
    'c7500000-0000-4000-8000-0000000000b3'
  )
);
DELETE FROM auth.users
WHERE id IN (
  'c7500000-0000-4000-8000-0000000000a1', 'c7500000-0000-4000-8000-0000000000b1',
  'c7500000-0000-4000-8000-0000000000c1', 'c7500000-0000-4000-8000-0000000000d1',
  'c7500000-0000-4000-8000-0000000000e1', 'c7500000-0000-4000-8000-0000000000f1',
  'c7500000-0000-4000-8000-0000000000a2', 'c7500000-0000-4000-8000-0000000000b2',
  'c7500000-0000-4000-8000-0000000000c2', 'c7500000-0000-4000-8000-0000000000d2',
  'c7500000-0000-4000-8000-0000000000e2', 'c7500000-0000-4000-8000-0000000000f2',
  'c7500000-0000-4000-8000-0000000000a3', 'c7500000-0000-4000-8000-0000000000b3'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

INSERT INTO auth.users (id, email) VALUES
  ('c7500000-0000-4000-8000-0000000000a1', 'f6-expired-standard@example.com'),
  ('c7500000-0000-4000-8000-0000000000b1', 'f6-grace-standard@example.com'),
  ('c7500000-0000-4000-8000-0000000000c1', 'f6-expired-full@example.com'),
  ('c7500000-0000-4000-8000-0000000000d1', 'f6-canceled-full@example.com'),
  ('c7500000-0000-4000-8000-0000000000e1', 'f6-null-grace@example.com'),
  ('c7500000-0000-4000-8000-0000000000f1', 'f6-no-subscription@example.com'),
  ('c7500000-0000-4000-8000-0000000000a2', 'f6-decision-table@example.com'),
  ('c7500000-0000-4000-8000-0000000000b2', 'f6-owner-expired@example.com'),
  ('c7500000-0000-4000-8000-0000000000c2', 'f6-active-owner@example.com'),
  ('c7500000-0000-4000-8000-0000000000d2', 'f6-pin-member@example.com'),
  ('c7500000-0000-4000-8000-0000000000e2', 'f6-multi-owner@example.com'),
  ('c7500000-0000-4000-8000-0000000000f2', 'f6-invitee@example.com'),
  ('c7500000-0000-4000-8000-0000000000a3', 'f6-pin-owner-i@example.com'),
  ('c7500000-0000-4000-8000-0000000000b3', 'f6-pin-owner-j@example.com');

-- ============ Fixtures: tenants (RPC atômica como service_role) ============
-- Cada tenant nasce `trial`; o status final vem das assinaturas abaixo.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_case record;
BEGIN
  FOR v_case IN
    SELECT * FROM (VALUES
      ('c7500000-0000-4000-8000-0000000000a1'::uuid, '54100000057', 'F6 Expired Standard', 'standard'),
      ('c7500000-0000-4000-8000-0000000000b1'::uuid, '54100000138', 'F6 Grace Standard', 'standard'),
      ('c7500000-0000-4000-8000-0000000000c1'::uuid, '54100000219', 'F6 Expired Full', 'full'),
      ('c7500000-0000-4000-8000-0000000000d1'::uuid, '54100000308', 'F6 Canceled Full', 'full'),
      ('c7500000-0000-4000-8000-0000000000e1'::uuid, '54100000480', 'F6 Null Grace Full', 'full'),
      ('c7500000-0000-4000-8000-0000000000f1'::uuid, '54100000561', 'F6 No Subscription', 'full'),
      ('c7500000-0000-4000-8000-0000000000a2'::uuid, '54100000642', 'F6 Decision Table', 'standard'),
      ('c7500000-0000-4000-8000-0000000000b2'::uuid, '54100000723', 'F6 Owner Expired', 'full'),
      ('c7500000-0000-4000-8000-0000000000c2'::uuid, '54100000804', 'F6 Active Owner', 'full'),
      ('c7500000-0000-4000-8000-0000000000d2'::uuid, '54100000995', 'F6 Pin Member', 'full'),
      ('c7500000-0000-4000-8000-0000000000e2'::uuid, '54100001029', 'F6 K Expired', 'full'),
      ('c7500000-0000-4000-8000-0000000000e2'::uuid, '54100001100', 'F6 L Grace', 'full'),
      ('c7500000-0000-4000-8000-0000000000a3'::uuid, '54100001371', 'F6 Pin Owner I', 'full'),
      ('c7500000-0000-4000-8000-0000000000b3'::uuid, '54100001452', 'F6 Pin Owner J', 'full')
    ) AS t(uid, doc, razao, plan)
  LOOP
    PERFORM pg_temp.f6_claims(v_case.uid, 'service_role');
    PERFORM public.create_tenant_with_owner_and_acceptance(
      'pf', v_case.doc, v_case.razao, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_case.plan);
  END LOOP;
END $$;
COMMIT;

-- ============ Fixtures: linhas das 5 tabelas (tenant ainda `trial`) ============
-- Tudo como postgres (DBA). As linhas precisam existir ANTES do status final —
-- o cenário real é "o que já estava gravado" sendo negado depois.

-- a1 (standard): 5 contas = quota estourada (max_accounts = 5).
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c7500000-0000-4000-8000-00000000a101', 'c7500000-0000-4000-8000-0000000000a1', 'F6 A1 1', 'checking', 0, 0),
  ('c7500000-0000-4000-8000-00000000a102', 'c7500000-0000-4000-8000-0000000000a1', 'F6 A1 2', 'checking', 0, 0),
  ('c7500000-0000-4000-8000-00000000a103', 'c7500000-0000-4000-8000-0000000000a1', 'F6 A1 3', 'checking', 0, 0),
  ('c7500000-0000-4000-8000-00000000a104', 'c7500000-0000-4000-8000-0000000000a1', 'F6 A1 4', 'checking', 0, 0),
  ('c7500000-0000-4000-8000-00000000a105', 'c7500000-0000-4000-8000-0000000000a1', 'F6 A1 5', 'checking', 0, 0);

-- b1 (standard): 5 contas = quota estourada, mas status em graça vigente.
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c7500000-0000-4000-8000-00000000b101', 'c7500000-0000-4000-8000-0000000000b1', 'F6 B1 1', 'checking', 0, 0),
  ('c7500000-0000-4000-8000-00000000b102', 'c7500000-0000-4000-8000-0000000000b1', 'F6 B1 2', 'checking', 0, 0),
  ('c7500000-0000-4000-8000-00000000b103', 'c7500000-0000-4000-8000-0000000000b1', 'F6 B1 3', 'checking', 0, 0),
  ('c7500000-0000-4000-8000-00000000b104', 'c7500000-0000-4000-8000-0000000000b1', 'F6 B1 4', 'checking', 0, 0),
  ('c7500000-0000-4000-8000-00000000b105', 'c7500000-0000-4000-8000-0000000000b1', 'F6 B1 5', 'checking', 0, 0);

-- c1 (full): 1 conta para o INSERT de transaction de T-A2.
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c7500000-0000-4000-8000-00000000c101', 'c7500000-0000-4000-8000-0000000000c1', 'F6 C1', 'checking', 0, 0);

-- d1 (full, termina canceled): 1 conta para UPDATE/DELETE.
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c7500000-0000-4000-8000-00000000d101', 'c7500000-0000-4000-8000-0000000000d1', 'F6 D1', 'checking', 0, 0);

-- T-A9: b2 é membro do tenant active de c2.
INSERT INTO public.tenant_members (tenant_id, user_id, role)
SELECT t.id, 'c7500000-0000-4000-8000-0000000000b2', 'member'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000c2';

-- T-A9b: d2 é membro de J (b3, mais antiga) e I (a3, mais nova). Sem pin a
-- ordem cairia em J (created_at); com pin em I, o pin vence.
INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at)
SELECT t.id, 'c7500000-0000-4000-8000-0000000000d2', 'member', '2026-01-01T00:00:00Z'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000b3';

INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at)
SELECT t.id, 'c7500000-0000-4000-8000-0000000000d2', 'member', '2026-02-01T00:00:00Z'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000a3';

-- ============ Fixtures: status final via tenant_subscriptions (espelho 0058) ============
INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day, past_due_since)
SELECT t.id, 'standard', 'past_due', 15, pg_catalog.now() - interval '8 days'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000a1';

INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day, past_due_since)
SELECT t.id, 'standard', 'past_due', 15, pg_catalog.now() - interval '3 days'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000b1';

INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day, past_due_since)
SELECT t.id, 'full', 'past_due', 10, pg_catalog.now() - interval '8 days'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000c1';

INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
SELECT t.id, 'full', 'canceled', 10
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000d1';

INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day, past_due_since)
SELECT t.id, 'full', 'past_due', 10, NULL
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000e1';

-- T-A9: G (b2, vencido) e H (c2, active).
INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day, past_due_since)
SELECT t.id, 'full', 'past_due', 10, pg_catalog.now() - interval '8 days'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000b2';

INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
SELECT t.id, 'full', 'active', 10
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000c2';

-- T-A9b: I (a3) e J (b3) graváveis.
INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
SELECT t.id, 'full', 'active', 10
FROM public.tenants AS t
WHERE t.owner_user_id IN (
  'c7500000-0000-4000-8000-0000000000a3',
  'c7500000-0000-4000-8000-0000000000b3'
);

-- T-A7b/T-A3: e2 é owner de K (vencido) e L (graça vigente).
INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day, past_due_since)
SELECT t.id, 'full', 'past_due', 10, pg_catalog.now() - interval '8 days'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000e2'
  AND t.razao_social = 'F6 K Expired';

INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day, past_due_since)
SELECT t.id, 'full', 'past_due', 10, pg_catalog.now() - interval '3 days'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000e2'
  AND t.razao_social = 'F6 L Grace';

-- ============ T00 — estrutura ============
DO $$
DECLARE
  v_proc pg_proc;
  v_n int;
  v_tbl text;
  v_tbls text[] := ARRAY['accounts', 'budgets', 'credit_cards', 'tenant_members', 'transactions'];
  v_src text;
BEGIN
  -- subscription_access: 1 assinatura, DEFINER, STABLE, search_path='', sem grant.
  SELECT count(*) INTO v_n FROM pg_proc WHERE proname = 'subscription_access';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access com % assinaturas', v_n;
  END IF;
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('private.subscription_access(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access sem SECURITY DEFINER';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access nao e STABLE (%)', v_proc.provolatile;
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access sem search_path vazio';
  END IF;
  IF has_function_privilege('authenticated', 'private.subscription_access(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.subscription_access(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.subscription_access(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access executavel por client';
  END IF;
  v_src := v_proc.prosrc;
  IF v_src NOT LIKE '%past_due_since%' OR v_src NOT LIKE '%tenants%' THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access nao le status/past_due_since';
  END IF;
  IF v_src LIKE '%updated_at%' THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access le updated_at (proibido por A1)';
  END IF;
  IF v_src LIKE '%current_user%' THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access usa current_user';
  END IF;

  -- assert_subscription_writable: 1 assinatura, DEFINER, search_path, sem grant.
  SELECT count(*) INTO v_n FROM pg_proc WHERE proname = 'assert_subscription_writable';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0075 T00 falhou: assert_subscription_writable com % assinaturas (overload proibido)', v_n;
  END IF;
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('private.assert_subscription_writable()');
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0075 T00 falhou: assert_subscription_writable sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0075 T00 falhou: assert_subscription_writable sem search_path vazio';
  END IF;
  IF has_function_privilege('authenticated', 'private.assert_subscription_writable()', 'EXECUTE')
     OR has_function_privilege('anon', 'private.assert_subscription_writable()', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.assert_subscription_writable()', 'EXECUTE') THEN
    RAISE EXCEPTION '0075 T00 falhou: assert_subscription_writable executavel por client';
  END IF;
  v_src := v_proc.prosrc;
  IF v_src LIKE '%tenant_subscriptions%' THEN
    RAISE EXCEPTION '0075 T00 falhou: guard referencia tenant_subscriptions (A1 quebrado)';
  END IF;
  IF v_src NOT LIKE '%bool_or%' OR v_src NOT LIKE '%subscription_access%' THEN
    RAISE EXCEPTION '0075 T00 falhou: guard nao decide por conjunto via subscription_access';
  END IF;
  IF v_src NOT LIKE '%subscription-canceled-readonly%'
     OR v_src NOT LIKE '%subscription-past-due-grace-expired%' THEN
    RAISE EXCEPTION '0075 T00 falhou: guard sem os 2 rotulos';
  END IF;
  IF v_src LIKE '%current_user%' THEN
    RAISE EXCEPTION '0075 T00 falhou: guard usa current_user';
  END IF;
  IF (pg_catalog.length(v_src) - pg_catalog.length(pg_catalog.replace(v_src, 'NEW.tenant_id', '')))
     / pg_catalog.length('NEW.tenant_id') <> 1 THEN
    RAISE EXCEPTION '0075 T00 falhou: NEW.tenant_id deveria aparecer 1x (ramo tenant_members)';
  END IF;

  -- enforce_tenant_quota: 1 assinatura, DEFINER, search_path, sem grant.
  SELECT count(*) INTO v_n FROM pg_proc WHERE proname = 'enforce_tenant_quota';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0076 T00 falhou: enforce_tenant_quota com % assinaturas', v_n;
  END IF;
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('public.enforce_tenant_quota()');
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0076 T00 falhou: enforce_tenant_quota sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0076 T00 falhou: enforce_tenant_quota sem search_path vazio';
  END IF;
  IF has_function_privilege('authenticated', 'public.enforce_tenant_quota()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.enforce_tenant_quota()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.enforce_tenant_quota()', 'EXECUTE') THEN
    RAISE EXCEPTION '0076 T00 falhou: enforce_tenant_quota executavel por client';
  END IF;
  v_src := v_proc.prosrc;
  IF v_src LIKE '%tenant_subscriptions%' THEN
    RAISE EXCEPTION '0076 T00 falhou: quota referencia tenant_subscriptions (A1 quebrado)';
  END IF;
  IF v_src NOT LIKE '%subscription_access%' THEN
    RAISE EXCEPTION '0076 T00 falhou: quota nao checa subscription_access';
  END IF;
  IF v_src LIKE '%current_user%' THEN
    RAISE EXCEPTION '0076 T00 falhou: quota usa current_user';
  END IF;
  IF position('quota-tenant-missing' IN v_src) > position('subscription_access' IN v_src) THEN
    RAISE EXCEPTION '0076 T00 falhou: status antes do quota-tenant-missing (ordem A5)';
  END IF;
  IF position('subscription_access' IN v_src) > position('plan_limits' IN v_src) THEN
    RAISE EXCEPTION '0076 T00 falhou: status depois de plan_limits (ordem A5)';
  END IF;
  IF position('subscription_access' IN v_src) > position('pg_advisory_xact_lock' IN v_src) THEN
    RAISE EXCEPTION '0076 T00 falhou: status depois do advisory lock (ordem A5)';
  END IF;
  IF position('subscription_access' IN v_src) > position('plan_quota_overrides' IN v_src) THEN
    RAISE EXCEPTION '0076 T00 falhou: status depois do override (ordem A5)';
  END IF;

  -- resolve_writable_tenant: assinatura intacta + subscription_access no ORDER BY.
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('private.resolve_writable_tenant(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0075 T00 falhou: resolve_writable_tenant ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0075 T00 falhou: resolve_writable_tenant sem SECURITY DEFINER';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION '0075 T00 falhou: resolve_writable_tenant nao e STABLE';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0075 T00 falhou: resolve_writable_tenant sem search_path vazio';
  END IF;
  IF has_function_privilege('authenticated', 'private.resolve_writable_tenant(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.resolve_writable_tenant(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.resolve_writable_tenant(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0075 T00 falhou: resolve_writable_tenant executavel por client';
  END IF;
  v_src := v_proc.prosrc;
  IF v_src LIKE '%tenant_subscriptions%' THEN
    RAISE EXCEPTION '0075 T00 falhou: resolve_writable_tenant referencia tenant_subscriptions';
  END IF;
  IF v_src !~ 'ORDER BY\s*\(private\.subscription_access\(' THEN
    RAISE EXCEPTION '0075 T00 falhou: subscription_access nao e o 1o termo do ORDER BY';
  END IF;

  -- pg_trigger: 5 aa_ (tgtype 23, sem DELETE) + 5 plan_quota_*.
  FOREACH v_tbl IN ARRAY v_tbls
  LOOP
    SELECT count(*) INTO v_n
    FROM pg_trigger
    WHERE tgrelid = pg_catalog.format('%I.%I', 'public', v_tbl)::regclass
      AND tgname = 'aa_subscription_readonly'
      AND NOT tgisinternal
      AND tgtype = 23;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '0075 T00 falhou: aa_subscription_readonly ausente/errado em % (%)', v_tbl, v_n;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_trigger
  WHERE tgname = 'aa_subscription_readonly' AND NOT tgisinternal;
  IF v_n <> 5 THEN
    RAISE EXCEPTION '0075 T00 falhou: % triggers aa_ (esperado 5)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
  WHERE tgname IN ('plan_quota_transactions', 'plan_quota_accounts',
                   'plan_quota_credit_cards', 'plan_quota_budgets',
                   'plan_quota_tenant_members')
    AND NOT tgisinternal;
  IF v_n <> 5 THEN
    RAISE EXCEPTION '0076 T00 falhou: % triggers plan_quota_* (esperado 5)', v_n;
  END IF;

  RAISE NOTICE '0075 T00 ok: 1 assinatura por funcao, DEFINER/STABLE/search_path, sem grant, prosrc e triggers';
END $$;

-- ============ T-A10 — tabela de decisão A2 ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid;
  v_got text;
  v_calls int := 0;
  v_bad int := 0;
BEGIN
  SELECT t.id INTO v_tenant FROM public.tenants AS t
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000a2';

  -- 1) p_tenant IS NULL ⇒ ok (linha 6).
  v_got := private.subscription_access(NULL);
  v_calls := v_calls + 1;
  IF v_got <> 'ok' THEN RAISE EXCEPTION '0075 T-A10 falhou: NULL -> %', v_got; END IF;

  -- 2) UUID inexistente ⇒ ok (fail-open).
  v_got := private.subscription_access('c7500000-0000-4000-8000-00000000dead');
  v_calls := v_calls + 1;
  IF v_got <> 'ok' THEN RAISE EXCEPTION '0075 T-A10 falhou: inexistente -> %', v_got; END IF;

  -- 3) trial sem linha em tenant_subscriptions ⇒ ok (linha 7).
  v_got := private.subscription_access(v_tenant);
  v_calls := v_calls + 1;
  IF v_got <> 'ok' THEN RAISE EXCEPTION '0075 T-A10 falhou: trial sem linha -> %', v_got; END IF;

  -- 4) active ⇒ ok (linha 2).
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant, 'standard', 'active', 15);
  v_got := private.subscription_access(v_tenant);
  v_calls := v_calls + 1;
  IF v_got <> 'ok' THEN RAISE EXCEPTION '0075 T-A10 falhou: active -> %', v_got; END IF;

  -- 5) past_due −6 d 23 h ⇒ grace (linha 3).
  UPDATE public.tenant_subscriptions
  SET status = 'past_due', past_due_since = pg_catalog.now() - interval '6 days 23 hours'
  WHERE tenant_id = v_tenant;
  v_got := private.subscription_access(v_tenant);
  v_calls := v_calls + 1;
  IF v_got <> 'grace' THEN RAISE EXCEPTION '0075 T-A10 falhou: past_due -6d23h -> %', v_got; END IF;

  -- 6) past_due −7 d −1 s ⇒ readonly (fronteira estrita, linha 4).
  UPDATE public.tenant_subscriptions
  SET past_due_since = pg_catalog.now() - interval '7 days' - interval '1 second'
  WHERE tenant_id = v_tenant;
  v_got := private.subscription_access(v_tenant);
  v_calls := v_calls + 1;
  IF v_got <> 'readonly' THEN RAISE EXCEPTION '0075 T-A10 falhou: past_due -7d-1s -> %', v_got; END IF;

  -- 7) past_due + past_due_since IS NULL ⇒ grace (linha 8, O-F6-2).
  UPDATE public.tenant_subscriptions
  SET past_due_since = NULL
  WHERE tenant_id = v_tenant;
  v_got := private.subscription_access(v_tenant);
  v_calls := v_calls + 1;
  IF v_got <> 'grace' THEN RAISE EXCEPTION '0075 T-A10 falhou: past_due NULL -> %', v_got; END IF;

  -- 8) canceled com linha ⇒ readonly (linha 5).
  UPDATE public.tenant_subscriptions
  SET status = 'canceled', past_due_since = NULL
  WHERE tenant_id = v_tenant;
  v_got := private.subscription_access(v_tenant);
  v_calls := v_calls + 1;
  IF v_got <> 'readonly' THEN RAISE EXCEPTION '0075 T-A10 falhou: canceled com linha -> %', v_got; END IF;

  -- 9) canceled SEM linha ⇒ readonly (independente da linha).
  DELETE FROM public.tenant_subscriptions WHERE tenant_id = v_tenant;
  UPDATE public.tenants SET subscription_status = 'canceled' WHERE id = v_tenant;
  v_got := private.subscription_access(v_tenant);
  v_calls := v_calls + 1;
  IF v_got <> 'readonly' THEN RAISE EXCEPTION '0075 T-A10 falhou: canceled sem linha -> %', v_got; END IF;

  -- 10) past_due SEM linha ⇒ grace (precedência da linha 8).
  UPDATE public.tenants SET subscription_status = 'past_due' WHERE id = v_tenant;
  v_got := private.subscription_access(v_tenant);
  v_calls := v_calls + 1;
  IF v_got <> 'grace' THEN RAISE EXCEPTION '0075 T-A10 falhou: past_due sem linha -> %', v_got; END IF;

  -- Nenhum retorno fora de {ok,grace,readonly}.
  SELECT count(*) INTO v_bad
  FROM (VALUES
    (private.subscription_access(NULL)),
    (private.subscription_access('c7500000-0000-4000-8000-00000000dead')),
    (private.subscription_access(v_tenant))
  ) AS r(v)
  WHERE r.v IS NULL OR r.v NOT IN ('ok', 'grace', 'readonly');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '0075 T-A10 falhou: retorno fora do conjunto fechado (%)', v_bad;
  END IF;

  RAISE NOTICE '0075 T-A10 ok: tabela de decisao A2 (% chamadas)', v_calls;
END $$;
ROLLBACK;

-- ============ T-A1 — canceled + INSERT accounts ⇒ rotulo, 0 linhas ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000d1');
DO $$
DECLARE
  v_before int;
  v_after int;
BEGIN
  SELECT count(*) INTO v_before FROM public.accounts
  WHERE user_id = 'c7500000-0000-4000-8000-0000000000d1';
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c7500000-0000-4000-8000-0000000000d1', 'F6 Canceled Insert', 'checking');
    RAISE EXCEPTION '0075 T-A1 falhou: INSERT passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A1 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0075 T-A1 falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_after FROM public.accounts
  WHERE user_id = 'c7500000-0000-4000-8000-0000000000d1';
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0075 T-A1 falhou: linha persistiu (% -> %)', v_before, v_after;
  END IF;
  RAISE NOTICE '0075 T-A1 ok: canceled + INSERT accounts -> subscription-canceled-readonly, 0 linhas';
END $$;
ROLLBACK;

-- ============ T-A2 — past_due graca vencida + INSERT transactions ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000c1');
DO $$
DECLARE
  v_n int;
BEGIN
  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c7500000-0000-4000-8000-0000000000c1',
            'c7500000-0000-4000-8000-00000000c101', 'F6 Past Due Tx', 900, '2026-02-01');
    RAISE EXCEPTION '0075 T-A2 falhou: INSERT passou com graca vencida';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A2 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-past-due-grace-expired' THEN
      RAISE EXCEPTION '0075 T-A2 falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.transactions
  WHERE user_id = 'c7500000-0000-4000-8000-0000000000c1'
    AND description = 'F6 Past Due Tx';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0075 T-A2 falhou: linha persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0075 T-A2 ok: past_due -8d + INSERT transactions -> rotulo, 0 linhas';
END $$;
ROLLBACK;

-- ============ T-A2b — UPDATE accounts em graca vencida ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000c1');
DO $$
DECLARE
  v_name text;
BEGIN
  BEGIN
    UPDATE public.accounts SET name = 'F6 Renomeada'
    WHERE id = 'c7500000-0000-4000-8000-00000000c101';
    RAISE EXCEPTION '0075 T-A2b falhou: UPDATE passou com graca vencida';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A2b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-past-due-grace-expired' THEN
      RAISE EXCEPTION '0075 T-A2b falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT name INTO v_name FROM public.accounts
  WHERE id = 'c7500000-0000-4000-8000-00000000c101';
  IF v_name <> 'F6 C1' THEN
    RAISE EXCEPTION '0075 T-A2b falhou: valor alterado (%)', v_name;
  END IF;
  RAISE NOTICE '0075 T-A2b ok: UPDATE accounts negado, valor intacto';
END $$;
ROLLBACK;

-- ============ T-A3 — past_due em graca ⇒ passa e cai no tenant gravavel ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000e2');
DO $$
DECLARE
  v_grace uuid;
  v_got uuid;
BEGIN
  SELECT t.id INTO v_grace FROM public.tenants AS t
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000e2'
    AND t.razao_social = 'F6 L Grace';

  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('c7500000-0000-4000-8000-00000000e201', 'c7500000-0000-4000-8000-0000000000e2',
          'F6 Grace Insert', 'checking');

  SELECT tenant_id INTO v_got FROM public.accounts
  WHERE id = 'c7500000-0000-4000-8000-00000000e201';
  IF v_got IS DISTINCT FROM v_grace THEN
    RAISE EXCEPTION '0075 T-A3 falhou: linha caiu em % (esperado grace %)', v_got, v_grace;
  END IF;
  RAISE NOTICE '0075 T-A3 ok: graca vigente grava e cai no tenant gravavel (D-1)';
END $$;
ROLLBACK;

-- ============ T-A3b — graca vigente + quota estourada ⇒ rotulo de quota ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000b1');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c7500000-0000-4000-8000-0000000000b1', 'F6 B1 Over', 'checking');
    RAISE EXCEPTION '0075 T-A3b falhou: INSERT passou com quota estourada';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A3b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-accounts-exceeded' THEN
      RAISE EXCEPTION '0075 T-A3b falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0075 T-A3b ok: graca vigente + quota estourada -> quota-accounts-exceeded (quota armada)';
END $$;
ROLLBACK;

-- ============ T-A3c — graca vencida + quota estourada ⇒ status vence ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000a1');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c7500000-0000-4000-8000-0000000000a1', 'F6 A1 Over', 'checking');
    RAISE EXCEPTION '0075 T-A3c falhou: INSERT passou (status + quota)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A3c falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-past-due-grace-expired' THEN
      RAISE EXCEPTION '0075 T-A3c falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0075 T-A3c ok: status vence a quota quando ambos negariam';
END $$;
ROLLBACK;

-- ============ T-A5 — negacao de status nao consome token de override ============
BEGIN;
INSERT INTO private.plan_quota_overrides (tenant_id, resource_type)
SELECT t.id, 'accounts' FROM public.tenants AS t
WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000a1';

SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000a1');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c7500000-0000-4000-8000-0000000000a1', 'F6 A1 Token', 'checking');
    RAISE EXCEPTION '0075 T-A5 falhou: INSERT passou (deveria negar por status)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A5 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-past-due-grace-expired' THEN
      RAISE EXCEPTION '0075 T-A5 falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_pending int;
  v_consumed int;
BEGIN
  SELECT count(*) FILTER (WHERE o.consumed_at IS NULL),
         count(*) FILTER (WHERE o.consumed_at IS NOT NULL)
    INTO v_pending, v_consumed
  FROM private.plan_quota_overrides AS o
  JOIN public.tenants AS t ON t.id = o.tenant_id
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000a1';

  IF v_pending <> 1 THEN
    RAISE EXCEPTION '0075 T-A5 falhou: token deveria seguir pendente (%)', v_pending;
  END IF;
  IF v_consumed <> 0 THEN
    RAISE EXCEPTION '0075 T-A5 falhou: token consumido por negacao de status (%)', v_consumed;
  END IF;
  RAISE NOTICE '0075 T-A5 ok: rotulo de status sem consumir token de override';
END $$;
ROLLBACK;

-- ============ T-A3d — defesa em profundidade: sem aa_ o 0076 nega ============
BEGIN;
ALTER TABLE public.accounts DISABLE TRIGGER aa_subscription_readonly;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000a1');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c7500000-0000-4000-8000-0000000000a1', 'F6 A1 Dfd', 'checking');
    RAISE EXCEPTION '0075 T-A3d falhou: INSERT passou com aa_ desligado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A3d falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-past-due-grace-expired' THEN
      RAISE EXCEPTION '0075 T-A3d falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0075 T-A3d ok: com aa_ desligado o rotulo de status sai do enforce_tenant_quota';
END $$;
RESET ROLE;
ALTER TABLE public.accounts ENABLE TRIGGER aa_subscription_readonly;
ROLLBACK;

-- ============ T-A3e — sem portao nenhum o INSERT passa ============
BEGIN;
ALTER TABLE public.accounts DISABLE TRIGGER aa_subscription_readonly;
ALTER TABLE public.accounts DISABLE TRIGGER plan_quota_accounts;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000a1');
DO $$
DECLARE
  v_n int;
BEGIN
  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('c7500000-0000-4000-8000-00000000a1ff', 'c7500000-0000-4000-8000-0000000000a1',
          'F6 A1 NoGate', 'checking');
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE id = 'c7500000-0000-4000-8000-00000000a1ff';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0075 T-A3e falhou: linha nao persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0075 T-A3e ok: com os 2 portoes desligados o INSERT passa (negacao vem dos triggers)';
END $$;
RESET ROLE;
ALTER TABLE public.accounts ENABLE TRIGGER plan_quota_accounts;
ALTER TABLE public.accounts ENABLE TRIGGER aa_subscription_readonly;
ROLLBACK;

-- ============ T-A4 — past_due_since IS NULL ⇒ passa (linha 8) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000e1');
DO $$
DECLARE
  v_n int;
BEGIN
  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('c7500000-0000-4000-8000-00000000e101', 'c7500000-0000-4000-8000-0000000000e1',
          'F6 Null Grace Insert', 'checking');
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE id = 'c7500000-0000-4000-8000-00000000e101';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0075 T-A4 falhou: linha nao persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0075 T-A4 ok: past_due_since IS NULL -> escrita permitida';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF private.subscription_access(
       (SELECT id FROM public.tenants WHERE owner_user_id = 'c7500000-0000-4000-8000-0000000000e1')
     ) <> 'grace' THEN
    RAISE EXCEPTION '0075 T-A4 falhou: past_due_since NULL deveria ser grace';
  END IF;
  RAISE NOTICE '0075 T-A4 ok: past_due_since IS NULL -> grace (linha 8, O-F6-2)';
END $$;
ROLLBACK;

-- ============ T-A6 — sem linha em tenant_subscriptions ⇒ passa ============
BEGIN;
DO $$
DECLARE
  v_n int;
  v_tenant uuid;
BEGIN
  SELECT t.id INTO v_tenant FROM public.tenants AS t
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000f1';
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions WHERE tenant_id = v_tenant;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0075 T-A6 falhou: fixture deveria estar sem linha de assinatura (%)', v_n;
  END IF;
END $$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000f1');
DO $$
DECLARE
  v_n int;
BEGIN
  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('c7500000-0000-4000-8000-00000000f101', 'c7500000-0000-4000-8000-0000000000f1',
          'F6 No Subscription Insert', 'checking');
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE id = 'c7500000-0000-4000-8000-00000000f101';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0075 T-A6 falhou: linha nao persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0075 T-A6 ok: sem linha em tenant_subscriptions -> escrita permitida (fail-open declarado)';
END $$;
ROLLBACK;

-- ============ T-A7 — UPDATE bloqueado, DELETE permitido ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000d1');
DO $$
DECLARE
  v_n int;
BEGIN
  BEGIN
    UPDATE public.accounts SET name = 'F6 D1 Renomeada'
    WHERE id = 'c7500000-0000-4000-8000-00000000d101';
    RAISE EXCEPTION '0075 T-A7 falhou: UPDATE passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A7 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0075 T-A7 falhou: rotulo errado no UPDATE (%)', SQLERRM;
    END IF;
  END;

  DELETE FROM public.accounts WHERE id = 'c7500000-0000-4000-8000-00000000d101';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0075 T-A7 falhou: DELETE bloqueado (%)', v_n;
  END IF;
  RAISE NOTICE '0075 T-A7 ok: UPDATE negado, DELETE permitido (O6 aberta)';
END $$;
ROLLBACK;

-- ============ T-A7b — tenant_members decide pelo NEW.tenant_id ============
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000f2', 'service_role');
DO $$
DECLARE
  v_k uuid;
  v_l uuid;
  v_n int;
BEGIN
  SELECT t.id INTO v_k FROM public.tenants AS t
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000e2'
    AND t.razao_social = 'F6 K Expired';
  SELECT t.id INTO v_l FROM public.tenants AS t
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000e2'
    AND t.razao_social = 'F6 L Grace';

  -- Convite em tenant com graca vencida ⇒ rotulo de status daquele tenant.
  BEGIN
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_k, 'c7500000-0000-4000-8000-0000000000f2', 'member');
    RAISE EXCEPTION '0075 T-A7b falhou: membership aceita em tenant vencido';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0075 T-A7b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-past-due-grace-expired' THEN
      RAISE EXCEPTION '0075 T-A7b falhou: rotulo errado no convite (%)', SQLERRM;
    END IF;
  END;

  -- Convite em tenant em graca ⇒ passa.
  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (v_l, 'c7500000-0000-4000-8000-0000000000f2', 'member');
  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = v_l AND user_id = 'c7500000-0000-4000-8000-0000000000f2';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0075 T-A7b falhou: membership em graca nao persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0075 T-A7b ok: tenant_members decide por NEW.tenant_id (vencido nega, graca passa)';
END $$;
ROLLBACK;

-- ============ T-A8 — rotulos byte a byte ============
DO $$
DECLARE
  v_src text;
  v_label text;
  v_labels text[] := ARRAY[
    'quota-transactions-exceeded', 'quota-accounts-exceeded', 'quota-credit-cards-exceeded',
    'quota-budgets-exceeded', 'quota-members-exceeded', 'quota-tenant-missing',
    'plan-limits-missing'
  ];
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.enforce_tenant_quota()');
  FOREACH v_label IN ARRAY v_labels
  LOOP
    IF position(v_label IN v_src) = 0 THEN
      RAISE EXCEPTION '0076 T-A8 falhou: rotulo de quota ausente (%)', v_label;
    END IF;
  END LOOP;
  IF position('subscription-past-due-grace-expired' IN v_src) = 0
     OR position('subscription-canceled-readonly' IN v_src) = 0 THEN
    RAISE EXCEPTION '0076 T-A8 falhou: quota sem os 2 rotulos de status';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('private.assert_subscription_writable()');
  IF position('subscription-past-due-grace-expired' IN v_src) = 0
     OR position('subscription-canceled-readonly' IN v_src) = 0 THEN
    RAISE EXCEPTION '0075 T-A8 falhou: guard sem os 2 rotulos de status';
  END IF;
  RAISE NOTICE '0075 T-A8 ok: 7 rotulos de quota e 2 de status byte a byte';
END $$;

-- ============ T-A9 — D-1: owner vencido + membro active ⇒ grava no active ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000b2');
DO $$
DECLARE
  v_active uuid;
  v_got uuid;
BEGIN
  SELECT t.id INTO v_active FROM public.tenants AS t
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000c2';

  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('c7500000-0000-4000-8000-00000000b201', 'c7500000-0000-4000-8000-0000000000b2',
          'F6 Cross Tenant Insert', 'checking');

  SELECT tenant_id INTO v_got FROM public.accounts
  WHERE id = 'c7500000-0000-4000-8000-00000000b201';
  IF v_got IS DISTINCT FROM v_active THEN
    RAISE EXCEPTION '0075 T-A9 falhou: linha caiu em % (esperado active %)', v_got, v_active;
  END IF;
  RAISE NOTICE '0075 T-A9 ok: owner vencido + membro active -> linha no tenant active (D-1)';
END $$;
ROLLBACK;

-- ============ T-A9b — pin da 0070 prevalece entre tenants gravaveis ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.f6_claims('c7500000-0000-4000-8000-0000000000d2');
DO $$
DECLARE
  v_i uuid;
  v_j uuid;
  v_got uuid;
BEGIN
  SELECT t.id INTO v_i FROM public.tenants AS t
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000a3';
  SELECT t.id INTO v_j FROM public.tenants AS t
  WHERE t.owner_user_id = 'c7500000-0000-4000-8000-0000000000b3';

  PERFORM public.switch_tenant(v_i);
  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('c7500000-0000-4000-8000-00000000d201', 'c7500000-0000-4000-8000-0000000000d2',
          'F6 Pin I', 'checking');
  SELECT tenant_id INTO v_got FROM public.accounts
  WHERE id = 'c7500000-0000-4000-8000-00000000d201';
  IF v_got IS DISTINCT FROM v_i THEN
    RAISE EXCEPTION '0075 T-A9b falhou: pin I ignorado (%)', v_got;
  END IF;

  PERFORM public.switch_tenant(v_j);
  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('c7500000-0000-4000-8000-00000000d202', 'c7500000-0000-4000-8000-0000000000d2',
          'F6 Pin J', 'checking');
  SELECT tenant_id INTO v_got FROM public.accounts
  WHERE id = 'c7500000-0000-4000-8000-00000000d202';
  IF v_got IS DISTINCT FROM v_j THEN
    RAISE EXCEPTION '0075 T-A9b falhou: pin J ignorado (%)', v_got;
  END IF;
  RAISE NOTICE '0075 T-A9b ok: pin da 0070 prevalece entre tenants gravaveis';
END $$;
ROLLBACK;

-- ============ T-A11 — SQLERRM literal sem PII; sem numeric/float ============
DO $$
DECLARE
  v_n int;
  v_err text;
BEGIN
  BEGIN
    PERFORM private.assert_subscription_writable();
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  -- Chamada sem contexto de trigger não deve chegar ao RAISE; se chegou, o
  -- rótulo tem de ser literal. O foco aqui é a ausência de PII nas mensagens.
  IF v_err IS NOT NULL THEN
    IF v_err ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' THEN
      RAISE EXCEPTION '0075 T-A11 falhou: mensagem contem UUID (%)', v_err;
    END IF;
    IF v_err LIKE '%@%' THEN
      RAISE EXCEPTION '0075 T-A11 falhou: mensagem contem e-mail (%)', v_err;
    END IF;
  END IF;

  SELECT count(*) INTO v_n
  FROM information_schema.columns AS c
  WHERE c.table_schema = 'public'
    AND c.table_name IN ('accounts', 'transactions', 'credit_cards', 'budgets', 'tenant_members')
    AND c.data_type IN ('numeric', 'double precision', 'real');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0075 T-A11 falhou: % colunas numeric/float nas tabelas tocadas', v_n;
  END IF;
  RAISE NOTICE '0075 T-A11 ok: sem PII nas mensagens e sem numeric/double precision';
END $$;

-- ============ Fixtures cleanup (fim) ============
BEGIN;
SET LOCAL app.card_purge = 'on';
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM private.plan_quota_overrides
WHERE tenant_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c7500000-0000-4000-8000-0000000000a1', 'c7500000-0000-4000-8000-0000000000b1',
    'c7500000-0000-4000-8000-0000000000c1', 'c7500000-0000-4000-8000-0000000000d1',
    'c7500000-0000-4000-8000-0000000000e1', 'c7500000-0000-4000-8000-0000000000f1',
    'c7500000-0000-4000-8000-0000000000a2', 'c7500000-0000-4000-8000-0000000000b2',
    'c7500000-0000-4000-8000-0000000000c2', 'c7500000-0000-4000-8000-0000000000d2',
    'c7500000-0000-4000-8000-0000000000e2', 'c7500000-0000-4000-8000-0000000000a3',
    'c7500000-0000-4000-8000-0000000000b3'
  )
);
DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c7500000-0000-4000-8000-0000000000a1', 'c7500000-0000-4000-8000-0000000000b1',
    'c7500000-0000-4000-8000-0000000000c1', 'c7500000-0000-4000-8000-0000000000d1',
    'c7500000-0000-4000-8000-0000000000e1', 'c7500000-0000-4000-8000-0000000000f1',
    'c7500000-0000-4000-8000-0000000000a2', 'c7500000-0000-4000-8000-0000000000b2',
    'c7500000-0000-4000-8000-0000000000c2', 'c7500000-0000-4000-8000-0000000000d2',
    'c7500000-0000-4000-8000-0000000000e2', 'c7500000-0000-4000-8000-0000000000a3',
    'c7500000-0000-4000-8000-0000000000b3'
  )
);
DELETE FROM auth.users
WHERE id IN (
  'c7500000-0000-4000-8000-0000000000a1', 'c7500000-0000-4000-8000-0000000000b1',
  'c7500000-0000-4000-8000-0000000000c1', 'c7500000-0000-4000-8000-0000000000d1',
  'c7500000-0000-4000-8000-0000000000e1', 'c7500000-0000-4000-8000-0000000000f1',
  'c7500000-0000-4000-8000-0000000000a2', 'c7500000-0000-4000-8000-0000000000b2',
  'c7500000-0000-4000-8000-0000000000c2', 'c7500000-0000-4000-8000-0000000000d2',
  'c7500000-0000-4000-8000-0000000000e2', 'c7500000-0000-4000-8000-0000000000f2',
  'c7500000-0000-4000-8000-0000000000a3', 'c7500000-0000-4000-8000-0000000000b3'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

\echo '0075-0076 subscription-past-due: OK'
