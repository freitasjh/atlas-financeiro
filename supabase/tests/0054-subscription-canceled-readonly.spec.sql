-- 0054-subscription-canceled-readonly.spec.sql — security-debts-49-50 / DEBT-50 (adendo ADR-002).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0054-subscription-canceled-readonly.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova em banco real (mock não avalia trigger, SECURITY DEFINER, search_path,
-- RLS, claims nem transação):
--   T00 estrutura: `private.resolve_user_tenant(uuid)` e
--       `private.assert_subscription_writable()` DEFINER + search_path=''
--       travado + EXECUTE revogado de client/service_role; trigger
--       `aa_subscription_readonly` presente nas 5 tabelas como
--       BEFORE INSERT OR UPDATE FOR EACH ROW (tgtype 23) e SEM DELETE;
--       nome ordena antes de `plan_quota_*`.
--   T1 tenant `canceled` ⇒ INSERT em transactions/accounts/credit_cards/
--       budgets/tenant_members devolve `subscription-canceled-readonly`
--       e 0 linhas.
--   T2 UPDATE em tenant `canceled` ⇒ mesmo rótulo, nenhuma coluna alterada
--       (nas 5 tabelas).
--   T3 DELETE em tenant `canceled` ⇒ PERMITIDO nas 5 tabelas (somente-leitura
--       cobre INSERT/UPDATE; LGPD/cascata dependem de DELETE).
--   T4 tenant `trial`/`active`/`past_due` ⇒ INSERT/UPDATE liberados
--       (regressão das 5 tabelas).
--   T5 usuário sem tenant ⇒ `quota-tenant-missing` (0061: tenant é obrigatório;
--       o legado P0 foi aposentado).
--   T6 ORDEM: tenant `canceled` com quota estourada devolve
--       `subscription-canceled-readonly`. Com o trigger de status desabilitado
--       (simulação) o mesmo INSERT continua devolvendo o rótulo de STATUS,
--       agora do `enforce_tenant_quota` (0076, defesa em profundidade) — os
--       dois portões emitem o mesmo rótulo, então o rótulo não distingue mais
--       ordem de defesa. A ordem status→quota é provada ESTRUTURALMENTE pelo
--       ordinal alfabético do catálogo (`aa_...` < `plan_quota_*`) e por T06
--       1/3, quando só existia um portão; a prova empírica de "quota primeiro"
--       foi perdida de propósito (O-F6-7). Em T06 a prova é não-vácua: existe
--       um token pendente em `private.plan_quota_overrides` do tenant e, após o
--       INSERT bloqueado, ele segue pendente (0 consumidos) — T-A5 do ADR-005
--       §18.3.
--   T7 `private.resolve_user_tenant` determinística: com 2 memberships o
--       owner vence, mesmo sendo a mais recente; sem owner, membership mais
--       antiga vence; empate cai em `tenant_id` (5 chamadas idênticas).
--   T8 C1 (parecer security-debts-49-50): owner de tenant `canceled` **com**
--       membership em tenant `trial` grava INSERT em accounts/transactions;
--       quando TODOS os tenants do usuário estão `canceled` a escrita segue
--       negada com o rótulo.
--   T02f service_role: UPDATE em tenant `canceled` também é negado (o guard
--       não depende de role/current_user).
--
-- Erros por rótulo fixo, sem PII/id. Rerunnable: fixtures (users c540*) são
-- apagadas no início e no fim; cenários mutáveis vivem em transação com ROLLBACK.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
-- ADR-004: o purge de tenants passa por `contract_acceptances` (append-only);
-- o escape declarado é desabilitar o trigger dentro da transação de fixture.
BEGIN;
SET LOCAL app.card_purge = 'on';
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users
WHERE id IN (
  'c5400000-0000-4000-8000-0000000000a1',
  'c5400000-0000-4000-8000-0000000000b1',
  'c5400000-0000-4000-8000-0000000000c1',
  'c5400000-0000-4000-8000-0000000000d1',
  'c5400000-0000-4000-8000-0000000000e1',
  'c5400000-0000-4000-8000-0000000000f1',
  'c5400000-0000-4000-8000-0000000000a2',
  'c5400000-0000-4000-8000-0000000000b2',
  'c5400000-0000-4000-8000-0000000000c2',
  'c5400000-0000-4000-8000-0000000000d2',
  'c5400000-0000-4000-8000-0000000000aa',
  'c5400000-0000-4000-8000-0000000000bb',
  'c5400000-0000-4000-8000-0000000000cc'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

INSERT INTO auth.users (id, email) VALUES
  ('c5400000-0000-4000-8000-0000000000a1', 'canceled-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000b1', 'trial-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000c1', 'active-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000d1', 'pastdue-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000e1', 'notenant-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000f1', 'canceledquota-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000a2', 'ownerwins-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000b2', 'tiebreak-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000c2', 'invitee-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000d2', 'otherowner-0054@example.com'),
  -- T08 (C1): owner de tenant cancelado + membro de trial; e todos-cancelados.
  ('c5400000-0000-4000-8000-0000000000aa', 'crosscanceled-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000bb', 'crosstrial-0054@example.com'),
  ('c5400000-0000-4000-8000-0000000000cc', 'allcanceled-0054@example.com');

-- ============ Fixtures: tenants (RPC atômica como service_role) ============
-- Cada tenant nasce `trial` com aceite; o status final é atribuído abaixo.

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000138', 'Cancelado 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000219', 'Trial 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000c1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000308', 'Ativo 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000d1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000d1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000480', 'Vencido 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000f1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000f1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000561', 'Cancelado Quota 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
COMMIT;

-- T7: tenant_B (owner a2) e tenant_A (owner d2).
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a2', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a2","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000642', 'Owner B 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000d2', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000d2","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000723', 'Owner A 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

-- T08 (C1): tenant de aa (termina `canceled`) — aa também será membro do
-- tenant `trial` de bb; e o tenant de cc (termina `canceled`) — cc é membro de
-- ambos os tenants cancelados (aa e o próprio), logo nenhum gravável.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000aa', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000aa","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000804', 'Cross Cancelado 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000bb', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000bb","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100000995', 'Cross Trial 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000cc', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000cc","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54100001029', 'All Canceled 0054', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

-- ============ Fixtures: linhas das 5 tabelas (tenant ainda `trial`) ============
-- Tudo como postgres (DBA); o trigger de status vale para qualquer role, logo
-- as linhas precisam existir ANTES do cancelamento (é o cenário real: o que já
-- estava gravado continua legível/atualizável? — não: UPDATE passa a ser
-- recusado, T2).

-- tenant cancelado (a1)
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c5400000-0000-4000-8000-000000000101', 'c5400000-0000-4000-8000-0000000000a1', 'Conta Principal 0054', 'checking', 0, 0),
  ('c5400000-0000-4000-8000-000000000102', 'c5400000-0000-4000-8000-0000000000a1', 'Conta Vazia 0054', 'checking', 0, 0),
  ('c5400000-0000-4000-8000-000000000103', 'c5400000-0000-4000-8000-0000000000a1', 'Conta Cartao 0054', 'checking', 0, 0);

INSERT INTO public.categories (id, user_id, name, type) VALUES
  ('c5400000-0000-4000-8000-000000000104', 'c5400000-0000-4000-8000-0000000000a1', 'Categoria 0054', 'expense');

INSERT INTO public.transactions (id, user_id, account_id, category_id, description, amount_cents, date) VALUES
  ('c5400000-0000-4000-8000-000000000105', 'c5400000-0000-4000-8000-0000000000a1',
   'c5400000-0000-4000-8000-000000000101', 'c5400000-0000-4000-8000-000000000104',
   'Lancamento 0054', 1000, '2026-01-10');

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day) VALUES
  ('c5400000-0000-4000-8000-000000000106', 'c5400000-0000-4000-8000-0000000000a1',
   'c5400000-0000-4000-8000-000000000103', 'Cartao 0054', 50000, 10, 20);

