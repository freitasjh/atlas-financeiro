-- rf03-link-immutability.spec.sql — RF03 / P2-saneamento (0018).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rf03-link-immutability.spec.sql
-- Prova o fecho da classe "UPDATE desfaz vínculo e vira despesa de caixa":
--   T1 UPDATE invoice_id = NULL → invoice-link-immutable; vínculo intacto
--   T2 UPDATE invoice_id = outra fatura → invoice-link-immutable; vínculo intacto
--   T3 UPDATE de amount_cents/description (sem colunas de vínculo) → permitido
--   T4 INSERT com invoice_id NULL → permitido
--   T5 INSERT de despesa em fatura paga → invoice-paid-locked (RN-03.5)
--   T6 INSERT de transferência em fatura paga → permitido (comportamento atual)
--   T7 UPDATE installment_plan_id = NULL → plan-link-immutable; vínculo intacto
--   T8 UPDATE installment_plan_id = outro plano → plan-link-immutable
--   T9 GUC administrativo app.card_purge='on' libera o unlink (FK SET NULL/purge)
--   T10 índice de apoio tem invoice_id como leading column
--
-- Rerunnable: fixtures apagadas no início com o GUC de purge.

-- ============ Fixtures (como postgres, RLS bypass) ============

SELECT set_config('app.card_purge', 'on', false);
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'ffff0000-0000-4000-8000-0000000000a1',
  'ffff0000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

SELECT set_config('app.card_purge', 'off', false);

