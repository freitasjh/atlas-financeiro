-- rf03-invoices.spec.sql — RF03 (SPEC §3 / §8.1) — TDD de migrations 0008/0009.
-- Uso: supabase db reset && psql "$DB_URL" -f supabase/tests/rf03-invoices.spec.sql
-- Falha (RAISE EXCEPTION) se qualquer invariante ausente:
--   paid_cents sync na transição para pago; paid_cents/status imutáveis direto;
--   RPCs idempotentes e escopadas por auth.uid(); guard de transações
--   (fatura paga × transferência × tenant); INSERT por coluna e exclusão de
--   cartão com histórico bloqueada no banco (0015).

-- ============ Fixtures (como postgres, RLS bypass) ============

-- 0016: purge de tenant exige o GUC explícito (cascade accounts → cards →
-- invoices). Reset após o DELETE para reativar o guard nos testes.
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
  ('aaaa0000-0000-4000-8000-000000000001', 'rf03-a@example.com'),
  ('bbbb0000-0000-4000-8000-000000000002', 'rf03-b@example.com');

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
    VALUES ('pf', v_user, pg_catalog.lpad((74600008000 + v_i)::text, 11, '0'),
            'Fixture rf03', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('a0000000-0000-4000-8000-00000000000a', 'aaaa0000-0000-4000-8000-000000000001', 'Conta A', 'checking', 0, 0),
  ('b0000000-0000-4000-8000-00000000000b', 'bbbb0000-0000-4000-8000-000000000002', 'Conta B', 'checking', 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day) VALUES
  ('c0000000-0000-4000-8000-00000000000c', 'aaaa0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'Cartão A', 100000, 15, 22),
  ('d0000000-0000-4000-8000-00000000000d', 'bbbb0000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b', 'Cartão B', 100000, 15, 22)
ON CONFLICT (id) DO NOTHING;

-- invA_paid: paga (sync do trigger); invA_partial: alvo da reabertura;
-- invA_paid2: paga p/ guard de transações; invA_open/expired: fechamento por RPC.
INSERT INTO public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, status, total_cents) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', '2026-01-01', '2026-01-15', '2026-01-22', 'open', 5000),
  ('10000000-0000-4000-8000-000000000002', 'aaaa0000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', '2026-02-01', '2026-02-15', '2026-02-22', 'open', 6000),
  ('10000000-0000-4000-8000-000000000003', 'aaaa0000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', '2026-03-01', '2026-03-15', '2026-03-22', 'open', 7000),
  ('20000000-0000-4000-8000-000000000001', 'bbbb0000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-00000000000d', '2026-01-01', '2026-01-15', '2026-01-22', 'open', 9000)
ON CONFLICT (id) DO NOTHING;

-- Fecha invA_paid (open → paid) como o payInvoice faz; sync deve gravar paid_cents.
-- B3F-03: 0011 exige `app.invoice_rpc = 'on'` para qualquer transição de
-- status; a fixture liga o GUC localmente (revertido ao fim do DO).
DO $$
BEGIN
  PERFORM set_config('app.invoice_rpc', 'on', true);
  UPDATE public.invoices SET status = 'paid' WHERE id = '10000000-0000-4000-8000-000000000001';
  UPDATE public.invoices SET status = 'paid' WHERE id = '10000000-0000-4000-8000-000000000003';
  UPDATE public.invoices SET status = 'paid' WHERE id = '20000000-0000-4000-8000-000000000001';
END $$;

-- ============ T1: sync_invoice_paid_cents na transição ============
DO $$
DECLARE v_paid bigint; v_total bigint;
BEGIN
  SELECT paid_cents, total_cents INTO v_paid, v_total
  FROM public.invoices WHERE id = '10000000-0000-4000-8000-000000000001';
  IF v_paid <> v_total OR v_paid <> 5000 THEN
    RAISE EXCEPTION 'rf03 T1 falhou: paid_cents=% total=% (esperado 5000)', v_paid, v_total;
  END IF;
  RAISE NOTICE 'rf03 T1 ok: paid_cents = total na transição para paid';
END $$;

-- ============ T2: paid_cents não é editável direto (SEC-G2) ============
DO $$
BEGIN
  UPDATE public.invoices SET paid_cents = 1 WHERE id = '10000000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'rf03 T2 falhou: UPDATE direto de paid_cents permitido';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'rf03 T2 falhou%' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE '%invoice-paid-cents-locked%' THEN
    RAISE EXCEPTION 'rf03 T2 falhou: negação veio da camada errada (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'rf03 T2 ok: paid_cents imutável fora do pagamento';
END $$;

-- ============ T3: paid → open bloqueado direto ============
DO $$
BEGIN
  UPDATE public.invoices SET status = 'open' WHERE id = '10000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'rf03 T3 falhou: paid → open permitido direto';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'rf03 T3 falhou%' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE '%invoice-status-locked%' THEN
    RAISE EXCEPTION 'rf03 T3 falhou: negação veio da camada errada (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'rf03 T3 ok: paid → open exige RPC';
END $$;

-- ============ T4: RPC reopen_invoice (dono, idempotente, preserva pagamento) ============
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaa0000-0000-4000-8000-000000000001', false);

SELECT public.reopen_invoice('10000000-0000-4000-8000-000000000001');

DO $$
DECLARE v_status text; v_paid bigint;
BEGIN
  SELECT status, paid_cents INTO v_status, v_paid
  FROM public.invoices WHERE id = '10000000-0000-4000-8000-000000000001';
  IF v_status <> 'partial' THEN
    RAISE EXCEPTION 'rf03 T4 falhou: status=% (esperado partial)', v_status;
  END IF;
  IF v_paid <> 5000 THEN
    RAISE EXCEPTION 'rf03 T4 falhou: paid_cents=% perdeu o pagamento', v_paid;
  END IF;
  RAISE NOTICE 'rf03 T4 ok: reopen preserva paid_cents';
END $$;

-- 2ª chamada: no-op (não volta a mudar nada)
SELECT public.reopen_invoice('10000000-0000-4000-8000-000000000001');
DO $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.invoices WHERE id = '10000000-0000-4000-8000-000000000001';
  IF v_status <> 'partial' THEN
    RAISE EXCEPTION 'rf03 T4b falhou: 2ª chamada alterou status=%', v_status;
  END IF;
  RAISE NOTICE 'rf03 T4b ok: reopen idempotente';
END $$;

-- ============ T5: partial → paid bloqueado direto; outro tenant não reabre ============
-- B3F-03: authenticated perdeu UPDATE(status) — a negação pode vir do privilégio
-- de coluna (42501) ou do trigger de transição (invoice-status-locked).
DO $$
BEGIN
  UPDATE public.invoices SET status = 'paid' WHERE id = '10000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'rf03 T5 falhou: partial → paid permitido direto';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'rf03 T5 falhou%' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE '%invoice-status-locked%' AND SQLERRM NOT LIKE '%permission denied%' THEN
    RAISE EXCEPTION 'rf03 T5 falhou: negação veio da camada errada (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'rf03 T5 ok: partial → paid exige RPC';
END $$;

SELECT set_config('request.jwt.claim.sub', 'bbbb0000-0000-4000-8000-000000000002', false);
SELECT public.reopen_invoice('10000000-0000-4000-8000-000000000003');
DO $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.invoices WHERE id = '10000000-0000-4000-8000-000000000003';
  IF v_status <> 'paid' THEN
    RAISE EXCEPTION 'rf03 T5b falhou: outro tenant reabriu fatura (status=%)', v_status;
  END IF;
  RAISE NOTICE 'rf03 T5b ok: reopen escopado por auth.uid()';
END $$;

-- ============ T6: close_due_invoices (escopo + idempotência) ============
SELECT set_config('request.jwt.claim.sub', 'aaaa0000-0000-4000-8000-000000000001', false);
DO $$
DECLARE v_first integer; v_second integer; v_closed integer;
BEGIN
  v_first := public.close_due_invoices('2026-05-01');
  v_second := public.close_due_invoices('2026-05-01');
  SELECT count(*) INTO v_closed FROM public.invoices
  WHERE id = '10000000-0000-4000-8000-000000000002' AND status = 'closed';
  -- invA_open (fev, period_end 2026-02-15) e invA_paid2 (mar, paga) => só a aberta fecha.
  IF v_first <> 1 THEN
    RAISE EXCEPTION 'rf03 T6 falhou: 1ª chamada fechou % faturas (esperado 1)', v_first;
  END IF;
  IF v_second <> 0 THEN
    RAISE EXCEPTION 'rf03 T6 falhou: 2ª chamada não foi no-op (%)', v_second;
  END IF;
  IF v_closed <> 1 THEN
    RAISE EXCEPTION 'rf03 T6 falhou: fatura vencida não foi fechada';
  END IF;
  RAISE NOTICE 'rf03 T6 ok: fechamento idempotente e escopado';
END $$;

-- ============ T7: guard de transações ============
-- Despesa em fatura paga (invA_paid2) falha com código fixo.
DO $$
BEGIN
  INSERT INTO public.transactions (user_id, account_id, invoice_id, amount_cents, date, is_transfer)
  VALUES ('aaaa0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a',
          '10000000-0000-4000-8000-000000000003', 1000, '2026-03-10', false);
  RAISE EXCEPTION 'rf03 T7a falhou: despesa em fatura paga permitida';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'rf03 T7a falhou%' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE '%invoice-paid-locked%' THEN
    RAISE EXCEPTION 'rf03 T7a falhou: negação veio da camada errada (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'rf03 T7a ok: despesa em fatura paga bloqueada';
END $$;

-- Transferência (pagamento) na mesma fatura paga passa.
INSERT INTO public.transactions (user_id, account_id, invoice_id, amount_cents, date, is_transfer)
VALUES ('aaaa0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a',
        '10000000-0000-4000-8000-000000000003', 7000, '2026-03-22', true);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.transactions
    WHERE user_id = 'aaaa0000-0000-4000-8000-000000000001'
      AND invoice_id = '10000000-0000-4000-8000-000000000003'
      AND is_transfer
  ) THEN
    RAISE EXCEPTION 'rf03 T7b falhou: transferência em fatura paga bloqueada';
  END IF;
  RAISE NOTICE 'rf03 T7b ok: transferência passa (é o ato de pagar)';
