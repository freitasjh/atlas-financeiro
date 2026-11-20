-- ddl-0004.spec.sql — Teste TDD FIRST (SB-30/SB-31) — Admin policy anti-elevação
-- Uso: supabase db reset && psql $DB_URL -f supabase/tests/ddl-0004.spec.sql
-- Falha (RAISE EXCEPTION) se qualquer invariante ausente.
-- Espelho da seção T15 de supabase/tests/ddl.spec.sql (manter sincronizadas).
-- Invariantes Fase 4 (SPEC §5, ADR-002/ADR-003):
-- is_admin() SECURITY DEFINER + policies SELECT/UPDATE admin + trigger duplo
-- role/status (exceção admin/service_role) + INSERT nunca auto-admin + signup user.

-- T15a: função is_admin existe, SECURITY DEFINER, STABLE
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin') THEN
    RAISE EXCEPTION 'ddl-0004 T15a falhou: function is_admin ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'is_admin' AND prosecdef
  ) THEN
    RAISE EXCEPTION 'ddl-0004 T15a falhou: is_admin sem SECURITY DEFINER (leak RLS)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'is_admin' AND provolatile = 's'
  ) THEN
    RAISE EXCEPTION 'ddl-0004 T15a falhou: is_admin sem STABLE';
  END IF;
  RAISE NOTICE 'ddl-0004 T15a ok: is_admin SECURITY DEFINER STABLE';
END $$;

-- T15b: policies admin SELECT lista + UPDATE status existem
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_select_admin'
  ) THEN
    RAISE EXCEPTION 'ddl-0004 T15b falhou: policy profiles_select_admin ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_update_admin'
  ) THEN
    RAISE EXCEPTION 'ddl-0004 T15b falhou: policy profiles_update_admin ausente';
  END IF;
  RAISE NOTICE 'ddl-0004 T15b ok: policies admin SELECT/UPDATE presentes';
END $$;

-- T15c: trigger deny_role_change existe e guarda role + status com exceção admin
DO $$
DECLARE
  src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'deny_role_change') THEN
    RAISE EXCEPTION 'ddl-0004 T15c falhou: trigger deny_role_change ausente';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'deny_role_change' ORDER BY oid LIMIT 1;
  IF src IS NULL OR src NOT ILIKE '%subscription_status%' THEN
    RAISE EXCEPTION 'ddl-0004 T15c falhou: trigger não guarda subscription_status (só role)';
  END IF;
  IF src NOT ILIKE '%is_admin%' THEN
    RAISE EXCEPTION 'ddl-0004 T15c falhou: trigger sem exceção is_admin (admin travado)';
  END IF;
  RAISE NOTICE 'ddl-0004 T15c ok: trigger duplo role+status com exceção admin';
END $$;

-- T15d: trigger INSERT anti auto-admin existe
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'deny_admin_insert') THEN
    RAISE EXCEPTION 'ddl-0004 T15d falhou: trigger deny_admin_insert ausente';
  END IF;
  RAISE NOTICE 'ddl-0004 T15d ok: INSERT nunca auto-admin';
END $$;

-- T15h: signup força role user (handle_new_user inalterado em comportamento)
DO $$
DECLARE
  src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'handle_new_user' ORDER BY oid LIMIT 1;
  IF src IS NULL OR src NOT ILIKE '%''user''%' THEN
    RAISE EXCEPTION 'ddl-0004 T15h falhou: handle_new_user não força role user';
  END IF;
  RAISE NOTICE 'ddl-0004 T15h ok: signup role user forçado';
END $$;

-- ===== Fixture funcional (user comum + admin + faker sem profile) =====
-- profiles.id tem FK auth.users: inserir auth.users dispara handle_new_user
-- (cria profile user/trial); promoção a admin usa bypass DBA (postgres).
DELETE FROM public.internal_operators
WHERE user_id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);

DELETE FROM auth.users
WHERE id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 't15-user@example.com'),
  ('22222222-2222-2222-2222-222222222222', 't15-super@example.com'),
  ('44444444-4444-4444-4444-444444444444', 't15-faker@example.com');
UPDATE public.profiles SET role = 'super_admin' WHERE id = '22222222-2222-2222-2222-222222222222';
DELETE FROM public.profiles WHERE id = '44444444-4444-4444-4444-444444444444';

