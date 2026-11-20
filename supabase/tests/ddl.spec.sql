-- ddl.spec.sql — Teste TDD FIRST (SB-01 + SB-10/SB-11) — Integration DDL/RLS
-- Uso: supabase db reset && psql $DB_URL -f supabase/tests/ddl.spec.sql
-- Falha (RAISE EXCEPTION) se qualquer invariante ausente.
-- Invariantes SB-01: 8 tabelas + 3 índices + RLS + CHECKs + triggers + colunas futuras.
-- Invariantes SB-10/SB-11 (G2-G7): budgets (9a tabela) + drop UNIQUE + CHECKs + índices + RLS.

-- T1: 9 tabelas existem (8 Fase 1 + budgets Fase 2)
DO $$
DECLARE
  expected text[] := ARRAY['profiles','accounts','credit_cards','invoices','categories','installment_plans','transactions','rules','budgets'];
  t text;
BEGIN
  FOREACH t IN ARRAY expected LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      RAISE EXCEPTION 'ddl.spec T1 falhou: tabela public.% ausente', t;
    END IF;
  END LOOP;
  RAISE NOTICE 'ddl.spec T1 ok: 9 tabelas presentes';
END $$;

-- T2: índices transactions (3 Fase 1) + 2 novos Fase 2 existem
DO $$
DECLARE
  expected text[] := ARRAY['idx_transactions_user_date','idx_transactions_user_account','idx_transactions_dedup','idx_budgets_user_month','idx_invoices_card_period'];
  i text;
BEGIN
  FOREACH i IN ARRAY expected LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = i) THEN
      RAISE EXCEPTION 'ddl.spec T2 falhou: índice % ausente', i;
    END IF;
  END LOOP;
  RAISE NOTICE 'ddl.spec T2 ok: 5 índices presentes';
END $$;

-- T3: RLS habilitada nas 9 tabelas
DO $$
DECLARE
  expected text[] := ARRAY['profiles','accounts','credit_cards','invoices','categories','installment_plans','transactions','rules','budgets'];
  t text;
BEGIN
  FOREACH t IN ARRAY expected LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t AND rowsecurity = true) THEN
      RAISE EXCEPTION 'ddl.spec T3 falhou: RLS desligada em %', t;
    END IF;
  END LOOP;
  RAISE NOTICE 'ddl.spec T3 ok: RLS ligada nas 9 tabelas';
END $$;

-- T4: policies tenant auth.uid()=user_id existem (8 tabelas tenant + profiles própria)
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('accounts','credit_cards','invoices','categories','installment_plans','transactions','rules','budgets')) < 8 THEN
    RAISE EXCEPTION 'ddl.spec T4 falhou: policies tenant incompletas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles') THEN
    RAISE EXCEPTION 'ddl.spec T4 falhou: policy profiles ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'budgets') THEN
    RAISE EXCEPTION 'ddl.spec T4 falhou: policy budgets ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T4 ok: policies RLS presentes';
END $$;

-- T5: BIGINT cents + CHECK (amount_cents >= 0), sem float/double/numeric em colunas de dinheiro
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name LIKE '%cents'
      AND data_type <> 'bigint';
  IF bad > 0 THEN
    RAISE EXCEPTION 'ddl.spec T5 falhou: % coluna(s) *_cents fora de BIGINT', bad;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('accounts','credit_cards','invoices','installment_plans','transactions','budgets')
      AND data_type IN ('double precision','real','numeric')
  ) THEN
    RAISE EXCEPTION 'ddl.spec T5 falhou: float/double/numeric em tabela de dinheiro';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_amount_cents_nonnegative'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T5 falhou: CHECK transactions amount_cents ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T5 ok: BIGINT cents + CHECK';
END $$;

-- T6: triggers handle_new_user + updated_at existem
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created') THEN
    RAISE EXCEPTION 'ddl.spec T6 falhou: trigger on_auth_user_created ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_new_user') THEN
    RAISE EXCEPTION 'ddl.spec T6 falhou: function handle_new_user ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    RAISE EXCEPTION 'ddl.spec T6 falhou: function set_updated_at ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T6 ok: triggers presentes';
END $$;

-- T7: colunas futuro-compatíveis (RN02/RN03/RN05 N/A-futura Fase 1)
DO $$
DECLARE
  expected text[] := ARRAY[
    'transactions.fitid','transactions.dedup_hash','transactions.installment_number',
    'invoices.period_start','invoices.period_end','invoices.due_date'
  ];
  c text; sch text; col text;
BEGIN
  FOREACH c IN ARRAY expected LOOP
    sch := split_part(c, '.', 1); col := split_part(c, '.', 2);
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=sch AND column_name=col) THEN
      RAISE EXCEPTION 'ddl.spec T7 falhou: coluna futura % ausente', c;
    END IF;
  END LOOP;
  RAISE NOTICE 'ddl.spec T7 ok: colunas futuras presentes';
END $$;