INSERT INTO public.budgets (id, user_id, category_id, month, limit_cents) VALUES
  ('c5400000-0000-4000-8000-000000000107', 'c5400000-0000-4000-8000-0000000000a1',
   'c5400000-0000-4000-8000-000000000104', '2026-01-01', 20000);

-- membership de fixture (T3 DELETE) — criada antes do cancelamento.
INSERT INTO public.tenant_members (tenant_id, user_id, role)
SELECT t.id, 'c5400000-0000-4000-8000-0000000000c2', 'member'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000a1';

-- tenant com quota estourada (f1; plano free = 2 contas) — 2 contas já usadas.
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c5400000-0000-4000-8000-0000000001f1', 'c5400000-0000-4000-8000-0000000000f1', 'Conta Quota 1 0054', 'checking', 0, 0),
  ('c5400000-0000-4000-8000-0000000001f2', 'c5400000-0000-4000-8000-0000000000f1', 'Conta Quota 2 0054', 'checking', 0, 0);

-- T4: conta + categoria por status (trial/active/past_due)
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c5400000-0000-4000-8000-0000000001b1', 'c5400000-0000-4000-8000-0000000000b1', 'Conta Trial 0054', 'checking', 0, 0),
  ('c5400000-0000-4000-8000-0000000001c1', 'c5400000-0000-4000-8000-0000000000c1', 'Conta Ativa 0054', 'checking', 0, 0),
  ('c5400000-0000-4000-8000-0000000001d1', 'c5400000-0000-4000-8000-0000000000d1', 'Conta Vencida 0054', 'checking', 0, 0);

INSERT INTO public.categories (id, user_id, name, type) VALUES
  ('c5400000-0000-4000-8000-0000000002b1', 'c5400000-0000-4000-8000-0000000000b1', 'Categoria Trial 0054', 'expense'),
  ('c5400000-0000-4000-8000-0000000002c1', 'c5400000-0000-4000-8000-0000000000c1', 'Categoria Ativa 0054', 'expense'),
  ('c5400000-0000-4000-8000-0000000002d1', 'c5400000-0000-4000-8000-0000000000d1', 'Categoria Vencida 0054', 'expense');

-- T7: memberships do tenant_A (owner d2) — owner vence / empate por tenant_id.
INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at)
SELECT t.id, m.user_id, 'member', m.created_at
FROM public.tenants AS t
CROSS JOIN (VALUES
  ('c5400000-0000-4000-8000-0000000000a2'::uuid, '2026-01-01T00:00:00Z'::timestamptz),
  ('c5400000-0000-4000-8000-0000000000b2'::uuid, '2026-02-01T00:00:00Z'::timestamptz)
) AS m(user_id, created_at)
WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000d2';

-- T7: b2 também é membro do tenant_B (owner a2), mesmo created_at (empate).
INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at)
SELECT t.id, 'c5400000-0000-4000-8000-0000000000b2', 'member', '2026-02-01T00:00:00Z'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000a2';

