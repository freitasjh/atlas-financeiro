-- 0101-signup-rpc-structure.spec.sql — ADR-001 / SIGN-06 (gates 1 e 2).
--
-- Uso: supabase test db --local supabase/tests/0101-signup-rpc-structure.spec.sql
--   (ou psql "$DB_URL" -v ON_ERROR_STOP=1 -f ...; DB_URL localhost:55322)
--
-- Prova em banco real: assinatura congelada (1 request + 1 owner + 13 fiscais,
-- RETURNS uuid), `SECURITY DEFINER` + `SET search_path=''`, sem `is_admin()`,
-- REVOKE ALL de PUBLIC/anon/authenticated e GRANT só a service_role nas DUAS
-- RPCs. `SET ROLE authenticated` ⇒ 42501 (gate 2).
--
-- TDD FIRST: arquivo escrito ANTES da migration 0101.

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

-- T01 — assinatura da RPC principal (15 args, 1 default, RETURNS uuid).
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure
      AND p.pronargs = 15
      AND p.pronargdefaults = 1
      AND p.prorettype = 'uuid'::regtype
  ),
  'T01 create_tenant_for_public_signup: 15 args, 1 default, RETURNS uuid'
);

-- T02 — security definer.
SELECT ok(
  (SELECT p.prosecdef FROM pg_catalog.pg_proc AS p WHERE p.oid =
    'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure),
  'T02 create_tenant_for_public_signup: prosecdef=true'
);

-- T03 — search_path vazio travado (proconfig).
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    CROSS JOIN LATERAL pg_catalog.unnest(COALESCE(p.proconfig, '{}'::text[])) AS c(acl)
    WHERE p.oid = 'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure
      AND c.acl IN ('search_path=', 'search_path=""')
  ),
  'T03 create_tenant_for_public_signup: proconfig search_path vazio'
);

-- T04 — sem is_admin(): o gate é o grant, não operador.
SELECT ok(
  pg_catalog.pg_get_functiondef(
    'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure
  ) !~ 'is_admin',
  'T04 create_tenant_for_public_signup: nenhuma chamada a is_admin()'
);

-- T05 — assinatura da RPC de auditoria (3 args, 1 default, RETURNS void).
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure
      AND p.pronargs = 3
      AND p.pronargdefaults = 1
      AND p.prorettype = 'void'::regtype
  ),
  'T05 record_public_signup_audit: 3 args, 1 default, RETURNS void'
);

-- T06 — definer + search_path vazio na auditoria.
SELECT ok(
  COALESCE((
    SELECT p.prosecdef AND EXISTS (
      SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, '{}'::text[])) AS c(acl)
      WHERE c.acl IN ('search_path=', 'search_path=""')
    )
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure
  ), false),
  'T06 record_public_signup_audit: prosecdef=true e search_path= vazio'
);

-- T07..T09 — ACL da RPC principal.
SELECT ok(
  has_function_privilege('service_role',
    'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure, 'EXECUTE'),
  'T07 service_role tem EXECUTE na RPC principal'
);
SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure, 'EXECUTE'),
  'T08 authenticated NÃO tem EXECUTE na RPC principal'
);
SELECT ok(
  NOT has_function_privilege('anon',
    'public.create_tenant_for_public_signup(
      uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
    )'::regprocedure, 'EXECUTE'),
  'T09 anon NÃO tem EXECUTE na RPC principal'
);

-- T10..T11 — ACL da RPC de auditoria.
SELECT ok(
  has_function_privilege('service_role',
    'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure, 'EXECUTE'),
  'T10 service_role tem EXECUTE na auditoria'
);
SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure, 'EXECUTE'),
  'T11 authenticated NÃO tem EXECUTE na auditoria'
);

-- T12 — nenhum EXECUTE implícito para PUBLIC nas duas funções.
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    CROSS JOIN LATERAL pg_catalog.unnest(COALESCE(p.proacl, '{}'::aclitem[])) AS a(acl)
    WHERE p.oid IN (
      'public.create_tenant_for_public_signup(
        uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text
      )'::regprocedure,
      'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure
    )
      AND a.acl::text LIKE '=X%'
  ),
  'T12 nenhum grant EXECUTE para PUBLIC'
);

-- T13 — gate 2: authenticated chamando a principal ⇒ 42501.
SET ROLE authenticated;
SELECT throws_ok(
  $sql$SELECT public.create_tenant_for_public_signup(
    'b0101000-0000-4000-8000-000000000001'::uuid,
    'c0101000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000106', 'x', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  )$sql$,
  '42501', NULL,
  'T13 authenticated ⇒ 42501 em create_tenant_for_public_signup'
);
-- T14 — gate 2: authenticated chamando a auditoria ⇒ 42501.
SELECT throws_ok(
  $sql$SELECT public.record_public_signup_audit(
    'b0101000-0000-4000-8000-000000000002'::uuid,
    'signup-public-throttled'
  )$sql$,
  '42501', NULL,
  'T14 authenticated ⇒ 42501 em record_public_signup_audit'
);
RESET ROLE;

SELECT * FROM finish();
