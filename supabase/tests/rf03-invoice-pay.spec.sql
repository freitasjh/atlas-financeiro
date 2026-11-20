-- rf03-invoice-pay.spec.sql — RF03 / B3F2-01 (SPEC §4 + §8.1).
-- Uso: supabase db reset && psql "$DB_URL" -f supabase/tests/rf03-invoice-pay.spec.sql
-- Cobre a RPC atômica pay_invoice(p_invoice, p_account, p_date) (0012):
--   T1 open     → paid, transferência 1-row com o valor cheio
--   T2 partial  → paid, transferência do saldo devedor (total − paid)
--   T3 paid     → erro 'invoice-already-paid' e nenhuma transferência nova
--   T4 saldo 0  → erro 'invoice-nothing-to-pay' (reabrir→pagar sem beco sem saída)
--   T5 conta de outro tenant → 'account-not-found' e nada é gravado
--   T6 fatura de outro tenant → 'invoice-not-found' e nada é gravado
--   T7 concorrência (duas sessões via dblink) → paga uma vez só
--   T8 grants: pay_invoice só para authenticated/service_role; mark_invoice_paid
--      não é mais executável pelo cliente
--   T9 UPDATE direto de status/paid_cents segue bloqueado
--   T10 falha em qualquer etapa não deixa transferência órfã nem fatura paga.
--
-- 0013 força `status='open'`/`paid_cents=0` no INSERT: fixtures usam o GUC
-- transacional `app.invoice_rpc` para montar os estados parcial/pago.

-- ============ Fixtures (como postgres, RLS bypass) ============

SELECT set_config('app.card_purge', 'on', false);
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'aaaa0000-0000-4000-8000-000000000001',
  'bbbb0000-0000-4000-8000-000000000002'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

SELECT set_config('app.card_purge', 'off', false);
INSERT INTO auth.users (id, email) VALUES
  ('aaaa0000-0000-4000-8000-000000000001', 'rf03pay-a@example.com'),
  ('bbbb0000-0000-4000-8000-000000000002', 'rf03pay-b@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['aaaa0000-0000-4000-8000-000000000001'::uuid, 'bbbb0000-0000-4000-8000-000000000002'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600007000 + v_i)::text, 11, '0'),
            'Fixture rf03', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('e0000000-0000-4000-8000-00000000000a', 'aaaa0000-0000-4000-8000-000000000001', 'Conta A', 'checking', 0, 0),
  ('f0000000-0000-4000-8000-00000000000b', 'bbbb0000-0000-4000-8000-000000000002', 'Conta B', 'checking', 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day) VALUES
  ('e0000000-0000-4000-8000-00000000000c', 'aaaa0000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000a', 'Cartão A', 100000, 15, 22),
  ('f0000000-0000-4000-8000-00000000000d', 'bbbb0000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-00000000000b', 'Cartão B', 100000, 15, 22)
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.invoices WHERE id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000004',
  '40000000-0000-4000-8000-000000000004',
  '50000000-0000-4000-8000-000000000005',
  '30000000-0000-4000-8000-000000000006'
);

-- 0013: toda fatura nasce open/paid_cents=0; o estado desejado é montado
-- depois no bloco com app.invoice_rpc='on'.
INSERT INTO public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, status, total_cents) VALUES
  ('30000000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000c', '2026-01-01', '2026-01-15', '2026-01-22', 'open', 5000),
  ('30000000-0000-4000-8000-000000000002', 'aaaa0000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000c', '2026-02-01', '2026-02-15', '2026-02-22', 'open', 6000),
  ('30000000-0000-4000-8000-000000000003', 'aaaa0000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000c', '2026-03-01', '2026-03-15', '2026-03-22', 'open', 7000),
  ('30000000-0000-4000-8000-000000000004', 'aaaa0000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000c', '2026-04-01', '2026-04-15', '2026-04-22', 'open', 8000),
  ('40000000-0000-4000-8000-000000000004', 'bbbb0000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-00000000000d', '2026-01-01', '2026-01-15', '2026-01-22', 'open', 9000),
  ('50000000-0000-4000-8000-000000000005', 'aaaa0000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000c', '2026-05-01', '2026-05-15', '2026-05-22', 'open', 12345),
  ('30000000-0000-4000-8000-000000000006', 'aaaa0000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000c', '2026-06-01', '2026-06-15', '2026-06-22', 'open', 4000);

DO $$
BEGIN
  PERFORM set_config('app.invoice_rpc', 'on', true);

  -- parcial: total 6000, já pago 2000 (saldo devedor 4000)
  UPDATE public.invoices
  SET status = 'partial', paid_cents = 2000
  WHERE id = '30000000-0000-4000-8000-000000000002';

  -- saldo devedor zero (paid_cents = total) ainda não marcada como paga
  UPDATE public.invoices
  SET paid_cents = 7000
  WHERE id = '30000000-0000-4000-8000-000000000003';

  -- já paga (sync preenche paid_cents = total)
  UPDATE public.invoices
  SET status = 'paid'
  WHERE id = '30000000-0000-4000-8000-000000000004';