-- T08 (C1): aa (owner do tenant que será cancelado) entra no tenant `trial`
-- de bb — é o cenário do convite do ADR-006. cc (owner de tenant que será
-- cancelado) entra no tenant de aa, que também será cancelado.
INSERT INTO public.tenant_members (tenant_id, user_id, role)
SELECT t.id, 'c5400000-0000-4000-8000-0000000000aa', 'member'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000bb';

INSERT INTO public.tenant_members (tenant_id, user_id, role)
SELECT t.id, 'c5400000-0000-4000-8000-0000000000cc', 'member'
FROM public.tenants AS t
WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000aa';

-- T06b: 20 lançamentos do mês corrente (free = 20/mês) para f1 — quota de
-- transactions estourada. Inseridos antes do cancelamento (o trigger de
-- status vale para qualquer role, inclusive postgres).
INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
SELECT 'c5400000-0000-4000-8000-0000000000f1',
       'c5400000-0000-4000-8000-0000000001f1',
       'Quota Tx ' || g, 100, '2026-01-05'
FROM generate_series(1, 20) AS g;

-- ============ Fixtures: status final dos tenants ============
UPDATE public.tenants SET subscription_status = 'active'
WHERE owner_user_id = 'c5400000-0000-4000-8000-0000000000c1';
UPDATE public.tenants SET subscription_status = 'past_due'
WHERE owner_user_id = 'c5400000-0000-4000-8000-0000000000d1';
UPDATE public.tenants SET subscription_status = 'canceled'
WHERE owner_user_id IN (
  'c5400000-0000-4000-8000-0000000000a1',
  'c5400000-0000-4000-8000-0000000000f1',
  'c5400000-0000-4000-8000-0000000000aa',
  'c5400000-0000-4000-8000-0000000000cc'
);

-- ============ T00 — estrutura ============
DO $$
DECLARE
  v_proc pg_proc;
  v_tg pg_trigger;
  v_table text;
  v_tables text[] := ARRAY['accounts', 'budgets', 'credit_cards', 'tenant_members', 'transactions'];
