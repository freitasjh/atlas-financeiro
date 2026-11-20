-- 44-internal-operators-freeze.spec.sql — internal-admin L0 / T01+T02 (migration 0041).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/44-internal-operators-freeze.spec.sql
-- Rerunnable: fixtures (users f440*) + linhas em internal_operators apagados no
-- início e no fim. O usuário seed admin@atlas.test (00000000-0000-4000-8000-0000000000a1)
-- NUNCA é apagado aqui.
-- Escrito ANTES da migration (TDD): falha sem 0041 (sem public.internal_operators,
-- sem private.is_internal_operator()) e passa com 0041 aplicada.
--
-- Prova em banco real (`SET ROLE authenticated`/`anon` + `request.jwt.claims` +
-- ROLLBACK por cenário mutante — nada persiste salvo fixtures):
--   T00 estrutura: public.internal_operators com user_id PK→auth.users,
--       active/created_at/created_by/disabled_at; RLS ENABLED; 0 policy
--       permissiva; REVOKE ALL de anon/authenticated (relacl sem privilege
--       para os dois); PUBLIC (grantee 0) sem privilege além de '=' na tabela
--       e no helper; service_role com DML mínimo explícito (SELECT/INSERT/
--       UPDATE/DELETE, sem TRUNCATE/REFERENCES/TRIGGER/MAINTAIN); helper
--       private.is_internal_operator() STABLE SECURITY DEFINER search_path=''
--       (fora do PostgREST: schema private, o config expõe só public/
--       graphql_public); sem current_user; EXECUTE só para authenticated/
--       service_role, nunca para anon/PUBLIC.
--   T-HELPER-OK: operador (super_admin + linha active=true) → true.
--   T-HELPER-OFF: super_admin + linha active=false → false (enroll MFA forçado
--       antes de active=true: backfill nasce inativo).
--   T-HELPER-PLAIN: user sem linha → false (sem PII, sem raise).
--   T-HELPER-ANON: anon/sem sessão → false ou 42501 (EXECUTE negado —
--       deny fail-closed); nunca true.
--   T-DENY-AUTH: authenticated SELECT/INSERT/UPDATE/DELETE → 42501 e 0 linhas
--       enumeradas (REVOKE, não apenas ausência de policy). BOLA provada:
--       tenant não enumera operadores.
--   T-DENY-ANON: anon SELECT/INSERT → 42501 estrito.
--   T-SVC: service_role lê 1 linha do operador fixture e escreve
--       (INSERT/UPDATE/DELETE em ROLLBACK) — único caminho Edge/seed, via
--       GRANT explícito da 0041.
--   T-BACKFILL-REAL: linha do seed admin@atlas.test (super_admin) existe com
--       active=true — SEC-05/0051: o seed de DEV garante o operador ativo para
--       o backoffice local nascer acessível (produção não roda seed; lá a
--       ativação é DBA/psql, runbook §10). O teste só lê.
--   T-BACKFILL: internal_operators ⊆ profiles.role='super_admin' (só
--       super_admins atuais); re-simulação do INSERT ... WHERE NOT EXISTS
--       insere 1 linha inativa e é idempotente (2ª vez insere 0).
--   T-RESTRICT: apagar auth.users com linha em internal_operators → 23503
--       (ON DELETE RESTRICT; histórico nunca some por cascade).
-- Erros por rótulo fixo, sem PII (ids/e-mail não aparecem nas mensagens).
-- Sem dinheiro (só identidade): nenhum float/double.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
DELETE FROM public.internal_operators
WHERE user_id IN (
  'f4400000-0000-4000-8000-000000000001',
  'f4400000-0000-4000-8000-000000000002',
  'f4400000-0000-4000-8000-000000000003'
);

DELETE FROM auth.users
WHERE id IN (
  'f4400000-0000-4000-8000-000000000001',
  'f4400000-0000-4000-8000-000000000002',
  'f4400000-0000-4000-8000-000000000003'
);

