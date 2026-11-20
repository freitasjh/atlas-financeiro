-- 0008_invoice_partial.sql — RF03 (SPEC §3): fatura com pagamento parcial.
-- Aditiva e idempotente: paid_cents BIGINT cents + backfill + status 'partial'
-- + trigger que sincroniza paid_cents na transição para pago.
-- NUNCA adiciona CHECK (paid_cents <= total_cents): fatura reaberta pode ter
-- total editado (exclusão de compra) sem invalidar o pagamento já recebido.
-- Migrations 0001–0007 intocadas.

-- ============ 1. Coluna paid_cents (BIGINT cents, default 0) ============

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS paid_cents bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoices_paid_cents_nonneg'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_paid_cents_nonneg CHECK (paid_cents >= 0);
  END IF;
END $$;

-- ============ 2. Backfill idempotente (fatura paga = pagamento integral) ============

UPDATE public.invoices
SET paid_cents = total_cents
WHERE status = 'paid' AND paid_cents = 0;

-- ============ 3. Status check recriado com o MESMO nome (ddl.spec T10) ============
-- DROP/ADD com mesmo nome é idempotente-safe: reexecutar não duplica constraint.

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('open', 'closed', 'partial', 'paid'));

-- ============ 4. Trigger sync_invoice_paid_cents ============
-- Invariante: status='paid' ⇒ paid_cents = total_cents no momento da transição.
-- Reabertura (paid → partial) preserva paid_cents.

CREATE OR REPLACE FUNCTION public.sync_invoice_paid_cents()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'paid' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.paid_cents := NEW.total_cents;
    ELSIF OLD.status IS DISTINCT FROM 'paid' THEN
      NEW.paid_cents := NEW.total_cents;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_invoice_paid_cents ON public.invoices;
CREATE TRIGGER sync_invoice_paid_cents
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.sync_invoice_paid_cents();