END $$;

-- ============ T1: open → paid com transferência 1-row ============

SELECT set_config('request.jwt.claims', '{"sub":"aaaa0000-0000-4000-8000-000000000001","role":"authenticated"}', false);
SET ROLE authenticated;

DO $$
DECLARE
  v_tx uuid;
  v_status text;
  v_paid bigint;
  v_paid_at timestamptz;
  v_rows integer;
  v_amount bigint;
  v_is_transfer boolean;
  v_category_is_null boolean;
BEGIN
  v_tx := public.pay_invoice(
    '30000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-00000000000a',
    '2026-01-22'
  );
  IF v_tx IS NULL THEN
    RAISE EXCEPTION 'rf03pay T1 falhou: pay_invoice não devolveu o id da transação';
  END IF;

  SELECT status, paid_cents, paid_at INTO v_status, v_paid, v_paid_at
  FROM public.invoices WHERE id = '30000000-0000-4000-8000-000000000001';
  IF v_status <> 'paid' OR v_paid <> 5000 OR v_paid_at IS NULL THEN
    RAISE EXCEPTION 'rf03pay T1 falhou: status=% paid_cents=% paid_at=%', v_status, v_paid, v_paid_at;
  END IF;

  SELECT count(*), max(amount_cents), bool_and(is_transfer), bool_and(category_id IS NULL)
    INTO v_rows, v_amount, v_is_transfer, v_category_is_null
  FROM public.transactions
  WHERE invoice_id = '30000000-0000-4000-8000-000000000001'
    AND user_id = 'aaaa0000-0000-4000-8000-000000000001';

  IF v_rows <> 1 OR v_amount <> 5000 OR NOT v_is_transfer OR NOT v_category_is_null THEN
    RAISE EXCEPTION 'rf03pay T1 falhou: rows=% amount=% transfer=% category_null=%',
      v_rows, v_amount, v_is_transfer, v_category_is_null;
  END IF;
  RAISE NOTICE 'rf03pay T1 ok: open → paid + transferência 1-row (5000)';
END $$;

-- ============ T2: partial cobra o saldo devedor ============

DO $$
DECLARE
  v_rows integer;
  v_amount bigint;
  v_status text;
  v_paid bigint;
BEGIN
  PERFORM public.pay_invoice(
    '30000000-0000-4000-8000-000000000002',
    'e0000000-0000-4000-8000-00000000000a',
    '2026-02-22'
  );

  SELECT count(*), max(amount_cents) INTO v_rows, v_amount
  FROM public.transactions WHERE invoice_id = '30000000-0000-4000-8000-000000000002';
  IF v_rows <> 1 OR v_amount <> 4000 THEN
    RAISE EXCEPTION 'rf03pay T2 falhou: rows=% amount=% (esperado 1/4000)', v_rows, v_amount;
  END IF;

  SELECT status, paid_cents INTO v_status, v_paid
  FROM public.invoices WHERE id = '30000000-0000-4000-8000-000000000002';
  IF v_status <> 'paid' OR v_paid <> 6000 THEN
    RAISE EXCEPTION 'rf03pay T2 falhou: status=% paid_cents=% (esperado paid/6000)', v_status, v_paid;
  END IF;
  RAISE NOTICE 'rf03pay T2 ok: partial transfere 4000 (saldo) e quita paid_cents';
END $$;

-- ============ T3: já paga → invoice-already-paid, sem transferência ============

DO $$
DECLARE
  v_before integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.transactions
  WHERE invoice_id = '30000000-0000-4000-8000-000000000004';

  BEGIN
    PERFORM public.pay_invoice(
      '30000000-0000-4000-8000-000000000004',
      'e0000000-0000-4000-8000-00000000000a',
      '2026-04-22'
    );
    RAISE EXCEPTION 'rf03pay T3 falhou: fatura já paga aceitou novo pagamento';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03pay T3 falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%invoice-already-paid%' THEN
      RAISE EXCEPTION 'rf03pay T3 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;

  IF (SELECT count(*) FROM public.transactions
      WHERE invoice_id = '30000000-0000-4000-8000-000000000004') <> v_before THEN
    RAISE EXCEPTION 'rf03pay T3 falhou: pagamento recusado deixou transferência';
  END IF;
  RAISE NOTICE 'rf03pay T3 ok: already-paid sem débito duplicado';
END $$;