END $$;

-- Fatura de outro tenant falha (mesmo para despesa).
DO $$
BEGIN
  INSERT INTO public.transactions (user_id, account_id, invoice_id, amount_cents, date, is_transfer)
  VALUES ('aaaa0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a',
          '20000000-0000-4000-8000-000000000001', 1000, '2026-01-10', false);
  RAISE EXCEPTION 'rf03 T7c falhou: invoice_id cross-tenant permitido';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'rf03 T7c falhou%' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE '%invoice-tenant-mismatch%' THEN
    RAISE EXCEPTION 'rf03 T7c falhou: negação veio da camada errada (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'rf03 T7c ok: invoice_id cross-tenant bloqueado';
END $$;

-- ============ T8: anon não executa as RPCs ============
DO $$
DECLARE v_grant boolean;
BEGIN
  SELECT has_function_privilege('anon', 'public.reopen_invoice(uuid)', 'EXECUTE') INTO v_grant;
  IF v_grant THEN
    RAISE EXCEPTION 'rf03 T8 falhou: anon executa reopen_invoice';
  END IF;
  SELECT has_function_privilege('anon', 'public.close_due_invoices(date)', 'EXECUTE') INTO v_grant;
  IF v_grant THEN
    RAISE EXCEPTION 'rf03 T8 falhou: anon executa close_due_invoices';
  END IF;
  SELECT has_function_privilege('authenticated', 'public.reopen_invoice(uuid)', 'EXECUTE') INTO v_grant;
  IF NOT v_grant THEN
    RAISE EXCEPTION 'rf03 T8 falhou: authenticated não executa reopen_invoice';
  END IF;
  RAISE NOTICE 'rf03 T8 ok: EXECUTE só para authenticated';