-- T8: role imutável client — trigger deny existe
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'deny_role_change') THEN
    RAISE EXCEPTION 'ddl.spec T8 falhou: trigger deny_role_change ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T8 ok: role imutável via trigger';
END $$;

-- T9 (G2): credit_cards.account_id SEM UNIQUE — 1 conta pode ter N cartões
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.credit_cards'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%account_id%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T9 (G2) falhou: UNIQUE em credit_cards.account_id ainda existe';
  END IF;
  RAISE NOTICE 'ddl.spec T9 (G2) ok: account_id sem UNIQUE';
END $$;

-- T10 (G3): invoices UNIQUE(card,period_start) + CHECK status + coerência período
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.invoices'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%credit_card_id%' AND pg_get_constraintdef(oid) ILIKE '%period_start%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T10 (G3) falhou: UNIQUE (credit_card_id, period_start) ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.invoices'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T10 (G3) falhou: CHECK invoices status ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.invoices'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%period_start%' AND pg_get_constraintdef(oid) ILIKE '%period_end%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T10 (G3) falhou: CHECK coerência período ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T10 (G3) ok: invoices UNIQUE + CHECKs';
END $$;

-- T11 (G4): installment_plans N BETWEEN 2 AND 24 + transactions coerência parcela
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.installment_plans'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%total_installments%>= 2%' AND pg_get_constraintdef(oid) ILIKE '%total_installments%<= 24%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T11 (G4) falhou: CHECK N BETWEEN 2 AND 24 ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%installment_number%' AND pg_get_constraintdef(oid) ILIKE '%installment_plan_id%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T11 (G4) falhou: CHECK coerência installment_number ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T11 (G4) ok: parcelas N + coerência';
END $$;

-- T12 (G6 corrigido): transactions CHECK transfer 1-row via invoice_id (category NULL + xor destino)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%is_transfer%' AND pg_get_constraintdef(oid) ILIKE '%category_id%IS NULL%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T12 (G6) falhou: CHECK transfer category NULL ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%is_transfer%' AND pg_get_constraintdef(oid) ILIKE '%transfer_destination_account_id%' AND pg_get_constraintdef(oid) ILIKE '%invoice_id%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T12 (G6) falhou: CHECK transfer xor destino/invoice ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T12 (G6) ok: transfer 1-row via invoice_id';
END $$;

-- T13 (G7): budgets UNIQUE(user,category,month) + mês dia-01 + limit >= 0 + BIGINT
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='budgets' AND column_name='limit_cents' AND data_type='bigint'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T13 (G7) falhou: budgets.limit_cents BIGINT ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.budgets'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%user_id%' AND pg_get_constraintdef(oid) ILIKE '%category_id%' AND pg_get_constraintdef(oid) ILIKE '%month%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T13 (G7) falhou: UNIQUE (user,category,month) ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.budgets'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%limit_cents%>= 0%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T13 (G7) falhou: CHECK limit_cents >= 0 ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.budgets'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%month%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T13 (G7) falhou: CHECK mês dia-01 ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T13 (G7) ok: budgets UNIQUE + CHECKs';
END $$;

-- T14 (SB-20/0003 ingestão): UNIQUE parcial dedup + CHECK formato 64hex + 2 índices
-- Sem backfill: legado dedup_hash NULL permanece válido (índice parcial ignora NULL).
DO $$
BEGIN
  -- 14a: UNIQUE parcial (user_id, dedup_hash) WHERE dedup_hash IS NOT NULL
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'transactions'
      AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%dedup_hash%'
      AND indexdef ILIKE '%WHERE%' AND indexdef ILIKE '%IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T14 falhou: UNIQUE parcial (user_id, dedup_hash) WHERE NOT NULL ausente';
  END IF;
  -- 14b: UNIQUE total é defeito (quebraria legado NULL) — não pode existir constraint UNIQUE sem WHERE em dedup_hash
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%dedup_hash%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T14 falhou: UNIQUE total em dedup_hash proibido (usar parcial WHERE NOT NULL)';
  END IF;
  -- 14c: CHECK formato 64hex (NULL passa — legado válido)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%dedup_hash%' AND pg_get_constraintdef(oid) ILIKE '%0-9a-f%64%'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T14 falhou: CHECK dedup_hash formato 64hex ausente';
  END IF;
  -- 14d: índice rules por keyword do tenant
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_rules_user_keyword'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T14 falhou: índice idx_rules_user_keyword ausente';
  END IF;
  -- 14e: índice transactions por reconciled do tenant
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_transactions_user_reconciled'
  ) THEN
    RAISE EXCEPTION 'ddl.spec T14 falhou: índice idx_transactions_user_reconciled ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T14 ok: unique parcial + check 64hex + 2 índices';
END $$;

-- T15 (SB-30/SB-31 — 0004 admin policy): espelho de supabase/tests/ddl-0004.spec.sql
-- is_admin SECURITY DEFINER + policies admin + trigger duplo role/status +
-- INSERT nunca auto-super_admin + signup user + funcional (elevação negada ×2 + super_admin ok).
DO $$
DECLARE
  src text;
