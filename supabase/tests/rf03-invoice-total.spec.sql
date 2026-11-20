-- rf03-invoice-total.spec.sql — RF03 / P2-total-client (SPEC §4 + §8.1).
-- Uso: supabase db reset && psql "$DB_URL" -f supabase/tests/rf03-invoice-total.spec.sql
-- Cobre a RPC recalc_invoice_total(p_invoice) (0014):
--   T1 soma das transações não-transfer, recalculada após INSERT e DELETE
--   T2 transferência (pagamento, RN04) não compõe o total
--   T3 UPDATE direto de total_cents como authenticated falha (42501)
--   T4 RPC de outro tenant devolve NULL e NÃO altera a fatura alheia
--   T5 EXECUTE só para authenticated (anon/PUBLIC negados)
--   T6 fatura inexistente devolve NULL sem escrever nada
--
-- Rerunnable: os fixtures são apagados no início.

-- ============ Fixtures (como postgres, RLS bypass) ============

SELECT set_config('app.card_purge', 'on', false);
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'aaaa0000-0000-4000-8000-0000000000c1',
  'bbbb0000-0000-4000-8000-0000000000c2'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

SELECT set_config('app.card_purge', 'off', false);
INSERT INTO auth.users (id, email) VALUES
  ('aaaa0000-0000-4000-8000-0000000000c1', 'rf03total-a@example.com'),
  ('bbbb0000-0000-4000-8000-0000000000c2', 'rf03total-b@example.com');

-- 0061 fixture tenant: a quota é do tenant (plano full = sem limite; este
-- teste não mede quota, mede o domínio da migration).
DO $$
DECLARE
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := ARRAY['aaaa0000-0000-4000-8000-0000000000c1'::uuid, 'bbbb0000-0000-4000-8000-0000000000c2'::uuid];
BEGIN
  FOREACH v_user IN ARRAY v_ids LOOP
    v_i := v_i + 1;
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    VALUES ('pf', v_user, pg_catalog.lpad((74600009000 + v_i)::text, 11, '0'),
            'Fixture rf03', 'full')
    RETURNING id INTO v_tenant;
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, v_user, 'owner');
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  END LOOP;
END $$;


INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('e1000000-0000-4000-8000-0000000000a1', 'aaaa0000-0000-4000-8000-0000000000c1', 'Conta A', 'checking', 0, 0),
  ('e2000000-0000-4000-8000-0000000000a2', 'bbbb0000-0000-4000-8000-0000000000c2', 'Conta B', 'checking', 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day) VALUES
  ('e1000000-0000-4000-8000-0000000000b1', 'aaaa0000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000a1', 'Cartão A', 100000, 15, 22),
  ('e2000000-0000-4000-8000-0000000000b2', 'bbbb0000-0000-4000-8000-0000000000c2', 'e2000000-0000-4000-8000-0000000000a2', 'Cartão B', 100000, 15, 22)
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.invoices WHERE id IN (
  '31000000-0000-4000-8000-0000000000f1',
  '31000000-0000-4000-8000-0000000000f2'
);

INSERT INTO public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, status, total_cents) VALUES
  ('31000000-0000-4000-8000-0000000000f1', 'aaaa0000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000b1', '2026-07-01', '2026-07-15', '2026-07-22', 'open', 99999),
  ('31000000-0000-4000-8000-0000000000f2', 'bbbb0000-0000-4000-8000-0000000000c2', 'e2000000-0000-4000-8000-0000000000b2', '2026-07-01', '2026-07-15', '2026-07-22', 'open', 50000);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaa0000-0000-4000-8000-0000000000c1', false);

-- ============ T1: recalc soma após INSERT e DELETE ============

INSERT INTO public.transactions (user_id, account_id, invoice_id, description, amount_cents, date, type, is_transfer)
VALUES
  ('aaaa0000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000a1', '31000000-0000-4000-8000-0000000000f1', 'Compra 1', 3000, '2026-07-02', 'expense', false),
  ('aaaa0000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000a1', '31000000-0000-4000-8000-0000000000f1', 'Compra 2', 2500, '2026-07-03', 'expense', false);

DO $$
DECLARE v_total bigint; v_row bigint;
BEGIN
  v_total := public.recalc_invoice_total('31000000-0000-4000-8000-0000000000f1');
  IF v_total <> 5500 THEN
    RAISE EXCEPTION 'rf03 T1 falhou: RPC devolveu % (esperado 5500)', v_total;
  END IF;
  SELECT total_cents INTO v_row FROM public.invoices WHERE id = '31000000-0000-4000-8000-0000000000f1';
  IF v_row <> 5500 THEN
    RAISE EXCEPTION 'rf03 T1 falhou: total_cents=% (esperado 5500)', v_row;
  END IF;
  RAISE NOTICE 'rf03 T1 ok: RPC soma as compras e grava o total';
END $$;

