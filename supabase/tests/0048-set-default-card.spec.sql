-- 0048-set-default-card.spec.sql — ADR-002: RPC set_default_card + índice parcial.
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0048-set-default-card.spec.sql
-- Prova em banco real (mock não avalia grant, SECURITY DEFINER, índice nem transação):
--   T0 estrutura: RPC existe, SECURITY DEFINER, search_path fixo, EXECUTE só
--      authenticated; índice parcial único ux_credit_cards_user_default existe;
--   T1 authenticated: promover A2 desmarca A1 na MESMA transação — sobra
--      exatamente 1 principal (nunca 0, nunca 2); repetir é idempotente;
--   T2 cartão de outro tenant (e uuid inexistente) → rótulo 'card-not-found'
--      e ZERO escrita no estado do tenant A;
--   T3 anon → 42501 (sem EXECUTE);
--   T4 UPDATE direto criando 2º principal é recusado pelo índice parcial;
--   T5 saneamento de duplicatas legadas por (created_at, id) antes do índice;
--   T6 falha artificial na 2ª UPDATE reverte a 1ª (atomicidade da RPC).
-- Rerunnable: fixtures (users a648*, contas e648*, cards c648*) apagadas no início e no fim.

\set ON_ERROR_STOP on

BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'a6480000-0000-4000-8000-0000000000a1',
  'a6480000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;


INSERT INTO auth.users (id, email) VALUES
  ('a6480000-0000-4000-8000-0000000000a1', 'card-default-rpc-a@example.com'),
  ('a6480000-0000-4000-8000-0000000000b1', 'card-default-rpc-b@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['a6480000-0000-4000-8000-0000000000a1'::uuid, 'a6480000-0000-4000-8000-0000000000b1'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600004000 + v_i)::text, 11, '0'),
            'Fixture 0048', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type) VALUES
  ('e6480000-0000-4000-8000-0000000000a1', 'a6480000-0000-4000-8000-0000000000a1', 'Conta A1', 'checking'),
  ('e6480000-0000-4000-8000-0000000000a2', 'a6480000-0000-4000-8000-0000000000a1', 'Conta A2', 'checking'),
  ('e6480000-0000-4000-8000-0000000000a3', 'a6480000-0000-4000-8000-0000000000a1', 'Conta A3', 'checking'),
  ('e6480000-0000-4000-8000-0000000000a4', 'a6480000-0000-4000-8000-0000000000a1', 'Conta A4', 'checking'),
  ('e6480000-0000-4000-8000-0000000000a5', 'a6480000-0000-4000-8000-0000000000a1', 'Conta A5', 'checking'),
  ('e6480000-0000-4000-8000-0000000000a6', 'a6480000-0000-4000-8000-0000000000a1', 'Conta A6', 'checking'),
  ('e6480000-0000-4000-8000-0000000000a7', 'a6480000-0000-4000-8000-0000000000a1', 'Conta A7', 'checking'),
  ('e6480000-0000-4000-8000-0000000000b1', 'a6480000-0000-4000-8000-0000000000b1', 'Conta B1', 'checking');

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day, is_default) VALUES
  ('c6480000-0000-4000-8000-0000000000a1', 'a6480000-0000-4000-8000-0000000000a1', 'e6480000-0000-4000-8000-0000000000a1', 'Cartao A1', 10000, 10, 17, true),
  ('c6480000-0000-4000-8000-0000000000a2', 'a6480000-0000-4000-8000-0000000000a1', 'e6480000-0000-4000-8000-0000000000a2', 'Cartao A2', 10000, 10, 17, false),
  ('c6480000-0000-4000-8000-0000000000a3', 'a6480000-0000-4000-8000-0000000000a1', 'e6480000-0000-4000-8000-0000000000a3', 'Cartao A3', 10000, 10, 17, false),
  ('c6480000-0000-4000-8000-0000000000b1', 'a6480000-0000-4000-8000-0000000000b1', 'e6480000-0000-4000-8000-0000000000b1', 'Cartao B1', 10000, 10, 17, true);

-- ============ T0 — estrutura: DEFINER + search_path + ACL + índice ============

DO $$
DECLARE
  v_proc pg_proc;