BEGIN
  -- 15a: is_admin SECURITY DEFINER STABLE
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin' AND prosecdef AND provolatile = 's') THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: function is_admin SECURITY DEFINER STABLE ausente';
  END IF;
  -- 15b: policies admin
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_select_admin') THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: policy profiles_select_admin ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_update_admin') THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: policy profiles_update_admin ausente';
  END IF;
  -- 15c: trigger duplo role+status com exceção admin
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'deny_role_change') THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: trigger deny_role_change ausente';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'deny_role_change' ORDER BY oid LIMIT 1;
  IF src IS NULL OR src NOT ILIKE '%subscription_status%' THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: trigger não guarda subscription_status';
  END IF;
  IF src NOT ILIKE '%is_admin%' THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: trigger sem exceção is_admin';
  END IF;
  -- 15d: trigger INSERT anti auto-admin
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'deny_admin_insert') THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: trigger deny_admin_insert ausente';
  END IF;
  RAISE NOTICE 'ddl.spec T15 estrutural ok: is_admin + policies + trigger duplo + insert guard';
END $$;

-- T15 funcional: fixture via auth.users (FK profiles.id), bypass DBA promove super_admin (0035 remove o admin legado)
DELETE FROM public.internal_operators
WHERE user_id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);

DELETE FROM auth.users
WHERE id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 't15-user@example.com'),
  ('22222222-2222-2222-2222-222222222222', 't15-super@example.com'),
  ('44444444-4444-4444-4444-444444444444', 't15-faker@example.com');
UPDATE public.profiles SET role = 'super_admin' WHERE id = '22222222-2222-2222-2222-222222222222';
DELETE FROM public.profiles WHERE id = '44444444-4444-4444-4444-444444444444';

-- SEC-03 (0051): o super_admin de fixture precisa de operador ATIVO para o
-- caminho feliz das RPCs admin_* (o gate global em is_super_admin() herdou
-- operator-inactive). Bootstrap de fixture, como o seed de dev.
INSERT INTO public.internal_operators (user_id, active)
SELECT p.id, true FROM public.profiles AS p
WHERE p.role = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
  );

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
DO $$
BEGIN
  UPDATE public.profiles SET role = 'super_admin' WHERE id = '11111111-1111-1111-1111-111111111111';
  RAISE EXCEPTION 'ddl.spec T15 falhou: auto-elevação role permitida';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%ddl.spec T15 falhou%' THEN RAISE; END IF;
  IF SQLERRM <> 'not-super-admin' THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: auto-elevação rótulo errado (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'ddl.spec T15 ok: auto-elevação role negada (not-super-admin)';
END $$;
DO $$
BEGIN
  UPDATE public.profiles SET subscription_status = 'active' WHERE id = '11111111-1111-1111-1111-111111111111';
  RAISE EXCEPTION 'ddl.spec T15 falhou: auto-elevação status permitida';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%ddl.spec T15 falhou%' THEN RAISE; END IF;
  RAISE NOTICE 'ddl.spec T15 ok: auto-elevação status negada';
END $$;

SELECT set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
DO $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role, subscription_status)
  VALUES ('44444444-4444-4444-4444-444444444444', 'T15 Fake', 'super_admin', 'trial');
  RAISE EXCEPTION 'ddl.spec T15 falhou: INSERT role super_admin permitido';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%ddl.spec T15 falhou%' THEN RAISE; END IF;
  IF SQLERRM <> 'not-super-admin' THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: negação veio da camada errada (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'ddl.spec T15 ok: INSERT role super_admin negado pelo trigger';
END $$;

SELECT set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
DO $$
DECLARE
  seen int;
BEGIN
  SELECT count(*) INTO seen FROM public.profiles WHERE id = '11111111-1111-1111-1111-111111111111';
  IF seen <> 1 THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: super_admin não enxerga tenant alheio';
  END IF;
  BEGIN
    UPDATE public.profiles SET subscription_status = 'past_due'
    WHERE id = '11111111-1111-1111-1111-111111111111';
    RAISE EXCEPTION 'ddl.spec T15 falhou: super_admin alterou status via client (freeze BE-03)';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%ddl.spec T15 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'profiles-status-readonly-use-tenant-rpc' THEN
        RAISE EXCEPTION 'ddl.spec T15 falhou: rótulo errado para freeze (%)', SQLERRM;
      END IF;
  END;
  UPDATE public.profiles SET role = 'user', full_name = 'Revisado'
  WHERE id = '11111111-1111-1111-1111-111111111111';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ddl.spec T15 falhou: super_admin UPDATE role afetou 0 rows';
  END IF;
  RAISE NOTICE 'ddl.spec T15 ok: super_admin lista alheio; status congela (BE-03); super_admin UPDATE sem mudanca de role ok';
END $$;

RESET ROLE;
DELETE FROM public.internal_operators
WHERE user_id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);

DELETE FROM auth.users
WHERE id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);
