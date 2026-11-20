-- 0049-profiles-first-access-lock.spec.sql — BUGFIX SEC-02 (F-08): grant por
-- coluna em profiles + ramo de primeiro acesso em deny_role_change.
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0049-profiles-first-access-lock.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
-- Prova em banco real (mock não avalia ACL, trigger, DEFINER nem transação):
--   T0 estrutura: authenticated SEM UPDATE de tabela; colunas permitidas
--      full_name/role/subscription_status; must_change_password/id/created_at/
--      updated_at FORA do grant; anon sem coluna; service_role preservado;
--      deny_role_change contém o rótulo profiles-first-access-readonly.
--   T1 dono da linha tenta desligar a própria flag → 42501 (grant negado).
--   T2 full_name continua atualizável pelo dono → permitido.
--   T3 contrato de role preservado: super_admin JWT aal2 esbarra no TRIGGER
--      (not-super-admin), nunca em 42501; a RPC sancionada
--      admin_grant_super_admin() promove normalmente (DEFINER).
--   T4 subscription_status segue recusado com
--      profiles-status-readonly-use-tenant-rpc (não 42501).
--   T5 SUPERSEDED pela 0050 (C1): complete_first_access() chamada como
--      authenticated → 42501 (EXECUTE revogado) e a flag permanece true.
--      Caminho positivo (service_role) e a prova de troca de senha vivem em
--      supabase/tests/0050-first-access-requires-password.sql (T1/T6/T2).
--   T6 seed/DBA e service_role escrevem a flag normalmente.
--   T7 defesa em profundidade: com grant de coluna concedido de propósito,
--      o TRIGGER recusa (profiles-first-access-readonly) fora do GUC
--      app.first_access='on' e aceita com o GUC — prova que o canal
--      sancionado é o GUC setado por complete_first_access().
-- Rerunnable: fixtures (users a649*/b649*/c649*) apagadas no início e no fim;
-- todo estado mutável vive em transação com ROLLBACK.

\set ON_ERROR_STOP on

DELETE FROM public.internal_operators
WHERE user_id IN (
  'a6490000-0000-4000-8000-0000000000a1',
  'b6490000-0000-4000-8000-0000000000b1',
  'c6490000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  'a6490000-0000-4000-8000-0000000000a1',
  'b6490000-0000-4000-8000-0000000000b1',
  'c6490000-0000-4000-8000-0000000000c1'
);

INSERT INTO auth.users (id, email) VALUES
  ('a6490000-0000-4000-8000-0000000000a1', 'sec02-user-0049@example.com'),
  ('b6490000-0000-4000-8000-0000000000b1', 'sec02-operator-0049@example.com'),
  ('c6490000-0000-4000-8000-0000000000c1', 'sec02-target-0049@example.com');

-- Promoção do operador via DBA (current_user = postgres): permitido pelo
-- ramo de role de deny_role_change. Flag de primeiro acesso já nasce false.
UPDATE public.profiles SET role = 'super_admin', must_change_password = false
WHERE id = 'b6490000-0000-4000-8000-0000000000b1';

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
  'a6490000-0000-4000-8000-0000000000a1',
  'b6490000-0000-4000-8000-0000000000b1',
  'c6490000-0000-4000-8000-0000000000c1'
);

-- ============ T0 — estrutura: ACL por coluna + trigger ============

DO $$
DECLARE
  v_body text;
