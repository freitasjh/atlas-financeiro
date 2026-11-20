-- 0062-0064-tenant-quota-members.spec.sql — tenant-quota / F3 / ADR-002 (BE-35/BE-37/BE-39).
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0062-0064-tenant-quota-members.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova em banco real (mock não avalia trigger, SECURITY DEFINER, search_path,
-- RLS, claims, GRANT nem CHECK):
--   T06 (0062) `plan_limits.max_members`: coluna integer com CHECK >= 1
--       (0/negativos violam; NULL ilimitado — R1); seed
--       free 1 / standard 3 / pro 10 / full NULL; os 4 limites antigos
--       inalterados; `get_plan_limit` recriada com 5 colunas na ordem do
--       contrato, DEFINER/search_path vazio, EXECUTE só `authenticated`;
--       `tenant-plan-invalid` preservado; `plan_limits` continua fechada.
--   T07 (0062/0063) I9: `plan_limits` sem linha é ERRO, nunca ilimitado —
--       DELETE do plano `free` na transação ⇒ `plan-limits-missing`, 0 linhas.
--   T08 (0062/0063) Borda: `full` (NULL) nunca bloqueia — 4 convites aceitos,
--       contagem = 5 (owner + 4); `max_members` NULL na leitura.
--   T09 (0063) owner conta como 1 (I13): tenant `free` nasce com owner
--       (count = 1 < limite 1) e o 2º convite ⇒ `quota-members-exceeded`,
--       count = 1, 0 linhas.
--   T10 (0063) DELETE libera vaga (RN-01): tenant `standard` (limite 3) cheio
--       recusa o 4º; removido 1 membro, o MESMO convite passa e a contagem
--       volta a 3.
--   T11 (0063) estrutura/ordinal: 1 trigger `plan_quota_tenant_members`
--       BEFORE INSERT (tgtype 7) apontando para `enforce_tenant_quota`,
--       ordinal depois de `aa_subscription_readonly` (I7); rótulo
--       `quota-members-exceeded` no corpo; DEFINER/search_path vazio; sem
--       EXECUTE para client; `members` fora dos 4 valores de override (REQ-24).
--   T12 (0064) `get_tenant_usage`: 1 arg com DEFAULT, RETURNS TABLE(resource
--       text, used bigint, limit_max integer), VOLATILE (grava trilha),
--       DEFINER/search_path vazio, EXECUTE só `authenticated`; 5 linhas fixas
--       na ordem transactions/accounts/credit_cards/budgets/members com
--       `used` exato e `limit_max` do plano; janela mensal SP (linha de 2
--       meses atrás fora da contagem).
--   T13 (0064) `p_tenant` NULL ⇒ tenant GRAVÁVEL do chamador; sem tenant ⇒
--       0 linhas (O-F3-4); sem sessão ⇒ `not-authenticated`.
--   T14 (0064) operador (`is_admin`/super_admin + aal2 + operador ativo) lê
--       qualquer tenant com EXATAMENTE 1 trilha
--       `admin_audit(action='other', reason='internal_admin_read',
--       target_id=tenant_id=p_tenant, actor=auth.uid())`; tenant inexistente ⇒
--       `tenant-not-found` sem trilha nova.
--   T15 (0064) `authenticated` de outro tenant ⇒ `tenant-not-member`, 0
--       linhas, sem trilha; o próprio tenant por `p_tenant` explícito ⇒ 5
--       linhas; tenant inexistente no caminho de membro ⇒ `tenant-not-member`.
--   T16 (0064) I-2: owner do tenant C1 `canceled` + membro do C2 `active` —
--       `get_tenant_usage(NULL)` devolve o consumo do tenant GRAVÁVEL (C2),
--       o MESMO sujeito do gate de escrita; o base (`resolve_user_tenant`)
--       devolveria C1.
--   T17 (0062) R1: `max_members = 0` e negativo violam o CHECK (`>= 1`);
--       NULL continua ilimitado — `0` é excedido no gate, não ilimitado.
--
-- Erros por rótulo fixo, sem PII/id. Rerunnable: fixtures (c62*/c63*/c64*)
-- apagadas no início e no fim; cenários mutáveis vivem em transação com
-- ROLLBACK.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
BEGIN;
SET LOCAL app.card_purge = 'on';
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.transactions
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.credit_cards
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.budgets
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.categories
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.accounts
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c6200000-0000-4000-8000-0000000000f1',
    'c6300000-0000-4000-8000-0000000000a1',
    'c6300000-0000-4000-8000-0000000000b1',
    'c6400000-0000-4000-8000-0000000000a1',
    'c6400000-0000-4000-8000-0000000000b1'
  )
);
DELETE FROM public.contract_acceptances
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.tenant_members
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.admin_audit
WHERE actor_id IN (
  'c6400000-0000-4000-8000-0000000000ad',
  'c6400000-0000-4000-8000-0000000000a1'
)
OR target_id = 'c6400000-0000-4000-8000-0000000000ad'
OR target_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c6200000-0000-4000-8000-0000000000f1',
    'c6300000-0000-4000-8000-0000000000a1',
    'c6300000-0000-4000-8000-0000000000b1',
    'c6400000-0000-4000-8000-0000000000a1',
    'c6400000-0000-4000-8000-0000000000b1'
  )
);
DELETE FROM public.internal_operators
WHERE user_id = 'c6400000-0000-4000-8000-0000000000ad';
DELETE FROM public.tenants
WHERE owner_user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM auth.users
WHERE id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1',
  'c6400000-0000-4000-8000-0000000000ad',
  'c6400000-0000-4000-8000-0000000000e1'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

