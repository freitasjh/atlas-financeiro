-- default-categories.spec.sql — TEST-01 (migration 0026_default_categories.sql)
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/default-categories.spec.sql
-- Prova: colunas novas, trigger cria 12, backfill idempotente, RLS.

\set ON_ERROR_STOP on

-- ============ Fixtures ============
DELETE FROM auth.users WHERE id IN (
  'dc000000-0000-4000-8000-0000000000a1',
  'dc000000-0000-4000-8000-0000000000b1'
);

-- ============ T1: colunas existem ============
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='categories' AND column_name='icon_code') THEN
    RAISE EXCEPTION 'default-categories T1 falhou: icon_code ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='categories' AND column_name='color_hex') THEN
    RAISE EXCEPTION 'default-categories T1 falhou: color_hex ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='categories' AND column_name='spending_limit_cents') THEN
    RAISE EXCEPTION 'default-categories T1 falhou: spending_limit_cents ausente';
  END IF;
  RAISE NOTICE 'default-categories T1 ok: colunas presentes';
END $$;

-- ============ T2: CHECK constraint ============
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='categories_spending_limit_check' AND conrelid='public.categories'::regclass) THEN
    RAISE EXCEPTION 'default-categories T2 falhou: CHECK ausente';
  END IF;
  RAISE NOTICE 'default-categories T2 ok: CHECK presente';
END $$;

-- ============ T3: trigger cria 12 categorias no signup ============
INSERT INTO auth.users (id, email) VALUES
  ('dc000000-0000-4000-8000-0000000000a1', 'dc-a@example.com');

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.categories WHERE user_id = 'dc000000-0000-4000-8000-0000000000a1';
  IF v_count <> 12 THEN
    RAISE EXCEPTION 'default-categories T3 falhou: esperado 12, obtido %', v_count;
  END IF;
  RAISE NOTICE 'default-categories T3 ok: 12 categorias criadas';
END $$;

-- ============ T4: dados default corretos ============
DO $$
DECLARE
  v_limit bigint;
  v_type text;
  v_icon text;
BEGIN
  SELECT spending_limit_cents, type, icon_code INTO v_limit, v_type, v_icon
  FROM public.categories WHERE user_id='dc000000-0000-4000-8000-0000000000a1' AND name='Alimentação';
  IF v_limit <> 100000 OR v_type <> 'expense' OR v_icon <> 'pi pi-shopping-cart' THEN
    RAISE EXCEPTION 'default-categories T4 falhou: Alimentação inválida (%,%,%)', v_limit, v_type, v_icon;
  END IF;
  SELECT spending_limit_cents, type INTO v_limit, v_type
  FROM public.categories WHERE user_id='dc000000-0000-4000-8000-0000000000a1' AND name='Salario Fixo';
  IF v_limit <> 0 OR v_type <> 'income' THEN
    RAISE EXCEPTION 'default-categories T4b falhou: Salario Fixo inválido';
  END IF;
  RAISE NOTICE 'default-categories T4 ok: dados default corretos';
END $$;

-- ============ T5: backfill idempotente (re-run migration) ============
\ir ../migrations/0026_default_categories.sql
\ir ../migrations/0026_default_categories.sql

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.categories WHERE user_id = 'dc000000-0000-4000-8000-0000000000a1';
  IF v_count <> 12 THEN
    RAISE EXCEPTION 'default-categories T5 falhou: esperado 12 após re-run, obtido %', v_count;
  END IF;
  RAISE NOTICE 'default-categories T5 ok: idempotente';
END $$;

-- ============ T6: RLS — user A não vê categorias de B ============
INSERT INTO auth.users (id, email) VALUES
  ('dc000000-0000-4000-8000-0000000000b1', 'dc-b@example.com');

DO $$
DECLARE
  v_b_count int;
BEGIN
  SELECT count(*) INTO v_b_count FROM public.categories WHERE user_id='dc000000-0000-4000-8000-0000000000b1';
  IF v_b_count <> 12 THEN
    RAISE EXCEPTION 'default-categories T6 setup falhou: B não tem 12';
  END IF;
END $$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'dc000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

DO $$
DECLARE
  v_visible int;
BEGIN
  SELECT count(*) INTO v_visible FROM public.categories;
  IF v_visible <> 12 THEN
    RAISE EXCEPTION 'default-categories T6 falhou: A vê % (esperado 12)', v_visible;
  END IF;
  IF EXISTS (SELECT 1 FROM public.categories WHERE user_id = 'dc000000-0000-4000-8000-0000000000b1') THEN
    RAISE EXCEPTION 'default-categories T6 falhou: A vê categorias de B';
  END IF;
  RAISE NOTICE 'default-categories T6 ok: RLS isola';
END $$;

RESET ROLE;

-- ============ Cleanup ============
DELETE FROM auth.users WHERE id IN (
  'dc000000-0000-4000-8000-0000000000a1',
  'dc000000-0000-4000-8000-0000000000b1'
);