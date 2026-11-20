-- 0050-first-access-requires-password.spec.sql — BUGFIX C1 + A1 (code review Batch 1).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0050-first-access-requires-password.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
-- Prova em banco real (mock não avalia ACL, trigger em auth.users, DEFINER nem transação):
--   T0 estrutura: trigger on_auth_user_password_changed existe em auth.users com
--      WHEN em encrypted_password; função do trigger é DEFINER + search_path
--      travado e SEM EXECUTE para PUBLIC/anon/authenticated/service_role;
--      complete_first_access() SEM EXECUTE para authenticated/anon e COM para
--      service_role.
--   T1 C1: authenticated chamando complete_first_access() → 42501 (sem EXECUTE).
--   T2 C1: troca real de senha em auth.users (crypt/gen_salt, owner) limpa
--      profiles.must_change_password no mesmo COMMIT.
--   T3 C1: UPDATE em auth.users que não muda encrypted_password (outra coluna,
--      e reescrita do mesmo valor) NÃO limpa a flag.
--   T4 A1: UPDATE único com must_change_password (GUC ligado) E
--      subscription_status → profiles-status-readonly-use-tenant-rpc
--      (fall-through; o ramo 0 não curto-circuita o freeze 0027) e o status
--      não muda.
--   T5 A1: UPDATE único com must_change_password (GUC ligado) E role
--      super_admin por JWT comum → not-super-admin; role não muda.
--   T6 regressão: complete_first_access() via service_role continua limpando a
--      flag (Edge/compat server-side preservado).
-- Rerunnable: fixtures (users a650*/b650*) apagadas no início e no fim; todo
-- estado mutável vive em transação com ROLLBACK.

\set ON_ERROR_STOP on

DELETE FROM auth.users WHERE id IN (
  'a6500000-0000-4000-8000-0000000000a1',
  'b6500000-0000-4000-8000-0000000000b1'
);

INSERT INTO auth.users (id, email) VALUES
  ('a6500000-0000-4000-8000-0000000000a1', 'sec02-first-access-0050@example.com'),
  ('b6500000-0000-4000-8000-0000000000b1', 'sec02-service-0050@example.com');

DELETE FROM public.admin_audit
WHERE target_id IN (
  'a6500000-0000-4000-8000-0000000000a1',
  'b6500000-0000-4000-8000-0000000000b1'
);

-- ============ T0 — estrutura: trigger + ACL das funções ============

