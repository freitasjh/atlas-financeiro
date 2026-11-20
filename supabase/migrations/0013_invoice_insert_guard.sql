-- 0013_invoice_insert_guard.sql — RF03 / B3F2-03 (SPEC §4 + §8.1).
-- Guarda de INSERT em `invoices`: nenhuma fatura nasce paga (nem com
-- `paid_cents` artificial) e o cartão referenciado precisa pertencer ao
-- mesmo tenant da fatura. Fecha a porta pela qual `authenticated` poderia
-- criar `status='paid'` direto via PostgREST.
--
-- Normalização (em vez de erro) para `status`/`paid_cents`/`paid_at`:
-- o INSERT nunca "resulta em fatura paga"; o valor pedido é descartado.
-- O cartão é validado com EXISTS sob RLS (`auth.uid() = user_id`), então um
-- cartão de outro tenant é invisível → `invoice-card-tenant-mismatch`.
--
-- Ordem dos triggers BEFORE INSERT é alfabética: `invoices_insert_guard`
-- roda antes de `sync_invoice_paid_cents` (0008), que passa a ver
-- `status='open'` e não toca em `paid_cents`.
--
-- Idempotente: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- Migrations 0001–0012 intocadas.

CREATE OR REPLACE FUNCTION public.invoices_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Fatura só nasce aberta e sem pagamento.
  NEW.status := 'open';
  NEW.paid_cents := 0;
  NEW.paid_at := NULL;

  IF NOT EXISTS (
    SELECT 1 FROM public.credit_cards c
    WHERE c.id = NEW.credit_card_id
      AND c.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'invoice-card-tenant-mismatch';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_insert_guard ON public.invoices;
CREATE TRIGGER invoices_insert_guard
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_insert_guard();