INSERT INTO auth.users (id, email) VALUES
  ('c6200000-0000-4000-8000-0000000000f1', 'quota-members-f1-0062@example.com'),
  ('c6200000-0000-4000-8000-0000000000f2', 'quota-members-f2-0062@example.com'),
  ('c6300000-0000-4000-8000-0000000000a1', 'quota-members-a1-0063@example.com'),
  ('c6300000-0000-4000-8000-0000000000a2', 'quota-members-a2-0063@example.com'),
  ('c6300000-0000-4000-8000-0000000000a3', 'quota-members-a3-0063@example.com'),
  ('c6300000-0000-4000-8000-0000000000a4', 'quota-members-a4-0063@example.com'),
  ('c6300000-0000-4000-8000-0000000000b1', 'quota-members-b1-0063@example.com'),
  ('c6300000-0000-4000-8000-0000000000b2', 'quota-members-b2-0063@example.com'),
  ('c6300000-0000-4000-8000-0000000000b3', 'quota-members-b3-0063@example.com'),
  ('c6300000-0000-4000-8000-0000000000b4', 'quota-members-b4-0063@example.com'),
  ('c6300000-0000-4000-8000-0000000000b5', 'quota-members-b5-0063@example.com'),
  ('c6400000-0000-4000-8000-0000000000a1', 'quota-usage-a1-0064@example.com'),
  ('c6400000-0000-4000-8000-0000000000b1', 'quota-usage-b1-0064@example.com'),
  ('c6400000-0000-4000-8000-0000000000ad', 'quota-usage-admin-0064@example.com'),
  ('c6400000-0000-4000-8000-0000000000e1', 'quota-usage-none-0064@example.com');

-- Admin de fixture (is_admin() = is_super_admin(): role + aal2 + operador ativo).
UPDATE public.profiles
SET role = 'super_admin', must_change_password = false
WHERE id = 'c6400000-0000-4000-8000-0000000000ad';

INSERT INTO public.internal_operators (user_id, active)
VALUES ('c6400000-0000-4000-8000-0000000000ad', true);

-- ============ Fixtures: tenants (RPC atômica como service_role) ============
-- F62 `free` (limite de membros 1), S63 `standard` (3), FULL63 `full` (NULL),
-- A64 `standard` (consumo), B64 `free` (cross-tenant).

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6200000-0000-4000-8000-0000000000f1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6200000-0000-4000-8000-0000000000f1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54300000190', 'Quota Members Free 0062', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6300000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6300000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54300000271', 'Quota Members Standard 0063', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'standard');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6300000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6300000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54300000352', 'Quota Members Full 0063', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'full');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6400000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6400000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54300000433', 'Quota Usage A 0064', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'standard');
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'c6400000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6400000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);
SELECT public.create_tenant_with_owner_and_acceptance(
  'pf', '54300000514', 'Quota Usage B 0064', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
COMMIT;

-- Membros de fixture (dentro do limite de cada plano).
INSERT INTO public.tenant_members (tenant_id, user_id, role)
SELECT t.id, m.user_id, 'member'
FROM public.tenants AS t
CROSS JOIN (VALUES
  ('c6300000-0000-4000-8000-0000000000a2'::uuid),
  ('c6300000-0000-4000-8000-0000000000a3'::uuid)
) AS m(user_id)
WHERE t.owner_user_id = 'c6300000-0000-4000-8000-0000000000a1';

INSERT INTO public.tenant_members (tenant_id, user_id, role)
SELECT t.id, m.user_id, 'member'
FROM public.tenants AS t
CROSS JOIN (VALUES
  ('c6300000-0000-4000-8000-0000000000b2'::uuid),
  ('c6300000-0000-4000-8000-0000000000b3'::uuid),
  ('c6300000-0000-4000-8000-0000000000b4'::uuid),
  ('c6300000-0000-4000-8000-0000000000b5'::uuid)
) AS m(user_id)
WHERE t.owner_user_id = 'c6300000-0000-4000-8000-0000000000b1';

-- Consumo do tenant A64 (standard): 2 contas, 1 cartão, 1 orçamento,
-- 3 lançamentos do mês corrente (created_at normalizado pelo gate 0061).
INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents) VALUES
  ('c6400000-0000-4000-8000-0000000a0101', 'c6400000-0000-4000-8000-0000000000a1', 'Usage Conta 1 0064', 'checking', 0, 0),
  ('c6400000-0000-4000-8000-0000000a0102', 'c6400000-0000-4000-8000-0000000000a1', 'Usage Conta 2 0064', 'checking', 0, 0);

INSERT INTO public.categories (id, user_id, name, type) VALUES
  ('c6400000-0000-4000-8000-0000000a0201', 'c6400000-0000-4000-8000-0000000000a1', 'Usage Categoria 0064', 'expense');

INSERT INTO public.budgets (id, user_id, category_id, month, limit_cents) VALUES
  ('c6400000-0000-4000-8000-0000000a0301', 'c6400000-0000-4000-8000-0000000000a1',
   'c6400000-0000-4000-8000-0000000a0201', date_trunc('month', now())::date, 100000);

