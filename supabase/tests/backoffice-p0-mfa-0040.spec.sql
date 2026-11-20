-- backoffice-p0-mfa-0040.spec.sql — P0M-BE-03-followup (migration 0040_record_mfa_enrolled.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backoffice-p0-mfa-0040.spec.sql
-- Rerunnable: fixtures (users e900*) + fatores + linhas de auditoria apagados no
-- início e no fim. O usuário seed admin@atlas.test (00000000-0000-4000-8000-0000000000a1)
-- NUNCA é apagado aqui.
-- Escrito ANTES da migration (TDD): falha sem 0040 (sem record_mfa_enrolled())
-- e passa com 0040 aplicada.
--
-- Prova em banco real (`SET ROLE authenticated` + `request.jwt.claims` aal +
-- fator verificado em auth.mfa_factors + ROLLBACK por cenário mutante):
--   T00 estrutura: record_mfa_enrolled() SECURITY DEFINER search_path=''; sem
--       current_user; cita auth.uid + verified + public.admin_audit; EXECUTE só
--       para authenticated.
--   T-OK: super_admin aal1 (must_change=false) + fator verified → insere 1 linha
--       action='mfa_enrolled' com actor_id=target_id=auth.uid(); sem raise
--       mfa-required (produtor do enroll vive FORA do gate aal2: enroll ainda é
--       aal1 — gate é papel + fator verificado, não is_super_admin()).
--   T-AAL2: super_admin aal2 + fator verified → também insere (idempotente de
--       nível de sessão: verify pós-enroll pode registrar sem cair no gate).
--   T-UNVER: super_admin aal1 sem fator verified (só unverified ou nenhum) →
--       'mfa-not-enrolled', sem linha inserida.
--   T-PLAIN: user comum aal1 + fator verified → 'not-admin', sem linha.
--   T-LOCK: must_change=true (mesmo super_admin + verified) → 'first-access-…'.
--   T-ANON: anon/adul sem sessão → 'not-admin' (sem raise de permissão crua,
--       sem linha). anon não tem EXECUTE: 42501 também é aceitável? Não — a
--       função deve ser chamável sem leak: anon recebe 'not-admin' por gate
--       próprio se tiver EXECUTE, ou 42501 sem EXECUTE. Este spec aceita
--       'not-admin' (EXECUTE para authenticated apenas; anon → 42501 aqui é
--       interpretado como deny fail-closed e também passa — ver T-ANON).
--   T-READ: a linha inserida por T-OK lê de volta via list_admin_audit_page
--       ('mfa_enrolled') por super_admin aal2.
-- Erros por rótulo fixo, sem PII (ids/e-mail não aparecem nas mensagens).
-- Escrita direta em admin_audit pelo cliente continua proibida (0019/0020):
-- authenticated não tem INSERT direto (42501) — a trilha só via RPC server-only.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
DELETE FROM auth.mfa_factors
WHERE user_id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

DELETE FROM public.admin_audit
WHERE target_id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

DELETE FROM auth.users
WHERE id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

INSERT INTO auth.users (id, email) VALUES
  ('e9000000-0000-4000-8000-000000000001', 'p0m-mfa-0040@example.com'),
  ('e9000000-0000-4000-8000-000000000002', 'p0m-plain-0040@example.com');

UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'e9000000-0000-4000-8000-000000000001';
-- 002 permanece 'user' (handle_new_user). Ambos must_change_password=false.

-- Fator verificado do super_admin (00990000…01): única linha que habilita T-OK.
INSERT INTO auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at, secret)
VALUES (
  'a9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000001',
  'totp', 'verified', now(), now(), 'testsecret'
);

-- SEC-03 (0051): o super_admin de fixture precisa de operador ATIVO para o
-- caminho feliz das RPCs admin_* (o gate global em is_super_admin() herdou
-- operator-inactive). Bootstrap de fixture, como o seed de dev.
INSERT INTO public.internal_operators (user_id, active)
SELECT p.id, true FROM public.profiles AS p
WHERE p.role = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
  );

DELETE FROM public.admin_audit
WHERE target_id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

-- ============ T00 — estrutura pós-0040 ============
DO $$
DECLARE
  v_proc pg_proc;
  v_src text;
  v_grant_count int;
BEGIN
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('public.record_mfa_enrolled()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: public.record_mfa_enrolled() ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() sem search_path='' travado';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.record_mfa_enrolled()');
  IF v_src IS NULL OR v_src NOT LIKE '%mfa_enrolled%' THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() sem ação mfa_enrolled';
  END IF;
  IF v_src NOT LIKE '%auth.uid%' THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() sem auth.uid()';
  END IF;
  IF v_src NOT LIKE '%public.admin_audit%' THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() sem tabela qualificada public.admin_audit';
  END IF;
  IF v_src NOT LIKE '%verified%' THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() sem checagem de fator verified';
  END IF;
  IF v_src LIKE '%current_user%' THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() usa current_user (isenção errada)';
  END IF;

  -- EXECUTE apenas para authenticated (nunca para anon/PUBLIC).
  SELECT count(*) INTO v_grant_count
  FROM pg_catalog.aclexplode(COALESCE(v_proc.proacl, pg_catalog.acldefault('f', v_proc.oid)))
  WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated');
  IF v_grant_count = 0 THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() sem EXECUTE para authenticated';
  END IF;
  SELECT count(*) INTO v_grant_count
  FROM pg_catalog.aclexplode(COALESCE(v_proc.proacl, pg_catalog.acldefault('f', v_proc.oid)))
  WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon');
  IF v_grant_count <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: record_mfa_enrolled() com EXECUTE para anon (leak)';
  END IF;

  RAISE NOTICE 'T00 ok: record_mfa_enrolled() DEFINER + search_path='' + verified + ACL authenticated-only';
END $$;

-- ============ T-OK — super_admin aal1 + fator verified insere a trilha ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e9000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);