END $$;

-- ============ T9: authenticated não grava status/paid_cents (B3F-03) ============
-- Privilégio de coluna: UPDATE(status)/paid_cents negado (42501); total_cents
-- também sai do cliente em 0014 (recálculo só pela RPC recalc_invoice_total).
DO $$
BEGIN
  BEGIN
    UPDATE public.invoices SET status = 'paid' WHERE id = '10000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'rf03 T9 falhou: authenticated marcou fatura como paga';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T9 falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'rf03 T9 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'rf03 T9 ok: UPDATE(status) negado a authenticated (42501)';
  END;

  BEGIN
    UPDATE public.invoices SET paid_cents = 1 WHERE id = '10000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'rf03 T9b falhou: authenticated gravou paid_cents';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T9b falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'rf03 T9b falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'rf03 T9b ok: UPDATE(paid_cents) negado a authenticated (42501)';
  END;

  BEGIN
    UPDATE public.invoices SET total_cents = total_cents WHERE id = '10000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'rf03 T9c falhou: authenticated gravou total_cents (0014)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T9c falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'rf03 T9c falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'rf03 T9c ok: UPDATE(total_cents) negado — recalc só pela RPC (0014)';
  END;
END $$;

-- ============ T10: INSERT guard (B3F2-03 + 0015) ============
-- 0013 normaliza toda fatura para open/paid_cents=0 e rejeita cartão de outro
-- tenant. 0015 fecha o INSERT por coluna: `total_cents`/`paid_cents`/`paid_at`
-- não são graváveis pelo cliente (42501). Roda como authenticated (é a
-- superfície que os guards protegem).