DELETE FROM public.transactions
WHERE invoice_id = '31000000-0000-4000-8000-0000000000f1'
  AND description = 'Compra 2';

DO $$
DECLARE v_total bigint; v_row bigint;
BEGIN
  v_total := public.recalc_invoice_total('31000000-0000-4000-8000-0000000000f1');
  IF v_total <> 3000 THEN
    RAISE EXCEPTION 'rf03 T1b falhou: RPC devolveu % após delete (esperado 3000)', v_total;
  END IF;
  SELECT total_cents INTO v_row FROM public.invoices WHERE id = '31000000-0000-4000-8000-0000000000f1';
  IF v_row <> 3000 THEN
    RAISE EXCEPTION 'rf03 T1b falhou: total_cents=% após delete (esperado 3000)', v_row;
  END IF;
  RAISE NOTICE 'rf03 T1b ok: RPC recalcula após delete';
END $$;

-- ============ T2: transferência (pagamento) fora do total (RN04) ============

INSERT INTO public.transactions (user_id, account_id, invoice_id, description, amount_cents, date, type, is_transfer)
VALUES
  ('aaaa0000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-0000000000a1', '31000000-0000-4000-8000-0000000000f1', 'Pagamento de fatura', 3000, '2026-07-22', 'expense', true);

DO $$
DECLARE v_total bigint;
BEGIN
  v_total := public.recalc_invoice_total('31000000-0000-4000-8000-0000000000f1');
  IF v_total <> 3000 THEN
    RAISE EXCEPTION 'rf03 T2 falhou: transfer compôs o total (%)', v_total;
  END IF;
  RAISE NOTICE 'rf03 T2 ok: is_transfer=true ignorado no recalc';
END $$;

-- ============ T3: total_cents não é gravável pelo cliente ============

DO $$
BEGIN
  BEGIN
    UPDATE public.invoices
    SET total_cents = 1
    WHERE id = '31000000-0000-4000-8000-0000000000f1';
    RAISE EXCEPTION 'rf03 T3 falhou: authenticated gravou total_cents';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rf03 T3 falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'rf03 T3 falhou: negação veio da camada errada (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'rf03 T3 ok: UPDATE(total_cents) negado a authenticated (42501)';
  END;
END $$;

-- ============ T4: RPC de outro tenant devolve NULL e não escreve ============

SELECT set_config('request.jwt.claim.sub', 'bbbb0000-0000-4000-8000-0000000000c2', false);

DO $$
DECLARE v_total bigint; v_row bigint;
BEGIN
  v_total := public.recalc_invoice_total('31000000-0000-4000-8000-0000000000f1');
  IF v_total IS NOT NULL THEN
    RAISE EXCEPTION 'rf03 T4 falhou: outro tenant recalculou (total=%)', v_total;
  END IF;
  SELECT total_cents INTO v_row FROM public.invoices WHERE id = '31000000-0000-4000-8000-0000000000f1';
  IF v_row <> 3000 THEN
    RAISE EXCEPTION 'rf03 T4 falhou: fatura alheia mudou para %', v_row;
  END IF;
  RAISE NOTICE 'rf03 T4 ok: RPC escopada por auth.uid() não toca fatura alheia';
END $$;

-- ============ T5: EXECUTE só para authenticated ============

RESET ROLE;

DO $$
DECLARE v_grant boolean;
BEGIN
  SELECT has_function_privilege('authenticated', 'public.recalc_invoice_total(uuid)', 'EXECUTE') INTO v_grant;
  IF NOT v_grant THEN
    RAISE EXCEPTION 'rf03 T5 falhou: authenticated não executa a RPC';
  END IF;
  SELECT has_function_privilege('anon', 'public.recalc_invoice_total(uuid)', 'EXECUTE') INTO v_grant;
  IF v_grant THEN
    RAISE EXCEPTION 'rf03 T5 falhou: anon executa a RPC';
  END IF;
  RAISE NOTICE 'rf03 T5 ok: EXECUTE só para authenticated';
END $$;

-- ============ T6: fatura inexistente devolve NULL sem erro ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaa0000-0000-4000-8000-0000000000c1', false);

DO $$
DECLARE v_total bigint;
BEGIN
  v_total := public.recalc_invoice_total('99999999-0000-4000-8000-0000000000ff');
  IF v_total IS NOT NULL THEN
    RAISE EXCEPTION 'rf03 T6 falhou: fatura inexistente devolveu %', v_total;
  END IF;
  RAISE NOTICE 'rf03 T6 ok: fatura inexistente devolve NULL';
END $$;

RESET ROLE;

-- ============ Fixtures cleanup (fim; tenant novo cascateia com o usuário) ============
BEGIN;
SELECT set_config('app.card_purge', 'on', true);
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users WHERE id IN (
  'aaaa0000-0000-4000-8000-0000000000c1',
  'bbbb0000-0000-4000-8000-0000000000c2'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

\echo 'rf03-invoice-total: OK'