DO $$
DECLARE
  v_body text;
  v_tgdef text;
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.clear_first_access_on_password_change()'::regprocedure)
  INTO v_def;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('public.clear_first_access_on_password_change()')
      AND prosecdef
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(proconfig, '{}')) AS c
        WHERE c LIKE 'search_path=%'
          AND (c = 'search_path=' OR c = 'search_path=""')
      )
  ) THEN
    RAISE EXCEPTION '0050 T0 falhou: função do trigger sem SECURITY DEFINER/search_path vazio';
  END IF;

  IF v_def NOT LIKE '%NEW.id%' OR v_def NOT LIKE '%public.profiles%' THEN
    RAISE EXCEPTION '0050 T0 falhou: função do trigger sem referência qualificada a public.profiles';
  END IF;

  -- EXECUTE negado a todos os papéis (ponto de chamada é trigger, não endpoint).
  IF has_function_privilege('authenticated',
       'public.clear_first_access_on_password_change()', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.clear_first_access_on_password_change()', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.clear_first_access_on_password_change()', 'EXECUTE') THEN
    RAISE EXCEPTION '0050 T0 falhou: função do trigger com EXECUTE para client/service_role';
  END IF;

  -- Trigger presente, restrito à coluna encrypted_password, com WHEN de mudança.
  SELECT pg_get_triggerdef(t.oid) INTO v_tgdef
  FROM pg_trigger AS t
  WHERE t.tgname = 'on_auth_user_password_changed'
    AND t.tgrelid = 'auth.users'::regclass
    AND NOT t.tgisinternal;

  IF v_tgdef IS NULL THEN
    RAISE EXCEPTION '0050 T0 falhou: trigger on_auth_user_password_changed ausente em auth.users';
  END IF;
  IF v_tgdef NOT LIKE '%AFTER UPDATE OF encrypted_password%'
     OR v_tgdef NOT LIKE '%IS DISTINCT FROM%' THEN
    RAISE EXCEPTION '0050 T0 falhou: trigger sem UPDATE OF encrypted_password / WHEN distinct';
  END IF;

  -- complete_first_access: cliente fora, server-side dentro.
  IF has_function_privilege('authenticated', 'public.complete_first_access()', 'EXECUTE') THEN
    RAISE EXCEPTION '0050 T0 falhou: authenticated ainda tem EXECUTE em complete_first_access';
  END IF;
  IF has_function_privilege('anon', 'public.complete_first_access()', 'EXECUTE') THEN
    RAISE EXCEPTION '0050 T0 falhou: anon ainda tem EXECUTE em complete_first_access';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_first_access()', 'EXECUTE') THEN
    RAISE EXCEPTION '0050 T0 falhou: service_role perdeu EXECUTE em complete_first_access';
  END IF;

  -- A1: ramo de primeiro acesso sem RETURN NEW antecipado.
  SELECT pg_get_functiondef('public.deny_role_change()'::regprocedure) INTO v_body;
  IF v_body NOT LIKE '%profiles-first-access-readonly%' THEN
    RAISE EXCEPTION '0050 T0 falhou: deny_role_change sem rótulo de primeiro acesso';
  END IF;

  RAISE NOTICE '0050 T0 ok: trigger em auth.users (WHEN encrypted_password) + ACL fechada + ramo A1';
END $$;

-- ============ T1 — authenticated não executa a RPC (C1) ============

BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'a6500000-0000-4000-8000-0000000000a1';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6500000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"a6500000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.complete_first_access();
    RAISE EXCEPTION '0050 T1 falhou: authenticated executou complete_first_access()';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '0050 T1 ok: complete_first_access() como authenticated → 42501';
  END;
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T2 — troca real de senha limpa a flag (C1) ============

BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'a6500000-0000-4000-8000-0000000000a1';

DO $$
BEGIN
  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'a6500000-0000-4000-8000-0000000000a1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0050 T2 falhou: fixture não nasceu travada';
  END IF;

  -- Caminho do `supabase.auth.updateUser({ password })`: só encrypted_password muda.
  UPDATE auth.users
  SET encrypted_password = crypt('nova-senha-trocada', gen_salt('bf'))
  WHERE id = 'a6500000-0000-4000-8000-0000000000a1';

  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'a6500000-0000-4000-8000-0000000000a1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0050 T2 falhou: troca de senha não limpou must_change_password';
  END IF;

  RAISE NOTICE '0050 T2 ok: encrypted_password mudou → flag limpa no mesmo COMMIT';
END $$;
ROLLBACK;

-- ============ T3 — UPDATE sem troca de senha NÃO limpa a flag (C1) ============

BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'a6500000-0000-4000-8000-0000000000a1';

DO $$
BEGIN
  -- 3a: outra coluna qualquer (GoTrue atualiza last_sign_in_at com frequência).
  UPDATE auth.users SET last_sign_in_at = now()
  WHERE id = 'a6500000-0000-4000-8000-0000000000a1';

  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'a6500000-0000-4000-8000-0000000000a1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0050 T3 falhou: UPDATE de last_sign_in_at limpou a flag';
  END IF;

  -- 3b: encrypted_password no statement, mas com o MESMO valor (WHEN falso).
  UPDATE auth.users SET encrypted_password = encrypted_password
  WHERE id = 'a6500000-0000-4000-8000-0000000000a1';

  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'a6500000-0000-4000-8000-0000000000a1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0050 T3 falhou: reescrita do mesmo hash limpou a flag';
  END IF;

  RAISE NOTICE '0050 T3 ok: sem troca real de senha a flag permanece travada';
