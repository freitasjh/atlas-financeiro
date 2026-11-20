-- 0046-accounts-default-rpc.spec.sql — troca de conta principal atômica (RPC).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0046-accounts-default-rpc.spec.sql
-- Prova em banco real (mock não avalia grant, SECURITY DEFINER nem índice):
--   T0 estrutura: `set_default_account(uuid)` existe, SECURITY DEFINER,
--      search_path fixo, EXECUTE para authenticated e negado a anon/PUBLIC.
--   T1 authenticated: promover B desmarca A na MESMA transação — sobra
--      exatamente 1 principal (nunca 0, nunca 2).
--   T1b idempotente: promover a conta que já é principal não levanta erro.
--   T2 conta de outro tenant → rótulo fixo 'account-not-found' e ZERO escrita.
--   T3 anon → 42501 (sem EXECUTE).
--   T4 uuid inexistente → 'account-not-found' sem escrita.
-- Rerunnable: fixtures (users a646*, contas e646*) apagadas no início e no fim.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (postgres bypassa RLS; fixture de teste) ============

BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'a6460000-0000-4000-8000-0000000000a1',
  'a6460000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;


INSERT INTO auth.users (id, email) VALUES
  ('a6460000-0000-4000-8000-0000000000a1', 'default-rpc-a@example.com'),
  ('a6460000-0000-4000-8000-0000000000b1', 'default-rpc-b@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['a6460000-0000-4000-8000-0000000000a1'::uuid, 'a6460000-0000-4000-8000-0000000000b1'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600002000 + v_i)::text, 11, '0'),
            'Fixture 0046', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type, is_default) VALUES
  ('e6460000-0000-4000-8000-0000000000a1', 'a6460000-0000-4000-8000-0000000000a1', 'Conta A1', 'checking', true),
  ('e6460000-0000-4000-8000-0000000000a2', 'a6460000-0000-4000-8000-0000000000a1', 'Conta A2', 'savings', false),
  ('e6460000-0000-4000-8000-0000000000a3', 'a6460000-0000-4000-8000-0000000000a1', 'Conta A3', 'physical_cash', false),
  ('e6460000-0000-4000-8000-0000000000b1', 'a6460000-0000-4000-8000-0000000000b1', 'Conta B1', 'checking', true);

-- ============ T0 — estrutura: SECURITY DEFINER + search_path + ACL ============

DO $$
DECLARE
  v_proc pg_proc;
BEGIN
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('public.set_default_account(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0046 T0 falhou: public.set_default_account(uuid) ausente';
  END IF;

  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0046 T0 falhou: set_default_account sem SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM unnest(coalesce(v_proc.proconfig, '{}')) AS c
    WHERE c LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION '0046 T0 falhou: set_default_account sem search_path fixo';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.set_default_account(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0046 T0 falhou: authenticated sem EXECUTE';
  END IF;

  IF has_function_privilege('anon', 'public.set_default_account(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0046 T0 falhou: anon com EXECUTE (deveria ser negado)';
  END IF;

  RAISE NOTICE '0046 T0 ok: RPC DEFINER, search_path fixo, EXECUTE só authenticated';
END $$;

-- ============ T1 — promover B desmarca A atomicamente ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6460000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

DO $$
DECLARE v_defaults int; v_name text;
BEGIN
  PERFORM public.set_default_account('e6460000-0000-4000-8000-0000000000a2');

  SELECT count(*) INTO v_defaults
  FROM public.accounts
  WHERE user_id = 'a6460000-0000-4000-8000-0000000000a1' AND is_default;

  IF v_defaults <> 1 THEN
    RAISE EXCEPTION '0046 T1 falhou: principais=% após promover (esperado 1)', v_defaults;
  END IF;

  SELECT name INTO v_name
  FROM public.accounts
  WHERE user_id = 'a6460000-0000-4000-8000-0000000000a1' AND is_default;

  IF v_name <> 'Conta A2' THEN
    RAISE EXCEPTION '0046 T1 falhou: principal=% (esperado Conta A2)', v_name;
  END IF;

  RAISE NOTICE '0046 T1 ok: promoção desmarca a anterior na mesma transação';
END $$;

-- ============ T1b — idempotente ============

DO $$
BEGIN
  PERFORM public.set_default_account('e6460000-0000-4000-8000-0000000000a2');

  IF (SELECT count(*) FROM public.accounts
      WHERE user_id = 'a6460000-0000-4000-8000-0000000000a1' AND is_default) <> 1 THEN
    RAISE EXCEPTION '0046 T1b falhou: idempotência quebrou a invariante de 1 principal';
  END IF;

  RAISE NOTICE '0046 T1b ok: repetir a promoção não levanta erro';
END $$;

-- ============ T2 — conta de outro tenant: rótulo fixo, zero escrita ============

DO $$
DECLARE v_defaults int;
BEGIN
  BEGIN
    PERFORM public.set_default_account('e6460000-0000-4000-8000-0000000000b1');
    RAISE EXCEPTION '0046 T2 falhou: promoveu conta de outro tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'account-not-found' THEN
      RAISE EXCEPTION '0046 T2 falhou: rótulo=% (esperado account-not-found)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_defaults
  FROM public.accounts
  WHERE user_id = 'a6460000-0000-4000-8000-0000000000a1' AND is_default;
  IF v_defaults <> 1 THEN
    RAISE EXCEPTION '0046 T2 falhou: escrita parcial (principais=%)', v_defaults;
  END IF;

  RAISE NOTICE '0046 T2 ok: conta alheia recusada sem tocar no estado';
END $$;

-- ============ T4 — uuid inexistente ============

DO $$
BEGIN
  BEGIN
    PERFORM public.set_default_account('e6460000-0000-4000-8000-0000000000ff');
    RAISE EXCEPTION '0046 T4 falhou: aceitou conta inexistente';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'account-not-found' THEN
      RAISE EXCEPTION '0046 T4 falhou: rótulo=% (esperado account-not-found)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE '0046 T4 ok: conta inexistente recusada';
END $$;

RESET ROLE;

-- ============ T3 — anon não executa ============

BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claim.role', 'anon', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.set_default_account('e6460000-0000-4000-8000-0000000000a3');
    RAISE EXCEPTION '0046 T3 falhou: anon executou set_default_account';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '0046 T3 ok: anon → 42501';
  END;
END $$;

RESET ROLE;
ROLLBACK;

-- Estado final preservado (A2 continua principal após os erros).
DO $$
BEGIN
  IF (SELECT name FROM public.accounts
      WHERE user_id = 'a6460000-0000-4000-8000-0000000000a1' AND is_default) <> 'Conta A2' THEN
    RAISE EXCEPTION '0046 final falhou: principal mudou após chamadas recusadas';
  END IF;
  RAISE NOTICE '0046 ok: estado final preservado';
END $$;

-- Fixtures cleanup (fim)
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'a6460000-0000-4000-8000-0000000000a1',
  'a6460000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;


\echo '0046-accounts-default-rpc.spec.sql: OK'
