-- 0055_tenant_subscriptions.sql — control-plane-billing / F1 / ADR-001 (D1, D4, D5; adendo §14).
--
-- Motivo: billing de tenant não tem lastro. `tenants.plan_id`/`subscription_status`
-- só mudam por RPC manual (`0028`), sem ciclo, sem aniversário, sem estado de
-- trial nem carência. Esta migration cria a VERDADE (`tenant_subscriptions`);
-- `tenants.*` passa a ser espelho derivado (trigger em `0058`).
--
-- Escopo (REQ-01..06, I1/I2/I9/I10/I14):
--   1) `public.tenant_subscriptions` com as 16 colunas congeladas de §4.1.
--   2) Constraints nomeadas (§4.1) + enum fechado de `status` (0022) e a
--      regra por plano do adendo §14: `free` sem aniversário/ciclo; pago com
--      `billing_day` NOT NULL e período ambos-ou-nenhum.
--   3) Índices: `UNIQUE (tenant_id)` (1 assinatura/tenant), `UNIQUE` parcial de
--      `psp_subscription_id` (correlação de reativação) e índice parcial de
--      `trial_ends_at` para `expire_subscriptions` (0059).
--   4) RLS deny-all: `ENABLE ROW LEVEL SECURITY` + ZERO policy + `REVOKE ALL`
--      de PUBLIC/anon/authenticated/service_role. Acesso só por RPC DEFINER
--      (0059/0060) — precedente `0014`/`0015` (fatura de cartão do usuário).
--   5) `set_updated_at` (`0001`) e COMMENTs declarando o deny intencional.
--
-- Dinheiro: NENHUMA coluna monetária nesta tabela (fatura de tenant é `0056`);
-- a regra BIGINT cents vale para `amount_cents` da fatura de tenant. Nenhuma
-- referência à tabela de fatura de cartão do usuário (domínio distinto — RF-BL-01).
--
-- Idempotente-safe: CREATE ... IF NOT EXISTS / DROP TRIGGER IF EXISTS /
-- REVOKE repetível. Migrations 0001–0054 intocadas. Nenhuma função nova.

-- ============ 1. Tabela (verdade do ciclo de vida) ============

CREATE TABLE IF NOT EXISTS public.tenant_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE RESTRICT,
  plan_slug text NOT NULL REFERENCES public.plan_catalog (slug),
  status text NOT NULL DEFAULT 'trial',
  psp_subscription_id text,
  psp_customer_id text,
  trial_ends_at timestamptz,
  billing_day smallint,
  period_start date,
  period_end date,
  past_due_since timestamptz,
  pending_plan_slug text REFERENCES public.plan_catalog (slug),
  pending_plan_at date,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_subscriptions_tenant_uq UNIQUE (tenant_id),
  CONSTRAINT tenant_subscriptions_status_check
    CHECK (status IN ('trial', 'active', 'past_due', 'canceled')),
  CONSTRAINT tenant_subscriptions_trial_ends_check
    CHECK (status <> 'trial' OR trial_ends_at IS NOT NULL),
  CONSTRAINT tenant_subscriptions_billing_day_check
    CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 31),
  CONSTRAINT tenant_subscriptions_period_pair_check
    CHECK ((period_start IS NULL) = (period_end IS NULL)),
  CONSTRAINT tenant_subscriptions_period_order_check
    CHECK (period_start IS NULL OR period_end > period_start),
  CONSTRAINT tenant_subscriptions_pending_pair_check
    CHECK ((pending_plan_slug IS NULL) = (pending_plan_at IS NULL)),
  CONSTRAINT tenant_subscriptions_pending_diff_check
    CHECK (pending_plan_slug IS NULL OR pending_plan_slug <> plan_slug),
  CONSTRAINT tenant_subscriptions_plan_cycle_check
    CHECK (
      (plan_slug = 'free' AND billing_day IS NULL
        AND period_start IS NULL AND period_end IS NULL)
      OR (plan_slug <> 'free' AND billing_day IS NOT NULL)
    ),
  CONSTRAINT tenant_subscriptions_free_status_check
    CHECK (plan_slug <> 'free' OR status IN ('active', 'canceled')),
  CONSTRAINT tenant_subscriptions_psp_subscription_len_check
    CHECK (psp_subscription_id IS NULL
      OR char_length(psp_subscription_id) BETWEEN 1 AND 255),
  CONSTRAINT tenant_subscriptions_psp_customer_len_check
    CHECK (psp_customer_id IS NULL
      OR char_length(psp_customer_id) BETWEEN 1 AND 255)
);

COMMENT ON TABLE public.tenant_subscriptions IS
  'Verdade de billing de tenant (ADR-001): uma linha por tenant. tenants.plan_id/subscription_status é ESPELHO (trigger 0058). Escrita exclusiva por RPC SECURITY DEFINER; RLS deny-all sem policy é intencional, não esquecimento.';
COMMENT ON COLUMN public.tenant_subscriptions.plan_slug IS
  'Plano vigente (plan_catalog.slug). Upgrade imediato; downgrade agendado em pending_plan_slug.';
COMMENT ON COLUMN public.tenant_subscriptions.billing_day IS
  'Dia do mês da ativação em America/Sao_Paulo (1..31). NULL no plano free; NOT NULL em plano pago (adendo §14).';
COMMENT ON COLUMN public.tenant_subscriptions.period_start IS
  'Inicio do ciclo corrente (date). Ambos-ou-nenhum com period_end; NULL = sem ciclo aberto (trial/free).';
COMMENT ON COLUMN public.tenant_subscriptions.past_due_since IS
  'Inicio da carencia de 7 dias. Escrita exclusiva da aresta active+payment_overdue -> past_due; leitura por private.subscription_access (0075).';

-- ============ 2. Índices ============

-- Correlação de reativação (REQ-21): nunca duas assinaturas para o mesmo id de PSP.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_psp_subscription_uq
  ON public.tenant_subscriptions (psp_subscription_id)
  WHERE psp_subscription_id IS NOT NULL;

-- Fila de `expire_subscriptions` (0059): só trial vencido interessa.
CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_trial_ends
  ON public.tenant_subscriptions (trial_ends_at)
  WHERE status = 'trial';

-- ============ 3. RLS deny-all (sem policy) ============

ALTER TABLE public.tenant_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenant_subscriptions
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 4. updated_at ============

DROP TRIGGER IF EXISTS set_tenant_subscriptions_updated_at ON public.tenant_subscriptions;
CREATE TRIGGER set_tenant_subscriptions_updated_at
  BEFORE UPDATE ON public.tenant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
