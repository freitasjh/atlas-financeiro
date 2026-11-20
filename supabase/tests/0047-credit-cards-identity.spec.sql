-- 0047-credit-cards-identity.spec.sql — ADR-001: identidade PCI-safe em credit_cards.
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0047-credit-cards-identity.spec.sql
-- Prova em banco real (mock não avalia information_schema, CHECK, DEFAULT nem RLS):
--   T0 colunas exatas (tipos/nullability/defaults) + zero PAN/CVV/número completo;
--   T1 CHECK do theme contém os 5 valores de ADR-003 e rejeita valor órfão;
--   T2 DEFAULTs: theme=platinum, is_default=false, identidade legada NULL;
--   T3 RLS credit_cards_tenant preservada: A não lê nem escreve cartão de B (e vice-versa).
-- Rerunnable: fixtures (users a647*, accounts e647*, cards c647*) apagadas no início e no fim.

\set ON_ERROR_STOP on

BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'a6470000-0000-4000-8000-0000000000a1',
  'a6470000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;


INSERT INTO auth.users (id, email) VALUES
  ('a6470000-0000-4000-8000-0000000000a1', 'identity-rls-a@example.com'),
  ('a6470000-0000-4000-8000-0000000000b1', 'identity-rls-b@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['a6470000-0000-4000-8000-0000000000a1'::uuid, 'a6470000-0000-4000-8000-0000000000b1'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600003000 + v_i)::text, 11, '0'),
            'Fixture 0047', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type) VALUES
  ('e6470000-0000-4000-8000-0000000000a1', 'a6470000-0000-4000-8000-0000000000a1', 'Conta A', 'checking'),
  ('e6470000-0000-4000-8000-0000000000b1', 'a6470000-0000-4000-8000-0000000000b1', 'Conta B', 'checking');

-- ============ T0 — estrutura exata + PCI ============

DO $$
DECLARE
  expected text[] := ARRAY[
    'last4|text|YES',
    'holder_name|text|YES',
    'expiry_mm_aa|text|YES',
    'theme|text|NO',
    'is_default|boolean|NO'
  ];
  e text;
  col text;
  typ text;
  nullable text;
  def text;
BEGIN
  FOREACH e IN ARRAY expected LOOP
    col := split_part(e, '|', 1);
    typ := split_part(e, '|', 2);
    nullable := split_part(e, '|', 3);
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'credit_cards'
        AND column_name = col AND data_type = typ AND is_nullable = nullable
    ) THEN
      RAISE EXCEPTION '0047 T0 falhou: coluna % com tipo/nullability divergentes', col;
    END IF;
  END LOOP;

  SELECT column_default INTO def FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'credit_cards' AND column_name = 'theme';
  IF def IS NULL OR def NOT LIKE '%platinum%' THEN
    RAISE EXCEPTION '0047 T0 falhou: DEFAULT theme=% (esperado platinum)', def;
  END IF;

  SELECT column_default INTO def FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'credit_cards' AND column_name = 'is_default';
  IF def IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION '0047 T0 falhou: DEFAULT is_default=% (esperado false)', def;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'credit_cards'
      AND (column_name ~* '(^|_)(pan|cvv|cvc|card_number|full_number)($|_)'
           OR column_name ~* '(cvv|cardnumber|pan)')
  ) THEN
    RAISE EXCEPTION '0047 T0 falhou: coluna PAN/CVV/número completo presente';
  END IF;

  RAISE NOTICE '0047 T0 ok: 5 colunas exatas, DEFAULTs corretos, zero PAN/CVV';
END $$;

-- ============ T1 — CHECK do theme (5 valores de ADR-003) ============