INSERT INTO public.credit_cards (id, user_id, account_id, name, limit_cents, closing_day, due_day) VALUES
  ('c6400000-0000-4000-8000-0000000a0401', 'c6400000-0000-4000-8000-0000000000a1',
   'c6400000-0000-4000-8000-0000000a0101', 'Usage Cartao 0064', 50000, 10, 20);

INSERT INTO public.transactions (id, user_id, account_id, description, amount_cents, date) VALUES
  ('c6400000-0000-4000-8000-0000000a0501', 'c6400000-0000-4000-8000-0000000000a1',
   'c6400000-0000-4000-8000-0000000a0101', 'Usage Tx 1 0064', 100, current_date),
  ('c6400000-0000-4000-8000-0000000a0502', 'c6400000-0000-4000-8000-0000000000a1',
   'c6400000-0000-4000-8000-0000000a0101', 'Usage Tx 2 0064', 200, current_date),
  ('c6400000-0000-4000-8000-0000000a0503', 'c6400000-0000-4000-8000-0000000000a1',
   'c6400000-0000-4000-8000-0000000a0101', 'Usage Tx 3 0064', 300, current_date);

-- Ids dos tenants para os cenários.
SELECT
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6200000-0000-4000-8000-0000000000f1') AS tf62,
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6300000-0000-4000-8000-0000000000a1') AS ts63,
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6300000-0000-4000-8000-0000000000b1') AS tfull,
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6400000-0000-4000-8000-0000000000a1') AS ta64,
  (SELECT t.id FROM public.tenants AS t
    WHERE t.owner_user_id = 'c6400000-0000-4000-8000-0000000000b1') AS tb64
\gset

-- ============ T06 — 0062: max_members + get_plan_limit com 5 colunas ============
DO $$
DECLARE
  v_proc pg_proc;
  v_ret text;
  v_type text;
  v_def text;