END $$;
ROLLBACK;

-- ============ T4 — A1: flag + subscription_status no mesmo UPDATE ============

BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'a6500000-0000-4000-8000-0000000000a1';

-- Grant de coluna devolvido só nesta transação: sem ele a ACL barra antes e o
-- fall-through nunca é exercitado (42501 mascararia o teste do ramo).
GRANT UPDATE (must_change_password) ON public.profiles TO authenticated;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6500000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"a6500000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);
SELECT set_config('app.first_access', 'on', true);

DO $$
BEGIN
  BEGIN
    UPDATE public.profiles
    SET must_change_password = false, subscription_status = 'active'
    WHERE id = 'a6500000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION '0050 T4 falhou: UPDATE combinado escapou do freeze de status (A1)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0050 T4 falhou: 42501 em vez do rótulo do freeze — grant temporário não aplicou';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0050 T4 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'profiles-status-readonly-use-tenant-rpc' THEN
        RAISE EXCEPTION '0050 T4 falhou: rótulo=% (esperado profiles-status-readonly-use-tenant-rpc)', SQLERRM;
      END IF;
  END;

  IF (SELECT subscription_status FROM public.profiles
      WHERE id = 'a6500000-0000-4000-8000-0000000000a1') <> 'trial' THEN
    RAISE EXCEPTION '0050 T4 falhou: subscription_status mudou apesar da recusa';
  END IF;

  RAISE NOTICE '0050 T4 ok: fall-through mantém o freeze 0027 (profiles-status-readonly-use-tenant-rpc)';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T5 — A1: flag + role super_admin no mesmo UPDATE ============

BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'a6500000-0000-4000-8000-0000000000a1';

GRANT UPDATE (must_change_password) ON public.profiles TO authenticated;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6500000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"a6500000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);
SELECT set_config('app.first_access', 'on', true);

DO $$
BEGIN
  BEGIN
    UPDATE public.profiles
    SET must_change_password = false, role = 'super_admin'
    WHERE id = 'a6500000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION '0050 T5 falhou: UPDATE combinado promoveu role (A1)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0050 T5 falhou: 42501 em vez do rótulo de role — grant temporário não aplicou';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0050 T5 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-super-admin' THEN
        RAISE EXCEPTION '0050 T5 falhou: rótulo=% (esperado not-super-admin)', SQLERRM;
      END IF;
  END;

  IF (SELECT role FROM public.profiles
      WHERE id = 'a6500000-0000-4000-8000-0000000000a1') <> 'user' THEN
    RAISE EXCEPTION '0050 T5 falhou: role mudou apesar da recusa';
  END IF;

  RAISE NOTICE '0050 T5 ok: fall-through mantém a trava de role (not-super-admin)';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T6 — service_role continua limpando a flag (regressão) ============

BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'b6500000-0000-4000-8000-0000000000b1';

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'b6500000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"b6500000-0000-4000-8000-0000000000b1","role":"service_role"}', false);

DO $$
BEGIN
  PERFORM public.complete_first_access();

  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'b6500000-0000-4000-8000-0000000000b1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0050 T6 falhou: service_role não limpou a flag';
  END IF;

  RAISE NOTICE '0050 T6 ok: complete_first_access() segue disponível para service_role';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ Final — grant temporário não vazou ============

DO $$
BEGIN
  IF has_column_privilege('authenticated', 'public.profiles', 'must_change_password', 'UPDATE') THEN
    RAISE EXCEPTION '0050 final falhou: grant temporário de T4/T5 sobreviveu ao ROLLBACK';
  END IF;
  RAISE NOTICE '0050 final ok: ACL por coluna intacta';
END $$;

DELETE FROM auth.users WHERE id IN (
  'a6500000-0000-4000-8000-0000000000a1',
  'b6500000-0000-4000-8000-0000000000b1'
);

\echo '0050-first-access-requires-password.spec.sql: OK'
