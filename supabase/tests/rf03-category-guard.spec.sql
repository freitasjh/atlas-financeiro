-- rf03-category-guard.spec.sql — QA-DRAWER-02 (0021).
-- Uso (a partir da raiz do repo): supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rf03-category-guard.spec.sql
-- Prova o fecho da classe "cross-tenant de categoria por escrita direta":
--   T1 INSERT com categoria do próprio tenant → permitido
--   T2 INSERT com categoria de outro tenant → category-tenant-mismatch; nada gravado
--   T3 INSERT com category_id NULL → permitido (categoria é opcional)
--   T4 INSERT com categoria inexistente → category-tenant-mismatch (mensagem fixa)
--   T5 UPDATE para categoria de outro tenant → category-tenant-mismatch; vínculo intacto
--   T6 UPDATE para outra categoria do próprio tenant → permitido
--   T7 reexecução da migration não duplica o trigger e mantém SECURITY DEFINER
--   T8 GUC administrativo app.card_purge='on' libera a checagem (manutenção)
--
-- Rerunnable: fixtures apagadas no início com o GUC de purge.

-- ============ Fixtures (como postgres, RLS bypass) ============

SELECT set_config('app.card_purge', 'on', false);
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'cccc0000-0000-4000-8000-0000000000a1',
  'cccc0000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

SELECT set_config('app.card_purge', 'off', false);