BEGIN
  -- Tabela: UPDATE revogado para os dois papéis de client.
  IF has_table_privilege('authenticated', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: authenticated ainda tem UPDATE de tabela em profiles';
  END IF;
  IF has_table_privilege('anon', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: anon ainda tem UPDATE de tabela em profiles';
  END IF;

  -- Colunas escrevíveis pelo cliente autenticado.
  IF NOT has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: authenticated sem UPDATE(full_name)';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: authenticated sem UPDATE(role) — contrato 0004 rompido';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.profiles', 'subscription_status', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: authenticated sem UPDATE(subscription_status)';
  END IF;

  -- Colunas fora do grant (estado de segurança / imutáveis).
  IF has_column_privilege('authenticated', 'public.profiles', 'must_change_password', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: must_change_password ainda gravável por authenticated';
  END IF;
  IF has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: coluna imutável (id/created_at/updated_at) no grant';
  END IF;

  -- anon não escreve nada.
  IF has_column_privilege('anon', 'public.profiles', 'full_name', 'UPDATE')
     OR has_column_privilege('anon', 'public.profiles', 'must_change_password', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: anon com UPDATE de coluna em profiles';
  END IF;

  -- service_role (server-only) mantém a escrita: seed/Edge precisam da flag.
  IF NOT has_table_privilege('service_role', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION '0049 T0 falhou: service_role perdeu UPDATE em profiles';
  END IF;

  -- Defesa em profundidade presente no corpo do trigger.
  SELECT pg_get_functiondef('public.deny_role_change()'::regprocedure) INTO v_body;
  IF v_body NOT LIKE '%profiles-first-access-readonly%'
     OR v_body NOT LIKE '%app.first_access%' THEN
    RAISE EXCEPTION '0049 T0 falhou: deny_role_change sem ramo de primeiro acesso/GUC';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'deny_role_change'
      AND tgrelid = 'public.profiles'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0049 T0 falhou: trigger deny_role_change ausente em profiles';
  END IF;

  RAISE NOTICE '0049 T0 ok: ACL por coluna (3 permitidas, 4 fora) + trigger endurecido';
END $$;

-- ============ T1 — dono da linha não desliga a própria flag ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6490000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"a6490000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET must_change_password = false
    WHERE id = 'a6490000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION '0049 T1 falhou: desligou a própria flag de primeiro acesso';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '0049 T1 ok: must_change_password=false → 42501 (grant negado)';
  END;

  BEGIN
    UPDATE public.profiles SET must_change_password = true
    WHERE id = 'a6490000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION '0049 T1 falhou: escreveu must_change_password=true';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T2 — full_name continua atualizável pelo dono ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6490000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

DO $$
DECLARE v_name text; v_rows bigint;
BEGIN
  UPDATE public.profiles SET full_name = 'Nome Editado SEC-02'
  WHERE id = 'a6490000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '0049 T2 falhou: UPDATE full_name afetou % linha(s)', v_rows;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles
  WHERE id = 'a6490000-0000-4000-8000-0000000000a1';
  IF v_name <> 'Nome Editado SEC-02' THEN
    RAISE EXCEPTION '0049 T2 falhou: full_name não persistiu (%)', v_name;
  END IF;

  RAISE NOTICE '0049 T2 ok: full_name atualizável (grant por coluna preserva o caminho feliz)';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T3 — contrato de role preservado ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'b6490000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"b6490000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  -- 3a: a coluna role está no grant; quem barra é o trigger, não a ACL.
  BEGIN
    UPDATE public.profiles SET role = 'super_admin'
    WHERE id = 'c6490000-0000-4000-8000-0000000000c1';
    RAISE EXCEPTION '0049 T3 falhou: JWT super_admin promoveu role por UPDATE direto';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0049 T3 falhou: role caiu fora do grant (42501) — contrato 0004 rompido';
    WHEN OTHERS THEN
      IF SQLERRM <> 'not-super-admin' THEN
        RAISE EXCEPTION '0049 T3 falhou: rótulo=% (esperado not-super-admin)', SQLERRM;
      END IF;
  END;

  -- 3b: o caminho sancionado (RPC DEFINER) continua promovendo.
  PERFORM public.admin_grant_super_admin('c6490000-0000-4000-8000-0000000000c1');
  IF (SELECT role FROM public.profiles
      WHERE id = 'c6490000-0000-4000-8000-0000000000c1') <> 'super_admin' THEN
    RAISE EXCEPTION '0049 T3 falhou: admin_grant_super_admin não promoveu';
  END IF;

  -- 3c: rebaixamento pela RPC sancionada.
  PERFORM public.admin_revoke_super_admin('c6490000-0000-4000-8000-0000000000c1');
  IF (SELECT role FROM public.profiles
      WHERE id = 'c6490000-0000-4000-8000-0000000000c1') <> 'user' THEN
    RAISE EXCEPTION '0049 T3 falhou: admin_revoke_super_admin não rebaixou';
  END IF;

  RAISE NOTICE '0049 T3 ok: UPDATE direto de role → not-super-admin (não 42501); RPCs sancionadas promovem/rebaixam';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T4 — subscription_status segue congelado pelo trigger ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6490000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"a6490000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET subscription_status = 'active'
    WHERE id = 'a6490000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION '0049 T4 falhou: alterou subscription_status via client';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION '0049 T4 falhou: rótulo virou 42501 (grant) em vez do freeze 0027';
    WHEN OTHERS THEN
      IF SQLERRM <> 'profiles-status-readonly-use-tenant-rpc' THEN
        RAISE EXCEPTION '0049 T4 falhou: rótulo=% (esperado profiles-status-readonly-use-tenant-rpc)', SQLERRM;
      END IF;
  END;

  IF (SELECT subscription_status FROM public.profiles
      WHERE id = 'a6490000-0000-4000-8000-0000000000a1') <> 'trial' THEN
    RAISE EXCEPTION '0049 T4 falhou: subscription_status mudou após recusa';
  END IF;

  RAISE NOTICE '0049 T4 ok: subscription_status → profiles-status-readonly-use-tenant-rpc';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T5 — complete_first_access() NEGADA ao cliente (0050/C1) ============
-- Histórico (preservado): até a 0050 este bloco provava o caminho positivo —
-- authenticated chamava complete_first_access() e a flag caía. A 0050 (C1)
-- revogou o EXECUTE para authenticated/anon de propósito: a flag só cai com
-- troca real de auth.users.encrypted_password (trigger
-- on_auth_user_password_changed) ou server-side (service_role/DBA). O caminho
-- positivo é coberto por 0050-first-access-requires-password.sql (T1 = 42501,
-- T2/T3 = trigger, T6 = service_role); aqui fica a asserção negativa do
-- contrato atual.

BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'a6490000-0000-4000-8000-0000000000a1';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6490000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"a6490000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.complete_first_access();
    RAISE EXCEPTION '0049 T5 falhou: authenticated executou complete_first_access() (C1/0050 rompido)';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'a6490000-0000-4000-8000-0000000000a1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0049 T5 falhou: flag caiu apesar do 42501';
  END IF;

  RAISE NOTICE '0049 T5 ok: complete_first_access() como authenticated → 42501 (C1/0050) e flag intacta';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T6 — seed/DBA e service_role escrevem a flag ============

BEGIN;
DO $$
BEGIN
  -- 6a: DBA (postgres) — caminho do seed.sql.
  UPDATE public.profiles SET must_change_password = true
  WHERE id = 'c6490000-0000-4000-8000-0000000000c1';
  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'c6490000-0000-4000-8000-0000000000c1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0049 T6 falhou: DBA (seed) não escreveu must_change_password=true';
  END IF;

  UPDATE public.profiles SET must_change_password = false
  WHERE id = 'c6490000-0000-4000-8000-0000000000c1';
  RAISE NOTICE '0049 T6 ok (DBA/seed): flag gravável por postgres';
END $$;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);

DO $$
BEGIN
  UPDATE public.profiles SET must_change_password = true
  WHERE id = 'c6490000-0000-4000-8000-0000000000c1';
  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'c6490000-0000-4000-8000-0000000000c1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0049 T6 falhou: service_role não escreveu a flag';
  END IF;
  RAISE NOTICE '0049 T6 ok (service_role): Edge/provisionamento seguem escrevendo a flag';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T7 — defesa em profundidade: trigger barra fora do GUC ============

BEGIN;
-- Simula regressão de ACL: devolve o grant de coluna só nesta transação.
GRANT UPDATE (must_change_password) ON public.profiles TO authenticated;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a6490000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

DO $$
BEGIN
  -- 7a: sem o GUC, o trigger recusa (barreira independente do grant).
  BEGIN
    UPDATE public.profiles SET must_change_password = true
    WHERE id = 'a6490000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION '0049 T7 falhou: trigger aceitou mudança da flag fora do GUC';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0049 T7 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'profiles-first-access-readonly' THEN
      RAISE EXCEPTION '0049 T7 falhou: rótulo=% (esperado profiles-first-access-readonly)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE '0049 T7 ok: sem GUC o trigger recusa (profiles-first-access-readonly)';
END $$;

-- 7b: com o GUC (canal de complete_first_access), a escrita passa.
SELECT set_config('app.first_access', 'on', true);

DO $$
BEGIN
  UPDATE public.profiles SET must_change_password = true
  WHERE id = 'a6490000-0000-4000-8000-0000000000a1';
  IF (SELECT must_change_password FROM public.profiles
      WHERE id = 'a6490000-0000-4000-8000-0000000000a1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0049 T7 falhou: GUC app.first_access=on não liberou a escrita';
  END IF;
  RAISE NOTICE '0049 T7 ok: GUC app.first_access=on é o canal sancionado';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ Final — estado limpo ============

DO $$
BEGIN
  IF has_column_privilege('authenticated', 'public.profiles', 'must_change_password', 'UPDATE') THEN
    RAISE EXCEPTION '0049 final falhou: grant temporário de T7 sobreviveu ao ROLLBACK';
  END IF;
  RAISE NOTICE '0049 final ok: grant por coluna intacto após os testes';
END $$;

DELETE FROM public.internal_operators
WHERE user_id IN (
  'a6490000-0000-4000-8000-0000000000a1',
  'b6490000-0000-4000-8000-0000000000b1',
  'c6490000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  'a6490000-0000-4000-8000-0000000000a1',
  'b6490000-0000-4000-8000-0000000000b1',
  'c6490000-0000-4000-8000-0000000000c1'
);

\echo '0049-profiles-first-access-lock.spec.sql: OK'
