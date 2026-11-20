-- 0062_tenant_quota_members_limit.sql — tenant-quota / F3 / ADR-002 (BE-36).
--
-- Motivo: a quota de seats (RF-QT-05) precisa de verdade no banco. `0033`
-- definiu 4 limites de recurso e `get_plan_limit` com 4 colunas; sem
-- `max_members` o gate de `0063` não tem limite para comparar e o consumo de
-- `0064` não tem `limit_max` para devolver. Seats não é dinheiro: `integer`,
-- nunca float/numeric.
--
-- Entrega (server-side; nenhuma escrita de `authenticated`):
--   1) `plan_limits.max_members integer NULL` + CHECK `>= 1`
--      (`plan_limits_max_members_check`; NULL continua ilimitado),
--      `ADD COLUMN IF NOT EXISTS` + `DROP`/`ADD` da constraint
--      (idempotente-safe; rerun aplica o piso `>= 1` de uma versão anterior).
--      R1 do review F3: o gate trata `0` como EXCEDIDO (REQ-13), logo `0`
--      abortaria a criação do próprio tenant — o CHECK precisa recusá-lo.
--   2) Seed 1/3/10/NULL (`free/standard/pro/full`) por `UPDATE` dos 4 slugs;
--      os 4 limites anteriores NÃO são tocados. Asserção de pós-condição:
--      exatamente 4 linhas com os valores do contrato — divergência aborta a
--      migration (`plan-limits-members-seed-mismatch`), nunca silencia.
--      O seed roda ANTES do CHECK para que um valor legado `0` seja
--      normalizado pelo contrato, não cause falha de validação.
--   3) `public.get_plan_limit(text)` recriada (`DROP` + `CREATE` — o tipo de
--      retorno muda e não há dependente): 5 colunas na ordem do contrato
--      (`…, max_budgets, max_members`), DEFINER, `search_path=''`,
--      `tenant-plan-invalid` preservado, `REVOKE ALL` antes do
--      `GRANT EXECUTE TO authenticated`. `plan_limits` continua fechada
--      (RLS sem policy + REVOKE de `0033`).
--
-- Erros por rótulo fixo, sem PII/id: tenant-plan-invalid,
-- plan-limits-members-seed-mismatch (guard de deploy).
-- Idempotente-safe: ADD COLUMN IF NOT EXISTS + DROP/ADD da constraint +
-- UPDATE idempotente + DROP IF EXISTS/CREATE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0061 e 0077–0081 intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regclass('public.plan_limits') IS NULL
    OR to_regprocedure('public.get_plan_limit(text)') IS NULL
    OR to_regprocedure('public.enforce_tenant_quota()') IS NULL THEN
    RAISE EXCEPTION 'tenant-quota-precondition-missing';
  END IF;
END $$;

-- ============ 1. Coluna max_members ============

ALTER TABLE public.plan_limits ADD COLUMN IF NOT EXISTS max_members integer;

COMMENT ON COLUMN public.plan_limits.max_members IS
  'Seats por plano (RF-QT-05/ADR-002 D10): free 1, standard 3, pro 10, full NULL (ilimitado). NULL nunca bloqueia; 0 é inválido (o gate trata 0 como excedido, REQ-13).';

-- ============ 2. Seed 1/3/10/NULL (4 limites antigos intactos) ============

UPDATE public.plan_limits AS pl
SET max_members = v.max_members
FROM (VALUES
  ('free'::text, 1),
  ('standard', 3),
  ('pro', 10),
  ('full', NULL::integer)
) AS v(plan_slug, max_members)
WHERE pl.plan_slug = v.plan_slug;

DO $$
DECLARE
  v_total integer;
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_total FROM public.plan_limits;
  IF v_total <> 4 THEN
    RAISE EXCEPTION 'plan-limits-members-seed-mismatch';
  END IF;

  SELECT count(*) INTO v_bad
  FROM public.plan_limits AS pl
  WHERE (pl.plan_slug = 'free' AND pl.max_members IS DISTINCT FROM 1)
     OR (pl.plan_slug = 'standard' AND pl.max_members IS DISTINCT FROM 3)
     OR (pl.plan_slug = 'pro' AND pl.max_members IS DISTINCT FROM 10)
     OR (pl.plan_slug = 'full' AND pl.max_members IS NOT NULL);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'plan-limits-members-seed-mismatch';
  END IF;

  RAISE NOTICE 'tenant-quota/0062: max_members seed 1/3/10/NULL aplicado (4 planos)';
END $$;

-- ============ 2b. CHECK >= 1 (R1: 0 é excedido, não ilimitado) ============
-- DROP/ADD (nunca condicional): um rerun sobre a versão `>= 0` precisa aplicar
-- o piso novo. O seed acima já normalizou as 4 linhas do catálogo.

ALTER TABLE public.plan_limits
  DROP CONSTRAINT IF EXISTS plan_limits_max_members_check;

ALTER TABLE public.plan_limits
  ADD CONSTRAINT plan_limits_max_members_check
  CHECK (max_members IS NULL OR max_members >= 1);

-- ============ 3. get_plan_limit com 5 colunas ============

DROP FUNCTION IF EXISTS public.get_plan_limit(text);

CREATE FUNCTION public.get_plan_limit(p_slug text)
RETURNS TABLE (
  max_transactions_month integer,
  max_accounts integer,
  max_credit_cards integer,
  max_budgets integer,
  max_members integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_slug text := pg_catalog.btrim(COALESCE(p_slug, ''));
BEGIN
  IF v_slug NOT IN ('free', 'standard', 'pro', 'full') THEN
    RAISE EXCEPTION 'tenant-plan-invalid';
  END IF;

  RETURN QUERY
  SELECT pl.max_transactions_month, pl.max_accounts,
         pl.max_credit_cards, pl.max_budgets, pl.max_members
  FROM public.plan_limits AS pl
  WHERE pl.plan_slug = v_slug;
END;
$$;

COMMENT ON FUNCTION public.get_plan_limit(text) IS
  'Limites de quota do plano (ADR-001 + ADR-002): 5 colunas, max_members incluído. Slug fora do catálogo -> tenant-plan-invalid. Leitura DEFINER; plan_limits segue fechada ao cliente.';

REVOKE ALL ON FUNCTION public.get_plan_limit(text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_plan_limit(text) TO authenticated;
