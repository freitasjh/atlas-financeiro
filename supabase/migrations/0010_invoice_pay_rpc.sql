-- 0010_invoice_pay_rpc.sql — RF03 (SPEC §4 / TASKS MIG-06): pagamento de fatura por RPC.
-- `invoices_transition_guard` (0009) bloqueia `partial → paid` fora de RPC; o
-- pagamento pelo cliente passa a ser `mark_invoice_paid`, que liga o GUC
-- `app.invoice_rpc` na transação corrente e delega a transição ao banco.
-- SECURITY DEFINER + SET search_path = public: sem hijack de search_path e o
-- filtro explícito `user_id = auth.uid()` garante isolamento de tenant (SEC-G1).
-- Idempotente: a 2ª chamada para a mesma fatura retorna 0 (status já 'paid').
-- Migrations 0001–0009 intocadas. Dinheiro segue BIGINT cents.

CREATE OR REPLACE FUNCTION public.mark_invoice_paid(p_invoice uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- GUC transacional que libera a transição no invoices_transition_guard.
  PERFORM set_config('app.invoice_rpc', 'on', true);

  UPDATE public.invoices
  SET status = 'paid',
      paid_at = now()
  WHERE id = p_invoice
    AND user_id = auth.uid()
    AND status IN ('open', 'closed', 'partial');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_invoice_paid(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_invoice_paid(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_invoice_paid(uuid) TO authenticated;
