-- 0102-signup-rpc-rollback.spec.sql — ADR-001 / SIGN-07 (RF-08, NFR-03).
--
-- Uso: supabase test db --local supabase/tests/0102-signup-rpc-rollback.spec.sql
--
-- Prova a transação ÚNICA das 5 escritas de aplicação: injeta uma falha em
-- CADA um dos 5 degraus (tenants, tenant_members, contract_acceptances,
-- tenant_subscriptions, admin_audit) e afirma count(*)=0 nas 5 tabelas por
-- request_id. `auth.users` fica FORA dessa transação: a identidade é
-- compensada pela Edge (SIGN-12) — este spec NÃO afirma "100% atômico".
--
-- TDD FIRST: escrito ANTES da migration 0101.

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

BEGIN;

-- O trigger diferido de aceite (0024) é desligado aqui: sem ele, o DDL de
-- injeção de falha esbarra em 'pending trigger events' e a falha injetada
-- seria mascarada por 'tenant-acceptance-required'. O ROLLBACK final restaura.
ALTER TABLE public.tenants DISABLE TRIGGER tenant_acceptance_required;

-- Fixtures: 6 donos (controle + 5 falhas). Trigger handle_new_user cria profiles.
INSERT INTO auth.users (id, email) VALUES
  ('c0102000-0000-4000-8000-000000000001', 'rb-control-0102@example.com'),
  ('c0102000-0000-4000-8000-000000000002', 'rb-tenant-0102@example.com'),
  ('c0102000-0000-4000-8000-000000000003', 'rb-member-0102@example.com'),
  ('c0102000-0000-4000-8000-000000000004', 'rb-accept-0102@example.com'),
  ('c0102000-0000-4000-8000-000000000005', 'rb-sub-0102@example.com'),
  ('c0102000-0000-4000-8000-000000000006', 'rb-audit-0102@example.com');

-- T00 — controle: caminho feliz grava 1 linha em cada uma das 5 tabelas.
SELECT ok(
  (SELECT public.create_tenant_for_public_signup(
    'b0102000-0000-4000-8000-000000000000'::uuid,
    'c0102000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000106', 'Rollback 0102 controle', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL) IS NOT NULL),
  'T00 controle: RPC devolve tenant_id'
);
SELECT ok(
  (SELECT count(*) FROM public.tenants WHERE owner_user_id = 'c0102000-0000-4000-8000-000000000001') = 1
  AND (SELECT count(*) FROM public.tenant_members WHERE user_id = 'c0102000-0000-4000-8000-000000000001') = 1
  AND (SELECT count(*) FROM public.contract_acceptances AS a
       JOIN public.tenants AS t ON t.id = a.tenant_id
       WHERE t.owner_user_id = 'c0102000-0000-4000-8000-000000000001') = 1
  AND (SELECT count(*) FROM public.tenant_subscriptions AS s
       JOIN public.tenants AS t ON t.id = s.tenant_id
       WHERE t.owner_user_id = 'c0102000-0000-4000-8000-000000000001') = 1
  AND (SELECT count(*) FROM public.admin_audit
       WHERE from_value = 'b0102000-0000-4000-8000-000000000000'::text) = 1,
  'T00 controle: 1 linha em cada uma das 5 tabelas (por request_id)'
);

-- T01 — falha no 1º degrau (INSERT em tenants).
ALTER TABLE public.tenants
  ADD CONSTRAINT signup_rb_fail_tenants
  CHECK (razao_social <> 'RB-FAIL-1') NOT VALID;
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0102000-0000-4000-8000-000000000001'::uuid,
    'c0102000-0000-4000-8000-000000000002'::uuid,
    'pf', '77100000297', 'RB-FAIL-1', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-data-invalid',
  'T01 falha no INSERT de tenants ⇒ tenant-data-invalid'
);
SELECT ok(
  (SELECT count(*) FROM public.tenants WHERE owner_user_id = 'c0102000-0000-4000-8000-000000000002') = 0
  AND (SELECT count(*) FROM public.tenant_members WHERE user_id = 'c0102000-0000-4000-8000-000000000002') = 0
  AND (SELECT count(*) FROM public.admin_audit WHERE from_value = 'b0102000-0000-4000-8000-000000000001') = 0,
  'T01 rollback: 0/0/0 em tenants, tenant_members e admin_audit'
);
ALTER TABLE public.tenants DROP CONSTRAINT signup_rb_fail_tenants;

-- T02 — falha no 2º degrau (INSERT em tenant_members).
ALTER TABLE public.tenant_members
  ADD CONSTRAINT signup_rb_fail_members CHECK (role <> 'owner') NOT VALID;
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0102000-0000-4000-8000-000000000002'::uuid,
    'c0102000-0000-4000-8000-000000000003'::uuid,
    'pf', '77100000378', 'RB-FAIL-2', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-data-invalid',
  'T02 falha no INSERT de tenant_members ⇒ tenant-data-invalid'
);
SELECT ok(
  (SELECT count(*) FROM public.tenants WHERE owner_user_id = 'c0102000-0000-4000-8000-000000000003') = 0
  AND (SELECT count(*) FROM public.tenant_members WHERE user_id = 'c0102000-0000-4000-8000-000000000003') = 0
  AND (SELECT count(*) FROM public.contract_acceptances AS a
       JOIN public.tenants AS t ON t.id = a.tenant_id
       WHERE t.owner_user_id = 'c0102000-0000-4000-8000-000000000003') = 0
  AND (SELECT count(*) FROM public.admin_audit WHERE from_value = 'b0102000-0000-4000-8000-000000000002') = 0,
  'T02 rollback: 0 tenant/0 membro/0 aceite/0 auditoria'
);
ALTER TABLE public.tenant_members DROP CONSTRAINT signup_rb_fail_members;