INSERT INTO auth.users (id, email) VALUES
  ('ffff0000-0000-4000-8000-0000000000a1', 'rf03link-a@example.com'),
  ('ffff0000-0000-4000-8000-0000000000b1', 'rf03link-b@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['ffff0000-0000-4000-8000-0000000000a1'::uuid, 'ffff0000-0000-4000-8000-0000000000b1'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600010000 + v_i)::text, 11, '0'),
            'Fixture rf03', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('f1000000-0000-4000-8000-0000000000a1', 'ffff0000-0000-4000-8000-0000000000a1', 'Conta A', 'checking', 0, 0),
  ('f2000000-0000-4000-8000-0000000000a2', 'ffff0000-0000-4000-8000-0000000000b1', 'Conta B', 'checking', 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day) VALUES
  ('f1000000-0000-4000-8000-0000000000c1', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', 'Cartão A', 100000, 15, 22),
  ('f2000000-0000-4000-8000-0000000000c2', 'ffff0000-0000-4000-8000-0000000000b1', 'f2000000-0000-4000-8000-0000000000a2', 'Cartão B', 100000, 15, 22)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, status) VALUES
  ('ff000000-0000-4000-8000-0000000000f1', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000c1', '2026-09-01', '2026-09-15', '2026-09-22', 'open'),
  ('ff000000-0000-4000-8000-0000000000f2', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000c1', '2026-10-01', '2026-10-15', '2026-10-22', 'open'),
  ('ff000000-0000-4000-8000-0000000000f3', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000c1', '2026-11-01', '2026-11-15', '2026-11-22', 'open')
ON CONFLICT (id) DO NOTHING;

-- f3 nasce paga (transição fora de RPC exige o GUC da 0011).
BEGIN;
SET LOCAL app.invoice_rpc = 'on';
UPDATE public.invoices SET status = 'paid' WHERE id = 'ff000000-0000-4000-8000-0000000000f3';
COMMIT;

INSERT INTO public.installment_plans (id, user_id, description, total_amount_cents, total_installments) VALUES
  ('fe000000-0000-4000-8000-0000000000e1', 'ffff0000-0000-4000-8000-0000000000a1', 'Plano 1', 9000, 3),
  ('fe000000-0000-4000-8000-0000000000e2', 'ffff0000-0000-4000-8000-0000000000a1', 'Plano 2', 6000, 2)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.transactions (id, user_id, account_id, invoice_id, installment_plan_id, installment_number, description, amount_cents, date, type) VALUES
  ('f1000000-0000-4000-8000-000000000011', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', 'ff000000-0000-4000-8000-0000000000f1', 'fe000000-0000-4000-8000-0000000000e1', 1, 'Compra parcelada 1/3', 3000, '2026-09-02', 'expense'),
  ('f1000000-0000-4000-8000-000000000012', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', NULL, NULL, NULL, 'Despesa de caixa', 1500, '2026-09-03', 'expense'),
  ('f1000000-0000-4000-8000-000000000015', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', 'ff000000-0000-4000-8000-0000000000f2', 'fe000000-0000-4000-8000-0000000000e2', 1, 'Compra purge 1/2', 3000, '2026-10-02', 'expense')
ON CONFLICT (id) DO NOTHING;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'ffff0000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"ffff0000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);

-- ============ T1: UPDATE invoice_id = NULL é negado ============

DO $$
DECLARE
  v_err text;
  v_invoice uuid;
BEGIN
  BEGIN
    UPDATE public.transactions SET invoice_id = NULL WHERE id = 'f1000000-0000-4000-8000-000000000011';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%invoice-link-immutable%' THEN
    RAISE EXCEPTION 'rf03link T1 falhou: unlink de fatura devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  SELECT invoice_id INTO v_invoice
  FROM public.transactions WHERE id = 'f1000000-0000-4000-8000-000000000011';

  IF v_invoice IS DISTINCT FROM 'ff000000-0000-4000-8000-0000000000f1'::uuid THEN
    RAISE EXCEPTION 'rf03link T1 falhou: vínculo com a fatura foi desfeito (invoice_id=%)', coalesce(v_invoice::text, 'NULL');
  END IF;

  RAISE NOTICE 'rf03link T1 ok: UPDATE invoice_id=NULL negado e vínculo intacto';
END $$;

-- ============ T2: UPDATE invoice_id para outra fatura é negado ============

DO $$
DECLARE
  v_err text;
  v_invoice uuid;
BEGIN
  BEGIN
    UPDATE public.transactions
    SET invoice_id = 'ff000000-0000-4000-8000-0000000000f2'
    WHERE id = 'f1000000-0000-4000-8000-000000000011';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%invoice-link-immutable%' THEN
    RAISE EXCEPTION 'rf03link T2 falhou: troca de fatura devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  SELECT invoice_id INTO v_invoice
  FROM public.transactions WHERE id = 'f1000000-0000-4000-8000-000000000011';

  IF v_invoice IS DISTINCT FROM 'ff000000-0000-4000-8000-0000000000f1'::uuid THEN
    RAISE EXCEPTION 'rf03link T2 falhou: fatura mudou apesar do guard (invoice_id=%)', coalesce(v_invoice::text, 'NULL');
  END IF;

  RAISE NOTICE 'rf03link T2 ok: troca de fatura negada e vínculo intacto';
END $$;

-- ============ T3: UPDATE de outros campos continua funcionando ============

DO $$
DECLARE
  v_amount bigint;
  v_invoice uuid;
BEGIN
  UPDATE public.transactions
  SET amount_cents = 3100, description = 'Compra editada'
  WHERE id = 'f1000000-0000-4000-8000-000000000011';

  SELECT amount_cents, invoice_id INTO v_amount, v_invoice
  FROM public.transactions WHERE id = 'f1000000-0000-4000-8000-000000000011';

  IF v_amount IS DISTINCT FROM 3100 THEN
    RAISE EXCEPTION 'rf03link T3 falhou: amount_cents não atualizou (%)', v_amount;
  END IF;

  IF v_invoice IS DISTINCT FROM 'ff000000-0000-4000-8000-0000000000f1'::uuid THEN
    RAISE EXCEPTION 'rf03link T3 falhou: edição de valor mexeu na fatura';
  END IF;

  RAISE NOTICE 'rf03link T3 ok: edição de amount/description permitida';
END $$;

-- ============ T4: INSERT com invoice_id NULL continua permitido ============

DO $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.transactions (id, user_id, account_id, invoice_id, description, amount_cents, date, type)
  VALUES ('f1000000-0000-4000-8000-000000000021', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', NULL, 'Caixa', 700, '2026-09-04', 'expense')
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'rf03link T4 falhou: INSERT de caixa não retornou id';
  END IF;

  RAISE NOTICE 'rf03link T4 ok: INSERT com invoice_id NULL permitido';
END $$;

-- ============ T5: despesa em fatura paga continua bloqueada ============

DO $$
DECLARE
  v_err text;
BEGIN
  BEGIN
    INSERT INTO public.transactions (user_id, account_id, invoice_id, description, amount_cents, date, type, is_transfer)
    VALUES ('ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', 'ff000000-0000-4000-8000-0000000000f3', 'Compra em fatura paga', 500, '2026-11-02', 'expense', false);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%invoice-paid-locked%' THEN
    RAISE EXCEPTION 'rf03link T5 falhou: despesa em fatura paga devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  RAISE NOTICE 'rf03link T5 ok: despesa em fatura paga continua negada';
END $$;

-- ============ T6: transferência em fatura paga segue o comportamento atual ============

DO $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.transactions (id, user_id, account_id, invoice_id, category_id, description, amount_cents, date, type, is_transfer)
  VALUES ('f1000000-0000-4000-8000-000000000022', 'ffff0000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', 'ff000000-0000-4000-8000-0000000000f3', NULL, 'Pagamento de fatura', 500, '2026-11-03', 'expense', true)
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'rf03link T6 falhou: transferência em fatura paga não foi aceita';
  END IF;

  RAISE NOTICE 'rf03link T6 ok: transferência mantém o comportamento atual';
END $$;

-- ============ T7: UPDATE installment_plan_id = NULL é negado ============

DO $$
DECLARE
  v_err text;
  v_plan uuid;
BEGIN
  BEGIN
    UPDATE public.transactions SET installment_plan_id = NULL WHERE id = 'f1000000-0000-4000-8000-000000000011';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%plan-link-immutable%' THEN
    RAISE EXCEPTION 'rf03link T7 falhou: unlink de plano devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  SELECT installment_plan_id INTO v_plan
  FROM public.transactions WHERE id = 'f1000000-0000-4000-8000-000000000011';

  IF v_plan IS DISTINCT FROM 'fe000000-0000-4000-8000-0000000000e1'::uuid THEN
    RAISE EXCEPTION 'rf03link T7 falhou: vínculo com o plano foi desfeito (plan_id=%)', coalesce(v_plan::text, 'NULL');
  END IF;

  RAISE NOTICE 'rf03link T7 ok: UPDATE installment_plan_id=NULL negado e vínculo intacto';
END $$;

-- ============ T8: UPDATE installment_plan_id para outro plano é negado ============

DO $$
DECLARE
  v_err text;
  v_plan uuid;
BEGIN
  BEGIN
    UPDATE public.transactions
    SET installment_plan_id = 'fe000000-0000-4000-8000-0000000000e2'
    WHERE id = 'f1000000-0000-4000-8000-000000000011';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL OR v_err NOT LIKE '%plan-link-immutable%' THEN
    RAISE EXCEPTION 'rf03link T8 falhou: troca de plano devolveu %', coalesce(v_err, 'sucesso');
  END IF;

  SELECT installment_plan_id INTO v_plan
  FROM public.transactions WHERE id = 'f1000000-0000-4000-8000-000000000011';

  IF v_plan IS DISTINCT FROM 'fe000000-0000-4000-8000-0000000000e1'::uuid THEN
    RAISE EXCEPTION 'rf03link T8 falhou: plano mudou apesar do guard (plan_id=%)', coalesce(v_plan::text, 'NULL');
  END IF;

  RAISE NOTICE 'rf03link T8 ok: troca de plano negada e vínculo intacto';
END $$;

-- ============ T9: GUC administrativo libera o unlink (purge / FK SET NULL) ============

BEGIN;
SET LOCAL app.card_purge = 'on';
UPDATE public.transactions
SET invoice_id = NULL, installment_plan_id = NULL, installment_number = NULL
WHERE id = 'f1000000-0000-4000-8000-000000000015';
COMMIT;

DO $$
DECLARE
  v_invoice uuid;
  v_plan uuid;
BEGIN
  SELECT invoice_id, installment_plan_id INTO v_invoice, v_plan
  FROM public.transactions WHERE id = 'f1000000-0000-4000-8000-000000000015';

  IF v_invoice IS NOT NULL OR v_plan IS NOT NULL THEN
    RAISE EXCEPTION 'rf03link T9 falhou: GUC de purge não liberou o unlink (invoice=%, plan=%)',
      coalesce(v_invoice::text, 'NULL'), coalesce(v_plan::text, 'NULL');
  END IF;

  RAISE NOTICE 'rf03link T9 ok: GUC administrativo libera o unlink';
END $$;

RESET ROLE;

-- ============ T10: índice de apoio com invoice_id como leading column ============

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'transactions'
      AND indexname = 'idx_transactions_user_invoice'
      AND indexdef ILIKE '%(invoice_id, user_id)%'
      AND indexdef ILIKE '%WHERE (invoice_id IS NOT NULL)%'
  ) THEN
    RAISE EXCEPTION 'rf03link T10 falhou: idx_transactions_user_invoice não é (invoice_id, user_id) WHERE invoice_id IS NOT NULL';
  END IF;

  RAISE NOTICE 'rf03link T10 ok: índice de apoio correto';
END $$;

-- ============ cleanup ============

SELECT set_config('app.card_purge', 'on', false);
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'ffff0000-0000-4000-8000-0000000000a1',
  'ffff0000-0000-4000-8000-0000000000b1'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

SELECT set_config('app.card_purge', 'off', false);