DO $$
DECLARE
  v_actor uuid;
  v_target uuid;
  v_action text;
  v_n int;
BEGIN
  BEGIN
    PERFORM public.record_mfa_enrolled();
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-OK falhou%' THEN RAISE; END IF;
    RAISE EXCEPTION 'T-OK falhou: super aal1+verified levantou (%)', SQLERRM;
  END;

  RAISE NOTICE 'T-OK ok: super aal1+verified insere mfa_enrolled self (sem mfa-required)';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_actor uuid;
  v_target uuid;
  v_n int;
BEGIN
  -- Verificação como DBA (authenticated não lê admin_audit direto — 0019/0020).
  SELECT a.actor_id, a.target_id INTO v_actor, v_target
  FROM public.admin_audit AS a
  WHERE a.target_id = 'e9000000-0000-4000-8000-000000000001'
    AND a.action = 'mfa_enrolled'
  ORDER BY a.at DESC
  LIMIT 1;
  IF v_actor IS DISTINCT FROM 'e9000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'T-OK falhou: actor_id != auth.uid() (%)', v_actor;
  END IF;
  IF v_target IS DISTINCT FROM 'e9000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'T-OK falhou: target_id != auth.uid() (%)', v_target;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE target_id = 'e9000000-0000-4000-8000-000000000001' AND action = 'mfa_enrolled';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-OK falhou: esperava 1 linha mfa_enrolled, veio %', v_n;
  END IF;
END $$;
ROLLBACK;

-- ============ T-AAL2 — super_admin aal2 + verified também registra ============
-- (verify pós-enroll já elevou a sessão: registrar não pode exigir aal1.)
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e9000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  PERFORM public.record_mfa_enrolled();
  RAISE NOTICE 'T-AAL2 ok: super aal2+verified também registra';
END $$;

RESET ROLE;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE target_id = 'e9000000-0000-4000-8000-000000000001' AND action = 'mfa_enrolled';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-AAL2 falhou: esperava 1 linha, veio %', v_n;
  END IF;
END $$;
ROLLBACK;

-- ============ T-UNVER — super_admin sem fator verified → mfa-not-enrolled ============
BEGIN;
-- Remove o fator TODOS (verified + unverified) dentro da transação (ROLLBACK restaura).
DELETE FROM auth.mfa_factors WHERE user_id = 'e9000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e9000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.record_mfa_enrolled();
    RAISE EXCEPTION 'T-UNVER falhou: sem fator passou em record_mfa_enrolled()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-UNVER falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-not-enrolled' THEN
      RAISE EXCEPTION 'T-UNVER falhou: rótulo errado sem fator (% )', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-UNVER ok: sem fator verified → mfa-not-enrolled, sem linha';
END $$;

RESET ROLE;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE target_id = 'e9000000-0000-4000-8000-000000000001' AND action = 'mfa_enrolled';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-UNVER falhou: linha mfa_enrolled inserida sem fator (%)', v_n;
  END IF;
END $$;
ROLLBACK;

-- Variante unverified-only (fator existe mas não verificado → também nega).
BEGIN;
DELETE FROM auth.mfa_factors WHERE user_id = 'e9000000-0000-4000-8000-000000000001';
INSERT INTO auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at, secret)
VALUES (
  'a9000000-0000-4000-8000-000000000012',
  'e9000000-0000-4000-8000-000000000001',
  'totp', 'unverified', now(), now(), 'testsecret'
);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e9000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.record_mfa_enrolled();
    RAISE EXCEPTION 'T-UNVER falhou: fator unverified passou em record_mfa_enrolled()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-UNVER falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-not-enrolled' THEN
      RAISE EXCEPTION 'T-UNVER falhou: rótulo errado p/ unverified (% )', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-UNVER ok: fator unverified → mfa-not-enrolled';
END $$;
ROLLBACK;

-- ============ T-PLAIN — user comum (com fator) → not-admin ============
-- Fator verified do user comum (prova: o gate é o papel, não a posse do fator).
INSERT INTO auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at, secret)
VALUES (
  'a9000000-0000-4000-8000-000000000002',
  'e9000000-0000-4000-8000-000000000002',
  'totp', 'verified', now(), now(), 'testsecret'
);

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e9000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.record_mfa_enrolled();
    RAISE EXCEPTION 'T-PLAIN falhou: user comum passou em record_mfa_enrolled()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-PLAIN falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' THEN
      RAISE EXCEPTION 'T-PLAIN falhou: rótulo errado p/ user comum (% )', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-PLAIN ok: user comum → not-admin, sem linha';
