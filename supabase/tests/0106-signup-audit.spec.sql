-- 0106-signup-audit.spec.sql — ADR-001 / SIGN-11 (RF-14, NFR-02, gate 3).
--
-- Uso: supabase test db --local supabase/tests/0106-signup-audit.spec.sql
--
-- p_event ∈ {'signup-public-throttled','signup-public-compensated'} validado
-- por CASE: nenhum texto livre do cliente entra em reason. INSERT com
-- action='other', target_id=COALESCE(p_user_id,p_request_id),
-- from_value=p_request_id, to_value=NULL. Mesmos definer/search_path/grants
-- da RPC principal (service_role only).
--
-- TDD FIRST: escrito ANTES da migration 0101.

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c0106000-0000-4000-8000-000000000001', 'audit-0106@example.com');

-- T01 — evento throttled sem user_id: target_id = request_id.
SELECT public.record_public_signup_audit(
  'b0106000-0000-4000-8000-000000000001'::uuid, 'signup-public-throttled'
);
SELECT ok(
  (SELECT count(*) FROM public.admin_audit AS a
   WHERE a.from_value = 'b0106000-0000-4000-8000-000000000001'
     AND a.target_id = 'b0106000-0000-4000-8000-000000000001'::uuid
     AND a.reason = 'signup-public-throttled'
     AND a.action = 'other'
     AND a.actor_id IS NULL
     AND a.to_value IS NULL
     AND a.tenant_id IS NULL) = 1,
  'T01 throttled: target_id=request_id, reason constante, sem PII'
);

-- T02 — com user_id: target_id = user_id, from_value segue o request_id.
SELECT public.record_public_signup_audit(
  'b0106000-0000-4000-8000-000000000002'::uuid,
  'signup-public-compensated',
  'c0106000-0000-4000-8000-000000000001'::uuid
);
SELECT ok(
  (SELECT count(*) FROM public.admin_audit AS a
   WHERE a.from_value = 'b0106000-0000-4000-8000-000000000002'
     AND a.target_id = 'c0106000-0000-4000-8000-000000000001'::uuid
     AND a.reason = 'signup-public-compensated') = 1,
  'T02 compensado: target_id=user_id, from_value=request_id'
);

-- T03 — enum fechado: texto livre do cliente não é aceito.
SELECT throws_ok(
  $sql$SELECT public.record_public_signup_audit(
    'b0106000-0000-4000-8000-000000000003'::uuid, 'user@example.com'
  )$sql$,
  'P0001', 'signup-audit-event-invalid',
  'T03 evento fora do enum ⇒ signup-audit-event-invalid (sem PII)'
);

-- T04 — request_id obrigatório.
SELECT throws_ok(
  $sql$SELECT public.record_public_signup_audit(
    NULL::uuid, 'signup-public-throttled'
  )$sql$,
  'P0001', 'signup-request-invalid',
  'T04 request_id NULL ⇒ signup-request-invalid'
);

-- T05 — nenhum reason livre: só as duas constantes do domínio.
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.admin_audit AS a
    WHERE a.from_value LIKE 'b0106000%'
      AND (a.reason IS NULL OR a.reason !~ '^signup-public-(throttled|compensated)$')
  ),
  'T05 reason sempre constante do domínio (0 PII)'
);

-- T06 — estrutura (definer + search_path vazio).
SELECT ok(
  COALESCE((
    SELECT p.prosecdef AND EXISTS (
      SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, '{}'::text[])) AS c(acl)
      WHERE c.acl IN ('search_path=', 'search_path=""')
    )
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure
  ), false),
  'T06 auditoria: prosecdef=true e search_path= vazio'
);

-- T07 — ACL idêntica à da RPC principal.
SELECT ok(
  has_function_privilege('service_role',
    'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.record_public_signup_audit(uuid,text,uuid)'::regprocedure, 'EXECUTE'),
  'T07 ACL: service_role sim, authenticated/anon não'
);

SELECT * FROM finish();

ROLLBACK;
