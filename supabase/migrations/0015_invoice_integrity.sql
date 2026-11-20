-- 0015_invoice_integrity.sql — RF03 / P2-saneamento (fecho do review).
--
-- 1) INSERT de `invoices` deixa de ser por tabela: `authenticated`/`anon` só
--    podem informar as colunas do fluxo legítimo (provisionamento lazy da
--    fatura). `total_cents`, `paid_cents` e `paid_at` ficam de fora — o
--    servidor calcula o total pela RPC `recalc_invoice_total` (0014) e o
--    trigger `sync_invoice_paid_cents` (0008) cuida do pagamento. Uma INSERT
--    forjada com `total_cents` arbitrário falha com 42501 antes de tocar o
--    trigger de guarda.
--
-- 2) Exclusão de `credit_cards` com histórico é bloqueada no banco. O
--    `ON DELETE CASCADE` de `invoices` + `transactions.invoice_id ON DELETE
--    SET NULL` transformaria compras em órfãs (débito de caixa em dobro). O
--    trigger fecha a porta mesmo quando a chamada não passa pelo serviço.
--    O gate por `current_user` preserva operações administrativas (postgres)
--    e o `service_role`; a superfície do cliente (`authenticated`) é negada.
--
-- Idempotente: REVOKE/GRANT e CREATE OR REPLACE repetíveis.
-- Migrations 0001–0014 intocadas. Dinheiro segue BIGINT cents.

-- ============ 1. INSERT por coluna (fail-closed) ============

REVOKE INSERT ON public.invoices FROM authenticated;
REVOKE INSERT ON public.invoices FROM anon;

GRANT INSERT (
  user_id,
  credit_card_id,
  period_start,
  period_end,
  due_date,
  status
) ON public.invoices TO authenticated;

-- ============ 2. Guarda de exclusão de cartão com histórico ============

CREATE OR REPLACE FUNCTION public.credit_cards_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Manutenção/administração roda como owner (postgres/service_role) e não é
  -- a superfície explorável; a negação vale para o cliente autenticado.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.transactions t
    JOIN public.invoices i ON i.id = t.invoice_id
    WHERE i.credit_card_id = OLD.id
      AND t.user_id = OLD.user_id
  ) THEN
    RAISE EXCEPTION 'card-has-history';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS credit_cards_delete_guard ON public.credit_cards;
CREATE TRIGGER credit_cards_delete_guard
  BEFORE DELETE ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.credit_cards_delete_guard();
