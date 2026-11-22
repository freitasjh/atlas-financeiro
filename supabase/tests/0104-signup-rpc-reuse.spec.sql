-- 0104-signup-rpc-reuse.spec.sql — ADR-001 / SIGN-09 (RF-10, 🟡-1).
--
-- Uso: supabase test db --local supabase/tests/0104-signup-rpc-reuse.spec.sql
--
-- Reuso por chave natural (owner_user_id, documento normalizado) entre tenants
-- não cancelados: mesma chamada devolve o MESMO tenant_id com reason
-- 'signup-reused' e ZERO INSERT de domínio. Documento já pertencente a OUTRO
-- dono ⇒ rótulo INTERNO 'tenant-document-duplicate' (nunca 500 na borda):
-- RPC faz ROLLBACK, zero INSERT de domínio; a Edge compensa e responde 201
-- genérico com 'signup-public-compensated' (SIGN-03/SIGN-12).
--
-- TDD FIRST: escrito ANTES da migration 0101.

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c0104000-0000-4000-8000-000000000001', 'reuse-owner-0104@example.com'),
  ('c0104000-0000-4000-8000-000000000002', 'reuse-other-0104@example.com');

-- 1º signup: cria tenant.
SELECT ok(
  (SELECT set_config('test.reuse_first', public.create_tenant_for_public_signup(
    'b0104000-0000-4000-8000-000000000001'::uuid,
    'c0104000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000106', 'Reuse 0104', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)::text, false) IS NOT NULL),
  'T01 1º signup: tenant criado'
);

-- 2º signup: mesmo (owner, documento), request_id diferente.
SELECT ok(
  (SELECT set_config('test.reuse_second', public.create_tenant_for_public_signup(
    'b0104000-0000-4000-8000-000000000002'::uuid,
    'c0104000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000106', 'Reuse 0104', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)::text, false)::uuid = current_setting('test.reuse_first')::uuid),
  'T02 reuso devolve o MESMO tenant_id'
);

SELECT ok(
  (SELECT count(*) FROM public.admin_audit AS a
   WHERE a.from_value = 'b0104000-0000-4000-8000-000000000002'
     AND a.reason = 'signup-reused'
     AND a.target_id = current_setting('test.reuse_first')::uuid) = 1,
  'T03 reuso grava 1 trilha signup-reused (request_id em from_value)'
);

SELECT ok(
  (SELECT count(*) FROM public.tenants AS t
   WHERE t.owner_user_id = 'c0104000-0000-4000-8000-000000000001'
     AND t.cpf = '77100000106') = 1
  AND (SELECT count(*) FROM public.tenant_members AS m
       WHERE m.user_id = 'c0104000-0000-4000-8000-000000000001') = 1
  AND (SELECT count(*) FROM public.contract_acceptances AS a
       JOIN public.tenants AS t ON t.id = a.tenant_id
       WHERE t.owner_user_id = 'c0104000-0000-4000-8000-000000000001') = 1
  AND (SELECT count(*) FROM public.tenant_subscriptions AS s
       JOIN public.tenants AS t ON t.id = s.tenant_id
       WHERE t.owner_user_id = 'c0104000-0000-4000-8000-000000000001') = 1,
  'T04 reuso: delta de INSERT = 0 nas 4 tabelas de domínio'
);

-- Colisão entre donos diferentes: unique_violation re-checa dono ⇒ rótulo
-- interno; EDGE (não o banco) transforma em 201 genérico + compensação.
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0104000-0000-4000-8000-000000000003'::uuid,
    'c0104000-0000-4000-8000-000000000002'::uuid,
    'pf', '77100000106', 'Colisao 0104', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-document-duplicate',
  'T05 documento de OUTRO dono ⇒ tenant-document-duplicate (rótulo interno)'
);

SELECT ok(
  (SELECT count(*) FROM public.tenants WHERE owner_user_id = 'c0104000-0000-4000-8000-000000000002') = 0
  AND (SELECT count(*) FROM public.tenant_members WHERE user_id = 'c0104000-0000-4000-8000-000000000002') = 0
  AND (SELECT count(*) FROM public.contract_acceptances AS a
       JOIN public.tenants AS t ON t.id = a.tenant_id
       WHERE t.owner_user_id = 'c0104000-0000-4000-8000-000000000002') = 0
  AND (SELECT count(*) FROM public.tenant_subscriptions AS s
       JOIN public.tenants AS t ON t.id = s.tenant_id
       WHERE t.owner_user_id = 'c0104000-0000-4000-8000-000000000002') = 0
  AND (SELECT count(*) FROM public.admin_audit
       WHERE from_value = 'b0104000-0000-4000-8000-000000000003') = 0,
  'T06 colisão: 0 INSERT de domínio e 0 trilha na RPC (compensação é da Edge)'
);

SELECT * FROM finish();

ROLLBACK;
