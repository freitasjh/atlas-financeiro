-- 0056_tenant_invoices.sql — control-plane-billing / F1 / ADR-001 (D2; REQ-11..17).
--
-- Motivo: a fatura de billing de tenant nao tem lastro. `tenant_subscriptions`
-- (0055) guarda a verdade do ciclo; falta a fatura do ciclo com competencia,
-- periodo, vencimento e valor. A fatura de cartao do usuario (dominio distinto)
-- permanece intocada — nenhuma FK, coluna ou referencia e criada para ela.
--
-- Entrega (REQ-11..17, I2/I3/I4/I7/I8):
--   1) `public.tenant_invoices` com as 15 colunas congeladas de §4.2.
--   2) `UNIQUE (tenant_id, competencia)` (idempotencia de emissao) e uniques
--      parciais de `psp_invoice_id`/`psp_payment_id` (idempotencia de PSP).
--   3) CHECKs: competencia dia 1, periodo fechado, amount_cents >= 0 (BIGINT
--      cents), status enum proprio, `paid` exige `paid_at`.
--   4) `tenant_invoices_tenant_guard` (BEFORE INSERT OR UPDATE): a fatura
--      pertence ao tenant da assinatura (`invoice-tenant-mismatch`).
--   5) `tenant_invoices_immutable_guard` (BEFORE UPDATE): paid/refunded sao
--      imutaveis em identidade/valor/competencia/periodo
--      (`tenant-invoice-immutable`) e a matriz de status e fechada
--      (`tenant-invoice-transition-invalid`).
--   6) RLS deny-all (sem policy) + REVOKE ALL de PUBLIC/anon/authenticated/
--      service_role. Escrita exclusiva por RPC SECURITY DEFINER (0059/0060).
--
-- Dinheiro: `amount_cents bigint` (cents), nunca float/numeric. Valor sempre
-- derivado de `get_plan_price` no servidor (0059/0060), nunca do payload.
--
-- Idempotente-safe: CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- DROP TRIGGER IF EXISTS / REVOKE repetivel. Migrations 0001–0055 intocadas.

-- ============ 1. Tabela ============

CREATE TABLE IF NOT EXISTS public.tenant_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES public.tenant_subscriptions (id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'cycle',
  competencia date NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  due_date date NOT NULL,
  amount_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'open',
  psp_invoice_id text,
  psp_payment_id text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_invoices_tenant_competencia_uq UNIQUE (tenant_id, competencia),
  CONSTRAINT tenant_invoices_kind_check
    CHECK (kind IN ('cycle', 'proration', 'manual')),
  CONSTRAINT tenant_invoices_status_check
    CHECK (status IN ('open', 'paid', 'overdue', 'canceled', 'refunded')),
  CONSTRAINT tenant_invoices_competencia_day1_check
    CHECK (EXTRACT(DAY FROM competencia) = 1),
  CONSTRAINT tenant_invoices_period_order_check
    CHECK (period_end > period_start),
  CONSTRAINT tenant_invoices_amount_check
    CHECK (amount_cents >= 0),
  CONSTRAINT tenant_invoices_paid_at_check
    CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

COMMENT ON TABLE public.tenant_invoices IS
  'Fatura de billing de tenant (ADR-001 §3.2). Uma fatura por (tenant, competencia); competencia dia 1. Dinheiro em BIGINT cents vindo de get_plan_price. Escrita exclusiva por RPC SECURITY DEFINER; RLS deny-all sem policy e intencional. Dominio separado da fatura de cartao do usuario: nenhuma referencia cruzada.';
COMMENT ON COLUMN public.tenant_invoices.competencia IS
  'Mes de competencia (sempre dia 1). Chave de idempotencia de emissao junto com tenant_id.';
COMMENT ON COLUMN public.tenant_invoices.amount_cents IS
  'Valor em centavos BRL (BIGINT >= 0). Derivado de plan_catalog/get_plan_price; nunca do payload do PSP.';
COMMENT ON COLUMN public.tenant_invoices.paid_at IS
  'Instante do pagamento. NOT NULL quando status=paid (CHECK).';

-- ============ 2. Índices parciais de PSP (idempotencia do inbox) ============

CREATE UNIQUE INDEX IF NOT EXISTS tenant_invoices_psp_invoice_uq
  ON public.tenant_invoices (psp_invoice_id)
  WHERE psp_invoice_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_invoices_psp_payment_uq
  ON public.tenant_invoices (psp_payment_id)
  WHERE psp_payment_id IS NOT NULL;

-- ============ 3. Guard de tenant (fatura pertence ao tenant da assinatura) ============

CREATE OR REPLACE FUNCTION public.tenant_invoices_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT s.tenant_id INTO v_tenant
  FROM public.tenant_subscriptions AS s
  WHERE s.id = NEW.subscription_id;

  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'invoice-tenant-mismatch';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tenant_invoices_tenant_guard() IS
  'REQ-16/I3: fatura so existe no tenant da assinatura. subscription_id de outro tenant -> invoice-tenant-mismatch (0 escrita).';

REVOKE ALL ON FUNCTION public.tenant_invoices_tenant_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenant_invoices_tenant_guard ON public.tenant_invoices;
CREATE TRIGGER tenant_invoices_tenant_guard
  BEFORE INSERT OR UPDATE ON public.tenant_invoices
  FOR EACH ROW EXECUTE FUNCTION public.tenant_invoices_tenant_guard();

-- ============ 4. Guard de imutabilidade e matriz de status ============

CREATE OR REPLACE FUNCTION public.tenant_invoices_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- REQ-14: paid/refunded sao imutaveis em identidade, competencia, periodo e valor.
  IF OLD.status IN ('paid', 'refunded') THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
       OR NEW.competencia IS DISTINCT FROM OLD.competencia
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents THEN
      RAISE EXCEPTION 'tenant-invoice-immutable';
    END IF;
  END IF;

  -- REQ-15: matriz fechada de status; fora dela -> 0 alteracao.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'open' AND NEW.status IN ('paid', 'overdue', 'canceled'))
      OR (OLD.status = 'overdue' AND NEW.status IN ('paid', 'canceled'))
      OR (OLD.status = 'paid' AND NEW.status = 'refunded')
    ) THEN
      RAISE EXCEPTION 'tenant-invoice-transition-invalid';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tenant_invoices_immutable_guard() IS
  'REQ-14/REQ-15/I8: paid/refunded imutaveis em valor/competencia/periodo; transicoes fechadas open|overdue|paid|canceled|refunded.';

REVOKE ALL ON FUNCTION public.tenant_invoices_immutable_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenant_invoices_immutable_guard ON public.tenant_invoices;
CREATE TRIGGER tenant_invoices_immutable_guard
  BEFORE UPDATE ON public.tenant_invoices
  FOR EACH ROW EXECUTE FUNCTION public.tenant_invoices_immutable_guard();

-- ============ 5. updated_at ============

DROP TRIGGER IF EXISTS set_tenant_invoices_updated_at ON public.tenant_invoices;
CREATE TRIGGER set_tenant_invoices_updated_at
  BEFORE UPDATE ON public.tenant_invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ 6. RLS deny-all (sem policy) ============

ALTER TABLE public.tenant_invoices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenant_invoices
  FROM PUBLIC, anon, authenticated, service_role;