INSERT INTO auth.users (id, email) VALUES
  ('f4400000-0000-4000-8000-000000000001', 'ia-operador-44@example.com'),
  ('f4400000-0000-4000-8000-000000000002', 'ia-inativo-44@example.com'),
  ('f4400000-0000-4000-8000-000000000003', 'ia-plain-44@example.com');

-- 001/002 super_admin (premissa do backfill: só super_admins atuais);
-- 003 permanece 'user' (handle_new_user). Todos must_change_password=false.
UPDATE public.profiles SET role = 'super_admin'
WHERE id IN (
  'f4400000-0000-4000-8000-000000000001',
  'f4400000-0000-4000-8000-000000000002'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'f4400000-0000-4000-8000-000000000001',
  'f4400000-0000-4000-8000-000000000002',
  'f4400000-0000-4000-8000-000000000003'
);

-- 001 ativo (via helper → true); 002 inativo (helper → false). created_by = seed.
INSERT INTO public.internal_operators (user_id, active, created_by) VALUES
  ('f4400000-0000-4000-8000-000000000001', true, '00000000-0000-4000-8000-0000000000a1'),
  ('f4400000-0000-4000-8000-000000000002', false, '00000000-0000-4000-8000-0000000000a1');

-- ============ T00 — estrutura pós-0041 ============
DO $$
DECLARE
  v_table oid;
  v_rls boolean;
  v_n int;
  v_proc pg_proc;
  v_src text;
  v_grantee_privs text;
