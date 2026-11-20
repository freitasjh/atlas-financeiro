-- backoffice-p0-mfa-0039.spec.sql — review Batch 2 🟡1+🟡3 (migration 0039_fix_gates_search_path_escape.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backoffice-p0-mfa-0039.spec.sql
-- Rerunnable: fixtures (users e800* + 6 tenants "Escape*") apagados no início e no fim.
-- O usuário seed admin@atlas.test (00000000-0000-4000-8000-0000000000a1) NUNCA é apagado aqui.
-- Escrito ANTES da migration (TDD): falha sem 0039 (is_super_admin() com search_path=public
-- na 0037:70; admin_list/admin_count sem ESCAPE/regexp_replace na 0036) e passa com 0039.
--
-- Prova em banco real (`SET ROLE authenticated` + `request.jwt.claims` aal2 + ROLLBACK por
-- cenário mutante — ROLLBACK restaura, nada persiste salvo fixtures):
--   T00 estrutura: is_super_admin() + admin_list_tenants + admin_count_tenants com
--       search_path='' travado (proconfig); is_super_admin() mantém semântica 0037
--       (must-check first-access + mfa-required + só role super_admin; chamadas
--       qualificadas auth.uid/public.profiles/private.is_aal2); is_admin() segue
--       delegando (0035, intacta); as duas RPCs citam regexp_replace + v_search_esc +
--       ESCAPE e mantêm o match auth.users (email do owner, ADR-003).
--   T-ESC (super_admin aal2): '100%' casa LITERAL só "Escape PCT 100% Ltda" (decoy
--       "100X" não vem — % nunca vira wildcard); 'a_c' casa LITERAL só "Escape UND a_c
--       Ltda" (decoy "abc" não vem — _ nunca vira wildcard); 'a\b' casa LITERAL só
--       "Escape BSL a\b Ltda" (decoy "ab" não vem — \ é escapado antes do ESCAPE '\').
--   T-COUNT: count(admin_count_tenants) == len(admin_list_tenants) em termo normal,
--       escapados ('100%','a_c','a\b'), vazio, NULL, bogus e com filtro status.
--   T-SEM: semântica 0037 preservada — aal1→mfa-required (is_super_admin e is_admin);
--       aal2→true; user comum→false sem raise; must_change→first-access (antes do mfa);
--       claim service_role isenta (aal2 por claim); anon→false.
-- Erros por rótulo fixo, sem PII (id/e-mail/hash/valor de busca não aparecem nas mensagens).

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
-- contract_acceptances é append-only (trigger): só o postgres desabilita o
-- trigger para a limpeza de fixtures (padrão 0036 spec).
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM public.contract_acceptances
WHERE tenant_id IN (SELECT id FROM public.tenants WHERE
  razao_social IN ('Escape PCT 100% Ltda', 'Escape PCX 100X Ltda',
    'Escape UND a_c Ltda', 'Escape UND abc Ltda',
    E'Escape BSL a\\b Ltda', 'Escape BSL ab Ltda')
  OR cpf IN ('20200101005', '30310203082', '40420204024')
  OR cnpj IN ('11222333000262', '12345678000195', '98765432000198'));

DELETE FROM public.tenant_members
WHERE tenant_id IN (SELECT id FROM public.tenants WHERE
  razao_social IN ('Escape PCT 100% Ltda', 'Escape PCX 100X Ltda',
    'Escape UND a_c Ltda', 'Escape UND abc Ltda',
    E'Escape BSL a\\b Ltda', 'Escape BSL ab Ltda')
  OR cpf IN ('20200101005', '30310203082', '40420204024')
  OR cnpj IN ('11222333000262', '12345678000195', '98765432000198'));

DELETE FROM public.tenants
WHERE razao_social IN ('Escape PCT 100% Ltda', 'Escape PCX 100X Ltda',
  'Escape UND a_c Ltda', 'Escape UND abc Ltda',
  E'Escape BSL a\\b Ltda', 'Escape BSL ab Ltda')
  OR cpf IN ('20200101005', '30310203082', '40420204024')
  OR cnpj IN ('11222333000262', '12345678000195', '98765432000198');

DELETE FROM public.admin_audit
WHERE target_id IN (
  'e8000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e8000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002'
);

DELETE FROM auth.users
WHERE id IN (
  'e8000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

INSERT INTO auth.users (id, email) VALUES
  ('e8000000-0000-4000-8000-000000000001', 'p0m-esc-0039@example.com'),
  ('e8000000-0000-4000-8000-000000000002', 'p0m-plain-0039@example.com');

UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'e8000000-0000-4000-8000-000000000001';
-- 002 permanece 'user' (handle_new_user). Ambos must_change_password=false.

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
  'e8000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002'
);

-- ============ T00 — estrutura pós-0039 ============
DO $$
DECLARE
  v_sig text;
  v_proc pg_proc;
  v_src text;
  v_def text;
  v_sigs text[] := ARRAY[
    'public.is_super_admin()',
    'public.admin_list_tenants(text, text, text, text, int, int)',
    'public.admin_count_tenants(text, text)'
  ];
BEGIN
  -- As três funções redefinidas pela 0039: DEFINER + STABLE + search_path='' travado.
  FOREACH v_sig IN ARRAY v_sigs LOOP
    SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure(v_sig);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'T00 falhou: % ausente', v_sig;
    END IF;
    IF v_proc.prosecdef IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'T00 falhou: % sem SECURITY DEFINER', v_sig;
    END IF;
    IF v_proc.provolatile <> 's' THEN
      RAISE EXCEPTION 'T00 falhou: % sem STABLE', v_sig;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION 'T00 falhou: % sem search_path='' travado', v_sig;
    END IF;
  END LOOP;

  -- is_super_admin(): semântica 0037 preservada + chamadas qualificadas.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.is_super_admin()');
  IF v_src NOT LIKE '%mfa-required%' THEN
    RAISE EXCEPTION 'T00 falhou: is_super_admin() sem rótulo mfa-required';
  END IF;
  IF v_src NOT LIKE '%first-access-password-change-required%' THEN
    RAISE EXCEPTION 'T00 falhou: is_super_admin() sem must-check de primeiro acesso';
  END IF;
  IF v_src NOT LIKE '%private.is_aal2%' THEN
    RAISE EXCEPTION 'T00 falhou: is_super_admin() sem gate aal2 (private.is_aal2)';
  END IF;
  IF v_src NOT LIKE '%auth.uid%' THEN
    RAISE EXCEPTION 'T00 falhou: is_super_admin() sem chamada qualificada auth.uid()';
  END IF;
  IF v_src NOT LIKE '%public.profiles%' THEN
    RAISE EXCEPTION 'T00 falhou: is_super_admin() sem tabela qualificada public.profiles';
  END IF;

  -- is_admin() (0035) intacta: segue delegando (herda o gate aal2 por transitividade).
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.is_admin()');
  IF v_src IS NULL OR position('is_super_admin' IN v_src) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: is_admin() deixou de delegar a is_super_admin()';
  END IF;

  -- As duas RPCs: escape de LIKE (%/_/\) + mesmo predicado + email do owner.
  SELECT pg_catalog.pg_get_functiondef('public.admin_list_tenants(text, text, text, text, int, int)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%regexp_replace%' OR v_def NOT LIKE '%v_search_esc%'
     OR v_def NOT LIKE '%ESCAPE%' OR v_def NOT LIKE '%auth.users%' THEN
    RAISE EXCEPTION 'T00 falhou: admin_list_tenants sem escape de LIKE (regexp_replace + ESCAPE)';
  END IF;
  SELECT pg_catalog.pg_get_functiondef('public.admin_count_tenants(text, text)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%regexp_replace%' OR v_def NOT LIKE '%v_search_esc%'
     OR v_def NOT LIKE '%ESCAPE%' OR v_def NOT LIKE '%auth.users%' THEN
    RAISE EXCEPTION 'T00 falhou: admin_count_tenants sem escape de LIKE (regexp_replace + ESCAPE)';
  END IF;

  RAISE NOTICE 'T00 ok: is_super_admin + list/count com search_path='' + escape LIKE + is_admin delegando';
END $$;

-- ============ Fixtures: 6 tenants (literal × decoy p/ %, _ e \) ============
-- Criados como o super_admin (dono = auth.uid) via RPC atômica; tenant + membership
-- owner + aceite na mesma transação (wrapper 0025).
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'e8000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', false);
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner_and_acceptance(
    'pf', '20200101005', 'Escape PCT 100% Ltda', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
  v_id := public.create_tenant_with_owner_and_acceptance(
    'pf', '30310203082', 'Escape PCX 100X Ltda', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
  v_id := public.create_tenant_with_owner_and_acceptance(
    'pj', '11222333000262', 'Escape UND a_c Ltda', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
  v_id := public.create_tenant_with_owner_and_acceptance(
    'pj', '12345678000195', 'Escape UND abc Ltda', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
  v_id := public.create_tenant_with_owner_and_acceptance(
    'pf', '40420204024', E'Escape BSL a\\b Ltda', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
  v_id := public.create_tenant_with_owner_and_acceptance(
    'pj', '98765432000198', 'Escape BSL ab Ltda', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
END $$;
COMMIT;

-- ============ T-ESC — %/_/\ casam literal (nunca wildcard) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e8000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
  v_c bigint;
  v_r text;
BEGIN
  -- '%': só o literal. Decoy 100X (casa se % fosse wildcard) não pode vir.
  SELECT count(id) INTO v_n FROM public.admin_list_tenants('100%', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('100%', NULL) INTO v_c;
  IF v_n <> 1 OR v_c <> 1 THEN
    RAISE EXCEPTION 'T-ESC falhou: termo 100%% list=% count=% (esperado 1/1)', v_n, v_c;
  END IF;
  SELECT t.razao_social INTO v_r FROM public.admin_list_tenants('100%', NULL, 'created_at', 'desc', 100, 0) AS t;
  IF v_r <> 'Escape PCT 100% Ltda' THEN
    RAISE EXCEPTION 'T-ESC falhou: termo 100%% não casou o literal (%%)';
  END IF;
  SELECT count(id) INTO v_n FROM public.admin_list_tenants('100%', NULL, 'created_at', 'desc', 100, 0)
  WHERE razao_social = 'Escape PCX 100X Ltda';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-ESC falhou: %% agiu como wildcard (decoy 100X veio junto)';
  END IF;

  -- '_': só o literal. Decoy abc (casa se _ fosse "um char qualquer") não pode vir.
  SELECT count(id) INTO v_n FROM public.admin_list_tenants('a_c', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('a_c', NULL) INTO v_c;
  IF v_n <> 1 OR v_c <> 1 THEN
    RAISE EXCEPTION 'T-ESC falhou: termo a_c list=% count=% (esperado 1/1)', v_n, v_c;
  END IF;
  SELECT t.razao_social INTO v_r FROM public.admin_list_tenants('a_c', NULL, 'created_at', 'desc', 100, 0) AS t;
  IF v_r <> 'Escape UND a_c Ltda' THEN
    RAISE EXCEPTION 'T-ESC falhou: termo a_c não casou o literal';
  END IF;
  SELECT count(id) INTO v_n FROM public.admin_list_tenants('a_c', NULL, 'created_at', 'desc', 100, 0)
  WHERE razao_social = 'Escape UND abc Ltda';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-ESC falhou: _ agiu como wildcard (decoy abc veio junto)';
  END IF;

  -- '\': só o literal. Decoy "ab" (casa se \ escapasse o b, virando "ab") não pode vir.
  SELECT count(id) INTO v_n FROM public.admin_list_tenants(E'a\\b', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants(E'a\\b', NULL) INTO v_c;
  IF v_n <> 1 OR v_c <> 1 THEN
    RAISE EXCEPTION 'T-ESC falhou: termo a\b list=% count=% (esperado 1/1)', v_n, v_c;
  END IF;
  SELECT t.razao_social INTO v_r FROM public.admin_list_tenants(E'a\\b', NULL, 'created_at', 'desc', 100, 0) AS t;
  IF v_r <> E'Escape BSL a\\b Ltda' THEN
    RAISE EXCEPTION 'T-ESC falhou: termo a\b não casou o literal';
  END IF;
  SELECT count(id) INTO v_n FROM public.admin_list_tenants(E'a\\b', NULL, 'created_at', 'desc', 100, 0)
  WHERE razao_social = 'Escape BSL ab Ltda';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-ESC falhou: \ não foi escapado (decoy ab veio junto)';
  END IF;

  RAISE NOTICE 'T-ESC ok: %%/%%/\ casam literal (decoys 100X/abc/ab fora)';
END $$;
ROLLBACK;

-- ============ T-COUNT — count == len(lista) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e8000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_list int;
  v_count bigint;
  v_term text;
  v_terms text[] := ARRAY['', 'Escape', '100%', 'a_c', 'zzzz-nada'];
BEGIN
  FOREACH v_term IN ARRAY v_terms LOOP
    SELECT count(id) INTO v_list FROM public.admin_list_tenants(v_term, NULL, 'created_at', 'desc', 100, 0);
    SELECT public.admin_count_tenants(v_term, NULL) INTO v_count;
    IF v_list::bigint <> v_count THEN
      RAISE EXCEPTION 'T-COUNT falhou: term=% list=% count=%', v_term, v_list, v_count;
    END IF;
  END LOOP;
  -- Termo com barra invertida literal.
  SELECT count(id) INTO v_list FROM public.admin_list_tenants(E'a\\b', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants(E'a\\b', NULL) INTO v_count;
  IF v_list::bigint <> v_count OR v_list <> 1 THEN
    RAISE EXCEPTION 'T-COUNT falhou: term=a\b list=% count=%', v_list, v_count;
  END IF;
  -- NULL == '' (sem busca): invariante é count==len.
  SELECT count(id) INTO v_list FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants(NULL, NULL) INTO v_count;
  IF v_list::bigint <> v_count THEN
    RAISE EXCEPTION 'T-COUNT falhou: NULL list=% count=%', v_list, v_count;
  END IF;
  -- Mesmo predicado com filtro de status (fixtures nascem 'trial').
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('100%', 'trial', 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('100%', 'trial') INTO v_count;
  IF v_list <> 1 OR v_list::bigint <> v_count THEN
    RAISE EXCEPTION 'T-COUNT falhou: status trial list=% count=%', v_list, v_count;
  END IF;
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('a_c', 'trial', 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('a_c', 'trial') INTO v_count;
  IF v_list <> 1 OR v_list::bigint <> v_count THEN
    RAISE EXCEPTION 'T-COUNT falhou: status trial a_c list=% count=%', v_list, v_count;
  END IF;
  RAISE NOTICE 'T-COUNT ok: count == len(lista) em normal/escapados/vazio/NULL/bogus/status';
END $$;
ROLLBACK;

-- ============ T-SEM — semântica 0037 preservada após redefinição ============
-- aal1 → mfa-required (is_super_admin e is_admin, gate por transitividade).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e8000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION 'T-SEM falhou: aal1 passou em is_super_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SEM falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-required' THEN
      RAISE EXCEPTION 'T-SEM falhou: rótulo errado em is_super_admin (% )', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM public.is_admin();
    RAISE EXCEPTION 'T-SEM falhou: aal1 passou em is_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SEM falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-required' THEN
      RAISE EXCEPTION 'T-SEM falhou: rótulo errado em is_admin (% )', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-SEM ok: aal1 → mfa-required (is_super_admin e is_admin)';
END $$;
ROLLBACK;

-- aal2 → true; user comum → false sem raise.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e8000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);
DO $$
DECLARE v_super boolean;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF v_super IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SEM falhou: super_admin aal2 sem is_super_admin=true';
  END IF;
  RAISE NOTICE 'T-SEM ok: super_admin aal2 → is_super_admin=true';
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e8000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', false);
DO $$
DECLARE v_admin boolean; v_super boolean;
BEGIN
  SELECT public.is_admin() INTO v_admin;
  SELECT public.is_super_admin() INTO v_super;
  IF v_admin IS DISTINCT FROM false OR v_super IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-SEM falhou: user comum aal1 levantou ou passou';
  END IF;
  RAISE NOTICE 'T-SEM ok: user comum aal1 → false sem raise';
END $$;
ROLLBACK;

-- must_change → first-access (antes do mfa, mesmo em aal1/aal2).
BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'e8000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e8000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION 'T-SEM falhou: travado aal1 passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SEM falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-password-change-required' THEN
      RAISE EXCEPTION 'T-SEM falhou: rótulo errado p/ travado (% )', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-SEM ok: travado + aal1 → first-access (ordem must antes do mfa)';
END $$;
ROLLBACK;

-- claim service_role (sub=super_admin, sem aal) → is_aal2=true → true.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'e8000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000001","role":"service_role"}', false);
DO $$
DECLARE v_aal boolean; v_super boolean;
BEGIN
  SELECT private.is_aal2() INTO v_aal;
  IF v_aal IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SEM falhou: is_aal2() com claim service_role <> true';
  END IF;
  SELECT public.is_super_admin() INTO v_super;
  IF v_super IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SEM falhou: service_role sem is_super_admin=true';
  END IF;
  RAISE NOTICE 'T-SEM ok: service_role isento por claim passa no gate';
END $$;
ROLLBACK;

-- anon → false sem raise, sem leak (claims zeradas: o COMMIT das fixtures
-- deixou sub=e800* na sessão; anon precisa de sessão vazia p/ auth.uid() NULL).
BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claims', NULL, false);
DO $$
BEGIN
  IF public.is_super_admin() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-SEM falhou: is_super_admin() anônimo ≠ false';
  END IF;
  RAISE NOTICE 'T-SEM ok: is_super_admin() anônimo = false';
END $$;
ROLLBACK;

-- ============ Limpeza final (rerun não duplica; seed preservado) ============
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM public.contract_acceptances
WHERE tenant_id IN (SELECT id FROM public.tenants WHERE
  razao_social IN ('Escape PCT 100% Ltda', 'Escape PCX 100X Ltda',
    'Escape UND a_c Ltda', 'Escape UND abc Ltda',
    E'Escape BSL a\\b Ltda', 'Escape BSL ab Ltda')
  OR cpf IN ('20200101005', '30310203082', '40420204024')
  OR cnpj IN ('11222333000262', '12345678000195', '98765432000198'));

DELETE FROM public.tenant_members
WHERE tenant_id IN (SELECT id FROM public.tenants WHERE
  razao_social IN ('Escape PCT 100% Ltda', 'Escape PCX 100X Ltda',
    'Escape UND a_c Ltda', 'Escape UND abc Ltda',
    E'Escape BSL a\\b Ltda', 'Escape BSL ab Ltda')
  OR cpf IN ('20200101005', '30310203082', '40420204024')
  OR cnpj IN ('11222333000262', '12345678000195', '98765432000198'));

DELETE FROM public.tenants
WHERE razao_social IN ('Escape PCT 100% Ltda', 'Escape PCX 100X Ltda',
  'Escape UND a_c Ltda', 'Escape UND abc Ltda',
  E'Escape BSL a\\b Ltda', 'Escape BSL ab Ltda')
  OR cpf IN ('20200101005', '30310203082', '40420204024')
  OR cnpj IN ('11222333000262', '12345678000195', '98765432000198');

DELETE FROM public.admin_audit
WHERE target_id IN (
  'e8000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e8000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002'
);

DELETE FROM auth.users
WHERE id IN (
  'e8000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

DO $$
DECLARE v_users int; v_seed int;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users WHERE id IN (
    'e8000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000002'
  );
  SELECT count(*) INTO v_seed FROM auth.users WHERE email = 'admin@atlas.test';
  IF v_users <> 0 THEN
    RAISE EXCEPTION 'T-FIM falhou: fixtures sobreviveram à limpeza (%)', v_users;
  END IF;
  IF v_seed <> 1 THEN
    RAISE EXCEPTION 'T-FIM falhou: seed admin@atlas.test sumiu na limpeza (%)', v_seed;
  END IF;
  RAISE NOTICE 'T-FIM ok: cleanup efetiva, seed preservado, próximo run limpo';
END $$;
