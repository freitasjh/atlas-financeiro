-- 0018_transaction_link_immutable.sql — RF03 / P2-saneamento (fecho da órfã).
--
-- Falha medida (rollback): `UPDATE transactions SET invoice_id = NULL` como
-- `authenticated` devolvia `UPDATE 1`. O `transactions_invoice_guard` (0009)
-- fazia `IF NEW.invoice_id IS NULL THEN RETURN NEW`, então o UPDATE que desfaz
-- o vínculo passava. Compra de cartão virava despesa de caixa (débito em
-- dobro). Mesmo furo existia para `installment_plan_id = NULL`.
--
-- Correção:
-- 1) `transactions_invoice_guard` cobre também o UPDATE do vínculo: se
--    `OLD.invoice_id` não é NULL e o novo valor é NULL ou diferente, levanta
--    `invoice-link-immutable`. INSERT continua livre para `invoice_id` NULL e
--    as regras de tenant/fatura paga de 0009 permanecem intactas.
-- 2) `transactions_plan_guard` (novo, BEFORE UPDATE OF installment_plan_id)
--    aplica a mesma imutabilidade ao plano: `plan-link-immutable`.
-- 3) Escape administrativo único: `SET LOCAL app.card_purge = 'on'` — o mesmo
--    GUC de 0016/0017. A cascata `invoices -> transactions` usa
--    `ON DELETE SET NULL`; durante o purge autorizado o RI dispara este
--    trigger de UPDATE e o GUC libera o unlink. Nenhum código de aplicação
--    seta esse GUC.
-- 4) `idx_transactions_user_invoice` recriado com `invoice_id` como leading
--    column: `EXISTS` dos guards e `recalc_invoice_total` (0014) filtram só
--    por `invoice_id`, então `(user_id, invoice_id)` não serve no PG 17.
--
-- Mensagens fixas, sem ids (SEC-G3). Nenhum gate por `current_user`.
-- Idempotente: CREATE OR REPLACE + DROP TRIGGER IF EXISTS + DROP/CREATE INDEX.
-- Migrations 0001–0017 intocadas. Dinheiro segue BIGINT cents.

-- ============ 1. Guard de vínculo com fatura (+ regras de 0009) ============

CREATE OR REPLACE FUNCTION public.transactions_invoice_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_user_id uuid;
BEGIN
  -- Vínculo existente é imutável. O GUC administrativo libera apenas a
  -- remoção/troca (purge de fatura usa ON DELETE SET NULL).
  IF TG_OP = 'UPDATE'
    AND OLD.invoice_id IS NOT NULL
    AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    AND coalesce(current_setting('app.card_purge', true), '') <> 'on'
  THEN
    RAISE EXCEPTION 'invoice-link-immutable';
  END IF;

  IF NEW.invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i.status, i.user_id INTO v_status, v_user_id
  FROM public.invoices i
  WHERE i.id = NEW.invoice_id;

  -- FK decide quando a fatura não existe.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- RF03-14 / F5 — isolamento de tenant. Mensagem fixa, sem ids (SEC-G3).
  IF v_user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'invoice-tenant-mismatch';
  END IF;

  -- RF03-11 — fatura paga só aceita transferência (o próprio ato de pagar).
  IF NOT COALESCE(NEW.is_transfer, false) AND v_status = 'paid' THEN
    RAISE EXCEPTION 'invoice-paid-locked';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_invoice_guard ON public.transactions;
CREATE TRIGGER transactions_invoice_guard
  BEFORE INSERT OR UPDATE OF invoice_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_invoice_guard();

-- ============ 2. Guard de vínculo com plano de parcelamento ============

CREATE OR REPLACE FUNCTION public.transactions_plan_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.installment_plan_id IS NOT NULL
    AND NEW.installment_plan_id IS DISTINCT FROM OLD.installment_plan_id
    AND coalesce(current_setting('app.card_purge', true), '') <> 'on'
  THEN
    RAISE EXCEPTION 'plan-link-immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_plan_guard ON public.transactions;
CREATE TRIGGER transactions_plan_guard
  BEFORE UPDATE OF installment_plan_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_plan_guard();

-- ============ 3. Índice de apoio (guards + recalc por fatura) ============
-- `invoice_id` como leading column: os guards filtram apenas `invoice_id`.
-- Recriação idempotente: o índice de 0017 era `(user_id, invoice_id)`.

DROP INDEX IF EXISTS public.idx_transactions_user_invoice;
CREATE INDEX idx_transactions_user_invoice
  ON public.transactions (invoice_id, user_id)
  WHERE invoice_id IS NOT NULL;