-- T03 — falha no 3º degrau (INSERT em contract_acceptances).
ALTER TABLE public.contract_acceptances
  ADD CONSTRAINT signup_rb_fail_accept
  CHECK (contract_version <> 'termos-2026-11-v1') NOT VALID;
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0102000-0000-4000-8000-000000000003'::uuid,
    'c0102000-0000-4000-8000-000000000004'::uuid,
    'pf', '77100000459', 'RB-FAIL-3', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-data-invalid',
  'T03 falha no INSERT de aceite ⇒ tenant-data-invalid'
);
SELECT ok(
  (SELECT count(*) FROM public.tenants WHERE owner_user_id = 'c0102000-0000-4000-8000-000000000004') = 0
  AND (SELECT count(*) FROM public.tenant_members WHERE user_id = 'c0102000-0000-4000-8000-000000000004') = 0
  AND (SELECT count(*) FROM public.contract_acceptances AS a
       JOIN public.tenants AS t ON t.id = a.tenant_id
       WHERE t.owner_user_id = 'c0102000-0000-4000-8000-000000000004') = 0
  AND (SELECT count(*) FROM public.admin_audit WHERE from_value = 'b0102000-0000-4000-8000-000000000003') = 0,
  'T03 rollback: 0 tenant/0 membro/0 aceite/0 auditoria'
);
ALTER TABLE public.contract_acceptances DROP CONSTRAINT signup_rb_fail_accept;

-- T04 — falha no 4º degrau (INSERT em tenant_subscriptions).
ALTER TABLE public.tenant_subscriptions
  ADD CONSTRAINT signup_rb_fail_sub CHECK (plan_slug <> 'free') NOT VALID;
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0102000-0000-4000-8000-000000000004'::uuid,
    'c0102000-0000-4000-8000-000000000005'::uuid,
    'pf', '77100000530', 'RB-FAIL-4', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-data-invalid',
  'T04 falha no INSERT de assinatura ⇒ tenant-data-invalid'
);
SELECT ok(
  (SELECT count(*) FROM public.tenants WHERE owner_user_id = 'c0102000-0000-4000-8000-000000000005') = 0
  AND (SELECT count(*) FROM public.tenant_subscriptions AS s
       JOIN public.tenants AS t ON t.id = s.tenant_id
       WHERE t.owner_user_id = 'c0102000-0000-4000-8000-000000000005') = 0
  AND (SELECT count(*) FROM public.admin_audit WHERE from_value = 'b0102000-0000-4000-8000-000000000004') = 0,
  'T04 rollback: 0 tenant/0 assinatura/0 auditoria'
);
ALTER TABLE public.tenant_subscriptions DROP CONSTRAINT signup_rb_fail_sub;

-- T05 — falha no 5º degrau (INSERT final em admin_audit). A trilha do espelho
-- usa reason='onboarding' (GUC), então este CHECK só derruba a escrita 'provisioned'.
ALTER TABLE public.admin_audit
  ADD CONSTRAINT signup_rb_fail_audit
  CHECK (reason IS DISTINCT FROM 'signup-public-provisioned') NOT VALID;
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0102000-0000-4000-8000-000000000005'::uuid,
    'c0102000-0000-4000-8000-000000000006'::uuid,
    'pf', '77100000610', 'RB-FAIL-5', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-data-invalid',
  'T05 falha no INSERT de admin_audit ⇒ tenant-data-invalid'
);
SELECT ok(
  (SELECT count(*) FROM public.tenants WHERE owner_user_id = 'c0102000-0000-4000-8000-000000000006') = 0
  AND (SELECT count(*) FROM public.tenant_members WHERE user_id = 'c0102000-0000-4000-8000-000000000006') = 0
  AND (SELECT count(*) FROM public.contract_acceptances AS a
       JOIN public.tenants AS t ON t.id = a.tenant_id
       WHERE t.owner_user_id = 'c0102000-0000-4000-8000-000000000006') = 0
  AND (SELECT count(*) FROM public.tenant_subscriptions AS s
       JOIN public.tenants AS t ON t.id = s.tenant_id
       WHERE t.owner_user_id = 'c0102000-0000-4000-8000-000000000006') = 0
  AND (SELECT count(*) FROM public.admin_audit WHERE from_value = 'b0102000-0000-4000-8000-000000000005') = 0,
  'T05 rollback: 0/0/0/0/0 nas 5 tabelas (última escrita)'
);

ALTER TABLE public.tenants ENABLE TRIGGER tenant_acceptance_required;

SELECT * FROM finish();

ROLLBACK;

-- Nota de fronteira (não é teste): auth.users é criado pela Edge ANTES da RPC
-- e apagado por admin.deleteUser na compensação (SIGN-12). ROLLBACK acima
-- cobre só as 5 escritas de aplicação; nunca se afirma atômico incluindo Auth.