-- T15e: auto-elevação role negada (user comum tenta virar super_admin)
-- SEC-03 (0051): o super_admin de fixture precisa de operador ATIVO para o
-- caminho feliz das RPCs admin_* (o gate global em is_super_admin() herdou
-- operator-inactive). Bootstrap de fixture, como o seed de dev.
INSERT INTO public.internal_operators (user_id, active)
SELECT p.id, true FROM public.profiles AS p
WHERE p.role = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
  );

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
DO $$
BEGIN
  UPDATE public.profiles SET role = 'super_admin' WHERE id = '11111111-1111-1111-1111-111111111111';
  RAISE EXCEPTION 'ddl-0004 T15e falhou: auto-elevação role permitida';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%ddl-0004 T15e falhou%' THEN
    RAISE;
  END IF;
  IF SQLERRM <> 'not-super-admin' THEN
    RAISE EXCEPTION 'ddl-0004 T15e falhou: rótulo errado (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'ddl-0004 T15e ok: auto-elevação role negada (%)', SQLERRM;
END $$;

-- T15f: auto-elevação status negada (user comum tenta ativar próprio plano)
DO $$
BEGIN
  UPDATE public.profiles SET subscription_status = 'active' WHERE id = '11111111-1111-1111-1111-111111111111';
  RAISE EXCEPTION 'ddl-0004 T15f falhou: auto-elevação status permitida';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%ddl-0004 T15f falhou%' THEN
    RAISE;
  END IF;
  RAISE NOTICE 'ddl-0004 T15f ok: auto-elevação status negada (%)', SQLERRM;
END $$;

-- T15i: auto-admin por payload negado (INSERT com role super_admin barrado pelo trigger,
-- não só pela RLS: faker usa o próprio id, passando no WITH CHECK auth.uid()=id)
SELECT set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
DO $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role, subscription_status)
  VALUES ('44444444-4444-4444-4444-444444444444', 'T15 Fake', 'super_admin', 'trial');
  RAISE EXCEPTION 'ddl-0004 T15i falhou: INSERT role super_admin permitido';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%ddl-0004 T15i falhou%' THEN
    RAISE;
  END IF;
  IF SQLERRM <> 'not-super-admin' THEN
    RAISE EXCEPTION 'ddl-0004 T15i falhou: negação veio da camada errada (%)', SQLERRM;
  END IF;
  RAISE NOTICE 'ddl-0004 T15i ok: INSERT role super_admin negado pelo trigger';
END $$;

-- T15g (BE-03/0027 freeze): super_admin enxerga outro tenant, mas status via client
-- congela — fonte única é tenants (RPC admin_set_tenant_status). Role via
-- super_admin segue permitida (prova abaixo).
SELECT set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
DO $$
DECLARE
  seen int;
BEGIN
  SELECT count(*) INTO seen FROM public.profiles WHERE id = '11111111-1111-1111-1111-111111111111';
  IF seen <> 1 THEN
    RAISE EXCEPTION 'ddl-0004 T15g falhou: super_admin não enxerga tenant alheio';
  END IF;
  BEGIN
    UPDATE public.profiles SET subscription_status = 'past_due'
    WHERE id = '11111111-1111-1111-1111-111111111111';
    RAISE EXCEPTION 'ddl-0004 T15g falhou: super_admin alterou status via client';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'ddl-0004 T15g falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'profiles-status-readonly-use-tenant-rpc' THEN
        RAISE EXCEPTION 'ddl-0004 T15g falhou: rótulo errado para freeze (%)', SQLERRM;
      END IF;
  END;
  UPDATE public.profiles SET role = 'user', full_name = 'Revisado'
  WHERE id = '11111111-1111-1111-1111-111111111111';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ddl-0004 T15g falhou: super_admin UPDATE role afetou 0 rows';
  END IF;
  RAISE NOTICE 'ddl-0004 T15g ok: super_admin lista alheio; status congela; super_admin UPDATE sem mudanca de role ok';
END $$;

RESET ROLE;
DELETE FROM public.internal_operators
WHERE user_id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);

DELETE FROM auth.users
WHERE id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);