BEGIN
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('private.resolve_user_tenant(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0054 T00 falhou: resolve_user_tenant ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0054 T00 falhou: resolve_user_tenant sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0054 T00 falhou: resolve_user_tenant sem search_path vazio';
  END IF;
  IF has_function_privilege('authenticated', 'private.resolve_user_tenant(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.resolve_user_tenant(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.resolve_user_tenant(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0054 T00 falhou: resolve_user_tenant executavel por client';
  END IF;

  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('private.assert_subscription_writable()');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0054 T00 falhou: assert_subscription_writable ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0054 T00 falhou: assert_subscription_writable sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0054 T00 falhou: assert_subscription_writable sem search_path vazio';
  END IF;
  IF v_proc.prosrc NOT LIKE '%subscription-canceled-readonly%' THEN
    RAISE EXCEPTION '0054 T00 falhou: rotulo subscription-canceled-readonly ausente';
  END IF;
  IF has_function_privilege('authenticated', 'private.assert_subscription_writable()', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.assert_subscription_writable()', 'EXECUTE') THEN
    RAISE EXCEPTION '0054 T00 falhou: trigger function com EXECUTE para client';
  END IF;

  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT * INTO v_tg FROM pg_trigger
    WHERE tgname = 'aa_subscription_readonly'
      AND tgrelid = format('public.%I', v_table)::regclass
      AND NOT tgisinternal;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0054 T00 falhou: trigger ausente em %', v_table;
    END IF;
    -- 23 = ROW(1) + BEFORE(2) + INSERT(4) + UPDATE(16); DELETE(8) fora.
    IF v_tg.tgtype <> 23 THEN
      RAISE EXCEPTION '0054 T00 falhou: tgtype % em % (esperado 23)', v_tg.tgtype, v_table;
    END IF;
  END LOOP;

  -- Ordinal alfabético: o nome do trigger de status vem antes de plan_quota_*.
  IF NOT ('aa_subscription_readonly' < 'plan_quota_transactions') THEN
    RAISE EXCEPTION '0054 T00 falhou: nome do trigger nao ordena antes de plan_quota_*';
  END IF;

  RAISE NOTICE '0054 T00 ok: DEFINER + search_path vazio + EXECUTE revogado + 5 triggers BEFORE INSERT/UPDATE sem DELETE';
END $$;

-- ============ T01a — INSERT bloqueado em tenant canceled (transactions) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c5400000-0000-4000-8000-0000000000a1',
            'c5400000-0000-4000-8000-000000000101', 'Novo 0054', 500, '2026-02-01');
    RAISE EXCEPTION '0054 T01a falhou: INSERT em transactions passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T01a falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T01a falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.transactions
  WHERE user_id = 'c5400000-0000-4000-8000-0000000000a1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T01a falhou: linha persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T01a ok: transactions INSERT -> subscription-canceled-readonly, 0 linhas';
END $$;
ROLLBACK;

-- ============ T01b — INSERT bloqueado (accounts) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c5400000-0000-4000-8000-0000000000a1', 'Nova Conta 0054', 'checking');
    RAISE EXCEPTION '0054 T01b falhou: INSERT em accounts passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T01b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T01b falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE user_id = 'c5400000-0000-4000-8000-0000000000a1';
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0054 T01b falhou: linha persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T01b ok: accounts INSERT -> subscription-canceled-readonly, 0 linhas';
END $$;
ROLLBACK;

-- ============ T01c — INSERT bloqueado (credit_cards) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  BEGIN
    INSERT INTO public.credit_cards (user_id, account_id, name, limit_cents, closing_day, due_day)
    VALUES ('c5400000-0000-4000-8000-0000000000a1',
            'c5400000-0000-4000-8000-000000000103', 'Novo Cartao 0054', 10000, 5, 15);
    RAISE EXCEPTION '0054 T01c falhou: INSERT em credit_cards passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T01c falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T01c falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.credit_cards
  WHERE user_id = 'c5400000-0000-4000-8000-0000000000a1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T01c falhou: linha persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T01c ok: credit_cards INSERT -> subscription-canceled-readonly, 0 linhas';
END $$;
ROLLBACK;

-- ============ T01d — INSERT bloqueado (budgets) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  BEGIN
    INSERT INTO public.budgets (user_id, category_id, month, limit_cents)
    VALUES ('c5400000-0000-4000-8000-0000000000a1',
            'c5400000-0000-4000-8000-000000000104', '2026-04-01', 10000);
    RAISE EXCEPTION '0054 T01d falhou: INSERT em budgets passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T01d falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T01d falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.budgets
  WHERE user_id = 'c5400000-0000-4000-8000-0000000000a1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T01d falhou: linha persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T01d ok: budgets INSERT -> subscription-canceled-readonly, 0 linhas';
END $$;
ROLLBACK;

-- ============ T01e — INSERT bloqueado (tenant_members) ============
-- `authenticated` não tem INSERT em tenant_members (matriz da 0022: só SELECT);
-- a via de escrita existente é backoffice/service_role. O trigger vale igual.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000c2', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000c2","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
  v_tenant uuid;
BEGIN
  SELECT t.id INTO v_tenant FROM public.tenants AS t
  WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000a1';
  BEGIN
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, 'c5400000-0000-4000-8000-0000000000b2', 'member');
    RAISE EXCEPTION '0054 T01e falhou: INSERT em tenant_members passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T01e falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T01e falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = v_tenant
    AND user_id = 'c5400000-0000-4000-8000-0000000000b2';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0054 T01e falhou: membership persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T01e ok: tenant_members INSERT -> subscription-canceled-readonly, 0 linhas';
END $$;
ROLLBACK;

-- ============ T02a — UPDATE bloqueado (transactions) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_desc text;
BEGIN
  BEGIN
    UPDATE public.transactions SET description = 'Alterado 0054'
    WHERE id = 'c5400000-0000-4000-8000-000000000105';
    RAISE EXCEPTION '0054 T02a falhou: UPDATE em transactions passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T02a falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T02a falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT description INTO v_desc FROM public.transactions
  WHERE id = 'c5400000-0000-4000-8000-000000000105';
  IF v_desc <> 'Lancamento 0054' THEN
    RAISE EXCEPTION '0054 T02a falhou: descricao alterada (%)', v_desc;
  END IF;
  RAISE NOTICE '0054 T02a ok: transactions UPDATE -> subscription-canceled-readonly, linha intacta';
END $$;
ROLLBACK;

-- ============ T02b — UPDATE bloqueado (accounts) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_name text;
BEGIN
  BEGIN
    UPDATE public.accounts SET name = 'Alterada 0054'
    WHERE id = 'c5400000-0000-4000-8000-000000000101';
    RAISE EXCEPTION '0054 T02b falhou: UPDATE em accounts passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T02b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T02b falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT name INTO v_name FROM public.accounts
  WHERE id = 'c5400000-0000-4000-8000-000000000101';
  IF v_name <> 'Conta Principal 0054' THEN
    RAISE EXCEPTION '0054 T02b falhou: nome alterado (%)', v_name;
  END IF;
  RAISE NOTICE '0054 T02b ok: accounts UPDATE -> subscription-canceled-readonly, linha intacta';
END $$;
ROLLBACK;

-- ============ T02c — UPDATE bloqueado (credit_cards) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_limit bigint;
BEGIN
  BEGIN
    UPDATE public.credit_cards SET limit_cents = 99000
    WHERE id = 'c5400000-0000-4000-8000-000000000106';
    RAISE EXCEPTION '0054 T02c falhou: UPDATE em credit_cards passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T02c falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T02c falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT limit_cents INTO v_limit FROM public.credit_cards
  WHERE id = 'c5400000-0000-4000-8000-000000000106';
  IF v_limit <> 50000 THEN
    RAISE EXCEPTION '0054 T02c falhou: limite alterado (%)', v_limit;
  END IF;
  RAISE NOTICE '0054 T02c ok: credit_cards UPDATE -> subscription-canceled-readonly, linha intacta';
END $$;
ROLLBACK;

-- ============ T02d — UPDATE bloqueado (budgets) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_limit bigint;
BEGIN
  BEGIN
    UPDATE public.budgets SET limit_cents = 99000
    WHERE id = 'c5400000-0000-4000-8000-000000000107';
    RAISE EXCEPTION '0054 T02d falhou: UPDATE em budgets passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T02d falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T02d falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT limit_cents INTO v_limit FROM public.budgets
  WHERE id = 'c5400000-0000-4000-8000-000000000107';
  IF v_limit <> 20000 THEN
    RAISE EXCEPTION '0054 T02d falhou: limite alterado (%)', v_limit;
  END IF;
  RAISE NOTICE '0054 T02d ok: budgets UPDATE -> subscription-canceled-readonly, linha intacta';
END $$;
ROLLBACK;

-- ============ T02e — UPDATE bloqueado (tenant_members) ============
-- Escrita de membership é backoffice/service_role (0022 revoga UPDATE de
-- authenticated). O trigger vale para a via que existe.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_role text;
  v_tenant uuid;
BEGIN
  SELECT t.id INTO v_tenant FROM public.tenants AS t
  WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000a1';
  BEGIN
    UPDATE public.tenant_members SET role = 'admin'
    WHERE tenant_id = v_tenant
      AND user_id = 'c5400000-0000-4000-8000-0000000000c2';
    RAISE EXCEPTION '0054 T02e falhou: UPDATE em tenant_members passou em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T02e falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T02e falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT role INTO v_role FROM public.tenant_members
  WHERE tenant_id = v_tenant
    AND user_id = 'c5400000-0000-4000-8000-0000000000c2';
  IF v_role <> 'member' THEN
    RAISE EXCEPTION '0054 T02e falhou: papel alterado (%)', v_role;
  END IF;
  RAISE NOTICE '0054 T02e ok: tenant_members UPDATE -> subscription-canceled-readonly, linha intacta';
END $$;
ROLLBACK;

-- ============ T02f — UPDATE bloqueado (service_role) ============
-- O guard não lê role/current_user (por desenho): a via administrativa
-- service_role também recebe o rótulo em tenant `canceled`.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_name text;
BEGIN
  BEGIN
    UPDATE public.accounts SET name = 'Alterada via Admin 0054'
    WHERE id = 'c5400000-0000-4000-8000-000000000103';
    RAISE EXCEPTION '0054 T02f falhou: UPDATE em accounts passou para service_role em tenant canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T02f falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T02f falhou: rotulo errado para service_role (%)', SQLERRM;
    END IF;
  END;
  SELECT name INTO v_name FROM public.accounts
  WHERE id = 'c5400000-0000-4000-8000-000000000103';
  IF v_name <> 'Conta Cartao 0054' THEN
    RAISE EXCEPTION '0054 T02f falhou: nome alterado (%)', v_name;
  END IF;
  RAISE NOTICE '0054 T02f ok: service_role UPDATE em tenant canceled -> subscription-canceled-readonly, linha intacta';
END $$;
ROLLBACK;

-- ============ T03a..e — DELETE permitido em tenant canceled ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  DELETE FROM public.transactions WHERE id = 'c5400000-0000-4000-8000-000000000105';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T03a falhou: DELETE de transaction bloqueado (%)', v_n;
  END IF;

  DELETE FROM public.budgets WHERE id = 'c5400000-0000-4000-8000-000000000107';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T03b falhou: DELETE de budget bloqueado (%)', v_n;
  END IF;

  DELETE FROM public.credit_cards WHERE id = 'c5400000-0000-4000-8000-000000000106';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T03c falhou: DELETE de cartao bloqueado (%)', v_n;
  END IF;

  DELETE FROM public.accounts WHERE id = 'c5400000-0000-4000-8000-000000000102';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T03d falhou: DELETE de conta vazia bloqueado (%)', v_n;
  END IF;

  RAISE NOTICE '0054 T03a-d ok: DELETE permitido em transactions/budgets/credit_cards/accounts';
END $$;
RESET ROLE;

-- tenant_members: via de escrita existente é service_role (0022 não concede
-- DELETE a authenticated).
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
DO $$
DECLARE
  v_n int;
  v_tenant uuid;
BEGIN
  SELECT t.id INTO v_tenant FROM public.tenants AS t
  WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000a1';
  DELETE FROM public.tenant_members
  WHERE tenant_id = v_tenant
    AND user_id = 'c5400000-0000-4000-8000-0000000000c2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T03e falhou: DELETE de membership bloqueado (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T03e ok: DELETE de tenant_members permitido';
END $$;
ROLLBACK;

-- ============ T04 — trial/active/past_due seguem graváveis (regressão) ============
-- Cada bloco: INSERT + UPDATE nas 5 tabelas. tenant_members pela via
-- service_role (única com escrita). Plano `full` (sem quota) isola o status.
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_cases record;
BEGIN
  FOR v_cases IN
    SELECT * FROM (VALUES
      ('c5400000-0000-4000-8000-0000000000b1'::uuid, 'c5400000-0000-4000-8000-0000000001b1'::uuid, 'c5400000-0000-4000-8000-0000000002b1'::uuid, 'trial'),
      ('c5400000-0000-4000-8000-0000000000c1'::uuid, 'c5400000-0000-4000-8000-0000000001c1'::uuid, 'c5400000-0000-4000-8000-0000000002c1'::uuid, 'active'),
      ('c5400000-0000-4000-8000-0000000000d1'::uuid, 'c5400000-0000-4000-8000-0000000001d1'::uuid, 'c5400000-0000-4000-8000-0000000002d1'::uuid, 'past_due')
    ) AS c(user_id, account_id, category_id, status)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', v_cases.user_id::text, false);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_cases.user_id, 'role', 'authenticated', 'aal', 'aal2')::text, false);

    BEGIN
      INSERT INTO public.accounts (user_id, name, type)
      VALUES (v_cases.user_id, 'Conta Nova ' || v_cases.status, 'checking');
      UPDATE public.accounts SET name = 'Conta Renomeada ' || v_cases.status
      WHERE id = v_cases.account_id;

      INSERT INTO public.transactions (user_id, account_id, category_id, description, amount_cents, date)
      VALUES (v_cases.user_id, v_cases.account_id, v_cases.category_id, 'Tx ' || v_cases.status, 700, '2026-05-05');
      UPDATE public.transactions SET description = 'Tx Renomeada ' || v_cases.status
      WHERE user_id = v_cases.user_id AND description = 'Tx ' || v_cases.status;

      INSERT INTO public.credit_cards (user_id, account_id, name, limit_cents, closing_day, due_day)
      VALUES (v_cases.user_id, v_cases.account_id, 'Cartao ' || v_cases.status, 10000, 8, 18);
      UPDATE public.credit_cards SET limit_cents = 12000
      WHERE user_id = v_cases.user_id AND name = 'Cartao ' || v_cases.status;

      INSERT INTO public.budgets (user_id, category_id, month, limit_cents)
      VALUES (v_cases.user_id, v_cases.category_id, '2026-06-01', 5000);
      UPDATE public.budgets SET limit_cents = 6000
      WHERE user_id = v_cases.user_id AND month = '2026-06-01';

      RAISE NOTICE '0054 T04 ok: status % grava INSERT/UPDATE (4 tabelas de dados)', v_cases.status;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '0054 T04 falhou: status % bloqueado (%)', v_cases.status, SQLERRM;
    END;
  END LOOP;
END $$;

-- tenant_members: mesma prova pela via autorizada (trial).
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT t.id INTO v_tenant FROM public.tenants AS t
  WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000b1';
  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (v_tenant, 'c5400000-0000-4000-8000-0000000000e1', 'member');
  UPDATE public.tenant_members SET role = 'admin'
  WHERE tenant_id = v_tenant
    AND user_id = 'c5400000-0000-4000-8000-0000000000e1';
  RAISE NOTICE '0054 T04 ok: tenant_members INSERT/UPDATE liberado em tenant trial';
END $$;
ROLLBACK;

-- ============ T05 — usuário sem tenant ⇒ quota-tenant-missing (0061) ============
-- O legado P0 ("sem tenant ⇒ libera") foi aposentado pela 0061: sem tenant é
-- erro de provisionamento, não caminho livre.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000e1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c5400000-0000-4000-8000-0000000000e1', 'Conta Sem Tenant 0054', 'checking');
    RAISE EXCEPTION '0054 T05 falhou: INSERT sem tenant passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T05 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'quota-tenant-missing' THEN
      RAISE EXCEPTION '0054 T05 falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE user_id = 'c5400000-0000-4000-8000-0000000000e1';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0054 T05 falhou: linha sem tenant persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T05 ok: sem tenant -> quota-tenant-missing, 0 linhas (0061)';
END $$;
ROLLBACK;

-- ============ T06 — ORDEM: status antes de quota ============
-- f1: tenant canceled + plano free (2 contas já usadas = quota estourada).
-- Token PENDENTE de override do tenant para `accounts`: sem ele a asserção de
-- "nada consumido" seria vácua (não haveria o que consumir). Com o guard de
-- status ligado o INSERT morre antes de `enforce_plan_quota`, logo o token
-- continua pendente — é a prova de T-A5 do ADR-005 §18.3.
BEGIN;
INSERT INTO private.plan_quota_overrides (tenant_id, resource_type)
SELECT t.id, 'accounts' FROM public.tenants AS t
WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000f1';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000f1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c5400000-0000-4000-8000-0000000000f1', 'Conta Ordem 0054', 'checking');
    RAISE EXCEPTION '0054 T06 falhou: INSERT passou (canceled + quota)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T06 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T06 falhou: rotulo errado com trigger ligado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0054 T06 ok (1/3): canceled + quota -> subscription-canceled-readonly';