BEGIN
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('public.get_plan_limit(text)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0062 T06 falhou: get_plan_limit ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0062 T06 falhou: get_plan_limit sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0062 T06 falhou: get_plan_limit sem search_path vazio';
  END IF;

  v_ret := pg_catalog.pg_get_function_result(v_proc.oid);
  IF v_ret IS DISTINCT FROM
     'TABLE(max_transactions_month integer, max_accounts integer, max_credit_cards integer, max_budgets integer, max_members integer)' THEN
    RAISE EXCEPTION '0062 T06 falhou: get_plan_limit com forma inesperada (%)', v_ret;
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.get_plan_limit(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0062 T06 falhou: get_plan_limit sem EXECUTE para authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.get_plan_limit(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_plan_limit(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0062 T06 falhou: get_plan_limit executavel por anon/service_role';
  END IF;

  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) INTO v_type
  FROM pg_attribute AS a
  WHERE a.attrelid = 'public.plan_limits'::regclass
    AND a.attname = 'max_members'
    AND NOT a.attisdropped;
  IF v_type IS DISTINCT FROM 'integer' THEN
    RAISE EXCEPTION '0062 T06 falhou: max_members nao e integer (%)', v_type;
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint AS c
  WHERE c.conrelid = 'public.plan_limits'::regclass
    AND c.conname = 'plan_limits_max_members_check';
  IF NOT FOUND OR v_def NOT LIKE '%max_members%' THEN
    RAISE EXCEPTION '0062 T06 falhou: CHECK de max_members ausente (%)', v_def;
  END IF;

  IF has_table_privilege('authenticated', 'public.plan_limits', 'SELECT') THEN
    RAISE EXCEPTION '0062 T06 falhou: plan_limits legivel por authenticated';
  END IF;

  -- CHECK >= 1 vale (DBA consegue tocar; o cliente não). O piso `0` é
  -- coberto em T17.
  BEGIN
    UPDATE public.plan_limits SET max_members = -1 WHERE plan_slug = 'free';
    RAISE EXCEPTION '0062 T06 falhou: CHECK de max_members aceitou negativo';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6200000-0000-4000-8000-0000000000f1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6200000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_free record;
  v_std record;
  v_pro record;
  v_full record;
BEGIN
  SELECT * INTO v_free FROM public.get_plan_limit('free');
  IF v_free.max_transactions_month IS DISTINCT FROM 20
     OR v_free.max_accounts IS DISTINCT FROM 2
     OR v_free.max_credit_cards IS DISTINCT FROM 1
     OR v_free.max_budgets IS DISTINCT FROM 3
     OR v_free.max_members IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '0062 T06 falhou: free divergente (%)', v_free;
  END IF;

  SELECT * INTO v_std FROM public.get_plan_limit('standard');
  IF v_std.max_transactions_month IS DISTINCT FROM 500
     OR v_std.max_accounts IS DISTINCT FROM 5
     OR v_std.max_credit_cards IS DISTINCT FROM 2
     OR v_std.max_budgets IS DISTINCT FROM 10
     OR v_std.max_members IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION '0062 T06 falhou: standard divergente (%)', v_std;
  END IF;

  SELECT * INTO v_pro FROM public.get_plan_limit('pro');
  IF v_pro.max_transactions_month IS DISTINCT FROM 5000
     OR v_pro.max_accounts IS DISTINCT FROM 10
     OR v_pro.max_credit_cards IS DISTINCT FROM 5
     OR v_pro.max_budgets IS DISTINCT FROM 20
     OR v_pro.max_members IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION '0062 T06 falhou: pro divergente (%)', v_pro;
  END IF;

  SELECT * INTO v_full FROM public.get_plan_limit('full');
  IF v_full.max_transactions_month IS NOT NULL
     OR v_full.max_accounts IS NOT NULL
     OR v_full.max_credit_cards IS NOT NULL
     OR v_full.max_budgets IS NOT NULL
     OR v_full.max_members IS NOT NULL THEN
    RAISE EXCEPTION '0062 T06 falhou: full deveria ser ilimitado (%)', v_full;
  END IF;

  BEGIN
    PERFORM * FROM public.get_plan_limit('bogus');
    RAISE EXCEPTION '0062 T06 falhou: slug bogus aceito';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0062 T06 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-plan-invalid' THEN
        RAISE EXCEPTION '0062 T06 falhou: rotulo errado no slug bogus (%)', SQLERRM;
      END IF;
  END;
END $$;
ROLLBACK;

-- ============ T07 — 0062/0063: plan_limits sem linha ⇒ plan-limits-missing ============
BEGIN;
SELECT set_config('c62.tf62', :'tf62', true);

DELETE FROM public.plan_limits WHERE plan_slug = 'free';

DO $$
DECLARE
  v_tenant uuid := current_setting('c62.tf62')::uuid;
  v_n bigint;
BEGIN
  BEGIN
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, 'c6200000-0000-4000-8000-0000000000f2', 'member');
    RAISE EXCEPTION '0062 T07 falhou: membro entrou sem linha em plan_limits';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0062 T07 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'plan-limits-missing' THEN
        RAISE EXCEPTION '0062 T07 falhou: rotulo errado (%)', SQLERRM;
      END IF;
  END;

  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_tenant;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0062 T07 falhou: contagem mudou com plano ausente (%)', v_n;
  END IF;

  RAISE NOTICE '0062 T07 ok: plan-limits-missing com 0 linhas';
END $$;
ROLLBACK;

-- ============ T08 — 0062/0063: full (NULL) nunca bloqueia ============
-- A fixture já inseriu 4 convites no tenant `full` (owner + 4 = 5); se o
-- limite NULL bloqueasse, a carga teria falhado antes de chegar aqui.
BEGIN;
SELECT set_config('c63.tfull', :'tfull', true);

DO $$
DECLARE
  v_tenant uuid := current_setting('c63.tfull')::uuid;
  v_n bigint;
  v_limit integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_tenant;
  IF v_n <> 5 THEN
    RAISE EXCEPTION '0062 T08 falhou: full bloqueou membro (%)', v_n;
  END IF;

  SELECT pl.max_members INTO v_limit FROM public.plan_limits AS pl WHERE pl.plan_slug = 'full';
  IF v_limit IS NOT NULL THEN
    RAISE EXCEPTION '0062 T08 falhou: max_members de full deveria ser NULL (%)', v_limit;
  END IF;

  RAISE NOTICE '0062 T08 ok: full (NULL) aceitou 5 membros';
END $$;
ROLLBACK;

-- ============ T09 — 0063: owner conta como 1 (free = 1) ============
BEGIN;
SELECT set_config('c63.tf62', :'tf62', true);

DO $$
DECLARE
  v_tenant uuid := current_setting('c63.tf62')::uuid;
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_tenant;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0063 T09 falhou: owner nao conta como 1 (%)', v_n;
  END IF;

  BEGIN
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, 'c6200000-0000-4000-8000-0000000000f2', 'member');
    RAISE EXCEPTION '0063 T09 falhou: 2o membro entrou em tenant free (limite 1)';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0063 T09 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'quota-members-exceeded' THEN
        RAISE EXCEPTION '0063 T09 falhou: rotulo errado (%)', SQLERRM;
      END IF;
  END;

  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_tenant;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0063 T09 falhou: linha persistiu apos o bloqueio (%)', v_n;
  END IF;

  RAISE NOTICE '0063 T09 ok: owner=1 e 2o convite -> quota-members-exceeded';
END $$;
ROLLBACK;

-- ============ T10 — 0063: DELETE libera vaga (standard = 3) ============
BEGIN;
SELECT set_config('c63.ts63', :'ts63', true);

DO $$
DECLARE
  v_tenant uuid := current_setting('c63.ts63')::uuid;
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_tenant;
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0063 T10 falhou: fixture standard deveria ter 3 membros (%)', v_n;
  END IF;

  BEGIN
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_tenant, 'c6300000-0000-4000-8000-0000000000a4', 'member');
    RAISE EXCEPTION '0063 T10 falhou: 4o membro entrou em tenant standard (limite 3)';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0063 T10 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'quota-members-exceeded' THEN
        RAISE EXCEPTION '0063 T10 falhou: rotulo errado no 4o (%)', SQLERRM;
      END IF;
  END;

  DELETE FROM public.tenant_members
  WHERE tenant_id = v_tenant
    AND user_id = 'c6300000-0000-4000-8000-0000000000a3';

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (v_tenant, 'c6300000-0000-4000-8000-0000000000a4', 'member');

  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_tenant;
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0063 T10 falhou: DELETE nao liberou a vaga (%)', v_n;
  END IF;

  RAISE NOTICE '0063 T10 ok: DELETE liberou a vaga e o convite passou';
END $$;
ROLLBACK;

-- ============ T11 — 0063: estrutura, ordinal e não-overridable ============
DO $$
DECLARE
  v_proc pg_proc;
  v_tg pg_trigger;
  v_n integer;
  v_def text;