-- ============ T4: saldo devedor zero → invoice-nothing-to-pay ============
-- B3F2-06: reabrir → pagar com outstanding = 0 não é beco sem saída; o erro é
-- explícito e a UI bloqueia o CTA (B5). Nada é gravado e a fatura não vira paga.

DO $$
DECLARE
  v_status text;
BEGIN
  BEGIN
    PERFORM public.pay_invoice(
      '30000000-0000-4000-8000-000000000003',
      'e0000000-0000-4000-8000-00000000000a',
      '2026-03-22'
    );
    RAISE EXCEPTION 'rf03pay T4 falhou: pagou fatura sem saldo devedor';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03pay T4 falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%invoice-nothing-to-pay%' THEN
      RAISE EXCEPTION 'rf03pay T4 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;

  SELECT status INTO v_status FROM public.invoices
  WHERE id = '30000000-0000-4000-8000-000000000003';
  IF v_status = 'paid' THEN
    RAISE EXCEPTION 'rf03pay T4 falhou: fatura sem débito foi marcada como paga';
  END IF;
  IF EXISTS (SELECT 1 FROM public.transactions WHERE invoice_id = '30000000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'rf03pay T4 falhou: fatura sem débito ganhou transferência';
  END IF;
  RAISE NOTICE 'rf03pay T4 ok: nothing-to-pay sem transferência e sem paid';
END $$;

-- ============ T5: conta de outro tenant → account-not-found ============

DO $$
DECLARE
  v_status text;
BEGIN
  BEGIN
    PERFORM public.pay_invoice(
      '30000000-0000-4000-8000-000000000006',
      'f0000000-0000-4000-8000-00000000000b',
      '2026-06-22'
    );
    RAISE EXCEPTION 'rf03pay T5 falhou: aceitou conta de outro tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03pay T5 falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%account-not-found%' THEN
      RAISE EXCEPTION 'rf03pay T5 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;

  SELECT status INTO v_status FROM public.invoices
  WHERE id = '30000000-0000-4000-8000-000000000006';
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'rf03pay T5 falhou: recusa de conta alterou a fatura (status=%)', v_status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.transactions WHERE invoice_id = '30000000-0000-4000-8000-000000000006') THEN
    RAISE EXCEPTION 'rf03pay T5 falhou: recusa de conta deixou transferência';
  END IF;
  RAISE NOTICE 'rf03pay T5 ok: conta de outro tenant recusada sem efeito';
END $$;

-- ============ T6: fatura de outro tenant → invoice-not-found ============