END $$;
RESET ROLE;

-- T06 (2/3) — T-A5 (ADR-005 §18.3): o guard de status falha ANTES do consumo
-- do token. O override pendente segue pendente e nenhum foi consumido.
DO $$
DECLARE
  v_pending int;
  v_consumed int;
BEGIN
  SELECT count(*) FILTER (WHERE o.consumed_at IS NULL),
         count(*) FILTER (WHERE o.consumed_at IS NOT NULL)
    INTO v_pending, v_consumed
  FROM private.plan_quota_overrides AS o
  JOIN public.tenants AS t ON t.id = o.tenant_id
  WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000f1';
  IF v_pending <> 1 THEN
    RAISE EXCEPTION '0054 T06 falhou: token de override deveria seguir pendente (%)', v_pending;
  END IF;
  IF v_consumed <> 0 THEN
    RAISE EXCEPTION '0054 T06 falhou: override consumido por INSERT bloqueado pelo status (%)', v_consumed;
  END IF;
  RAISE NOTICE '0054 T06 ok (2/3): override pendente intacto, 0 consumidos (status antes de quota)';
END $$;

-- O token é retirado para a contraprova: com override disponível o INSERT
-- passaria (é justamente o que o token faz), mascarando a ordem.
DELETE FROM private.plan_quota_overrides AS o
USING public.tenants AS t
WHERE t.id = o.tenant_id
  AND t.owner_user_id = 'c5400000-0000-4000-8000-0000000000f1';

