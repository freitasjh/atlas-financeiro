-- 0017_delete_guards.sql — RF03 / P2-saneamento (iteração 4).
--
-- Fecha a última classe de "delete deixa compra órfã" apontada no review:
-- as FKs `transactions.invoice_id ON DELETE SET NULL` e
-- `transactions.installment_plan_id ON DELETE CASCADE` não passam pelo guard
-- de INSERT/UPDATE (0009/0013). Um DELETE direto em `invoices` como
-- `authenticated` soltava a compra (`invoice_id = NULL`) e ela virava despesa
-- de caixa — débito em dobro; um DELETE em `installment_plans` apagava as
-- parcelas em cascata.
--
-- 1) `invoices_delete_guard`: BEFORE DELETE em `invoices` levanta
--    `invoice-has-history` quando existe transação apontando para a fatura.
--    Sem discriminador de `current_user`: em cascata de FK o trigger roda como
--    owner (aprendizado de 0016). O caminho administrativo explícito exige
--    `SET LOCAL app.card_purge = 'on'` na transação corrente — nenhum código de
--    aplicação seta esse GUC.
-- 2) `installment_plans_delete_guard`: mesma regra para o plano
--    (`plan-has-history`), impedindo que o CASCADE apague parcelas.
--    A compensação de `createInstallmentPurchase` apaga as transações ANTES do
--    plano, então continua funcionando; por isso DELETE não é revogado.
-- 3) `idx_transactions_user_invoice`: o guard e a RPC `recalc_invoice_total`
--    (0014) filtram/agrupam por `invoice_id`, que hoje não tem índice.
--
-- Mensagens fixas, sem ids (SEC-G3).
-- Idempotente: CREATE OR REPLACE + DROP TRIGGER IF EXISTS + CREATE INDEX IF NOT EXISTS.
-- Migrations 0001–0016 intocadas. Dinheiro segue BIGINT cents.

-- ============ 1. Guard de exclusão de fatura ============

CREATE OR REPLACE FUNCTION public.invoices_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF coalesce(current_setting('app.card_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.transactions t
    WHERE t.invoice_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'invoice-has-history';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS invoices_delete_guard ON public.invoices;
CREATE TRIGGER invoices_delete_guard
  BEFORE DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_delete_guard();

-- ============ 2. Guard de exclusão de plano de parcelamento ============

CREATE OR REPLACE FUNCTION public.installment_plans_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF coalesce(current_setting('app.card_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.transactions t
    WHERE t.installment_plan_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'plan-has-history';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS installment_plans_delete_guard ON public.installment_plans;
CREATE TRIGGER installment_plans_delete_guard
  BEFORE DELETE ON public.installment_plans
  FOR EACH ROW EXECUTE FUNCTION public.installment_plans_delete_guard();

-- ============ 3. Índice de apoio (guard + recalc por fatura) ============

CREATE INDEX IF NOT EXISTS idx_transactions_user_invoice
  ON public.transactions (user_id, invoice_id)
  WHERE invoice_id IS NOT NULL;