BEGIN
  SELECT c.oid INTO v_table
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'internal_operators';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: public.internal_operators ausente';
  END IF;

  -- RLS habilitado (defesa em profundidade; o deny ativo é o REVOKE abaixo).
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = v_table;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: internal_operators sem RLS ENABLED';
  END IF;

  -- 0 policy permissiva: nenhuma policy pode liberar anon/authenticated.
  SELECT count(*) INTO v_n FROM pg_policy WHERE polrelid = v_table;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: internal_operators com % policy (deny-all exige 0)', v_n;
  END IF;

  -- Colunas mínimas (ADR-05): PK em user_id → auth.users.
  SELECT count(*) INTO v_n
  FROM pg_attribute
  WHERE attrelid = v_table
    AND attname IN ('user_id', 'active', 'created_at', 'created_by', 'disabled_at');
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'T00 falhou: internal_operators sem as 5 colunas ADR-05 (achou %)', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_index AS i
  WHERE i.indrelid = v_table AND i.indisprimary;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T00 falhou: internal_operators sem PK (achou %)', v_n;
  END IF;

  -- REVOKE ALL: relacl sem nenhum privilege para anon/authenticated
  -- (service_role é o único caminho — Edge server-side; SPEC ADR-01/ADR-02).
  SELECT string_agg(DISTINCT p.privilege_type, ',') INTO v_grantee_privs
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.oid))) AS p
  WHERE n.nspname = 'public' AND c.relname = 'internal_operators'
    AND p.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
    AND p.privilege_type <> '='; -- '=' = grant option marker; ignora
  IF v_grantee_privs IS NOT NULL AND v_grantee_privs <> '' THEN
    RAISE EXCEPTION 'T00 falhou: authenticated com privilege em internal_operators (%)', v_grantee_privs;
  END IF;
  SELECT string_agg(DISTINCT p.privilege_type, ',') INTO v_grantee_privs
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.oid))) AS p
  WHERE n.nspname = 'public' AND c.relname = 'internal_operators'
    AND p.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')
    AND p.privilege_type <> '=';
  IF v_grantee_privs IS NOT NULL AND v_grantee_privs <> '' THEN
    RAISE EXCEPTION 'T00 falhou: anon com privilege em internal_operators (%)', v_grantee_privs;
  END IF;

  -- PUBLIC (grantee 0): nenhum privilege além de '=' (grant option) na tabela.
  SELECT string_agg(DISTINCT p.privilege_type, ',') INTO v_grantee_privs
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.oid))) AS p
  WHERE n.nspname = 'public' AND c.relname = 'internal_operators'
    AND p.grantee = 0
    AND p.privilege_type <> '=';
  IF v_grantee_privs IS NOT NULL AND v_grantee_privs <> '' THEN
    RAISE EXCEPTION 'T00 falhou: PUBLIC com privilege em internal_operators (%)', v_grantee_privs;
  END IF;

  -- service_role: DML mínimo explícito da 0041 (precedente 0020); sobra
  -- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN do default ALL do Supabase nega.
  IF NOT pg_catalog.has_table_privilege('service_role', 'public.internal_operators', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.internal_operators', 'INSERT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.internal_operators', 'UPDATE')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.internal_operators', 'DELETE') THEN
    RAISE EXCEPTION 'T00 falhou: service_role sem DML mínimo em internal_operators';
  END IF;
  IF pg_catalog.has_table_privilege('service_role', 'public.internal_operators', 'TRUNCATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.internal_operators', 'REFERENCES')
     OR pg_catalog.has_table_privilege('service_role', 'public.internal_operators', 'TRIGGER')
     OR pg_catalog.has_table_privilege('service_role', 'public.internal_operators', 'MAINTAIN') THEN
    RAISE EXCEPTION 'T00 falhou: service_role com privilege residual (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)';
  END IF;

  -- Helper private.is_internal_operator(): STABLE + DEFINER + search_path=''.
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('private.is_internal_operator()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: private.is_internal_operator() ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() sem SECURITY DEFINER';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() sem STABLE';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() sem search_path='' travado';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('private.is_internal_operator()');
  IF v_src IS NULL OR v_src NOT LIKE '%public.internal_operators%' THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() sem tabela qualificada public.internal_operators';
  END IF;
  IF v_src NOT LIKE '%auth.uid%' THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() sem auth.uid()';
  END IF;
  IF v_src LIKE '%current_user%' THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() usa current_user';
  END IF;
  -- Fora do PostgREST: pronamespace = private (config expõe só public).
  IF (SELECT nspname FROM pg_namespace WHERE oid = v_proc.pronamespace) <> 'private' THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() fora do schema private';
  END IF;
  -- EXECUTE: authenticated sim (gates RPC futuros), anon nunca.
  SELECT count(*) INTO v_n
  FROM pg_catalog.aclexplode(COALESCE(v_proc.proacl, pg_catalog.acldefault('f', v_proc.oid)))
  WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
    AND privilege_type = 'EXECUTE';
  IF v_n = 0 THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() sem EXECUTE para authenticated';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_catalog.aclexplode(COALESCE(v_proc.proacl, pg_catalog.acldefault('f', v_proc.oid)))
  WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')
    AND privilege_type = 'EXECUTE';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: is_internal_operator() com EXECUTE para anon (leak)';
  END IF;
  -- PUBLIC (grantee 0): nenhum privilege além de '=' no helper (nem EXECUTE).
  SELECT string_agg(DISTINCT p.privilege_type, ',') INTO v_grantee_privs
  FROM pg_catalog.aclexplode(COALESCE(v_proc.proacl, pg_catalog.acldefault('f', v_proc.oid))) AS p
  WHERE p.grantee = 0
    AND p.privilege_type <> '=';
  IF v_grantee_privs IS NOT NULL AND v_grantee_privs <> '' THEN
    RAISE EXCEPTION 'T00 falhou: PUBLIC com privilege em is_internal_operator() (%)', v_grantee_privs;
  END IF;

  RAISE NOTICE 'T00 ok: internal_operators deny-all (RLS + 0 policy + REVOKE) + helper private STABLE DEFINER search_path=''''';
END $$;

-- ============ T-HELPER-OK — operador ativo → true ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f4400000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f4400000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT private.is_internal_operator() INTO v_ok;
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-HELPER-OK falhou: operador ativo sem true (%)', v_ok;
  END IF;
  RAISE NOTICE 'T-HELPER-OK ok: operador ativo → is_internal_operator()=true';
END $$;
ROLLBACK;

-- ============ T-HELPER-OFF — linha inativa → false ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f4400000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f4400000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}', false);
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT private.is_internal_operator() INTO v_ok;
  IF v_ok IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-HELPER-OFF falhou: operador inativo sem false (%)', v_ok;
  END IF;
  RAISE NOTICE 'T-HELPER-OFF ok: linha inativa → is_internal_operator()=false';
END $$;
ROLLBACK;

-- ============ T-HELPER-PLAIN — sem linha → false ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f4400000-0000-4000-8000-000000000003', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f4400000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', false);
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT private.is_internal_operator() INTO v_ok;
  IF v_ok IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-HELPER-PLAIN falhou: user sem linha sem false (%)', v_ok;
  END IF;
  RAISE NOTICE 'T-HELPER-PLAIN ok: sem linha → is_internal_operator()=false, sem raise';
END $$;
ROLLBACK;

-- ============ T-HELPER-ANON — anon/sem sessão: nunca true ============
BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claims', NULL, false);
DO $$
DECLARE v_ok boolean;
BEGIN
  BEGIN
    SELECT private.is_internal_operator() INTO v_ok;
    IF v_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'T-HELPER-ANON falhou: anon sem false (%)', v_ok;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Sem EXECUTE para anon (T00): 42501 também é deny fail-closed.
    IF SQLERRM LIKE 'T-HELPER-ANON falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' AND SQLERRM <> 'false' THEN
      RAISE EXCEPTION 'T-HELPER-ANON falhou: deny inesperado (%) SQLSTATE=%', SQLERRM, SQLSTATE;
    END IF;
  END;
  RAISE NOTICE 'T-HELPER-ANON ok: anon/sem sessão nunca true (deny fail-closed)';
END $$;
ROLLBACK;

-- ============ T-DENY-AUTH — authenticated: 0 linhas + 42501 (BOLA) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f4400000-0000-4000-8000-000000000003', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f4400000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', false);
DO $$
DECLARE v_n bigint;
BEGIN
  -- SELECT: 42501 (REVOKE) — e 0 linhas enumeradas em qualquer hipótese.
  BEGIN
    SELECT count(*) INTO v_n FROM public.internal_operators;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'T-DENY-AUTH falhou: authenticated enumerou % linha(s)', v_n;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-DENY-AUTH falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'T-DENY-AUTH falhou: SELECT SQLSTATE errado (%) %', SQLSTATE, SQLERRM;
    END IF;
  END;
  -- INSERT
  BEGIN
    INSERT INTO public.internal_operators (user_id, active)
    VALUES ('f4400000-0000-4000-8000-000000000003', true);
    RAISE EXCEPTION 'T-DENY-AUTH falhou: INSERT direto passou (authenticated)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-DENY-AUTH falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'T-DENY-AUTH falhou: INSERT SQLSTATE errado (%) %', SQLSTATE, SQLERRM;
    END IF;
  END;
  -- UPDATE
  BEGIN
    UPDATE public.internal_operators SET active = true
    WHERE user_id = 'f4400000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'T-DENY-AUTH falhou: UPDATE direto passou (authenticated)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-DENY-AUTH falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'T-DENY-AUTH falhou: UPDATE SQLSTATE errado (%) %', SQLSTATE, SQLERRM;
    END IF;
  END;
  -- DELETE
  BEGIN
    DELETE FROM public.internal_operators
    WHERE user_id = 'f4400000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'T-DENY-AUTH falhou: DELETE direto passou (authenticated)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-DENY-AUTH falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'T-DENY-AUTH falhou: DELETE SQLSTATE errado (%) %', SQLSTATE, SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-DENY-AUTH ok: authenticated enumera 0 linhas e nega escrita (42501)';
END $$;
ROLLBACK;

-- ============ T-DENY-ANON — anon negado (42501 estrito) ============
BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claims', NULL, false);
DO $$
DECLARE v_n bigint;
BEGIN
  BEGIN
    SELECT count(*) INTO v_n FROM public.internal_operators;
    RAISE EXCEPTION 'T-DENY-ANON falhou: anon enumerou % linha(s)', v_n;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-DENY-ANON falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'T-DENY-ANON falhou: SELECT SQLSTATE errado (%) %', SQLSTATE, SQLERRM;
    END IF;
  END;
  BEGIN
    INSERT INTO public.internal_operators (user_id, active)
    VALUES ('f4400000-0000-4000-8000-000000000003', true);
    RAISE EXCEPTION 'T-DENY-ANON falhou: INSERT direto passou (anon)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-DENY-ANON falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '42501' THEN
      RAISE EXCEPTION 'T-DENY-ANON falhou: INSERT SQLSTATE errado (%) %', SQLSTATE, SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-DENY-ANON ok: anon nega SELECT/INSERT (42501)';
END $$;
ROLLBACK;

-- ============ T-SVC — service_role (Edge/seed): lê 1 e escreve (único caminho) ============
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE v_n bigint;
BEGIN
  -- SELECT: 1 linha do operador fixture ativo (bypass RLS + GRANT explícito).
  SELECT count(*) INTO v_n FROM public.internal_operators
  WHERE user_id = 'f4400000-0000-4000-8000-000000000001';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-SVC falhou: service_role leu % linha(s) do operador (esperava 1)', v_n;
  END IF;
  -- INSERT/UPDATE/DELETE do GRANT mínimo (ROLLBACK abaixo desfaz a sonda).
  INSERT INTO public.internal_operators (user_id, active)
  VALUES ('f4400000-0000-4000-8000-000000000003', false);
  SELECT count(*) INTO v_n FROM public.internal_operators
  WHERE user_id = 'f4400000-0000-4000-8000-000000000003';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-SVC falhou: INSERT por service_role sem 1 linha (%)', v_n;
  END IF;
  UPDATE public.internal_operators SET active = true
  WHERE user_id = 'f4400000-0000-4000-8000-000000000003';
  DELETE FROM public.internal_operators
  WHERE user_id = 'f4400000-0000-4000-8000-000000000003';
  SELECT count(*) INTO v_n FROM public.internal_operators
  WHERE user_id = 'f4400000-0000-4000-8000-000000000003';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-SVC falhou: DELETE por service_role sobraram % linha(s)', v_n;
  END IF;
  RAISE NOTICE 'T-SVC ok: service_role lê 1 linha e escreve via GRANT explícito (0041)';
END $$;
ROLLBACK;

-- ============ T-BACKFILL-REAL — operador do seed de dev ============
-- O seed nasce DEPOIS das migrations no `db reset`; desde SEC-05/0051 ele
-- cria o admin como operador ATIVO (bootstrap de DEV). O teste só LÊ — se o
-- seed não provisionou o dono, falha. (Backfill de migration continua
-- inserindo inativo; ver T-BACKFILL abaixo.)
DO $$
DECLARE
  v_role text;
  v_active boolean;
  v_n int;
BEGIN
  SELECT p.role, io.active INTO v_role, v_active
  FROM public.profiles AS p
  JOIN auth.users AS u ON u.id = p.id
  JOIN public.internal_operators AS io ON io.user_id = p.id
  WHERE u.email = 'admin@atlas.test';
  IF NOT FOUND OR v_role <> 'super_admin' OR v_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-BACKFILL-REAL falhou: seed admin@atlas.test sem linha ATIVA super_admin (role=%, active=%)',
      COALESCE(v_role, '<null>'), COALESCE(v_active::text, '<null>');
  END IF;
  SELECT count(*) INTO v_n
  FROM public.internal_operators AS io
  JOIN auth.users AS u ON u.id = io.user_id
  WHERE u.email = 'admin@atlas.test';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-BACKFILL-REAL falhou: seed com % linha(s) (esperava 1)', v_n;
  END IF;
  RAISE NOTICE 'T-BACKFILL-REAL ok: seed de dev provisionou admin@atlas.test (super_admin, ativo)';
END $$;

-- ============ T-BACKFILL — só super_admins + idempotente/inativo ============
DO $$
DECLARE v_n int; v_active boolean;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.internal_operators AS io
  LEFT JOIN public.profiles AS p ON p.id = io.user_id
  WHERE p.id IS NULL OR p.role <> 'super_admin';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-BACKFILL falhou: % linha(s) sem profile super_admin', v_n;
  END IF;
  RAISE NOTICE 'T-BACKFILL ok: internal_operators só contém super_admins atuais';
END $$;

BEGIN;
-- Re-simula o INSERT da migration 0041 (mesmo predicado): 1ª vez insere 1
-- linha inativa; 2ª vez insere 0 (idempotente). ROLLBACK restaura a fixture.
DO $$
DECLARE v_n int; v_active boolean;
BEGIN
  DELETE FROM public.internal_operators
  WHERE user_id = 'f4400000-0000-4000-8000-000000000002';
  INSERT INTO public.internal_operators (user_id, active)
  SELECT p.id, false
  FROM public.profiles AS p
  WHERE p.role = 'super_admin'
    AND NOT EXISTS (
      SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
    )
    AND p.id = 'f4400000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-BACKFILL falhou: 1ª simulação inseriu % (esperava 1)', v_n;
  END IF;
  SELECT active INTO v_active FROM public.internal_operators
  WHERE user_id = 'f4400000-0000-4000-8000-000000000002';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-BACKFILL falhou: backfill nasceu ativo (%) — enroll MFA forçado exige inativo', v_active;
  END IF;
  INSERT INTO public.internal_operators (user_id, active)
  SELECT p.id, false
  FROM public.profiles AS p
  WHERE p.role = 'super_admin'
    AND NOT EXISTS (
      SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
    )
    AND p.id = 'f4400000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-BACKFILL falhou: 2ª simulação inseriu % (esperava 0)', v_n;
  END IF;
  RAISE NOTICE 'T-BACKFILL ok: backfill inativo + idempotente (1 depois 0)';
END $$;
ROLLBACK;

-- ============ T-RESTRICT — apagar user com linha nega (23503) ============
BEGIN;
DO $$
BEGIN
  BEGIN
    DELETE FROM auth.users
    WHERE id = 'f4400000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'T-RESTRICT falhou: DELETE em auth.users com operador passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-RESTRICT falhou%' THEN RAISE; END IF;
    IF SQLSTATE <> '23503' THEN
      RAISE EXCEPTION 'T-RESTRICT falhou: SQLSTATE errado (%) %', SQLSTATE, SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-RESTRICT ok: ON DELETE RESTRICT bloqueia apagar operador com linha';
END $$;
ROLLBACK;

-- ============ Limpeza final (rerun não duplica; seed preservado) ============
DELETE FROM public.internal_operators
WHERE user_id IN (
  'f4400000-0000-4000-8000-000000000001',
  'f4400000-0000-4000-8000-000000000002',
  'f4400000-0000-4000-8000-000000000003'
);

DELETE FROM auth.users
WHERE id IN (
  'f4400000-0000-4000-8000-000000000001',
  'f4400000-0000-4000-8000-000000000002',
  'f4400000-0000-4000-8000-000000000003'
);

DO $$
DECLARE v_users int; v_ops int; v_seed int;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users WHERE id IN (
    'f4400000-0000-4000-8000-000000000001',
    'f4400000-0000-4000-8000-000000000002',
    'f4400000-0000-4000-8000-000000000003'
  );
  SELECT count(*) INTO v_ops FROM public.internal_operators WHERE user_id IN (
    'f4400000-0000-4000-8000-000000000001',
    'f4400000-0000-4000-8000-000000000002',
    'f4400000-0000-4000-8000-000000000003'
  );
  SELECT count(*) INTO v_seed FROM auth.users WHERE email = 'admin@atlas.test';
  IF v_users <> 0 THEN
    RAISE EXCEPTION 'T-FIM falhou: fixtures sobreviveram à limpeza (%)', v_users;
  END IF;
  IF v_ops <> 0 THEN
    RAISE EXCEPTION 'T-FIM falhou: linhas de operador sobreviveram (%)', v_ops;
  END IF;
  IF v_seed <> 1 THEN
    RAISE EXCEPTION 'T-FIM falhou: seed admin@atlas.test sumiu na limpeza (%)', v_seed;
  END IF;
  RAISE NOTICE 'T-FIM ok: cleanup efetiva, seed preservado, próximo run limpo';
END $$;
