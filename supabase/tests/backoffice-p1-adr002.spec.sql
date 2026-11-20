-- backoffice-p1-adr002.spec.sql — P1 ADR-002 (migrations 0034_super_admin_seed_guard.sql + 0035_remove_admin.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backoffice-p1-adr002.spec.sql
-- Rerunnable: fixtures (users c300*) apagados no início e no fim. O usuário seed
-- admin@atlas.test (00000000-0000-4000-8000-0000000000a1) NUNCA é apagado aqui.
--
-- Prova em banco real (nunca mock — mock não avalia trigger/policy/grant), `SET ROLE authenticated` + ROLLBACK:
--   T00 estrutura: role CHECK com super_admin, must_change_password bool default false,
--       is_admin/is_super_admin/complete_first_access/grant/revoke SECURITY DEFINER
--       (search_path=public; is_super_admin com search_path='' desde a 0039),
--       REVOKE antes de GRANT mínimo (complete_first_access: só service_role desde a 0050),
--       audit CHECK grant/revoke_super_admin, sem float.
--   T-SA1 não-admin -> not-admin (admin_list_tenants).
--   T-SA2 super_admin travado (must_change_password=true) -> first-access-password-change-required
--       em RPC admin, em is_admin() e em grant (0 linhas, sem tenant).
--   T-SA3 super-only (0035): 'admin' legado não existe mais; super_admin livre passa
--       (is_admin=true, is_super_admin=true) e user puro tem os dois false
--       (is_admin() = alias estrito de is_super_admin()).
--   T-SA4 JWT nunca concede super_admin: UPDATE/INSERT direto -> not-super-admin; grant por
--       não-super_admin -> not-super-admin; grant/revoke por super_admin livre ok + trilha audit.
--   T-SA5 seed admin@atlas.test travado (super_admin + must_change=true + senha padrão local) e
--       complete_first_access() via service_role (0050) libera só o próprio flag true
--       (alheio/sem flag -> rótulo fixo).
-- Erros por rótulo fixo, sem PII (id/e-mail/hash).

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
DELETE FROM public.admin_audit
WHERE target_id IN (
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  'c3000000-0000-4000-8000-000000000003',
  'c3000000-0000-4000-8000-000000000004',
  'c3000000-0000-4000-8000-000000000005'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  'c3000000-0000-4000-8000-000000000003',
  'c3000000-0000-4000-8000-000000000004',
  'c3000000-0000-4000-8000-000000000005'
);

DELETE FROM auth.users
WHERE id IN (
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  'c3000000-0000-4000-8000-000000000003',
  'c3000000-0000-4000-8000-000000000004',
  'c3000000-0000-4000-8000-000000000005'
);

INSERT INTO auth.users (id, email) VALUES
  ('c3000000-0000-4000-8000-000000000001', 'p1-sa-locked@example.com'),
  ('c3000000-0000-4000-8000-000000000002', 'p1-sa-free@example.com'),
  ('c3000000-0000-4000-8000-000000000003', 'p1-sa-plain2@example.com'),
  ('c3000000-0000-4000-8000-000000000004', 'p1-plain@example.com'),
  ('c3000000-0000-4000-8000-000000000005', 'p1-target@example.com');

UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'c3000000-0000-4000-8000-000000000001';
UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'c3000000-0000-4000-8000-000000000002';
-- legacy (003) + plain (004) + target (005) permanecem 'user' (handle_new_user;
-- o 'admin' legado foi removido pela 0035 — CHECK só aceita user/super_admin).

UPDATE public.profiles SET must_change_password = true
WHERE id = 'c3000000-0000-4000-8000-000000000001';

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
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  'c3000000-0000-4000-8000-000000000003',
  'c3000000-0000-4000-8000-000000000004',
  'c3000000-0000-4000-8000-000000000005'
);

-- ============ T00 — estrutura ============
DO $$
DECLARE
  v_count int;
  v_proc pg_proc;
  v_fn text;
