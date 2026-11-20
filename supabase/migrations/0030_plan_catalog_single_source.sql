-- 0030_plan_catalog_single_source.sql — backoffice P0 / BE-01 (ADR-004).
--
-- Motivo: o preço dos planos vivia só em TS (`catalog.ts`); o banco validava
-- `plan_id` por CHECK literal sem fonte de centavos. Sem SSoT server-side não
-- há base para MRR futura nem validação de domínio auditável.
--
-- Entrega (server-side):
--   1) `public.plan_catalog` — catálogo (slug, price_cents BIGINT).
--   2) Seed fixo: free 0 / standard 1990 / pro 3990 / full 6990.
--   3) `public.get_plan_price(p_slug)` — preço em centavos; slug fora do
--      catálogo → `tenant-plan-invalid` (nunca silencia para `free`).
--   4) RLS + REVOKE ALL antes do GRANT; `authenticated`/`anon` só leem.
--
-- Dinheiro: BIGINT cents + CHECK >= 0; nenhum float/double. Erros por rótulo
-- fixo, sem PII. Idempotente-safe: CREATE IF NOT EXISTS + DO blocks +
-- INSERT ON CONFLICT DO NOTHING + REVOKE/GRANT repetíveis.
-- Migrations 0001–0029 intocadas. Ordem-independente: nenhuma FK de/para
-- tenants (o enum literal dos CHECKs 0022 espelha o seed; sem dependência
-- física de ordem de aplicação 0027/0028/0030).

-- ============ 1. Tabela + CHECKs ============

CREATE TABLE IF NOT EXISTS public.plan_catalog (
  slug text PRIMARY KEY,
  price_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_catalog_slug_check'
      AND conrelid = 'public.plan_catalog'::regclass
  ) THEN
    ALTER TABLE public.plan_catalog
      ADD CONSTRAINT plan_catalog_slug_check
      CHECK (slug IN ('free', 'standard', 'pro', 'full'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_catalog_price_cents_check'
      AND conrelid = 'public.plan_catalog'::regclass
  ) THEN
    ALTER TABLE public.plan_catalog
      ADD CONSTRAINT plan_catalog_price_cents_check
      CHECK (price_cents >= 0);
  END IF;
END $$;

COMMENT ON TABLE public.plan_catalog IS
  'SSoT server-side de preços (ADR-004). Centavos BIGINT; UI formata com Intl, nunca float.';
COMMENT ON COLUMN public.plan_catalog.price_cents IS
  'Preço em centavos BRL (BIGINT >= 0). Base futura de MRR.';

-- ============ 2. Seed idempotente (não sobrescreve preço existente) ============

INSERT INTO public.plan_catalog (slug, price_cents) VALUES
  ('free', 0),
  ('standard', 1990),
  ('pro', 3990),
  ('full', 6990)
ON CONFLICT (slug) DO NOTHING;

-- ============ 3. RPC de leitura ============
-- SECURITY DEFINER + search_path='' (padrão 0022): leitura estável mesmo com
-- RLS ligada; sem EXECUTE para service_role (lê direto da tabela).

CREATE OR REPLACE FUNCTION public.get_plan_price(p_slug text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_slug text := pg_catalog.btrim(COALESCE(p_slug, ''));
  v_price bigint;
BEGIN
  SELECT price_cents INTO v_price
  FROM public.plan_catalog
  WHERE slug = v_slug;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant-plan-invalid';
  END IF;

  RETURN v_price;
END;
$$;

COMMENT ON FUNCTION public.get_plan_price(text) IS
  'Preço do plano em centavos. Slug fora do catálogo → tenant-plan-invalid.';

REVOKE ALL ON FUNCTION public.get_plan_price(text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_plan_price(text) TO anon, authenticated;

-- ============ 4. RLS + privilégios ============
-- Catálogo é público (RBAC SPEC §3: anon lê). Nenhuma policy de escrita:
-- preço só muda por DBA/runbook, nunca via client.

ALTER TABLE public.plan_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_catalog_select_all ON public.plan_catalog;
CREATE POLICY plan_catalog_select_all ON public.plan_catalog
  FOR SELECT TO anon, authenticated
  USING (true);

REVOKE ALL ON TABLE public.plan_catalog FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.plan_catalog TO anon, authenticated;
