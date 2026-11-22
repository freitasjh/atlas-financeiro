-- 0105-signup-rpc-document.spec.sql — ADR-001 / SIGN-10 (RF-11, RF-20).
--
-- Uso: supabase test db --local supabase/tests/0105-signup-rpc-document.spec.sql
--
-- Revalidação no banco: DVs por private.cpf_dv_ok / private.cnpj_dv_ok
-- totalmente qualificados (search_path=''), kind antes de documento, xor e
-- pré-validação de dados. Rótulos congelados; nenhum DETAIL/PII vaza.
-- Zero CREATE TABLE / ALTER TABLE (verificado no gate de escopo SIGN-18,
-- fora desta fatia); este spec prova o comportamento SQL.
--
-- TDD FIRST: escrito ANTES da migration 0101.

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c0105000-0000-4000-8000-000000000001', 'document-0105@example.com');

-- T01 — CPF com DV válido provisiona (controle).
SELECT lives_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0105000-0000-4000-8000-000000000001'::uuid,
    'c0105000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000106', 'Documento 0105', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'T01 CPF com DVs válidos ⇒ provisiona'
);

-- T02 — DV de CPF errado.
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0105000-0000-4000-8000-000000000002'::uuid,
    'c0105000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000105', 'Documento 0105', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-document-invalid',
  'T02 DV de CPF inválido ⇒ tenant-document-invalid'
);

-- T03 — DV de CNPJ errado.
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0105000-0000-4000-8000-000000000003'::uuid,
    'c0105000-0000-4000-8000-000000000001'::uuid,
    'pj', '77100000100142', 'Documento 0105 PJ', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-document-invalid',
  'T03 DV de CNPJ inválido ⇒ tenant-document-invalid'
);

-- T04 — kind inválido é avaliado ANTES do documento.
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0105000-0000-4000-8000-000000000004'::uuid,
    'c0105000-0000-4000-8000-000000000001'::uuid,
    'xx', '77100000106', 'Documento 0105', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-kind-invalid',
  'T04 kind=xx ⇒ tenant-kind-invalid (antes do documento)'
);

-- T05 — dados de identidade faltando (xor/CHECK espelhado na pré-validação).
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0105000-0000-4000-8000-000000000005'::uuid,
    'c0105000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000106', '', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-data-invalid',
  'T05 razaoSocial vazia ⇒ tenant-data-invalid (sem DETAIL cru)'
);

-- T06 — kind=pf com documento de 14 dígitos ⇒ inválido (xor).
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0105000-0000-4000-8000-000000000006'::uuid,
    'c0105000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000100141', 'Documento 0105', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'tenant-document-invalid',
  'T06 pf com CNPJ ⇒ tenant-document-invalid'
);

-- T07 — request_id obrigatório.
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    NULL::uuid,
    'c0105000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000106', 'Documento 0105', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'signup-request-invalid',
  'T07 request_id NULL ⇒ signup-request-invalid'
);

-- T08 — dono precisa existir em profiles (identidade materializada pela Edge).
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0105000-0000-4000-8000-000000000008'::uuid,
    'd0105000-0000-4000-8000-000000000099'::uuid,
    'pf', '77100000106', 'Documento 0105', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)$sql$,
  'P0001', 'signup-owner-invalid',
  'T08 owner ausente ⇒ signup-owner-invalid'
);

-- T09 — funções de DV chamadas totalmente qualificadas no corpo da RPC.
SELECT ok(
  pg_catalog.pg_get_functiondef(
    'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure
  ) ~ 'private\.cpf_dv_ok'
  AND pg_catalog.pg_get_functiondef(
    'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure
  ) ~ 'private\.cnpj_dv_ok',
  'T09 DVs qualificados (private.cpf_dv_ok / private.cnpj_dv_ok)'
);

SELECT * FROM finish();

ROLLBACK;
