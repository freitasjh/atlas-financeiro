-- 0011_invoice_status_lock.sql — RF03 / B3F-03 (SPEC §4 + §8.1).
-- Endurece o lock de status da fatura:
-- 1) invoices_transition_guard passa a exigir `app.invoice_rpc = 'on'` para
--    QUALQUER transição de `status` (as whitelists de open|closed -> paid e
--    closed -> open saem; pagamento/reabertura/fechamento só por RPC).
-- 2) `authenticated` perde UPDATE de `status`, `paid_cents` e `paid_at`:
--    o privilégio de tabela é revogado e reconcedido apenas nas colunas que o
--    cliente realmente escreve (`total_cents`, recalculado pelo recalc).
-- 3) reopen_invoice/close_due_invoices viram SECURITY DEFINER (igual a
--    mark_invoice_paid): continuam escopadas por `auth.uid()` e deixam de
--    depender do privilégio de coluna do invoker.
-- Decisão documentada (B3F-03 fixture): NÃO há CHECK paid_cents <= total_cents
-- (herdado de 0008 — reabertura/exclusão pode editar total sem invalidar o
-- pagamento recebido). `outstandingCents` clampa em 0 na aplicação.
-- Idempotente: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0010 intocadas. Dinheiro segue BIGINT cents.

-- ============ 1. Guard: status só transita dentro de RPC ============

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

  -- Fora de RPC nenhuma coluna sensível muda — sem whitelist de transição.
  IF NEW.paid_cents IS DISTINCT FROM OLD.paid_cents THEN
    RAISE EXCEPTION 'invoice-paid-cents-locked';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invoice-status-locked';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_transition_guard ON public.invoices;
CREATE TRIGGER invoices_transition_guard
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_transition_guard();

-- ============ 2. RPCs de status com SECURITY DEFINER ============
-- O invoker (authenticated) não tem mais UPDATE(status); a função roda como o
-- dono e mantém o filtro explícito `user_id = auth.uid()` (SEC-G1).

CREATE OR REPLACE FUNCTION public.reopen_invoice(p_invoice uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
SECURITY DEFINER
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

-- ============ 3. Privilégio de coluna para authenticated ============
-- UPDATE de tabela cobre TODAS as colunas; revogar coluna após grant de tabela
-- não restringe nada. Por isso: revoga o privilégio de tabela e reconcede só
-- as colunas que o cliente escreve (recalc de total_cents). INSERT/SELECT/
-- DELETE continuam como estão (policies RLS inalteradas).

REVOKE UPDATE ON public.invoices FROM authenticated;
GRANT UPDATE (total_cents) ON public.invoices TO authenticated;
