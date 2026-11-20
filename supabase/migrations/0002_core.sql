-- 0002_core.sql — Fase 2 Core (SB-10)
-- budgets + drop UNIQUE conta-cartão (G2) + UNIQUE/CHECK faturas (G3)
-- + CHECK N BETWEEN 2 AND 24 + coerência parcela (G4) + CHECK transfer 1-row via invoice_id (G6)
-- + RLS budgets (G7). Idempotente (IF NOT EXISTS / DO blocks). NÃO edita 0001.
-- Dinheiro: BIGINT cents + CHECK >= 0. Sem tipos binários de ponto flutuante. Colunas legadas de conciliação intocadas.

-- ============ TABELA budgets (G7) ============

CREATE TABLE IF NOT EXISTS public.budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories (id) ON DELETE CASCADE,
  month date NOT NULL,
  limit_cents bigint NOT NULL DEFAULT 0 CHECK (limit_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budgets_month_first_day CHECK ((EXTRACT(DAY FROM month)) = 1),
  CONSTRAINT budgets_user_category_month_key UNIQUE (user_id, category_id, month)
);

-- Garante UNIQUE caso tabela pré-exista sem ele (re-run parcial)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.budgets'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%user_id%' AND pg_get_constraintdef(oid) ILIKE '%category_id%' AND pg_get_constraintdef(oid) ILIKE '%month%'
  ) THEN
    ALTER TABLE public.budgets ADD CONSTRAINT budgets_user_category_month_key UNIQUE (user_id, category_id, month);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budgets_month_first_day') THEN
    ALTER TABLE public.budgets ADD CONSTRAINT budgets_month_first_day CHECK ((EXTRACT(DAY FROM month)) = 1);
  END IF;
END $$;

-- ============ G2: drop UNIQUE credit_cards.account_id (1 conta → N cartões) ============

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'public.credit_cards'::regclass AND contype = 'u'
    AND pg_get_constraintdef(oid) ILIKE '%account_id%'
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.credit_cards DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- ============ G3: invoices UNIQUE(card,period_start) + CHECKs ============

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.invoices'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%credit_card_id%' AND pg_get_constraintdef(oid) ILIKE '%period_start%'
  ) THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_credit_card_period_key UNIQUE (credit_card_id, period_start);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_status_check') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('open', 'closed', 'paid'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_period_coherence') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_period_coherence CHECK (period_start <= period_end);
  END IF;
END $$;

-- ============ G4: parcelas N BETWEEN 2 AND 24 + coerência installment_number ============

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'installment_plans_count_range') THEN
    ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_count_range CHECK (total_installments BETWEEN 2 AND 24);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_installment_coherence') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_installment_coherence CHECK (
      (installment_plan_id IS NULL AND installment_number IS NULL)
      OR (installment_plan_id IS NOT NULL AND installment_number IS NOT NULL AND installment_number >= 1)
    );
  END IF;
END $$;

-- ============ G6 corrigido: transfer 1-row via invoice_id ============
-- conta→conta: transfer_destination_account_id set, invoice_id NULL.
-- conta→cartão: invoice_id set, destination NULL. category_id sempre NULL em transfer.
-- não-transfer: destination sempre NULL (invoice_id livre p/ compra no cartão).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_transfer_rule') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_transfer_rule CHECK (
      (
        is_transfer AND category_id IS NULL
        AND ((transfer_destination_account_id IS NULL) <> (invoice_id IS NULL))
      )
      OR (
        NOT is_transfer AND transfer_destination_account_id IS NULL
      )
    );
  END IF;
END $$;

-- ============ ÍNDICES Fase 2 ============

CREATE INDEX IF NOT EXISTS idx_budgets_user_month
  ON public.budgets (user_id, month);
CREATE INDEX IF NOT EXISTS idx_invoices_card_period
  ON public.invoices (credit_card_id, period_start);

-- ============ TRIGGER updated_at budgets (reusa set_updated_at da 0001) ============

DROP TRIGGER IF EXISTS set_budgets_updated_at ON public.budgets;
CREATE TRIGGER set_budgets_updated_at
  BEFORE UPDATE ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ RLS budgets (G7) ============

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS budgets_tenant ON public.budgets;
CREATE POLICY budgets_tenant ON public.budgets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