DO $$
DECLARE
  theme text;
  check_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO check_def
  FROM pg_constraint
  WHERE conrelid = 'public.credit_cards'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%theme%'
  LIMIT 1;

  IF check_def IS NULL THEN
    RAISE EXCEPTION '0047 T1 falhou: CHECK de theme ausente';
  END IF;

  FOREACH theme IN ARRAY ARRAY['midnight','emerald','violet','platinum','rose_gold'] LOOP
    IF check_def NOT LIKE '%''' || theme || '''%' THEN
      RAISE EXCEPTION '0047 T1 falhou: valor % ausente no CHECK', theme;
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO public.credit_cards (user_id, account_id, name, limit_cents, closing_day, due_day, theme)
    VALUES (
      'a6470000-0000-4000-8000-0000000000a1',
      'e6470000-0000-4000-8000-0000000000a1',
      'Tema inválido', 10000, 10, 17, 'blue'
    );
    RAISE EXCEPTION '0047 T1 falhou: CHECK aceitou tema órfão';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  RAISE NOTICE '0047 T1 ok: CHECK cobre os 5 temas e rejeita valor fora do domínio';
END $$;

-- ============ T2 — DEFAULTs e identidade legada nula ============

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day)
VALUES (
  'c6470000-0000-4000-8000-0000000000a1',
  'a6470000-0000-4000-8000-0000000000a1',
  'e6470000-0000-4000-8000-0000000000a1',
  'Legado sem identidade', 10000, 10, 17
);

DO $$
DECLARE r public.credit_cards%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.credit_cards WHERE id = 'c6470000-0000-4000-8000-0000000000a1';
  IF r.theme <> 'platinum' OR r.is_default IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0047 T2 falhou: DEFAULTs theme=% is_default=%', r.theme, r.is_default;
  END IF;
  IF r.last4 IS NOT NULL OR r.holder_name IS NOT NULL OR r.expiry_mm_aa IS NOT NULL THEN
    RAISE EXCEPTION '0047 T2 falhou: backfill falso em cartão legado';
  END IF;

  UPDATE public.credit_cards
     SET last4 = '1234', holder_name = 'JOAO SILVA', expiry_mm_aa = '12/29',
         theme = 'violet', is_default = true
   WHERE id = 'c6470000-0000-4000-8000-0000000000a1';

  SELECT * INTO r FROM public.credit_cards WHERE id = 'c6470000-0000-4000-8000-0000000000a1';
  IF r.last4 <> '1234' OR r.holder_name <> 'JOAO SILVA' OR r.expiry_mm_aa <> '12/29'
     OR r.theme <> 'violet' OR r.is_default IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0047 T2 falhou: identidade PCI-safe não persistiu';
  END IF;

  UPDATE public.credit_cards SET is_default = false WHERE id = 'c6470000-0000-4000-8000-0000000000a1';
  RAISE NOTICE '0047 T2 ok: DEFAULTs neutros, identidade legada NULL, escrita PCI-safe persiste';
END $$;

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day)
VALUES (
  'c6470000-0000-4000-8000-0000000000b1',
  'a6470000-0000-4000-8000-0000000000b1',
  'e6470000-0000-4000-8000-0000000000b1',
  'Cartão B', 20000, 5, 12
);

-- ============ T3 — RLS A≠B preservada ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claim.sub', 'a6470000-0000-4000-8000-0000000000a1', false);

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.credit_cards
  WHERE id = 'c6470000-0000-4000-8000-0000000000a1';
  IF v <> 1 THEN RAISE EXCEPTION '0047 T3 falhou: A não vê próprio cartão'; END IF;

  SELECT count(*) INTO v FROM public.credit_cards
  WHERE id = 'c6470000-0000-4000-8000-0000000000b1';
  IF v <> 0 THEN RAISE EXCEPTION '0047 T3 falhou: A vê cartão de B'; END IF;

  UPDATE public.credit_cards SET holder_name = 'INVASAO'
  WHERE id = 'c6470000-0000-4000-8000-0000000000b1';
  IF FOUND THEN RAISE EXCEPTION '0047 T3 falhou: A atualizou cartão de B'; END IF;

  BEGIN
    INSERT INTO public.credit_cards (user_id, account_id, name, limit_cents, closing_day, due_day)
    VALUES (
      'a6470000-0000-4000-8000-0000000000b1',
      'e6470000-0000-4000-8000-0000000000b1',
      'Invasão A→B', 100, 1, 2
    );
    RAISE EXCEPTION '0047 T3 falhou: A inseriu cartão para B';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL;
  END;

  RAISE NOTICE '0047 T3a ok: A lê só o próprio cartão e não escreve em B';
END $$;

SELECT set_config('request.jwt.claim.sub', 'a6470000-0000-4000-8000-0000000000b1', false);

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.credit_cards
  WHERE id = 'c6470000-0000-4000-8000-0000000000b1';
  IF v <> 1 THEN RAISE EXCEPTION '0047 T3 falhou: B não vê próprio cartão'; END IF;

  SELECT count(*) INTO v FROM public.credit_cards
  WHERE id = 'c6470000-0000-4000-8000-0000000000a1';
  IF v <> 0 THEN RAISE EXCEPTION '0047 T3 falhou: B vê cartão de A'; END IF;

  UPDATE public.credit_cards SET last4 = '9999'
  WHERE id = 'c6470000-0000-4000-8000-0000000000a1';
  IF FOUND THEN RAISE EXCEPTION '0047 T3 falhou: B atualizou cartão de A'; END IF;

  RAISE NOTICE '0047 T3b ok: B lê só o próprio cartão e não escreve em A';
END $$;

RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.credit_cards WHERE last4 = '9999' OR holder_name = 'INVASAO') THEN
    RAISE EXCEPTION '0047 T3 falhou: escrita cross-tenant persistiu';
  END IF;
  RAISE NOTICE '0047 T3 ok: RLS auth.uid()=user_id preservada (A≠B)';
END $$;

BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'a6470000-0000-4000-8000-0000000000a1',
  'a6470000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;


\echo '0047-credit-cards-identity.spec.sql: OK'