INSERT INTO auth.users (id, email) VALUES
  ('cccc0000-0000-4000-8000-0000000000a1', 'qadrawer02-a@example.com'),
  ('cccc0000-0000-4000-8000-0000000000b1', 'qadrawer02-b@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['cccc0000-0000-4000-8000-0000000000a1'::uuid, 'cccc0000-0000-4000-8000-0000000000b1'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600005000 + v_i)::text, 11, '0'),
            'Fixture rf03', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('cc000000-0000-4000-8000-0000000000a1', 'cccc0000-0000-4000-8000-0000000000a1', 'Conta A', 'checking', 0, 0),
  ('cc000000-0000-4000-8000-0000000000a2', 'cccc0000-0000-4000-8000-0000000000b1', 'Conta B', 'checking', 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.categories (id, user_id, name, type) VALUES
  ('cc000000-0000-4000-8000-0000000000c1', 'cccc0000-0000-4000-8000-0000000000a1', 'Mercado A', 'expense'),
  ('cc000000-0000-4000-8000-0000000000c2', 'cccc0000-0000-4000-8000-0000000000a1', 'Farmácia A', 'expense'),
  ('cc000000-0000-4000-8000-0000000000c3', 'cccc0000-0000-4000-8000-0000000000b1', 'Mercado B', 'expense')
ON CONFLICT (id) DO NOTHING;

-- ============ T7 (parte 1): reexecutar a migration não duplica trigger ============

\ir ../migrations/0021_transaction_category_guard.sql
\ir ../migrations/0021_transaction_category_guard.sql

DO $$
DECLARE
  v_triggers int;
  v_security_definer boolean;
  v_search_path text;
BEGIN
  SELECT count(*) INTO v_triggers
  FROM pg_trigger
  WHERE tgrelid = 'public.transactions'::regclass
    AND tgname = 'transactions_category_guard'
    AND NOT tgisinternal;

  IF v_triggers <> 1 THEN
    RAISE EXCEPTION 'qadrawer02 T7 falhou: trigger duplicado/ausente (count=%)', v_triggers;
  END IF;

  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
  INTO v_security_definer, v_search_path
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'transactions_category_guard';

  IF v_security_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'qadrawer02 T7 falhou: função sem SECURITY DEFINER';
  END IF;

  IF v_search_path IS NULL OR v_search_path NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'qadrawer02 T7 falhou: search_path fixo ausente (%)', coalesce(v_search_path, 'NULL');
  END IF;

  RAISE NOTICE 'qadrawer02 T7 ok: reexecução idempotente (1 trigger, SECURITY DEFINER, search_path=public)';
END $$;

-- ============ Escrita como tenant A ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'cccc0000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"cccc0000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);

-- ============ T1: categoria do próprio tenant é aceita ============

INSERT INTO public.transactions (id, user_id, account_id, category_id, description, amount_cents, date, type)
VALUES (
  'cc000000-0000-4000-8000-0000000000d1',
  'cccc0000-0000-4000-8000-0000000000a1',
  'cc000000-0000-4000-8000-0000000000a1',
  'cc000000-0000-4000-8000-0000000000c1',
  'Compra A com categoria A',
  1000,
  '2026-09-02',
  'expense'
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE id = 'cc000000-0000-4000-8000-0000000000d1') THEN
    RAISE EXCEPTION 'qadrawer02 T1 falhou: insert legítimo não gravou';
  END IF;
  RAISE NOTICE 'qadrawer02 T1 ok: categoria do próprio tenant aceita';
END $$;

-- ============ T2: categoria de OUTRO tenant é recusada ============

DO $$
DECLARE
  v_err text;
BEGIN
  BEGIN
    INSERT INTO public.transactions (id, user_id, account_id, category_id, description, amount_cents, date, type)
    VALUES (
      'cc000000-0000-4000-8000-0000000000d2',
      'cccc0000-0000-4000-8000-0000000000a1',
      'cc000000-0000-4000-8000-0000000000a1',
      'cc000000-0000-4000-8000-0000000000c3',
      'Cross-tenant probe',
      1000,
      '2026-09-03',
      'expense'
    );
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%category-tenant-mismatch%' THEN
    RAISE EXCEPTION 'qadrawer02 T2 falhou: categoria alheia devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  IF EXISTS (SELECT 1 FROM public.transactions WHERE id = 'cc000000-0000-4000-8000-0000000000d2') THEN
    RAISE EXCEPTION 'qadrawer02 T2 falhou: linha cross-tenant foi gravada';
  END IF;

  RAISE NOTICE 'qadrawer02 T2 ok: categoria de outro tenant recusada e nada gravado';
END $$;

-- ============ T3: category_id NULL é permitido ============

INSERT INTO public.transactions (id, user_id, account_id, category_id, description, amount_cents, date, type)
VALUES (
  'cc000000-0000-4000-8000-0000000000d3',
  'cccc0000-0000-4000-8000-0000000000a1',
  'cc000000-0000-4000-8000-0000000000a1',
  NULL,
  'Compra sem categoria',
  500,
  '2026-09-04',
  'expense'
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE id = 'cc000000-0000-4000-8000-0000000000d3') THEN
    RAISE EXCEPTION 'qadrawer02 T3 falhou: insert sem categoria não gravou';
  END IF;
  RAISE NOTICE 'qadrawer02 T3 ok: category_id NULL permitido';
END $$;

-- ============ T4: categoria inexistente tem a mesma recusa tipada ============

DO $$
DECLARE
  v_err text;
BEGIN
  BEGIN
    INSERT INTO public.transactions (id, user_id, account_id, category_id, description, amount_cents, date, type)
    VALUES (
      'cc000000-0000-4000-8000-0000000000d4',
      'cccc0000-0000-4000-8000-0000000000a1',
      'cc000000-0000-4000-8000-0000000000a1',
      'cc000000-0000-4000-8000-0000000000ff',
      'Categoria inexistente',
      500,
      '2026-09-05',
      'expense'
    );
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%category-tenant-mismatch%' THEN
    RAISE EXCEPTION 'qadrawer02 T4 falhou: categoria inexistente devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  RAISE NOTICE 'qadrawer02 T4 ok: categoria inexistente recusada com mensagem fixa';
END $$;

-- ============ T5: UPDATE para categoria alheia é recusado ============

DO $$
DECLARE
  v_err text;
  v_category uuid;
BEGIN
  BEGIN
    UPDATE public.transactions
    SET category_id = 'cc000000-0000-4000-8000-0000000000c3'
    WHERE id = 'cc000000-0000-4000-8000-0000000000d1';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%category-tenant-mismatch%' THEN
    RAISE EXCEPTION 'qadrawer02 T5 falhou: UPDATE cross-tenant devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  SELECT category_id INTO v_category
  FROM public.transactions WHERE id = 'cc000000-0000-4000-8000-0000000000d1';

  IF v_category IS DISTINCT FROM 'cc000000-0000-4000-8000-0000000000c1'::uuid THEN
    RAISE EXCEPTION 'qadrawer02 T5 falhou: categoria mudou apesar do guard (%)', coalesce(v_category::text, 'NULL');
  END IF;

  RAISE NOTICE 'qadrawer02 T5 ok: UPDATE para categoria alheia negado e vínculo intacto';
END $$;

-- ============ T6: UPDATE para categoria do próprio tenant é permitido ============

UPDATE public.transactions
SET category_id = 'cc000000-0000-4000-8000-0000000000c2'
WHERE id = 'cc000000-0000-4000-8000-0000000000d1';

DO $$
DECLARE
  v_category uuid;
BEGIN
  SELECT category_id INTO v_category
  FROM public.transactions WHERE id = 'cc000000-0000-4000-8000-0000000000d1';

  IF v_category IS DISTINCT FROM 'cc000000-0000-4000-8000-0000000000c2'::uuid THEN
    RAISE EXCEPTION 'qadrawer02 T6 falhou: troca legítima de categoria não gravou (%)', coalesce(v_category::text, 'NULL');
  END IF;

  RAISE NOTICE 'qadrawer02 T6 ok: UPDATE para categoria do próprio tenant permitido';
END $$;

-- ============ T8: GUC administrativo libera a checagem ============

DO $$
DECLARE
  v_err text;
BEGIN
  BEGIN
    PERFORM set_config('app.card_purge', 'on', true);
    UPDATE public.transactions
    SET category_id = 'cc000000-0000-4000-8000-0000000000c3'
    WHERE id = 'cc000000-0000-4000-8000-0000000000d1';
    PERFORM set_config('app.card_purge', 'off', true);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    PERFORM set_config('app.card_purge', 'off', true);
  END;

  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION 'qadrawer02 T8 falhou: GUC de purge não liberou (%)', v_err;
  END IF;

  -- Restaura o vínculo legítimo para deixar a fixture coerente.
  UPDATE public.transactions
  SET category_id = 'cc000000-0000-4000-8000-0000000000c1'
  WHERE id = 'cc000000-0000-4000-8000-0000000000d1';

  RAISE NOTICE 'qadrawer02 T8 ok: app.card_purge=on libera a checagem administrativa';
END $$;

RESET ROLE;

-- ============ Fixtures cleanup (fim; tenant novo cascateia com o usuário) ============
BEGIN;
SELECT set_config('app.card_purge', 'on', true);
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'cccc0000-0000-4000-8000-0000000000a1',
  'cccc0000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

\echo 'rf03-category-guard: OK'