-- T10a — total_cents forjado é negado pelo privilégio de coluna (42501).
DO $$
BEGIN
  BEGIN
    INSERT INTO public.invoices (
      user_id, credit_card_id, period_start, period_end, due_date, status, total_cents
    ) VALUES (
      'aaaa0000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-00000000000c',
      '2026-07-01', '2026-07-15', '2026-07-22', 'open', 999999999
    );
    RAISE EXCEPTION 'rf03 T10a falhou: INSERT com total_cents forjado foi aceito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T10a falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'rf03 T10a falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'rf03 T10a ok: total_cents fora do grant → 42501';
END $$;

-- T10b — INSERT legítimo (só colunas do grant) funciona e a fatura nasce
-- aberta/sem pagamento, mesmo pedindo status='paid'.
DO $$
DECLARE
  v_id uuid;
  v_status text;
  v_paid bigint;
  v_total bigint;
BEGIN
  INSERT INTO public.invoices (
    user_id, credit_card_id, period_start, period_end, due_date, status
  ) VALUES (
    'aaaa0000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-00000000000c',
    '2026-07-01', '2026-07-15', '2026-07-22', 'paid'
  )
  RETURNING id INTO v_id;

  SELECT status, paid_cents, total_cents INTO v_status, v_paid, v_total
  FROM public.invoices WHERE id = v_id;

  IF v_status <> 'open' OR v_paid <> 0 OR v_total <> 0 THEN
    RAISE EXCEPTION 'rf03 T10b falhou: INSERT legítimo resultou em status=% paid_cents=% total=%',
      v_status, v_paid, v_total;
  END IF;

  DELETE FROM public.invoices WHERE id = v_id;
  RAISE NOTICE 'rf03 T10b ok: INSERT legítimo normalizado para open/0';
END $$;

-- T10c — cartão de outro tenant segue rejeitado (sem total_cents no payload).
DO $$
BEGIN
  BEGIN
    INSERT INTO public.invoices (
      user_id, credit_card_id, period_start, period_end, due_date, status
    ) VALUES (
      'aaaa0000-0000-4000-8000-000000000001',
      'd0000000-0000-4000-8000-00000000000d',
      '2026-08-01', '2026-08-15', '2026-08-22', 'open'
    );
    RAISE EXCEPTION 'rf03 T10c falhou: fatura aceitou cartão de outro tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T10c falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%invoice-card-tenant-mismatch%' THEN
      RAISE EXCEPTION 'rf03 T10c falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'rf03 T10c ok: cartão de outro tenant rejeitado no INSERT';
END $$;