-- Contraprova (re-apontada em F6/0076 — O-F6-7): com `aa_subscription_readonly`
-- desabilitado o rótulo de status CONTINUA saindo, agora do
-- `public.enforce_tenant_quota` (0076, checagem de status antes da quota). A
-- ordem status→quota deixou de ser distinguível pelo rótulo porque os dois
-- portões emitem o MESMO rótulo; a prova de ordem migrou para o estrutural —
-- ordinal alfabético do catálogo (`aa_` < `plan_quota_*`, T00 do spec 0075-0076
-- e o bloco de catálogo deste arquivo) — e para o registro de execução de T06
-- (1/3), quando só existia um portão. A prova empírica de "quota primeiro" foi
-- perdida de propósito: se o 0076 não existisse, este INSERT voltaria a emitir
-- `quota-accounts-exceeded`.
ALTER TABLE public.accounts DISABLE TRIGGER aa_subscription_readonly;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c5400000-0000-4000-8000-0000000000f1', 'Conta Ordem 0054', 'checking');
    RAISE EXCEPTION '0054 T06 falhou: INSERT passou com trigger de status desligado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T06 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T06 falhou: rotulo errado sem trigger de status (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0054 T06 ok (3/3): sem o trigger de status o mesmo INSERT -> subscription-canceled-readonly (defesa em profundidade do 0076)';
