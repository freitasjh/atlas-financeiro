-- 0045-accounts-single-default.spec.sql — no máximo UMA conta principal por usuário.
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0045-accounts-single-default.spec.sql
-- Prova em banco real (mock não avalia índice único nem saneamento):
--   T0 estrutura: índice `ux_accounts_user_default` existe, é UNIQUE, parcial
--      (predicado `is_default`) e cobre `user_id`.
--   T1 segundo INSERT com is_default=true do MESMO usuário → 23505.
--   T2 usuários diferentes podem ter cada um a sua principal (índice por tenant).
--   T3 várias contas com is_default=false continuam permitidas (predicado parcial).
--   T4 saneamento legado: com duas principais pré-existentes, o saneamento da
--      0045 mantém a MAIS RECENTE (created_at, id) e desmarca a antiga.
--      Executado em transação com o índice removido (o índice impede o estado
--      legado) e ROLLBACK no fim — o banco fica intacto.
-- Rerunnable: fixtures (users a545*, contas e545*) apagadas no início e no fim.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (postgres bypassa RLS; fixture de teste) ============

BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'a5450000-0000-4000-8000-0000000000a1',
  'a5450000-0000-4000-8000-0000000000b1',
  'a5450000-0000-4000-8000-0000000000c1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;


INSERT INTO auth.users (id, email) VALUES
  ('a5450000-0000-4000-8000-0000000000a1', 'single-default-a@example.com'),
  ('a5450000-0000-4000-8000-0000000000b1', 'single-default-b@example.com'),
  ('a5450000-0000-4000-8000-0000000000c1', 'single-default-c@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['a5450000-0000-4000-8000-0000000000a1'::uuid, 'a5450000-0000-4000-8000-0000000000b1'::uuid, 'a5450000-0000-4000-8000-0000000000c1'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600001000 + v_i)::text, 11, '0'),
            'Fixture 0045', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


-- ============ T0: o índice parcial único existe e é o que a migração declara ============

DO $$
DECLARE
  v_index oid;
BEGIN
  v_index := to_regclass('public.ux_accounts_user_default');
  IF v_index IS NULL THEN
    RAISE EXCEPTION '0045 T0 falhou: índice ux_accounts_user_default ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i WHERE i.indexrelid = v_index AND i.indisunique
  ) THEN
    RAISE EXCEPTION '0045 T0 falhou: ux_accounts_user_default não é UNIQUE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = v_index
      AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%is_default%'
  ) THEN
    RAISE EXCEPTION '0045 T0 falhou: índice sem predicado is_default (não é parcial)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = v_index
      AND pg_get_indexdef(i.indexrelid) ILIKE '%(user_id)%'
  ) THEN
    RAISE EXCEPTION '0045 T0 falhou: índice não é escopado por user_id';
  END IF;

  RAISE NOTICE '0045 T0 ok: índice único parcial por user_id presente';
END $$;

-- ============ T1: segunda principal do mesmo usuário é recusada ============