DO $$
BEGIN
  BEGIN
    PERFORM public.pay_invoice(
      '40000000-0000-4000-8000-000000000004',
      'e0000000-0000-4000-8000-00000000000a',
      '2026-01-22'
    );
    RAISE EXCEPTION 'rf03pay T6 falhou: pagou fatura de outro tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03pay T6 falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%invoice-not-found%' THEN
      RAISE EXCEPTION 'rf03pay T6 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;

  IF EXISTS (SELECT 1 FROM public.transactions
             WHERE invoice_id = '40000000-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'rf03pay T6 falhou: fatura de outro tenant ganhou transferência';
  END IF;
  RAISE NOTICE 'rf03pay T6 ok: isolamento de tenant preservado';
END $$;

RESET ROLE;

-- ============ T7: concorrência — duas sessões, um único pagamento ============
-- dblink (na schema `extensions`, como no Supabase) abre a 2ª sessão.
-- A sessão principal segura o lock e comita; a 2ª acorda, reavalia a linha e
-- recebe 'invoice-already-paid'. Exatamente 1 transferência existe no fim.

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

SELECT extensions.dblink_connect(
  'rf03pay_conc',
  format(
    'host=%s port=%s dbname=%s user=postgres password=postgres',
    host(inet_server_addr()), inet_server_port(), current_database()
  )
);

SELECT extensions.dblink_exec(
  'rf03pay_conc',
  'SET request.jwt.claims = ''{"sub":"aaaa0000-0000-4000-8000-000000000001","role":"authenticated"}'''
);

SELECT set_config('request.jwt.claims', '{"sub":"aaaa0000-0000-4000-8000-000000000001","role":"authenticated"}', false);

BEGIN;

SELECT public.pay_invoice(
  '50000000-0000-4000-8000-000000000005',
  'e0000000-0000-4000-8000-00000000000a',
  '2026-05-22'
) AS conc_tx;

-- dispara a 2ª sessão enquanto o lock ainda está com a principal
SELECT extensions.dblink_send_query(
  'rf03pay_conc',
  'SELECT public.pay_invoice(''50000000-0000-4000-8000-000000000005'', ''e0000000-0000-4000-8000-00000000000a'', ''2026-05-22'')'
);

COMMIT;

RESET ROLE;

DO $$
DECLARE
  v_err text := '';
BEGIN
  BEGIN
    PERFORM 1 FROM extensions.dblink_get_result('rf03pay_conc') AS t(tx uuid);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err NOT LIKE '%invoice-already-paid%' THEN
    RAISE EXCEPTION 'rf03pay T7 falhou: 2ª sessão não recebeu already-paid (%)',
      COALESCE(NULLIF(v_err, ''), 'pagou de novo');
  END IF;

  IF (SELECT count(*) FROM public.transactions
      WHERE invoice_id = '50000000-0000-4000-8000-000000000005') <> 1 THEN
    RAISE EXCEPTION 'rf03pay T7 falhou: concorrência gerou débito duplicado';
  END IF;

  IF (SELECT paid_cents FROM public.invoices
      WHERE id = '50000000-0000-4000-8000-000000000005') <> 12345 THEN
    RAISE EXCEPTION 'rf03pay T7 falhou: fatura não foi quitada pelo valor certo';
  END IF;

  RAISE NOTICE 'rf03pay T7 ok: duas sessões pagam uma vez só';
END $$;

SELECT extensions.dblink_disconnect('rf03pay_conc');

-- ============ T8: grants (SEC-G1) ============

DO $$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.pay_invoice(uuid,uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rf03pay T8 falhou: authenticated sem EXECUTE em pay_invoice';
  END IF;
  IF has_function_privilege('anon', 'public.pay_invoice(uuid,uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rf03pay T8 falhou: anon com EXECUTE em pay_invoice';
  END IF;
  IF has_function_privilege('authenticated', 'public.mark_invoice_paid(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rf03pay T8 falhou: authenticated ainda executa mark_invoice_paid';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.mark_invoice_paid(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rf03pay T8 falhou: service_role perdeu mark_invoice_paid (uso interno)';
  END IF;
  RAISE NOTICE 'rf03pay T8 ok: EXECUTE de pagamento só na RPC atômica';
END $$;

-- ============ T9: UPDATE direto segue bloqueado ============
-- Reabre a fatura de concorrência (paid → partial) numa transação própria: o
-- GUC app.invoice_rpc é transacional e não vaza para o UPDATE direto.

SET ROLE authenticated;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"aaaa0000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  PERFORM public.reopen_invoice('50000000-0000-4000-8000-000000000005');
  IF (SELECT paid_cents FROM public.invoices WHERE id = '50000000-0000-4000-8000-000000000005') <> 12345 THEN
    RAISE EXCEPTION 'rf03pay T9 prep falhou: reabertura não preservou paid_cents';
  END IF;
END $$;

DO $$
BEGIN
  -- Transação própria: o GUC app.invoice_rpc ligado pela reabertura já expirou.
  BEGIN
    UPDATE public.invoices SET status = 'paid' WHERE id = '50000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'rf03pay T9a falhou: partial → paid direto permitido';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03pay T9a falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%invoice-status-locked%' AND SQLERRM NOT LIKE '%permission denied%' THEN
      RAISE EXCEPTION 'rf03pay T9a falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;

  BEGIN
    UPDATE public.invoices SET paid_cents = 1 WHERE id = '50000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'rf03pay T9b falhou: UPDATE direto de paid_cents permitido';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03pay T9b falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%invoice-paid-cents-locked%' AND SQLERRM NOT LIKE '%permission denied%' THEN
      RAISE EXCEPTION 'rf03pay T9b falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;

  -- B3F2-06 — exatamente o caminho reabrir → pagar com saldo devedor zero:
  -- a reabertura preservou paid_cents = total, então o pagamento é recusado
  -- com 'invoice-nothing-to-pay' (a UI bloqueará o CTA em B5).
  BEGIN
    PERFORM public.pay_invoice(
      '50000000-0000-4000-8000-000000000005',
      'e0000000-0000-4000-8000-00000000000a',
      '2026-11-03'
    );
    RAISE EXCEPTION 'rf03pay T9c falhou: reabrir → pagar sem saldo foi aceito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03pay T9c falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%invoice-nothing-to-pay%' THEN
      RAISE EXCEPTION 'rf03pay T9c falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;

  IF (SELECT count(*) FROM public.transactions
      WHERE invoice_id = '50000000-0000-4000-8000-000000000005') <> 1 THEN
    RAISE EXCEPTION 'rf03pay T9c falhou: reopen → pay sem saldo gerou transferência';
  END IF;

  RAISE NOTICE 'rf03pay T9 ok: status/paid_cents só mudam por RPC';
END $$;

RESET ROLE;

-- ============ Limpeza ============

SELECT set_config('request.jwt.claims', '', false);

SELECT set_config('app.card_purge', 'on', false);
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'aaaa0000-0000-4000-8000-000000000001',
  'bbbb0000-0000-4000-8000-000000000002'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

SELECT set_config('app.card_purge', 'off', false);