END $$;
RESET ROLE;
ALTER TABLE public.accounts ENABLE TRIGGER aa_subscription_readonly;

-- T06 (fecho) — nenhum override consumido no tenant do teste, nem pelo caminho
-- que chega na quota (token já retirado: a quota nega sem consumir).
DO $$
DECLARE
  v_consumed int;
BEGIN
  SELECT count(*) FILTER (WHERE o.consumed_at IS NOT NULL)
    INTO v_consumed
  FROM private.plan_quota_overrides AS o
  JOIN public.tenants AS t ON t.id = o.tenant_id
  WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000f1';
  IF v_consumed <> 0 THEN
    RAISE EXCEPTION '0054 T06 falhou: override consumido no tenant do teste (%)', v_consumed;
  END IF;
  RAISE NOTICE '0054 T06 ok (fecho): 0 overrides consumidos no tenant';
END $$;
ROLLBACK;

-- ============ T06b — ORDEM em transactions: status antes de quota ============
-- f1: tenant canceled + free (20 transactions no mês já gravadas na fixture).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000f1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c5400000-0000-4000-8000-0000000000f1',
            'c5400000-0000-4000-8000-0000000001f1', 'Tx Ordem 0054', 300, '2026-01-20');
    RAISE EXCEPTION '0054 T06b falhou: INSERT passou (canceled + quota de transactions)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T06b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T06b falhou: rotulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0054 T06b ok (1/2): canceled + quota de transactions -> subscription-canceled-readonly';
END $$;
RESET ROLE;

-- Contraprova (re-apontada em F6/0076 — O-F6-7): com o `aa_` desabilitado o
-- rótulo de status continua saindo do `enforce_tenant_quota` (0076). A ordem
-- status→quota passou a ser provada estruturalmente (ordinal alfabético no
-- catálogo: `aa_` < `plan_quota_*`) porque os dois portões emitem o mesmo
-- rótulo; sem o 0076 este INSERT voltaria a emitir `quota-transactions-exceeded`.
ALTER TABLE public.transactions DISABLE TRIGGER aa_subscription_readonly;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
    VALUES ('c5400000-0000-4000-8000-0000000000f1',
            'c5400000-0000-4000-8000-0000000001f1', 'Tx Ordem 0054', 300, '2026-01-20');
    RAISE EXCEPTION '0054 T06b falhou: INSERT passou com trigger de status desligado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T06b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T06b falhou: rotulo errado sem trigger de status (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0054 T06b ok (2/2): sem o trigger de status o mesmo INSERT -> subscription-canceled-readonly (defesa em profundidade do 0076)';
END $$;
RESET ROLE;
ALTER TABLE public.transactions ENABLE TRIGGER aa_subscription_readonly;
ROLLBACK;

-- ============ T08 — C1: membership gravável libera escrita ============
-- Cenário exato do parecer: owner de tenant `canceled` E membro de tenant
-- `trial` recebia `subscription-canceled-readonly` porque a decisão olhava só
-- o tenant "resolvido" (owner mais antigo). Agora: existe ao menos um tenant
-- gravável ⇒ INSERT/UPDATE liberados.

-- Evidência de que a fixture reproduz o C1: a decisão ANTIGA
-- (`resolve_user_tenant`, owner primeiro) aponta para o tenant `canceled`.
DO $$
DECLARE
  v_resolved uuid;
  v_status text;
BEGIN
  v_resolved := private.resolve_user_tenant('c5400000-0000-4000-8000-0000000000aa');
  SELECT t.subscription_status INTO v_status
  FROM public.tenants AS t WHERE t.id = v_resolved;
  IF v_status IS DISTINCT FROM 'canceled' THEN
    RAISE EXCEPTION '0054 T08 falhou: fixture nao reproduz o C1 (resolvido = %)', v_status;
  END IF;
  RAISE NOTICE '0054 T08 ok (0/2): resolve_user_tenant aponta para tenant canceled (repro do C1 confirmado)';
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000aa', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000aa","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
  v_writable int;