BEGIN
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('public.set_default_card(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0048 T0 falhou: public.set_default_card(uuid) ausente';
  END IF;

  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0048 T0 falhou: set_default_card sem SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM unnest(coalesce(v_proc.proconfig, '{}')) AS c
    WHERE c LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION '0048 T0 falhou: set_default_card sem search_path fixo';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.set_default_card(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0048 T0 falhou: authenticated sem EXECUTE';
  END IF;

  IF has_function_privilege('anon', 'public.set_default_card(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.set_default_card(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0048 T0 falhou: anon/PUBLIC com EXECUTE (deveria ser negado)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relname = 'credit_cards'
      AND i.indexrelid = to_regclass('public.ux_credit_cards_user_default')
      AND i.indisunique
      AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0048 T0 falhou: índice parcial único ux_credit_cards_user_default ausente';
  END IF;

  RAISE NOTICE '0048 T0 ok: RPC DEFINER, search_path fixo, EXECUTE só authenticated, índice parcial';
END $$;

-- ============ T1 — promover A2 desmarca A1 atomicamente ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6480000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

DO $$
DECLARE v_defaults int; v_name text;
BEGIN
  PERFORM public.set_default_card('c6480000-0000-4000-8000-0000000000a2');

  SELECT count(*) INTO v_defaults
  FROM public.credit_cards
  WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default;
  IF v_defaults <> 1 THEN
    RAISE EXCEPTION '0048 T1 falhou: principais=% após promover (esperado 1)', v_defaults;
  END IF;

  SELECT name INTO v_name
  FROM public.credit_cards
  WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default;
  IF v_name <> 'Cartao A2' THEN
    RAISE EXCEPTION '0048 T1 falhou: principal=% (esperado Cartao A2)', v_name;
  END IF;

  PERFORM public.set_default_card('c6480000-0000-4000-8000-0000000000a2');
  IF (SELECT count(*) FROM public.credit_cards
      WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default) <> 1 THEN
    RAISE EXCEPTION '0048 T1 falhou: idempotência quebrou a invariante de 1 principal';
  END IF;

  RAISE NOTICE '0048 T1 ok: promoção desmarca a anterior na mesma transação (idempotente)';
END $$;

-- ============ T2 — cartão alheio / inexistente: rótulo fixo, zero escrita ============

DO $$
DECLARE v_defaults int; v_name text;
BEGIN
  BEGIN
    PERFORM public.set_default_card('c6480000-0000-4000-8000-0000000000b1');
    RAISE EXCEPTION '0048 T2 falhou: promoveu cartão de outro tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'card-not-found' THEN
      RAISE EXCEPTION '0048 T2 falhou: rótulo=% (esperado card-not-found)', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.set_default_card('c6480000-0000-4000-8000-0000000000ff');
    RAISE EXCEPTION '0048 T2 falhou: aceitou cartão inexistente';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'card-not-found' THEN
      RAISE EXCEPTION '0048 T2 falhou: rótulo=% (esperado card-not-found)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_defaults
  FROM public.credit_cards
  WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default;
  SELECT name INTO v_name
  FROM public.credit_cards
  WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default;
  IF v_defaults <> 1 OR v_name <> 'Cartao A2' THEN
    RAISE EXCEPTION '0048 T2 falhou: escrita parcial (principais=%, nome=%)', v_defaults, v_name;
  END IF;

  RAISE NOTICE '0048 T2 ok: cartão alheio/inexistente recusado sem tocar no estado';
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
    PERFORM public.set_default_card('c6480000-0000-4000-8000-0000000000a3');
    RAISE EXCEPTION '0048 T3 falhou: anon executou set_default_card';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '0048 T3 ok: anon → 42501';
  END;
END $$;

RESET ROLE;
ROLLBACK;

-- ============ T4 — índice rejeita 2º principal via UPDATE direto ============

DO $$
BEGIN
  BEGIN
    UPDATE public.credit_cards SET is_default = true
    WHERE id = 'c6480000-0000-4000-8000-0000000000a3';
    RAISE EXCEPTION '0048 T4 falhou: UPDATE direto criou 2º principal';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  IF (SELECT count(*) FROM public.credit_cards
      WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default) <> 1 THEN
    RAISE EXCEPTION '0048 T4 falhou: estado mudou após unique_violation';
  END IF;
  RAISE NOTICE '0048 T4 ok: índice parcial barra escrita direta';
END $$;

-- ============ T5 — saneamento legado por (created_at, id) antes do índice ============

DROP INDEX public.ux_credit_cards_user_default;

-- 0033 normaliza created_at := now() no INSERT e o congela no UPDATE; para
-- simular dados legados com datas distintas, suspension temporária dos
-- triggers de usuário (postgres/fixture de teste). Reativados na seqüência.
ALTER TABLE public.credit_cards DISABLE TRIGGER USER;

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day, created_at, is_default) VALUES
  ('c6480000-0000-4000-8000-0000000000a4', 'a6480000-0000-4000-8000-0000000000a1', 'e6480000-0000-4000-8000-0000000000a4', 'Legado antigo', 10000, 10, 17, '2020-01-01T00:00:00Z', true),
  ('c6480000-0000-4000-8000-0000000000a5', 'a6480000-0000-4000-8000-0000000000a1', 'e6480000-0000-4000-8000-0000000000a5', 'Legado recente', 10000, 10, 17, '2099-01-01T00:00:00Z', true),
  ('c6480000-0000-4000-8000-0000000000a6', 'a6480000-0000-4000-8000-0000000000a1', 'e6480000-0000-4000-8000-0000000000a6', 'Legado empate menor id', 10000, 10, 17, '2021-01-01T00:00:00Z', true),
  ('c6480000-0000-4000-8000-0000000000a7', 'a6480000-0000-4000-8000-0000000000a1', 'e6480000-0000-4000-8000-0000000000a7', 'Legado empate maior id', 10000, 10, 17, '2021-01-01T00:00:00Z', true);

ALTER TABLE public.credit_cards ENABLE TRIGGER USER;

-- Mesmo critério da migration 0048 / 0045.
UPDATE public.credit_cards AS a
SET is_default = false
WHERE a.is_default
  AND EXISTS (
    SELECT 1 FROM public.credit_cards AS b
    WHERE b.user_id = a.user_id
      AND b.is_default
      AND (b.created_at, b.id) > (a.created_at, a.id)
  );

DO $$
DECLARE v_keep text; v_defaults int;
BEGIN
  SELECT id INTO v_keep FROM public.credit_cards
  WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default;
  IF v_keep <> 'c6480000-0000-4000-8000-0000000000a5' THEN
    RAISE EXCEPTION '0048 T5 falhou: manteve % (esperado created_at=2099)', v_keep;
  END IF;
  SELECT count(*) INTO v_defaults FROM public.credit_cards
  WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default;
  IF v_defaults <> 1 THEN
    RAISE EXCEPTION '0048 T5 falhou: principais=% após saneamento', v_defaults;
  END IF;
  RAISE NOTICE '0048 T5 ok: saneamento mantém (created_at, id) máximo';
END $$;

DELETE FROM public.credit_cards WHERE id IN (
  'c6480000-0000-4000-8000-0000000000a4',
  'c6480000-0000-4000-8000-0000000000a5',
  'c6480000-0000-4000-8000-0000000000a6',
  'c6480000-0000-4000-8000-0000000000a7'
);
UPDATE public.credit_cards SET is_default = true
WHERE id = 'c6480000-0000-4000-8000-0000000000a2';

CREATE UNIQUE INDEX ux_credit_cards_user_default
  ON public.credit_cards (user_id) WHERE is_default;

-- ============ T6 — atomicidade: falha na 2ª UPDATE reverte a 1ª ============

CREATE OR REPLACE FUNCTION public.t648_boom_on_promote() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_default AND NEW.id = 'c6480000-0000-4000-8000-0000000000a3' THEN
    RAISE EXCEPTION 'boom';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t648_boom BEFORE UPDATE OF is_default ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.t648_boom_on_promote();

DO $$
DECLARE v_name text;
BEGIN
  BEGIN
    PERFORM public.set_default_card('c6480000-0000-4000-8000-0000000000a3');
    RAISE EXCEPTION '0048 T6 falhou: promoção não disparou falha artificial';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'boom' THEN
      RAISE EXCEPTION '0048 T6 falhou: rótulo=% (esperado boom)', SQLERRM;
    END IF;
  END;

  SELECT name INTO v_name FROM public.credit_cards
  WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default;
  IF v_name <> 'Cartao A2' THEN
    RAISE EXCEPTION '0048 T6 falhou: 1ª UPDATE não revertida (principal=%)', v_name;
  END IF;
  RAISE NOTICE '0048 T6 ok: erro na 2ª UPDATE reverte a 1ª';
END $$;

DROP TRIGGER t648_boom ON public.credit_cards;
DROP FUNCTION public.t648_boom_on_promote();

DO $$
BEGIN
  IF (SELECT name FROM public.credit_cards
      WHERE user_id = 'a6480000-0000-4000-8000-0000000000a1' AND is_default) <> 'Cartao A2' THEN
    RAISE EXCEPTION '0048 final falhou: principal mudou após chamadas recusadas';
  END IF;
  RAISE NOTICE '0048 ok: estado final preservado';
END $$;

BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'a6480000-0000-4000-8000-0000000000a1',
  'a6480000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;


\echo '0048-set-default-card.spec.sql: OK'