BEGIN
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('public.enforce_tenant_quota()');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0063 T11 falhou: enforce_tenant_quota ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0063 T11 falhou: enforce_tenant_quota sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0063 T11 falhou: enforce_tenant_quota sem search_path vazio';
  END IF;
  IF v_proc.prosrc NOT LIKE '%quota-members-exceeded%' THEN
    RAISE EXCEPTION '0063 T11 falhou: rotulo quota-members-exceeded ausente';
  END IF;
  IF v_proc.prosrc NOT LIKE '%max_members%' THEN
    RAISE EXCEPTION '0063 T11 falhou: ramo de max_members ausente';
  END IF;
  IF has_function_privilege('authenticated', 'public.enforce_tenant_quota()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.enforce_tenant_quota()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.enforce_tenant_quota()', 'EXECUTE') THEN
    RAISE EXCEPTION '0063 T11 falhou: enforce_tenant_quota executavel por client';
  END IF;

  SELECT * INTO v_tg FROM pg_trigger
  WHERE tgrelid = 'public.tenant_members'::regclass
    AND tgname = 'plan_quota_tenant_members'
    AND NOT tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION '0063 T11 falhou: trigger plan_quota_tenant_members ausente';
  END IF;
  -- 7 = ROW(1) + BEFORE(2) + INSERT(4)
  IF v_tg.tgtype <> 7 THEN
    RAISE EXCEPTION '0063 T11 falhou: tgtype inesperado (%)', v_tg.tgtype;
  END IF;
  IF v_tg.tgfoid <> 'public.enforce_tenant_quota()'::regprocedure THEN
    RAISE EXCEPTION '0063 T11 falhou: trigger aponta para outra funcao';
  END IF;

  -- I6/I7: exatamente 1 BEFORE INSERT de quota e o ordinal do nome vem depois do `aa_`.
  SELECT count(*) INTO v_n FROM pg_trigger
  WHERE tgrelid = 'public.tenant_members'::regclass
    AND NOT tgisinternal
    AND (tgtype & 4) = 4
    AND tgtype & 2 = 2;
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0063 T11 falhou: triggers BEFORE INSERT inesperados (%)', v_n;
  END IF;
  IF NOT ('aa_subscription_readonly' < 'plan_quota_tenant_members') THEN
    RAISE EXCEPTION '0063 T11 falhou: ordinal do trigger (status deve vir antes)';
  END IF;

  -- REQ-24: members nao e overridable.
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint AS c
  WHERE c.conrelid = 'private.plan_quota_overrides'::regclass
    AND c.conname = 'plan_quota_overrides_resource_type_check';
  IF NOT FOUND OR v_def LIKE '%members%' THEN
    RAISE EXCEPTION '0063 T11 falhou: members entrou no CHECK de override (%)', v_def;
  END IF;

  RAISE NOTICE '0063 T11 ok: trigger BEFORE INSERT, ordinal aa_<plan_quota, members nao overridable';
END $$;

-- ============ T12 — 0064: forma, valores e janela SP ============
DO $$
DECLARE
  v_proc pg_proc;
  v_ret text;