BEGIN
  -- Pré-condição do cenário: dono do tenant cancelado + 1 tenant gravável.
  SELECT count(*) INTO v_writable
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE tm.user_id = 'c5400000-0000-4000-8000-0000000000aa'
    AND t.subscription_status <> 'canceled';
  IF v_writable <> 1 THEN
    RAISE EXCEPTION '0054 T08 falhou: fixture sem tenant gravavel (%)', v_writable;
  END IF;

  INSERT INTO public.accounts (id, user_id, name, type)
  VALUES ('c5400000-0000-4000-8000-0000000003aa',
          'c5400000-0000-4000-8000-0000000000aa', 'Conta Cross Tenant 0054', 'checking');

  INSERT INTO public.transactions (user_id, account_id, description, amount_cents, date)
  VALUES ('c5400000-0000-4000-8000-0000000000aa',
          'c5400000-0000-4000-8000-0000000003aa', 'Tx Cross Tenant 0054', 150, '2026-03-01');

  SELECT count(*) INTO v_n FROM public.accounts
  WHERE user_id = 'c5400000-0000-4000-8000-0000000000aa';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T08 falhou: conta nao persistiu (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.transactions
  WHERE user_id = 'c5400000-0000-4000-8000-0000000000aa';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0054 T08 falhou: lancamento nao persistiu (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T08 ok (1/2): owner de canceled + membro de trial -> INSERT liberado em accounts/transactions (C1 revertido)';
END $$;
ROLLBACK;

-- Contraprova: membership existe e TODOS os tenants estão `canceled` ⇒
-- somente-leitura (a liberação acima não é fail-open).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c5400000-0000-4000-8000-0000000000cc', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c5400000-0000-4000-8000-0000000000cc","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
  v_total int;
  v_writable int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE t.subscription_status <> 'canceled')
    INTO v_total, v_writable
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE tm.user_id = 'c5400000-0000-4000-8000-0000000000cc';
  IF v_total < 2 OR v_writable <> 0 THEN
    RAISE EXCEPTION '0054 T08 falhou: fixture deveria ter >=2 tenants, todos canceled (%/%)',
      v_total, v_writable;
  END IF;

  BEGIN
    INSERT INTO public.accounts (user_id, name, type)
    VALUES ('c5400000-0000-4000-8000-0000000000cc', 'Conta Todos Cancelados 0054', 'checking');
    RAISE EXCEPTION '0054 T08 falhou: INSERT passou com todos os tenants canceled';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0054 T08 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'subscription-canceled-readonly' THEN
      RAISE EXCEPTION '0054 T08 falhou: rotulo errado com todos canceled (%)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_n FROM public.accounts
  WHERE user_id = 'c5400000-0000-4000-8000-0000000000cc';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0054 T08 falhou: linha persistiu com todos canceled (%)', v_n;
  END IF;
  RAISE NOTICE '0054 T08 ok (2/2): todos os tenants canceled -> subscription-canceled-readonly, 0 linhas';
END $$;
ROLLBACK;

-- ============ T07 — resolve_user_tenant determinística ============
DO $$
DECLARE
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_got uuid;
  v_got2 uuid;
  v_expected uuid;
  i int;
BEGIN
  SELECT t.id INTO v_tenant_a FROM public.tenants AS t
  WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000d2';
  SELECT t.id INTO v_tenant_b FROM public.tenants AS t
  WHERE t.owner_user_id = 'c5400000-0000-4000-8000-0000000000a2';

  IF v_tenant_a IS NULL OR v_tenant_b IS NULL THEN
    RAISE EXCEPTION '0054 T07 falhou: tenants de fixture ausentes';
  END IF;

  -- Owner vence, mesmo sendo a membership mais recente (2026-11 > 2026-01).
  v_got := private.resolve_user_tenant('c5400000-0000-4000-8000-0000000000a2');
  IF v_got IS DISTINCT FROM v_tenant_b THEN
    RAISE EXCEPTION '0054 T07 falhou: owner nao venceu a membership antiga';
  END IF;

  -- 5 chamadas idênticas (determinismo).
  FOR i IN 1..5 LOOP
    v_got2 := private.resolve_user_tenant('c5400000-0000-4000-8000-0000000000a2');
    IF v_got2 IS DISTINCT FROM v_got THEN
      RAISE EXCEPTION '0054 T07 falhou: resolucao nao deterministica (%)', v_got2;
    END IF;
  END LOOP;

  -- Sem owner: empate de created_at cai em tenant_id (menor vence).
  v_expected := LEAST(v_tenant_a, v_tenant_b);
  v_got := private.resolve_user_tenant('c5400000-0000-4000-8000-0000000000b2');
  IF v_got IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION '0054 T07 falhou: desempate por tenant_id divergente';
  END IF;
  FOR i IN 1..5 LOOP
    v_got2 := private.resolve_user_tenant('c5400000-0000-4000-8000-0000000000b2');
    IF v_got2 IS DISTINCT FROM v_got THEN
      RAISE EXCEPTION '0054 T07 falhou: desempate nao deterministico (%)', v_got2;
    END IF;
  END LOOP;

  -- Sem membership: NULL (contrato base; 0061 trata o orfao).
  IF private.resolve_user_tenant('c5400000-0000-4000-8000-0000000000e1') IS NOT NULL THEN
    RAISE EXCEPTION '0054 T07 falhou: usuario sem tenant deveria resolver NULL';
  END IF;

  RAISE NOTICE '0054 T07 ok: owner vence, desempate por tenant_id, 5 chamadas identicas, sem tenant -> NULL';
END $$;

-- ============ Fixtures cleanup (fim) ============
BEGIN;
SET LOCAL app.card_purge = 'on';
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM auth.users
WHERE id IN (
  'c5400000-0000-4000-8000-0000000000a1',
  'c5400000-0000-4000-8000-0000000000b1',
  'c5400000-0000-4000-8000-0000000000c1',
  'c5400000-0000-4000-8000-0000000000d1',
  'c5400000-0000-4000-8000-0000000000e1',
  'c5400000-0000-4000-8000-0000000000f1',
  'c5400000-0000-4000-8000-0000000000a2',
  'c5400000-0000-4000-8000-0000000000b2',
  'c5400000-0000-4000-8000-0000000000c2',
  'c5400000-0000-4000-8000-0000000000d2',
  'c5400000-0000-4000-8000-0000000000aa',
  'c5400000-0000-4000-8000-0000000000bb',
  'c5400000-0000-4000-8000-0000000000cc'
);
ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

\echo '0054 subscription-canceled-readonly: OK'