INSERT INTO public.accounts (id, user_id, name, type, is_default) VALUES
  ('e5450000-0000-4000-8000-0000000000a1', 'a5450000-0000-4000-8000-0000000000a1', 'Principal A', 'checking', true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (id, user_id, name, type, is_default) VALUES
      ('e5450000-0000-4000-8000-0000000000a2', 'a5450000-0000-4000-8000-0000000000a1', 'Segunda principal', 'checking', true);
    RAISE EXCEPTION '0045 T1 falhou: banco aceitou duas contas principais do mesmo usuário';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE '0045 T1 ok: segunda principal recusada (23505)';
  END;
END $$;

-- ============ T2: outro usuário pode ter a própria principal ============

INSERT INTO public.accounts (id, user_id, name, type, is_default) VALUES
  ('e5450000-0000-4000-8000-0000000000b1', 'a5450000-0000-4000-8000-0000000000b1', 'Principal B', 'checking', true);

DO $$
DECLARE v_defaults int;
BEGIN
  SELECT count(*) INTO v_defaults
  FROM public.accounts
  WHERE user_id IN (
    'a5450000-0000-4000-8000-0000000000a1',
    'a5450000-0000-4000-8000-0000000000b1'
  ) AND is_default;

  IF v_defaults <> 2 THEN
    RAISE EXCEPTION '0045 T2 falhou: principais=% (esperado 1 por usuário = 2)', v_defaults;
  END IF;
  RAISE NOTICE '0045 T2 ok: principal é única por usuário, não global';
END $$;

-- ============ T3: várias não-principais convivem ============

INSERT INTO public.accounts (id, user_id, name, type, is_default) VALUES
  ('e5450000-0000-4000-8000-0000000000a3', 'a5450000-0000-4000-8000-0000000000a1', 'Reserva', 'savings', false),
  ('e5450000-0000-4000-8000-0000000000a4', 'a5450000-0000-4000-8000-0000000000a1', 'Caixa', 'physical_cash', false);

DO $$
DECLARE v_rows int;
BEGIN
  SELECT count(*) INTO v_rows
  FROM public.accounts
  WHERE user_id = 'a5450000-0000-4000-8000-0000000000a1' AND NOT is_default;

  IF v_rows <> 2 THEN
    RAISE EXCEPTION '0045 T3 falhou: não-principais=% (esperado 2)', v_rows;
  END IF;
  RAISE NOTICE '0045 T3 ok: predicado parcial permite várias não-principais';
END $$;

-- ============ T4: saneamento legado mantém a mais recente ============

BEGIN;

-- O estado legado (duas principais) só existe sem o índice. ROLLBACK restaura.
DROP INDEX public.ux_accounts_user_default;

-- created_at é data de negócio/cota: o trigger plan_quota_accounts (0033)
-- normaliza NEW.created_at := now() no INSERT. Fixture desliga o trigger só
-- dentro desta transação (ROLLBACK restaura) para simular contas criadas em
-- meses diferentes — senão as três nascem com o mesmo timestamp.
ALTER TABLE public.accounts DISABLE TRIGGER plan_quota_accounts;

INSERT INTO public.accounts (id, user_id, name, type, is_default, created_at) VALUES
  ('e5450000-0000-4000-8000-0000000000c1', 'a5450000-0000-4000-8000-0000000000c1', 'Antiga', 'checking', true,  '2026-01-01T10:00:00Z'),
  ('e5450000-0000-4000-8000-0000000000c2', 'a5450000-0000-4000-8000-0000000000c1', 'Recente', 'savings', true, '2026-05-01T10:00:00Z'),
  ('e5450000-0000-4000-8000-0000000000c3', 'a5450000-0000-4000-8000-0000000000c1', 'Intermediária', 'checking', true, '2026-03-01T10:00:00Z');

ALTER TABLE public.accounts ENABLE TRIGGER plan_quota_accounts;

-- Saneamento idêntico ao bloco 1 da migration 0045.
UPDATE public.accounts AS a
SET is_default = false
WHERE a.is_default
  AND EXISTS (
    SELECT 1
    FROM public.accounts AS b
    WHERE b.user_id = a.user_id
      AND b.is_default
      AND (b.created_at, b.id) > (a.created_at, a.id)
  );

DO $$
DECLARE v_defaults int; v_name text;
BEGIN
  SELECT count(*) INTO v_defaults
  FROM public.accounts
  WHERE user_id = 'a5450000-0000-4000-8000-0000000000c1' AND is_default;

  IF v_defaults <> 1 THEN
    RAISE EXCEPTION '0045 T4 falhou: principais após saneamento=% (esperado 1)', v_defaults;
  END IF;

  SELECT name INTO v_name
  FROM public.accounts
  WHERE user_id = 'a5450000-0000-4000-8000-0000000000c1' AND is_default;

  IF v_name <> 'Recente' THEN
    RAISE EXCEPTION '0045 T4 falhou: principal=% (esperado a mais recente)', v_name;
  END IF;

  RAISE NOTICE '0045 T4 ok: saneamento mantém a principal mais recente';
END $$;

ROLLBACK;

-- Fixtures cleanup (fim)
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'a5450000-0000-4000-8000-0000000000a1',
  'a5450000-0000-4000-8000-0000000000b1',
  'a5450000-0000-4000-8000-0000000000c1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;


\echo '0045-accounts-single-default.spec.sql: OK'