BEGIN
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('public.get_tenant_usage(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0064 T12 falhou: get_tenant_usage ausente';
  END IF;
  IF v_proc.pronargs <> 1 OR v_proc.pronargdefaults <> 1 THEN
    RAISE EXCEPTION '0064 T12 falhou: assinatura sem DEFAULT (%)', v_proc.pronargs;
  END IF;
  IF v_proc.provolatile <> 'v' THEN
    RAISE EXCEPTION '0064 T12 falhou: get_tenant_usage nao e VOLATILE (grava trilha)';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0064 T12 falhou: get_tenant_usage sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0064 T12 falhou: get_tenant_usage sem search_path vazio';
  END IF;

  v_ret := pg_catalog.pg_get_function_result(v_proc.oid);
  IF v_ret IS DISTINCT FROM 'TABLE(resource text, used bigint, limit_max integer)' THEN
    RAISE EXCEPTION '0064 T12 falhou: forma inesperada (%)', v_ret;
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.get_tenant_usage(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0064 T12 falhou: sem EXECUTE para authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.get_tenant_usage(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_tenant_usage(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0064 T12 falhou: get_tenant_usage executavel por anon/service_role';
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6400000-0000-4000-8000-0000000000a1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_res text[];
  v_row record;
  v_n bigint;
BEGIN
  SELECT pg_catalog.array_agg(u.resource ORDER BY u.ord)
    INTO v_res
  FROM public.get_tenant_usage() WITH ORDINALITY AS u(resource, used, limit_max, ord);
  IF v_res IS DISTINCT FROM ARRAY['transactions', 'accounts', 'credit_cards', 'budgets', 'members'] THEN
    RAISE EXCEPTION '0064 T12 falhou: ordem das linhas (%)', v_res;
  END IF;

  SELECT * INTO v_row FROM public.get_tenant_usage() AS x(resource, used, limit_max) WHERE x.resource = 'transactions';
  IF v_row.used <> 3 OR v_row.limit_max IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION '0064 T12 falhou: transactions divergente (%)', v_row;
  END IF;
  SELECT * INTO v_row FROM public.get_tenant_usage() AS x(resource, used, limit_max) WHERE x.resource = 'accounts';
  IF v_row.used <> 2 OR v_row.limit_max IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION '0064 T12 falhou: accounts divergente (%)', v_row;
  END IF;
  SELECT * INTO v_row FROM public.get_tenant_usage() AS x(resource, used, limit_max) WHERE x.resource = 'credit_cards';
  IF v_row.used <> 1 OR v_row.limit_max IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION '0064 T12 falhou: credit_cards divergente (%)', v_row;
  END IF;
  SELECT * INTO v_row FROM public.get_tenant_usage() AS x(resource, used, limit_max) WHERE x.resource = 'budgets';
  IF v_row.used <> 1 OR v_row.limit_max IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION '0064 T12 falhou: budgets divergente (%)', v_row;
  END IF;
  SELECT * INTO v_row FROM public.get_tenant_usage() AS x(resource, used, limit_max) WHERE x.resource = 'members';
  IF v_row.used <> 1 OR v_row.limit_max IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION '0064 T12 falhou: members divergente (%)', v_row;
  END IF;

  RAISE NOTICE '0064 T12 ok: 5 linhas na ordem, used/limit_max exatos';
END $$;
ROLLBACK;

-- T12b — janela mensal SP: linha de 2 meses atrás não conta.
BEGIN;
SELECT set_config('c64.ta64', :'ta64', true);

ALTER TABLE public.transactions DISABLE TRIGGER plan_quota_transactions;
INSERT INTO public.transactions
  (id, user_id, account_id, tenant_id, description, amount_cents, date, created_at)
VALUES
  ('c6400000-0000-4000-8000-0000000a0509',
   'c6400000-0000-4000-8000-0000000000a1',
   'c6400000-0000-4000-8000-0000000a0101',
   :'ta64',
   'Usage Tx antiga 0064', 400, current_date - 60,
   now() - interval '2 months');
ALTER TABLE public.transactions ENABLE TRIGGER plan_quota_transactions;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6400000-0000-4000-8000-0000000000a1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_used bigint;
  v_raw bigint;
  v_tenant uuid := current_setting('c64.ta64')::uuid;
BEGIN
  SELECT x.used INTO v_used FROM public.get_tenant_usage() AS x(resource, used, limit_max)
  WHERE x.resource = 'transactions';
  IF v_used <> 3 THEN
    RAISE EXCEPTION '0064 T12b falhou: janela SP contou linha antiga (%)', v_used;
  END IF;

  SELECT count(*) INTO v_raw FROM public.transactions AS tx WHERE tx.tenant_id = v_tenant;
  IF v_raw <> 4 THEN
    RAISE EXCEPTION '0064 T12b falhou: fixture antiga nao gravou (%)', v_raw;
  END IF;

  RAISE NOTICE '0064 T12b ok: janela SP ignora linha de 2 meses atras';
END $$;
ROLLBACK;

-- ============ T13 — 0064: NULL sem tenant ⇒ 0 linhas; sem sessão ⇒ not-authenticated ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6400000-0000-4000-8000-0000000000e1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6400000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.get_tenant_usage();
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0064 T13 falhou: usuario sem tenant recebeu % linhas', v_n;
  END IF;
  RAISE NOTICE '0064 T13a ok: sem tenant -> 0 linhas';
END $$;

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '', true);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.get_tenant_usage();
    RAISE EXCEPTION '0064 T13 falhou: sem sessao aceitou a leitura';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0064 T13 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-authenticated' THEN
        RAISE EXCEPTION '0064 T13 falhou: rotulo errado sem sessao (%)', SQLERRM;
      END IF;
  END;
  RAISE NOTICE '0064 T13b ok: sem sessao -> not-authenticated';
END $$;
ROLLBACK;

-- ============ T14 — 0064: operador lê qualquer tenant COM trilha ============
BEGIN;
SELECT set_config('c64.tb64', :'tb64', true);

DO $$
DECLARE
  v_before bigint;
BEGIN
  SELECT count(*) INTO v_before FROM public.admin_audit
  WHERE actor_id = 'c6400000-0000-4000-8000-0000000000ad';
  PERFORM set_config('c64.before', v_before::text, true);
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6400000-0000-4000-8000-0000000000ad', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6400000-0000-4000-8000-0000000000ad","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_tenant uuid := current_setting('c64.tb64')::uuid;
  v_missing uuid := 'c6400000-0000-4000-8000-0000000000ff';
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.get_tenant_usage(v_tenant);
  IF v_n <> 5 THEN
    RAISE EXCEPTION '0064 T14 falhou: operador nao leu 5 linhas (%)', v_n;
  END IF;

  BEGIN
    PERFORM * FROM public.get_tenant_usage(v_missing);
    RAISE EXCEPTION '0064 T14 falhou: tenant inexistente aceito no caminho operador';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0064 T14 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-not-found' THEN
        RAISE EXCEPTION '0064 T14 falhou: rotulo errado no inexistente (%)', SQLERRM;
      END IF;
  END;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenant uuid := current_setting('c64.tb64')::uuid;
  v_before bigint := current_setting('c64.before')::bigint;
  v_after bigint;
  v_audit record;
BEGIN
  SELECT count(*) INTO v_after FROM public.admin_audit
  WHERE actor_id = 'c6400000-0000-4000-8000-0000000000ad';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION '0064 T14 falhou: trilha do operador ausente (% -> %)', v_before, v_after;
  END IF;

  SELECT * INTO v_audit FROM public.admin_audit
  WHERE actor_id = 'c6400000-0000-4000-8000-0000000000ad'
  ORDER BY at DESC, id DESC
  LIMIT 1;
  IF v_audit.action <> 'other' OR v_audit.reason <> 'internal_admin_read' THEN
    RAISE EXCEPTION '0064 T14 falhou: trilha com action/reason inesperados (%)', v_audit;
  END IF;
  IF v_audit.target_id <> v_tenant OR v_audit.tenant_id <> v_tenant THEN
    RAISE EXCEPTION '0064 T14 falhou: trilha sem escopo do tenant';
  END IF;

  RAISE NOTICE '0064 T14 ok: operador leu com 1 trilha internal_admin_read; inexistente -> tenant-not-found';
END $$;
ROLLBACK;

-- ============ T15 — 0064: outro tenant ⇒ tenant-not-member, 0 linhas ============
BEGIN;
SELECT set_config('c64.ta64', :'ta64', true), set_config('c64.tb64', :'tb64', true);

DO $$
DECLARE
  v_before bigint;
BEGIN
  SELECT count(*) INTO v_before FROM public.admin_audit;
  PERFORM set_config('c64.before', v_before::text, true);
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6400000-0000-4000-8000-0000000000a1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_own uuid := current_setting('c64.ta64')::uuid;
  v_other uuid := current_setting('c64.tb64')::uuid;
  v_missing uuid := 'c6400000-0000-4000-8000-0000000000ff';
  v_n bigint;
BEGIN
  BEGIN
    PERFORM * FROM public.get_tenant_usage(v_other);
    RAISE EXCEPTION '0064 T15 falhou: membro leu tenant alheio';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0064 T15 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-not-member' THEN
        RAISE EXCEPTION '0064 T15 falhou: rotulo errado no alheio (%)', SQLERRM;
      END IF;
  END;

  BEGIN
    PERFORM * FROM public.get_tenant_usage(v_missing);
    RAISE EXCEPTION '0064 T15 falhou: tenant inexistente aceito no caminho de membro';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0064 T15 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-not-member' THEN
        RAISE EXCEPTION '0064 T15 falhou: rotulo errado no inexistente (%)', SQLERRM;
      END IF;
  END;

  SELECT count(*) INTO v_n FROM public.get_tenant_usage(v_own);
  IF v_n <> 5 THEN
    RAISE EXCEPTION '0064 T15 falhou: proprio tenant via p_tenant nao devolveu 5 (%)', v_n;
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_before bigint := current_setting('c64.before')::bigint;
  v_after bigint;
BEGIN
  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0064 T15 falhou: caminho de membro gerou trilha';
  END IF;

  RAISE NOTICE '0064 T15 ok: alheio -> tenant-not-member sem trilha; proprio -> 5 linhas';
END $$;
ROLLBACK;

-- ============ T16 — 0064 (I-2): p_tenant NULL lê o tenant GRAVÁVEL ============
-- Owner do tenant C1 (`canceled`) que também é membro do tenant C2 (`active`):
-- a leitura por `p_tenant NULL` deve devolver o consumo do tenant GRAVÁVEL
-- (C2) — o MESMO sujeito do gate de escrita (`resolve_writable_tenant`) — e
-- não o derivado base (`resolve_user_tenant`, owner primeiro), que devolveria
-- C1. Sem isso a tela lê um tenant e o INSERT grava em outro.
-- Fixtures próprias (c64…c1/c2) vivem só nesta transação; ROLLBACK garante
-- rerun sem resíduo.
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c6400000-0000-4000-8000-0000000000c1', 'quota-usage-c1-0064@example.com'),
  ('c6400000-0000-4000-8000-0000000000c2', 'quota-usage-c2-0064@example.com');

INSERT INTO public.tenants (id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status) VALUES
  ('c6400000-0000-4000-8000-0000000c0001', 'pf', 'c6400000-0000-4000-8000-0000000000c1',
   '54300000695', 'Quota Usage C1 Cancelada 0064', 'free', 'active'),
  ('c6400000-0000-4000-8000-0000000c0002', 'pf', 'c6400000-0000-4000-8000-0000000000c2',
   '54300000776', 'Quota Usage C2 Gravavel 0064', 'standard', 'active');

INSERT INTO public.tenant_members (tenant_id, user_id, role) VALUES
  ('c6400000-0000-4000-8000-0000000c0001', 'c6400000-0000-4000-8000-0000000000c1', 'owner'),
  ('c6400000-0000-4000-8000-0000000c0002', 'c6400000-0000-4000-8000-0000000000c2', 'owner'),
  ('c6400000-0000-4000-8000-0000000c0002', 'c6400000-0000-4000-8000-0000000000c1', 'member');

UPDATE public.tenants SET subscription_status = 'canceled'
WHERE id = 'c6400000-0000-4000-8000-0000000c0001';

-- Consumo do C2 (gravavel): 2 contas. O `used`/`limit_max` prova de QUAL
-- tenant a leitura veio (C1 free: 0 contas, limite 2).
INSERT INTO public.accounts (id, user_id, name, type) VALUES
  ('c6400000-0000-4000-8000-0000000c0011', 'c6400000-0000-4000-8000-0000000000c2', 'Usage C2 Conta 1 0064', 'checking'),
  ('c6400000-0000-4000-8000-0000000c0012', 'c6400000-0000-4000-8000-0000000000c2', 'Usage C2 Conta 2 0064', 'checking');

DO $$
DECLARE
  v_base uuid;
  v_writable uuid;
BEGIN
  v_base := private.resolve_user_tenant('c6400000-0000-4000-8000-0000000000c1');
  v_writable := private.resolve_writable_tenant('c6400000-0000-4000-8000-0000000000c1');
  IF v_base IS DISTINCT FROM 'c6400000-0000-4000-8000-0000000c0001' THEN
    RAISE EXCEPTION '0064 T16 falhou: base deveria resolver o owner (canceled)';
  END IF;
  IF v_writable IS DISTINCT FROM 'c6400000-0000-4000-8000-0000000c0002' THEN
    RAISE EXCEPTION '0064 T16 falhou: gravavel deveria resolver o tenant ativo';
  END IF;
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6400000-0000-4000-8000-0000000000c1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6400000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_acc record;
  v_mem record;
BEGIN
  SELECT * INTO v_acc
  FROM public.get_tenant_usage() AS x(resource, used, limit_max)
  WHERE x.resource = 'accounts';
  IF v_acc.used <> 2 OR v_acc.limit_max IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION '0064 T16 falhou: NULL nao leu o tenant gravavel (accounts=%)', v_acc;
  END IF;

  SELECT * INTO v_mem
  FROM public.get_tenant_usage() AS x(resource, used, limit_max)
  WHERE x.resource = 'members';
  IF v_mem.used <> 2 OR v_mem.limit_max IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION '0064 T16 falhou: NULL nao leu o tenant gravavel (members=%)', v_mem;
  END IF;

  RAISE NOTICE '0064 T16 ok: p_tenant NULL le o tenant GRAVAVEL (C2), coerente com o gate';
END $$;
ROLLBACK;

-- ============ T17 — 0062 (R1): max_members exige >= 1 (NULL ilimitado) ============
-- `max_members = 0` é tratado pelo gate como "excedido" (REQ-13), logo um plano
-- com 0 abortaria a criação do próprio tenant. O CHECK precisa recusar 0 e
-- negativos; NULL continua ilimitado (`full`).
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint AS c
  WHERE c.conrelid = 'public.plan_limits'::regclass
    AND c.conname = 'plan_limits_max_members_check';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0062 T17 falhou: CHECK de max_members ausente';
  END IF;
  IF v_def NOT LIKE '%>= 1%' THEN
    RAISE EXCEPTION '0062 T17 falhou: CHECK ainda aceita 0 (%)', v_def;
  END IF;

  BEGIN
    UPDATE public.plan_limits SET max_members = 0 WHERE plan_slug = 'free';
    RAISE EXCEPTION '0062 T17 falhou: CHECK aceitou max_members = 0';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.plan_limits SET max_members = -1 WHERE plan_slug = 'free';
    RAISE EXCEPTION '0062 T17 falhou: CHECK aceitou max_members negativo';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- NULL continua valido (ilimitado).
  UPDATE public.plan_limits SET max_members = NULL WHERE plan_slug = 'full';

  RAISE NOTICE '0062 T17 ok: max_members 0/-1 violam o CHECK (>= 1); NULL segue ilimitado';
END $$;

-- ============ Fixtures cleanup (fim) ============
BEGIN;
SET LOCAL app.card_purge = 'on';
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.transactions
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.credit_cards
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.budgets
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.categories
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.accounts
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c6200000-0000-4000-8000-0000000000f1',
    'c6300000-0000-4000-8000-0000000000a1',
    'c6300000-0000-4000-8000-0000000000b1',
    'c6400000-0000-4000-8000-0000000000a1',
    'c6400000-0000-4000-8000-0000000000b1'
  )
);
DELETE FROM public.contract_acceptances
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.tenant_members
WHERE user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM public.admin_audit
WHERE actor_id IN (
  'c6400000-0000-4000-8000-0000000000ad',
  'c6400000-0000-4000-8000-0000000000a1'
)
OR target_id = 'c6400000-0000-4000-8000-0000000000ad'
OR target_id IN (
  SELECT t.id FROM public.tenants AS t
  WHERE t.owner_user_id IN (
    'c6200000-0000-4000-8000-0000000000f1',
    'c6300000-0000-4000-8000-0000000000a1',
    'c6300000-0000-4000-8000-0000000000b1',
    'c6400000-0000-4000-8000-0000000000a1',
    'c6400000-0000-4000-8000-0000000000b1'
  )
);
DELETE FROM public.internal_operators
WHERE user_id = 'c6400000-0000-4000-8000-0000000000ad';
DELETE FROM public.tenants
WHERE owner_user_id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1'
);
DELETE FROM auth.users
WHERE id IN (
  'c6200000-0000-4000-8000-0000000000f1',
  'c6200000-0000-4000-8000-0000000000f2',
  'c6300000-0000-4000-8000-0000000000a1',
  'c6300000-0000-4000-8000-0000000000a2',
  'c6300000-0000-4000-8000-0000000000a3',
  'c6300000-0000-4000-8000-0000000000a4',
  'c6300000-0000-4000-8000-0000000000b1',
  'c6300000-0000-4000-8000-0000000000b2',
  'c6300000-0000-4000-8000-0000000000b3',
  'c6300000-0000-4000-8000-0000000000b4',
  'c6300000-0000-4000-8000-0000000000b5',
  'c6400000-0000-4000-8000-0000000000a1',
  'c6400000-0000-4000-8000-0000000000b1',
  'c6400000-0000-4000-8000-0000000000ad',
  'c6400000-0000-4000-8000-0000000000e1'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;
