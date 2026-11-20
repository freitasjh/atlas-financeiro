-- 0009_invoice_guard.sql — RF03 (SPEC §3 + §8.1): guardas de fatura.
-- 1) transactions_invoice_guard: despesa não pode entrar em fatura 'paid' e o
--    invoice_id precisa pertencer ao mesmo tenant da transação (F5).
-- 2) invoices_transition_guard (SEC-G2): paid_cents/status não são editáveis
--    direto via PostgREST; transições ocorrem por RPC.
-- 3) RPCs reopen_invoice / close_due_invoices filtradas por auth.uid().
-- SECURITY DEFINER com SET search_path = public (anti search_path hijack).
-- Migrations 0001–0008 intocadas. Dinheiro segue BIGINT cents.

-- ============ 1. Guard de transações por fatura ============

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

-- ============ 2. Guard de transições da fatura (SEC-G2) ============
-- Fora de RPC (GUC app.invoice_rpc='on'):
--   · paid_cents imutável, exceto a aplicação do próprio pagamento;
--   · status só vai para 'paid' vindo de open/closed (payInvoice existente) e
--     closed → open (compra retroativa em ciclo já fechado).
--   · partial → paid e paid → open/partial exigem RPC (reabertura/pagamento).

CREATE OR REPLACE FUNCTION public.invoices_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_in_rpc boolean := COALESCE(current_setting('app.invoice_rpc', true), '') = 'on';
BEGIN
  IF v_in_rpc THEN
    RETURN NEW;
  END IF;

  IF NEW.paid_cents IS DISTINCT FROM OLD.paid_cents THEN
    IF NOT (
      NEW.status = 'paid'
      AND OLD.status IS DISTINCT FROM 'paid'
      AND NEW.paid_cents = NEW.total_cents
    ) THEN
      RAISE EXCEPTION 'invoice-paid-cents-locked';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (NEW.status = 'paid' AND OLD.status IN ('open', 'closed'))
      OR (NEW.status = 'open' AND OLD.status = 'closed')
    ) THEN
      RAISE EXCEPTION 'invoice-status-locked';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_transition_guard ON public.invoices;
CREATE TRIGGER invoices_transition_guard
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_transition_guard();

-- ============ 3. RPCs (SEC-G1: filtro explícito de dono + grant mínimo) ============

CREATE OR REPLACE FUNCTION public.reopen_invoice(p_invoice uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Marca a transação corrente como operação de RPC (o guard permite a transição).
  PERFORM set_config('app.invoice_rpc', 'on', true);
  UPDATE public.invoices
  SET status = 'partial'
  WHERE id = p_invoice
    AND user_id = auth.uid()
    AND status = 'paid';
END;
$$;

CREATE OR REPLACE FUNCTION public.close_due_invoices(p_today date)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('app.invoice_rpc', 'on', true);
  UPDATE public.invoices
  SET status = 'closed'
  WHERE user_id = auth.uid()
    AND status = 'open'
    AND period_end < p_today;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_invoice(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_invoice(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.reopen_invoice(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.close_due_invoices(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_due_invoices(date) FROM anon;
GRANT EXECUTE ON FUNCTION public.close_due_invoices(date) TO authenticated;
