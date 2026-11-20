-- 0012_invoice_pay_atomic.sql — RF03 / B3F2-01 (SPEC §4 + §8.1).
-- Pagamento de fatura atômico: uma única RPC transacional faz o lock da
-- fatura, calcula o saldo devedor no servidor, valida a conta de origem,
-- insere a transferência 1-row e marca a fatura como paga. Qualquer RAISE
-- desfaz TUDO (não existe fatura paga sem débito nem transferência órfã).
--
-- Concorrência: `SELECT ... FOR UPDATE` serializa duas abas/duas sessões.
-- Sob READ COMMITTED a 2ª chamada reavalia o WHERE depois do lock e enxerga
-- `status='paid'` → `invoice-already-paid` (paga uma vez só).
--
-- Segurança: SECURITY DEFINER + `SET search_path = public`; todo predicado
-- filtra `user_id = auth.uid()` (SEC-G1). Mensagens de erro fixas, sem ids
-- (SEC-G3). Dinheiro segue BIGINT cents.
--
-- `mark_invoice_paid` (0010) deixa de ser pública: o pagamento só existe na
-- forma atômica. A função antiga permanece para uso interno/service_role.
--
-- Idempotente: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0011 intocadas.

CREATE OR REPLACE FUNCTION public.pay_invoice(
  p_invoice uuid,
  p_account uuid,
  p_date date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_paid bigint;
  v_status text;
  v_amount bigint;
  v_tx_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice-not-found';
  END IF;

  -- 1) Lock da fatura do tenant: serializa pagamentos concorrentes.
  SELECT i.total_cents, i.paid_cents, i.status
    INTO v_total, v_paid, v_status
  FROM public.invoices i
  WHERE i.id = p_invoice
    AND i.user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice-not-found';
  END IF;

  -- 2) Fatura já quitada: nunca gera débito duplicado.
  IF v_status = 'paid' THEN
    RAISE EXCEPTION 'invoice-already-paid';
  END IF;

  -- 3) O valor transferido é o saldo devedor (total − paid), clampado em 0.
  v_amount := GREATEST(v_total - v_paid, 0);
  IF v_amount = 0 THEN
    RAISE EXCEPTION 'invoice-nothing-to-pay';
  END IF;

  -- 4) Conta de origem precisa existir no MESMO tenant.
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = p_account
      AND a.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'account-not-found';
  END IF;

  -- 5) Transferência interna 1-row (RN04): invoice_id, categoria NULL,
  --    is_transfer = true; nunca despesa de cartão.
  INSERT INTO public.transactions (
    user_id,
    account_id,
    invoice_id,
    category_id,
    description,
    amount_cents,
    date,
    type,
    is_transfer
  ) VALUES (
    auth.uid(),
    p_account,
    p_invoice,
    NULL,
    'Pagamento de fatura',
    v_amount,
    p_date,
    'expense',
    true
  )
  RETURNING id INTO v_tx_id;

  -- 6) Transição de status liberada só dentro da RPC (0011).
  PERFORM set_config('app.invoice_rpc', 'on', true);

  UPDATE public.invoices
  SET status = 'paid',
      paid_at = now()
  WHERE id = p_invoice
    AND user_id = auth.uid();

  RETURN v_tx_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pay_invoice(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pay_invoice(uuid, uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.pay_invoice(uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_invoice(uuid, uuid, date) TO service_role;

-- A RPC antiga vira detalhe interno: o cliente não pode marcar fatura paga
-- sem o débito correspondente.
REVOKE ALL ON FUNCTION public.mark_invoice_paid(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_invoice_paid(uuid) TO service_role;