-- T10d — paid_cents também fora do grant (0015): 42501.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.invoices (
      user_id, credit_card_id, period_start, period_end, due_date, status, paid_cents
    ) VALUES (
      'aaaa0000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-00000000000c',
      '2026-09-01', '2026-09-15', '2026-09-22', 'open', 2500
    );
    RAISE EXCEPTION 'rf03 T10d falhou: INSERT com paid_cents foi aceito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T10d falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'rf03 T10d falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'rf03 T10d ok: paid_cents fora do grant → 42501';
END $$;

-- T10e — paid_at também fora do grant (0015): 42501.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.invoices (
      user_id, credit_card_id, period_start, period_end, due_date, status, paid_at
    ) VALUES (
      'aaaa0000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-00000000000c',
      '2026-10-01', '2026-10-15', '2026-10-22', 'open', now()
    );
    RAISE EXCEPTION 'rf03 T10e falhou: INSERT com paid_at foi aceito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T10e falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'rf03 T10e falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'rf03 T10e ok: paid_at fora do grant → 42501';
END $$;

-- ============ T11: exclusão de cartão com histórico (0015) ============
-- T7 deixou uma transferência vinculada à fatura paga do cartão A: o DELETE
-- direto, sem passar pelo serviço, precisa ser negado pelo banco.
DO $$
BEGIN
  BEGIN
    DELETE FROM public.credit_cards WHERE id = 'c0000000-0000-4000-8000-00000000000c';
    RAISE EXCEPTION 'rf03 T11 falhou: DELETE de cartão com histórico permitido';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T11 falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%card-has-history%' THEN
      RAISE EXCEPTION 'rf03 T11 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'rf03 T11 ok: cartão com histórico bloqueado no banco';
END $$;

-- ============ T12: cartão sem histórico continua excluível ============
DO $$
BEGIN
  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('a1000000-0000-4000-8000-0000000000aa',
          'aaaa0000-0000-4000-8000-000000000001', 'Conta sem histórico', 'checking')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.credit_cards (id, user_id, account_id, name, closing_day, due_day)
  VALUES ('c1000000-0000-4000-8000-0000000000cc',
          'aaaa0000-0000-4000-8000-000000000001',
          'a1000000-0000-4000-8000-0000000000aa', 'Cartão sem histórico', 15, 22)
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM public.credit_cards WHERE id = 'c1000000-0000-4000-8000-0000000000cc';
  IF EXISTS (
    SELECT 1 FROM public.credit_cards WHERE id = 'c1000000-0000-4000-8000-0000000000cc'
  ) THEN
    RAISE EXCEPTION 'rf03 T12 falhou: cartão sem histórico não foi excluído';
  END IF;

  DELETE FROM public.accounts WHERE id = 'a1000000-0000-4000-8000-0000000000aa';
  RAISE NOTICE 'rf03 T12 ok: cartão sem histórico excluído';
END $$;

-- ============ T13: cascata de conta com histórico NÃO apaga nada (0016) ============
-- O guard de cartão discriminava por `current_user`; na cascata de FK o trigger
-- roda como `postgres` e deixava passar. Agora o bloqueio é por existência de
-- histórico (ou GUC `app.card_purge='on'`), então a conta dona do cartão com
-- compras não pode ser excluída — a cascata não chega a rodar.
DO $$
DECLARE
  v_cards int; v_invoices int; v_tx int;
  v_cards_after int; v_invoices_after int; v_tx_after int;
BEGIN
  SELECT count(*) INTO v_cards FROM public.credit_cards
  WHERE user_id = 'aaaa0000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_invoices FROM public.invoices
  WHERE user_id = 'aaaa0000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_tx FROM public.transactions
  WHERE user_id = 'aaaa0000-0000-4000-8000-000000000001';

  BEGIN
    DELETE FROM public.accounts WHERE id = 'a0000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'rf03 T13 falhou: DELETE de conta com histórico de cartão foi aceito';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T13 falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%account-has-history%' THEN
      RAISE EXCEPTION 'rf03 T13 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_cards_after FROM public.credit_cards
  WHERE user_id = 'aaaa0000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_invoices_after FROM public.invoices
  WHERE user_id = 'aaaa0000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_tx_after FROM public.transactions
  WHERE user_id = 'aaaa0000-0000-4000-8000-000000000001';

  IF v_cards_after <> v_cards OR v_invoices_after <> v_invoices OR v_tx_after <> v_tx THEN
    RAISE EXCEPTION
      'rf03 T13 falhou: cascata apagou linhas (cards %→%, invoices %→%, tx %→%)',
      v_cards, v_cards_after, v_invoices, v_invoices_after, v_tx, v_tx_after;
  END IF;

  RAISE NOTICE 'rf03 T13 ok: conta com histórico bloqueada, cascata não apagou nada';
