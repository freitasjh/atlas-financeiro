-- 0014_invoice_total_rpc.sql — RF03 / P2-total-client (SPEC §4 + §8.1).
-- `total_cents` deixa de ser escrita pelo cliente: o recálculo vira uma RPC
-- `SECURITY DEFINER` escopada por `auth.uid()`.
--
-- Motivação: 0011 concedeu `UPDATE (total_cents)` a `authenticated` para o
-- recalc client-side. Qualquer sessão do tenant podia gravar um total
-- arbitrário via PostgREST, quebrando a invariante
-- `total_cents = Σ transactions(amount_cents) FILTER (is_transfer = false)`.
--
-- A RPC:
--   · valida a fatura pelo par (id, user_id = auth.uid()) ANTES de escrever;
--     fatura ausente/estrangeira devolve NULL sem tocar em nada (SEC-G1);
--   · soma no servidor, ignorando transferências (RN04: pagamento não compõe
--     o total) — BIGINT cents, sem float;
--   · devolve o novo total para o chamador.
--
-- Privilégios: `authenticated` perde a coluna `total_cents` e recebe apenas
-- EXECUTE da RPC. `PUBLIC`/`anon` não executam.
--
-- Idempotente: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0013 intocadas.

-- ============ 1. RPC de recálculo ============

CREATE OR REPLACE FUNCTION public.recalc_invoice_total(p_invoice uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  -- Fatura do próprio tenant? Sem ela, nada é escrito (nem erro com id).
  IF NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = p_invoice
      AND i.user_id = auth.uid()
  ) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(t.amount_cents) FILTER (WHERE t.is_transfer = false), 0)
    INTO v_total
  FROM public.transactions t
  WHERE t.invoice_id = p_invoice
    AND t.user_id = auth.uid();

  UPDATE public.invoices
  SET total_cents = v_total
  WHERE id = p_invoice
    AND user_id = auth.uid();

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.recalc_invoice_total(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalc_invoice_total(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.recalc_invoice_total(uuid) TO authenticated;

-- ============ 2. `total_cents` sai do privilégio do cliente ============
-- 0011 revogou UPDATE de tabela e reconcedeu só a coluna total_cents.
-- Aqui a coluna também sai: o único caminho de escrita é a RPC acima.

REVOKE UPDATE (total_cents) ON public.invoices FROM authenticated;
REVOKE UPDATE ON public.invoices FROM authenticated;