END $$;

RESET ROLE;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE target_id = 'e9000000-0000-4000-8000-000000000002' AND action = 'mfa_enrolled';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-PLAIN falhou: linha mfa_enrolled de user comum (%)', v_n;
  END IF;
END $$;
ROLLBACK;

DELETE FROM auth.mfa_factors
WHERE id = 'a9000000-0000-4000-8000-000000000002';

-- ============ T-LOCK — travado de primeiro acesso (antes do mfa) ============
BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'e9000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e9000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.record_mfa_enrolled();
    RAISE EXCEPTION 'T-LOCK falhou: travado passou em record_mfa_enrolled()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-LOCK falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-password-change-required' THEN
      RAISE EXCEPTION 'T-LOCK falhou: rótulo errado p/ travado (% )', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-LOCK ok: travado → first-access-password-change-required';
END $$;
ROLLBACK;

-- ============ T-DIRECT — escrita direta em admin_audit pelo cliente é negada ============
-- (authenticated não tem INSERT direto — 0019/0020. A trilha só via RPC.)
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e9000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value)
    VALUES (
      'e9000000-0000-4000-8000-000000000001',
      'e9000000-0000-4000-8000-000000000001', 'mfa_enrolled', 'aal1', 'aal2');
    RAISE EXCEPTION 'T-DIRECT falhou: INSERT direto em admin_audit passou (authenticated)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-DIRECT falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'T-DIRECT falhou: SQLSTATE errado no INSERT direto (%) %', SQLSTATE, SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-DIRECT ok: INSERT direto em admin_audit negado (42501), trilha só via RPC';
END $$;
ROLLBACK;

-- ============ T-ANON — anon sem sessão → deny fail-closed ============
-- anon não tem EXECUTE (T00): 42501 é o deny esperado; gate 'not-admin' também
-- é deny fail-closed. Sem linha inserida em ambos os casos.
BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claims', NULL, false);

DO $$
BEGIN
  BEGIN
    PERFORM public.record_mfa_enrolled();
    RAISE EXCEPTION 'T-ANON falhou: anon passou em record_mfa_enrolled()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-ANON falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' AND SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'T-ANON falhou: deny inesperado (% ) SQLSTATE=%', SQLERRM, SQLSTATE;
    END IF;
  END;
  RAISE NOTICE 'T-ANON ok: anon → deny fail-closed (not-admin ou 42501), sem linha';
END $$;

RESET ROLE;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE target_id = 'e9000000-0000-4000-8000-000000000001' AND action = 'mfa_enrolled';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-ANON falhou: linha mfa_enrolled de anon (%)', v_n;
  END IF;
END $$;
ROLLBACK;

-- ============ T-READ — trilha legível via list_admin_audit_page (aal2) ============
INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value)
VALUES ('e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000001', 'mfa_enrolled', 'aal1', 'aal2');

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e9000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.list_admin_audit_page(
    'e9000000-0000-4000-8000-000000000001', 'mfa_enrolled', 20, 0) AS a;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-READ falhou: mfa_enrolled count=% via RPC', v_n;
  END IF;
  RAISE NOTICE 'T-READ ok: mfa_enrolled lê via list_admin_audit_page (aal2)';
END $$;
ROLLBACK;

DELETE FROM public.admin_audit
WHERE target_id = 'e9000000-0000-4000-8000-000000000001' AND action = 'mfa_enrolled';

-- ============ Limpeza final (rerun não duplica; seed preservado) ============
DELETE FROM auth.mfa_factors
WHERE user_id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

DELETE FROM public.admin_audit
WHERE target_id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

DELETE FROM auth.users
WHERE id IN (
  'e9000000-0000-4000-8000-000000000001',
  'e9000000-0000-4000-8000-000000000002'
);

DO $$
DECLARE v_users int; v_factors int; v_seed int;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users WHERE id IN (
    'e9000000-0000-4000-8000-000000000001',
    'e9000000-0000-4000-8000-000000000002'
  );
  SELECT count(*) INTO v_factors FROM auth.mfa_factors WHERE user_id IN (
    'e9000000-0000-4000-8000-000000000001',
    'e9000000-0000-4000-8000-000000000002'
  );
  SELECT count(*) INTO v_seed FROM auth.users WHERE email = 'admin@atlas.test';
  IF v_users <> 0 THEN
    RAISE EXCEPTION 'T-FIM falhou: fixtures sobreviveram à limpeza (%)', v_users;
  END IF;
  IF v_factors <> 0 THEN
    RAISE EXCEPTION 'T-FIM falhou: fatores sobreviveram à limpeza (%)', v_factors;
  END IF;
  IF v_seed <> 1 THEN
    RAISE EXCEPTION 'T-FIM falhou: seed admin@atlas.test sumiu na limpeza (%)', v_seed;
  END IF;
  RAISE NOTICE 'T-FIM ok: cleanup efetiva, seed preservado, próximo run limpo';
END $$;