END $$;

-- ============ T14: conta sem histórico continua excluível ============
DO $$
BEGIN
  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('a2000000-0000-4000-8000-0000000000bb',
          'aaaa0000-0000-4000-8000-000000000001', 'Conta limpa', 'checking')
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM public.accounts WHERE id = 'a2000000-0000-4000-8000-0000000000bb';

  IF EXISTS (SELECT 1 FROM public.accounts WHERE id = 'a2000000-0000-4000-8000-0000000000bb') THEN
    RAISE EXCEPTION 'rf03 T14 falhou: conta sem histórico não foi excluída';
  END IF;

  RAISE NOTICE 'rf03 T14 ok: conta sem histórico excluída';
END $$;

-- ============ T15: guard de cartão vale também fora do cliente (0016) ============
-- Sem o gate por `current_user`, o DELETE como owner (manutenção/`service_role`)
-- também é negado quando há histórico.
RESET ROLE;
DO $$
BEGIN
  BEGIN
    DELETE FROM public.credit_cards WHERE id = 'c0000000-0000-4000-8000-00000000000c';
    RAISE EXCEPTION 'rf03 T15 falhou: owner apagou cartão com histórico';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T15 falhou%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%card-has-history%' THEN
      RAISE EXCEPTION 'rf03 T15 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'rf03 T15 ok: cartão com histórico bloqueado sem discriminador de usuário';
END $$;

-- ============ T16: `SET LOCAL app.card_purge='on'` libera o purge ============
-- Caminho administrativo explícito (nenhum código de app seta o GUC).
INSERT INTO public.accounts (id, user_id, name, type)
VALUES ('a3000000-0000-4000-8000-0000000000cc',
        'aaaa0000-0000-4000-8000-000000000001', 'Conta purge', 'checking');
INSERT INTO public.credit_cards (id, user_id, account_id, name, closing_day, due_day)
VALUES ('c3000000-0000-4000-8000-0000000000dd',
        'aaaa0000-0000-4000-8000-000000000001',
        'a3000000-0000-4000-8000-0000000000cc', 'Cartão purge', 15, 22);
INSERT INTO public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, status)
VALUES ('13000000-0000-4000-8000-0000000000ee',
        'aaaa0000-0000-4000-8000-000000000001',
        'c3000000-0000-4000-8000-0000000000dd',
        '2026-11-01', '2026-11-15', '2026-11-22', 'open');
INSERT INTO public.transactions (user_id, account_id, invoice_id, description, amount_cents, date, type)
VALUES ('aaaa0000-0000-4000-8000-000000000001',
        'a3000000-0000-4000-8000-0000000000cc',
        '13000000-0000-4000-8000-0000000000ee', 'Compra purge', 4200, '2026-11-10', 'expense');

SET ROLE authenticated;
BEGIN;
SET LOCAL app.card_purge = 'on';
DELETE FROM public.accounts WHERE id = 'a3000000-0000-4000-8000-0000000000cc';
COMMIT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.accounts WHERE id = 'a3000000-0000-4000-8000-0000000000cc')
     OR EXISTS (SELECT 1 FROM public.credit_cards WHERE id = 'c3000000-0000-4000-8000-0000000000dd')
     OR EXISTS (SELECT 1 FROM public.invoices WHERE id = '13000000-0000-4000-8000-0000000000ee') THEN
    RAISE EXCEPTION 'rf03 T16 falhou: purge com GUC não apagou a cascata';
  END IF;
  RAISE NOTICE 'rf03 T16 ok: GUC de purge libera a cascata administrativa';
END $$;

RESET ROLE;

-- ============ cleanup ============
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