BEGIN
  -- Coluna must_change_password boolean NOT NULL DEFAULT false.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'must_change_password'
      AND data_type = 'boolean'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: profiles.must_change_password ausente ou não é boolean NOT NULL';
  END IF;

  -- CHECK de role com super_admin (0035: sem o literal legado isolado).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_role_check'
      AND conrelid = 'public.profiles'::regclass
      AND pg_get_constraintdef(oid) LIKE '%super_admin%'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: profiles_role_check sem super_admin';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_role_check'
      AND conrelid = 'public.profiles'::regclass
      AND pg_get_constraintdef(oid) LIKE '%''admin''%'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: profiles_role_check ainda com admin legado (0035)';
  END IF;

  -- Funções novas/redefinidas: DEFINER + search_path travado.
  -- is_super_admin() foi redefinida na 0039 com search_path='' (hijack por
  -- schema do chamador); as demais seguem search_path=public.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.is_admin()',
    'public.is_super_admin()',
    'public.complete_first_access()',
    'public.admin_grant_super_admin(uuid)',
    'public.admin_revoke_super_admin(uuid)'
  ] LOOP
    SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure(v_fn);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'T00 falhou: função ausente %', v_fn;
    END IF;
    IF v_proc.prosecdef IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'T00 falhou: sem SECURITY DEFINER em %', v_fn;
    END IF;
    IF v_fn = 'public.is_super_admin()' THEN
      IF v_proc.proconfig IS NULL OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
        WHERE c LIKE 'search_path=%'
          AND (c = 'search_path=' OR c = 'search_path=""')
      ) THEN
        RAISE EXCEPTION 'T00 falhou: sem search_path='''' travado em % (0039)', v_fn;
      END IF;
    ELSE
      IF v_proc.proconfig IS NULL OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
        WHERE c = 'search_path=public'
      ) THEN
        RAISE EXCEPTION 'T00 falhou: sem search_path=public travado em %', v_fn;
      END IF;
    END IF;
  END LOOP;

  -- Guards de trigger: search_path travado, SEM DEFINER de propósito — com
  -- DEFINER o current_user viraria postgres e o deny sempre permitiria.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.deny_role_change()',
    'public.deny_admin_insert()'
  ] LOOP
    SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure(v_fn);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'T00 falhou: função ausente %', v_fn;
    END IF;
    IF v_proc.prosecdef IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'T00 falhou: trigger com DEFINER em % (quebra o deny)', v_fn;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c = 'search_path=public'
    ) THEN
      RAISE EXCEPTION 'T00 falhou: sem search_path=public travado em %', v_fn;
    END IF;
  END LOOP;

  -- EXECUTE mínimo: complete_first_access é server-side (service_role; 0050 C1),
  -- grant/revoke seguem só p/ authenticated (0034). Nunca anon.
  IF has_function_privilege('authenticated', 'public.complete_first_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated com EXECUTE em complete_first_access (fechado pela 0050)';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_first_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: service_role sem EXECUTE em complete_first_access';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_grant_super_admin(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_revoke_super_admin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated sem EXECUTE nas RPCs de grant';
  END IF;
  IF has_function_privilege('anon', 'public.complete_first_access()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_grant_super_admin(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_revoke_super_admin(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.admin_grant_super_admin(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.admin_revoke_super_admin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: EXECUTE indevido (anon/service_role) nas RPCs de grant';
  END IF;

  -- Gates booleanos legíveis por authenticated (policies usam).
  IF NOT has_function_privilege('authenticated', 'public.is_admin()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated sem EXECUTE em is_admin/is_super_admin';
  END IF;

  -- Funções de trigger: sem EXECUTE p/ client (só disparam como owner).
  IF has_function_privilege('authenticated', 'public.deny_role_change()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deny_admin_insert()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated com EXECUTE na função de trigger';
  END IF;

  -- Audit CHECK com grant/revoke_super_admin (preservando quota_override 0033).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_audit_action_check'
      AND conrelid = 'public.admin_audit'::regclass
      AND pg_get_constraintdef(oid) LIKE '%grant_super_admin%'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: CHECK admin_audit sem grant_super_admin';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_audit_action_check'
      AND conrelid = 'public.admin_audit'::regclass
      AND pg_get_constraintdef(oid) LIKE '%revoke_super_admin%'
      AND pg_get_constraintdef(oid) LIKE '%quota_override%'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: CHECK admin_audit sem revoke_super_admin/quota_override';
  END IF;

  -- list_admin_audit_page aceita as ações novas (whitelist expandida).
  IF pg_catalog.pg_get_functiondef('public.list_admin_audit_page(uuid, text, int, int)'::regprocedure)
       NOT LIKE '%grant_super_admin%' THEN
    RAISE EXCEPTION 'T00 falhou: list_admin_audit_page sem grant_super_admin na whitelist';
  END IF;

  RAISE NOTICE 'T00 ok: role super_admin + must_change_password + RPCs DEFINER/search_path público + audit';
END $$;

-- ============ T-SA1 — não-admin -> not-admin ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000004', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0);
    RAISE EXCEPTION 'T-SA1 falhou: não-admin passou na RPC admin';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA1 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' THEN
      RAISE EXCEPTION 'T-SA1 falhou: rótulo errado p/ não-admin (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-SA1 ok: not-admin sem linhas';
END $$;
ROLLBACK;

-- ============ T-SA2 — super_admin travado -> first-access ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0);
    RAISE EXCEPTION 'T-SA2 falhou: super_admin travado passou na RPC admin';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA2 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-password-change-required' THEN
      RAISE EXCEPTION 'T-SA2 falhou: rótulo errado (%); esperado first-access-password-change-required', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.is_admin();
    RAISE EXCEPTION 'T-SA2 falhou: is_admin() não travou super_admin com flag true';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA2 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-password-change-required' THEN
      RAISE EXCEPTION 'T-SA2 falhou: is_admin() rótulo errado (%)', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.admin_grant_super_admin('c3000000-0000-4000-8000-000000000005');
    RAISE EXCEPTION 'T-SA2 falhou: grant por super_admin travado passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA2 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-password-change-required' THEN
      RAISE EXCEPTION 'T-SA2 falhou: grant travado rótulo errado (%)', SQLERRM;
    END IF;
  END;

  -- Flag intacta: nada foi liberado dentro da transação bloqueada.
  IF (SELECT must_change_password FROM public.profiles WHERE id = 'c3000000-0000-4000-8000-000000000001') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SA2 falhou: flag must_change_password mudou sem complete_first_access';
  END IF;

  RAISE NOTICE 'T-SA2 ok: super_admin travado -> first-access-password-change-required, 0 linhas';
END $$;
ROLLBACK;

-- ============ T-SA3 — super-only (0035): user não passa; super_admin livre passa ============
-- T-SA3 — super-only (0035): 'admin' legado não existe; user puro não passa.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000003', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_admin boolean; v_super boolean;
BEGIN
  SELECT public.is_admin() INTO v_admin;
  SELECT public.is_super_admin() INTO v_super;
  IF v_admin IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-SA3 falhou: user comum com is_admin=true (legado?)';
  END IF;
  IF v_super IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-SA3 falhou: user comum com is_super_admin=true';
  END IF;
  -- RPC admin nega (sem super_admin não há is_admin).
  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0);
    RAISE EXCEPTION 'T-SA3 falhou: user comum passou na RPC admin';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA3 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' THEN
      RAISE EXCEPTION 'T-SA3 falhou: rótulo errado p/ user (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-SA3 ok: user comum não passa (is_admin=false, sem legado)';
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_admin boolean; v_super boolean;
BEGIN
  SELECT public.is_admin() INTO v_admin;
  SELECT public.is_super_admin() INTO v_super;
  IF v_admin IS DISTINCT FROM true OR v_super IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SA3 falhou: super_admin livre sem is_admin/is_super_admin=true';
  END IF;
  PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0);
  RAISE NOTICE 'T-SA3 ok: super_admin livre passa (is_admin + is_super_admin)';
END $$;
ROLLBACK;

-- ============ T-SA4 — JWT nunca concede super_admin ============

-- T-SA4a: usuário comum via UPDATE direto do próprio profile.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000004', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'super_admin'
    WHERE id = 'c3000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'T-SA4a falhou: UPDATE direto p/ super_admin passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA4a falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-super-admin' THEN
      RAISE EXCEPTION 'T-SA4a falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;
  IF (SELECT role FROM public.profiles WHERE id = 'c3000000-0000-4000-8000-000000000004') <> 'user' THEN
    RAISE EXCEPTION 'T-SA4a falhou: role mudou apesar do bloqueio';
  END IF;
  RAISE NOTICE 'T-SA4a ok: UPDATE direto negado (not-super-admin), role intacto';
END $$;
ROLLBACK;

-- T-SA4b: super_admin via UPDATE direto e via INSERT direto (nem o dono via JWT).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'super_admin'
    WHERE id = 'c3000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'T-SA4b falhou: super_admin concedeu via UPDATE direto';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA4b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-super-admin' THEN
      RAISE EXCEPTION 'T-SA4b falhou: rótulo errado no UPDATE (%)', SQLERRM;
    END IF;
  END;

  BEGIN
    INSERT INTO public.profiles (id, role) VALUES ('c3000000-0000-4000-8000-000000000003', 'super_admin');
    RAISE EXCEPTION 'T-SA4b falhou: INSERT direto de super_admin passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA4b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-super-admin' THEN
      RAISE EXCEPTION 'T-SA4b falhou: rótulo errado no INSERT (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE 'T-SA4b ok: super_admin JWT não concede super_admin via direto';
END $$;
ROLLBACK;

-- T-SA4c: grant RPC por não-super_admin -> not-super-admin (sem escrita).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000003', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_grant_super_admin('c3000000-0000-4000-8000-000000000005');
    RAISE EXCEPTION 'T-SA4c falhou: não-super_admin concedeu via RPC grant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA4c falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-super-admin' THEN
      RAISE EXCEPTION 'T-SA4c falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;
  IF (SELECT role FROM public.profiles WHERE id = 'c3000000-0000-4000-8000-000000000005') <> 'user' THEN
    RAISE EXCEPTION 'T-SA4c falhou: role do alvo mudou sem grant válido';
  END IF;
  RAISE NOTICE 'T-SA4c ok: grant por não-super_admin -> not-super-admin';
END $$;
ROLLBACK;

-- T-SA4d: super_admin livre concede + revoga via RPC, com trilha audit (ROLLBACK).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_n int;
BEGIN
  PERFORM public.admin_grant_super_admin('c3000000-0000-4000-8000-000000000005');
  IF (SELECT role FROM public.profiles WHERE id = 'c3000000-0000-4000-8000-000000000005') <> 'super_admin' THEN
    RAISE EXCEPTION 'T-SA4d falhou: grant não promoveu o alvo';
  END IF;

  -- Idempotente: segundo grant não duplica a trilha.
  PERFORM public.admin_grant_super_admin('c3000000-0000-4000-8000-000000000005');
  SELECT count(*) INTO v_n FROM public.list_admin_audit_page(
    'c3000000-0000-4000-8000-000000000005', 'grant_super_admin', 20, 0) AS a;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-SA4d falhou: grant_super_admin em duplicata (%)', v_n;
  END IF;

  PERFORM public.admin_revoke_super_admin('c3000000-0000-4000-8000-000000000005');
  IF (SELECT role FROM public.profiles WHERE id = 'c3000000-0000-4000-8000-000000000005') <> 'user' THEN
    RAISE EXCEPTION 'T-SA4d falhou: revoke não rebaixou o alvo';
  END IF;

  SELECT count(*) INTO v_n FROM public.list_admin_audit_page(
    'c3000000-0000-4000-8000-000000000005', 'revoke_super_admin', 20, 0) AS a;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-SA4d falhou: revoke_super_admin ausente na trilha (%)', v_n;
  END IF;

  RAISE NOTICE 'T-SA4d ok: grant/revoke por super_admin + trilha grant/revoke_super_admin';
END $$;
ROLLBACK;

-- ============ T-SA5 — seed travado + complete_first_access libera ============

-- T-SA5a: seed criou o dono travado (estado após db reset; sem senha em mensagem).
DO $$
DECLARE
  v_count int;
  v_role text;
  v_must boolean;
  v_enc text;
BEGIN
  SELECT count(*) INTO v_count FROM auth.users
  WHERE email = 'admin@atlas.test';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T-SA5 falhou: seed admin@atlas.test count=% (esperado 1)', v_count;
  END IF;

  SELECT p.role, p.must_change_password INTO v_role, v_must
  FROM public.profiles AS p
  JOIN auth.users AS u ON u.id = p.id
  WHERE u.email = 'admin@atlas.test';
  IF NOT FOUND OR v_role <> 'super_admin' OR v_must IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SA5 falhou: seed sem super_admin + must_change=true';
  END IF;

  SELECT u.encrypted_password INTO v_enc FROM auth.users AS u
  WHERE u.email = 'admin@atlas.test';
  -- SEC-05 (0051): não existe senha fixa. Só o formato do hash é verificável
  -- sem conhecer o segredo (bcrypt `$2a$`/`$2b$`); nunca imprimir credencial.
  IF v_enc IS NULL OR v_enc = '' OR v_enc NOT LIKE '$2%' THEN
    RAISE EXCEPTION 'T-SA5 falhou: seed sem hash bcrypt válido';
  END IF;

  -- SEC-03 (0051): o seed de DEV provisiona o admin como operador ATIVO.
  IF NOT EXISTS (
    SELECT 1 FROM public.internal_operators AS io
    JOIN auth.users AS u ON u.id = io.user_id
    WHERE u.email = 'admin@atlas.test' AND io.active = true
  ) THEN
    RAISE EXCEPTION 'T-SA5 falhou: seed admin@atlas.test sem operador ativo';
  END IF;

  RAISE NOTICE 'T-SA5 ok: seed admin@atlas.test travado (super_admin + must_change=true + operador ativo)';
END $$;

-- T-SA5b: complete_first_access via service_role (0050 C1) libera o próprio flag
-- e destrava a RPC admin p/ o usuário (ROLLBACK).
BEGIN;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000001","role":"service_role"}', false);

SET LOCAL ROLE service_role;

DO $$
BEGIN
  PERFORM public.complete_first_access();
END $$;

RESET ROLE;

DO $$
BEGIN
  IF (SELECT must_change_password FROM public.profiles WHERE id = 'c3000000-0000-4000-8000-000000000001') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-SA5 falhou: complete_first_access não liberou a flag';
  END IF;
END $$;

-- RPC admin destravada após o complete, agora pelo caminho do cliente.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0);
  RAISE NOTICE 'T-SA5 ok: complete_first_access (service_role) libera e destrava a RPC admin';
END $$;
ROLLBACK;

-- T-SA5c: complete sem flag (já liberado) recusa com rótulo fixo, sem tocar alheio.
BEGIN;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000002","role":"service_role"}', false);

SET LOCAL ROLE service_role;

DO $$
BEGIN
  BEGIN
    PERFORM public.complete_first_access();
    RAISE EXCEPTION 'T-SA5 falhou: complete sem flag true passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-SA5 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-not-required' THEN
      RAISE EXCEPTION 'T-SA5 falhou: rótulo errado p/ complete sem flag (%)', SQLERRM;
    END IF;
  END;
END $$;

RESET ROLE;

DO $$
BEGIN
  -- Flag do outro fixture travado intacta (complete só toca o próprio).
  IF (SELECT must_change_password FROM public.profiles WHERE id = 'c3000000-0000-4000-8000-000000000001') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SA5 falhou: complete alheio liberou flag de outro usuário';
  END IF;
  IF (SELECT must_change_password FROM public.profiles WHERE id = 'c3000000-0000-4000-8000-000000000002') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-SA5 falhou: complete sem flag alterou a flag do chamador';
  END IF;
  RAISE NOTICE 'T-SA5 ok: complete sem flag -> first-access-not-required, alheio intacto';
END $$;
ROLLBACK;

-- ============ Limpeza final (rerun não duplica; seed preservado) ============
DELETE FROM public.admin_audit
WHERE target_id IN (
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  'c3000000-0000-4000-8000-000000000003',
  'c3000000-0000-4000-8000-000000000004',
  'c3000000-0000-4000-8000-000000000005'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  'c3000000-0000-4000-8000-000000000003',
  'c3000000-0000-4000-8000-000000000004',
  'c3000000-0000-4000-8000-000000000005'
);

DELETE FROM auth.users
WHERE id IN (
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  'c3000000-0000-4000-8000-000000000003',
  'c3000000-0000-4000-8000-000000000004',
  'c3000000-0000-4000-8000-000000000005'
);

DO $$
DECLARE v_users int; v_seed int;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users WHERE id IN (
    'c3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000002',
    'c3000000-0000-4000-8000-000000000003',
    'c3000000-0000-4000-8000-000000000004',
    'c3000000-0000-4000-8000-000000000005'
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
