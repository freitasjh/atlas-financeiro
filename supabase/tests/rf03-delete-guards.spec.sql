-- rf03-delete-guards.spec.sql — RF03 / P2-saneamento (0017).
-- Uso: supabase db reset && psql "$DB_URL" -f supabase/tests/rf03-delete-guards.spec.sql
-- Prova o fecho da classe "delete deixa compra órfã":
--   T1 DELETE de fatura com transação → invoice-has-history; a transação
--      MANTÉM invoice_id (não vira NULL / não vira despesa de caixa)
--   T2 DELETE de fatura sem transação → permitido
--   T3 DELETE de plano de parcelamento com parcelas → plan-has-history
--   T4 compensação do serviço (apaga transações e depois o plano) → permitida
--   T5 GUC administrativo app.card_purge='on' libera os dois DELETEs
--
-- Rerunnable: fixtures apagadas no início com o GUC de purge.

-- ============ Fixtures (como postgres, RLS bypass) ============

SELECT set_config('app.card_purge', 'on', false);
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'aaaa0000-0000-4000-8000-0000000000d1',
  'bbbb0000-0000-4000-8000-0000000000d2'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

SELECT set_config('app.card_purge', 'off', false);

INSERT INTO auth.users (id, email) VALUES
  ('aaaa0000-0000-4000-8000-0000000000d1', 'rf03del-a@example.com'),
  ('bbbb0000-0000-4000-8000-0000000000d2', 'rf03del-b@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['aaaa0000-0000-4000-8000-0000000000d1'::uuid, 'bbbb0000-0000-4000-8000-0000000000d2'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600006000 + v_i)::text, 11, '0'),
            'Fixture rf03', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('d1000000-0000-4000-8000-0000000000a1', 'aaaa0000-0000-4000-8000-0000000000d1', 'Conta A', 'checking', 0, 0),
  ('d2000000-0000-4000-8000-0000000000a2', 'bbbb0000-0000-4000-8000-0000000000d2', 'Conta B', 'checking', 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day) VALUES
  ('d1000000-0000-4000-8000-0000000000c1', 'aaaa0000-0000-4000-8000-0000000000d1', 'd1000000-0000-4000-8000-0000000000a1', 'Cartão A', 100000, 15, 22),
  ('d2000000-0000-4000-8000-0000000000c2', 'bbbb0000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-0000000000a2', 'Cartão B', 100000, 15, 22)
ON CONFLICT (id) DO NOTHING;

-- inv1: tem compra (não pode ser apagada). inv2: provisionada vazia (pode).
INSERT INTO public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, status) VALUES
  ('dd000000-0000-4000-8000-0000000000f1', 'aaaa0000-0000-4000-8000-0000000000d1', 'd1000000-0000-4000-8000-0000000000c1', '2026-09-01', '2026-09-15', '2026-09-22', 'open'),
  ('dd000000-0000-4000-8000-0000000000f2', 'aaaa0000-0000-4000-8000-0000000000d1', 'd1000000-0000-4000-8000-0000000000c1', '2026-10-01', '2026-10-15', '2026-10-22', 'open')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.installment_plans (id, user_id, description, total_amount_cents, total_installments) VALUES
  ('dd000000-0000-4000-8000-0000000000e1', 'aaaa0000-0000-4000-8000-0000000000d1', 'Compra parcelada', 9000, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.transactions (id, user_id, account_id, invoice_id, installment_plan_id, installment_number, description, amount_cents, date, type) VALUES
  ('dd000000-0000-4000-8000-000000000011', 'aaaa0000-0000-4000-8000-0000000000d1', 'd1000000-0000-4000-8000-0000000000a1', 'dd000000-0000-4000-8000-0000000000f1', 'dd000000-0000-4000-8000-0000000000e1', 1, 'Compra parcelada 1/3', 3000, '2026-09-02', 'expense')
ON CONFLICT (id) DO NOTHING;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaa0000-0000-4000-8000-0000000000d1', false);
SELECT set_config('request.jwt.claims', '{"sub":"aaaa0000-0000-4000-8000-0000000000d1","role":"authenticated"}', false);

-- ============ T1: DELETE de fatura com histórico é negado e não orfana ============

DO $$
DECLARE
  v_err text;
  v_invoice uuid;
BEGIN
  BEGIN
    DELETE FROM public.invoices WHERE id = 'dd000000-0000-4000-8000-0000000000f1';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%invoice-has-history%' THEN
    RAISE EXCEPTION 'rf03del T1 falhou: DELETE de fatura com histórico devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  SELECT invoice_id INTO v_invoice
  FROM public.transactions
  WHERE id = 'dd000000-0000-4000-8000-000000000011';

  IF v_invoice IS DISTINCT FROM 'dd000000-0000-4000-8000-0000000000f1'::uuid THEN
    RAISE EXCEPTION 'rf03del T1 falhou: compra ficou órfã (invoice_id=%)', coalesce(v_invoice::text, 'NULL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE id = 'dd000000-0000-4000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'rf03del T1 falhou: fatura foi apagada apesar do guard';
  END IF;

  RAISE NOTICE 'rf03del T1 ok: fatura com histórico preservada e compra sem órfã';
END $$;

-- ============ T2: DELETE de fatura sem histórico é permitido ============

DO $$
BEGIN
  DELETE FROM public.invoices WHERE id = 'dd000000-0000-4000-8000-0000000000f2';
  IF EXISTS (SELECT 1 FROM public.invoices WHERE id = 'dd000000-0000-4000-8000-0000000000f2') THEN
    RAISE EXCEPTION 'rf03del T2 falhou: fatura vazia não foi apagada';
  END IF;
  RAISE NOTICE 'rf03del T2 ok: fatura provisionada vazia pode ser apagada';
END $$;

-- ============ T3: DELETE de plano com parcelas é negado ============

DO $$
DECLARE
  v_err text;
  v_plan uuid;
BEGIN
  BEGIN
    DELETE FROM public.installment_plans WHERE id = 'dd000000-0000-4000-8000-0000000000e1';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%plan-has-history%' THEN
    RAISE EXCEPTION 'rf03del T3 falhou: DELETE de plano com parcelas devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  SELECT installment_plan_id INTO v_plan
  FROM public.transactions
  WHERE id = 'dd000000-0000-4000-8000-000000000011';

  IF v_plan IS DISTINCT FROM 'dd000000-0000-4000-8000-0000000000e1'::uuid THEN
    RAISE EXCEPTION 'rf03del T3 falhou: parcela foi apagada em cascata (plan_id=%)', coalesce(v_plan::text, 'NULL');
  END IF;

  RAISE NOTICE 'rf03del T3 ok: plano com parcelas preservado';
END $$;

-- ============ T4: compensação do serviço continua funcionando ============
-- createInstallmentPurchase apaga as transações primeiro e só então o plano.

DO $$
BEGIN
  DELETE FROM public.transactions WHERE id = 'dd000000-0000-4000-8000-000000000011';
  DELETE FROM public.installment_plans WHERE id = 'dd000000-0000-4000-8000-0000000000e1';

  IF EXISTS (SELECT 1 FROM public.installment_plans WHERE id = 'dd000000-0000-4000-8000-0000000000e1') THEN
    RAISE EXCEPTION 'rf03del T4 falhou: compensação não apagou o plano';
  END IF;

  RAISE NOTICE 'rf03del T4 ok: transações antes do plano (compensação) permitida';
END $$;

RESET ROLE;

-- ============ T5: GUC administrativo libera o purge ============
-- Repõe fixtures (como postgres) e faz o purge intencional com o GUC.

INSERT INTO public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, status) VALUES
  ('dd000000-0000-4000-8000-0000000000f3', 'aaaa0000-0000-4000-8000-0000000000d1', 'd1000000-0000-4000-8000-0000000000c1', '2026-11-01', '2026-11-15', '2026-11-22', 'open')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.installment_plans (id, user_id, description, total_amount_cents, total_installments) VALUES
  ('dd000000-0000-4000-8000-0000000000e3', 'aaaa0000-0000-4000-8000-0000000000d1', 'Compra purge', 3000, 2)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.transactions (id, user_id, account_id, invoice_id, installment_plan_id, installment_number, description, amount_cents, date, type) VALUES
  ('dd000000-0000-4000-8000-000000000033', 'aaaa0000-0000-4000-8000-0000000000d1', 'd1000000-0000-4000-8000-0000000000a1', 'dd000000-0000-4000-8000-0000000000f3', 'dd000000-0000-4000-8000-0000000000e3', 1, 'Compra purge 1/2', 1500, '2026-11-02', 'expense')
ON CONFLICT (id) DO NOTHING;

SET ROLE authenticated;
BEGIN;
SET LOCAL app.card_purge = 'on';
DELETE FROM public.invoices WHERE id = 'dd000000-0000-4000-8000-0000000000f3';
DELETE FROM public.installment_plans WHERE id = 'dd000000-0000-4000-8000-0000000000e3';
COMMIT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.invoices WHERE id = 'dd000000-0000-4000-8000-0000000000f3') THEN
    RAISE EXCEPTION 'rf03del T5 falhou: purge autorizado não apagou a fatura';
  END IF;
  IF EXISTS (SELECT 1 FROM public.installment_plans WHERE id = 'dd000000-0000-4000-8000-0000000000e3') THEN
    RAISE EXCEPTION 'rf03del T5 falhou: purge autorizado não apagou o plano';
  END IF;
  RAISE NOTICE 'rf03del T5 ok: GUC de purge libera fatura e plano';
END $$;

RESET ROLE;

-- ============ cleanup ============

SELECT set_config('app.card_purge', 'on', false);
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'aaaa0000-0000-4000-8000-0000000000d1',
  'bbbb0000-0000-4000-8000-0000000000d2'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

SELECT set_config('app.card_purge', 'off', false);
