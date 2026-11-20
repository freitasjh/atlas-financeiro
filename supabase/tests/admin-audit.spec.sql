-- admin-audit.spec.sql — Frente A / A-AUDIT (0019_admin_audit.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/admin-audit.spec.sql
-- Rerunnable: as fixtures são apagadas no início.
--
-- Prova, no banco real (não em mock):
--   T00 estrutura: tabela, RLS sem policy, 2 índices, 1 trigger SECURITY DEFINER
--   T01 super_admin promove tenant via RPC → 1 linha grant_super_admin (user→super_admin)
--   T02 admin muda subscription_status → 1 linha change_plan (trial→active)
--   T03 UPDATE de full_name pelo próprio usuário → 0 linha nova
--   T04 authenticated: SELECT/INSERT/UPDATE/DELETE negados (SET ROLE + ROLLBACK)
--   T05 service_role lê; não escreve
--   T06 reexecução não duplica trigger (contagem continua 1)
--   T07 ACL endurecida (0020): sem EXECUTE na função; service_role só SELECT
--       em admin_audit (sem INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER)
--   T08 trigger continua gravando após o REVOKE da função (0020)
--
-- Nenhuma mensagem de falha carrega ids (SEC-G3).

\set ON_ERROR_STOP on

-- ============ Fixtures (como postgres: RLS bypass, DBA permitido) ============

DELETE FROM public.admin_audit
WHERE target_id IN (
  'aa190000-0000-4000-8000-0000000000a1',
  'aa190000-0000-4000-8000-0000000000b1',
  'aa190000-0000-4000-8000-0000000000c1'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'aa190000-0000-4000-8000-0000000000a1',
  'aa190000-0000-4000-8000-0000000000b1',
  'aa190000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  'aa190000-0000-4000-8000-0000000000a1',
  'aa190000-0000-4000-8000-0000000000b1',
  'aa190000-0000-4000-8000-0000000000c1'
);

INSERT INTO auth.users (id, email) VALUES
  ('aa190000-0000-4000-8000-0000000000a1', 'audit-super@example.com'),
  ('aa190000-0000-4000-8000-0000000000b1', 'audit-user1@example.com'),
  ('aa190000-0000-4000-8000-0000000000c1', 'audit-user2@example.com');

-- Promoção do ator via DBA (current_user = postgres) — gera linha de auditoria
-- do setup; a trilha é zerada em seguida para as contagens dos testes.
-- (0035: 'super_admin' — o 'admin' legado não existe; a trilha de promoção é
-- grant_super_admin e o histórico grant_admin segue só como leitura.)
UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'aa190000-0000-4000-8000-0000000000a1';

-- SEC-03 (0051): o super_admin de fixture precisa de operador ATIVO para o
-- caminho feliz das RPCs admin_* (o gate global em is_super_admin() herdou
-- operator-inactive). Bootstrap de fixture, como o seed de dev.
INSERT INTO public.internal_operators (user_id, active)
SELECT p.id, true FROM public.profiles AS p
WHERE p.role = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
  );

DELETE FROM public.admin_audit;

-- ============ T00 — estrutura ============

DO $$
DECLARE
  v_rls boolean;
  v_policies int;
  v_triggers int;
  v_definer boolean;
  v_search_path text[];
  v_idx int;
BEGIN
  IF to_regclass('public.admin_audit') IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: tabela admin_audit ausente';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.admin_audit'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RLS desligada em admin_audit';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_audit';
  IF v_policies <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: admin_audit com policy para client';
  END IF;

  SELECT count(*) INTO v_triggers
  FROM pg_trigger
  WHERE tgrelid = 'public.profiles'::regclass
    AND tgname = 'profiles_admin_audit'
    AND NOT tgisinternal;
  IF v_triggers <> 1 THEN
    RAISE EXCEPTION 'T00 falhou: trigger profiles_admin_audit ausente/duplicado';
  END IF;

  SELECT p.prosecdef, p.proconfig INTO v_definer, v_search_path
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'profiles_admin_audit_fn';
  IF v_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: profiles_admin_audit_fn sem SECURITY DEFINER';
  END IF;
  IF v_search_path IS NULL
    OR NOT ('search_path=public' = ANY (v_search_path)) THEN
    RAISE EXCEPTION 'T00 falhou: profiles_admin_audit_fn sem search_path fixo';
  END IF;

  SELECT count(*) INTO v_idx
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'admin_audit'
    AND indexname IN ('idx_admin_audit_target_at', 'idx_admin_audit_actor_at');
  IF v_idx <> 2 THEN
    RAISE EXCEPTION 'T00 falhou: índices de auditoria ausentes';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.admin_audit', 'SELECT') THEN
    RAISE EXCEPTION 'T00 falhou: service_role sem SELECT em admin_audit';
  END IF;

  RAISE NOTICE 'T00 ok: tabela + RLS sem policy + trigger SECURITY DEFINER + índices';
END $$;

-- ============ T01 — super_admin promove tenant via RPC → grant_super_admin ============
-- (0035: JWT direto user→super_admin é negado pelo trigger (not-super-admin);
-- a promoção viva passa pela RPC auditada admin_grant_super_admin, que grava a
-- trilha no mesmo COMMIT — o que T01 prova.)

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa190000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

SELECT public.admin_grant_super_admin('aa190000-0000-4000-8000-0000000000b1');

RESET ROLE;

DO $$
DECLARE
  r public.admin_audit;
BEGIN
  SELECT * INTO r FROM public.admin_audit
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000b1'
  ORDER BY at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'T01 falhou: promoção a super_admin sem linha de auditoria';
  END IF;
  IF r.action <> 'grant_super_admin' THEN
    RAISE EXCEPTION 'T01 falhou: action incorreta (%)', r.action;
  END IF;
  IF r.from_value <> 'user' OR r.to_value <> 'super_admin' THEN
    RAISE EXCEPTION 'T01 falhou: transição registrada errada (%→%)', r.from_value, r.to_value;
  END IF;
  IF r.actor_id IS DISTINCT FROM 'aa190000-0000-4000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION 'T01 falhou: actor_id não é quem executou';
  END IF;

  RAISE NOTICE 'T01 ok: grant_super_admin user→super_admin por ator JWT';
END $$;

-- ============ T02 — freeze BE-03: super_admin JWT não muda subscription_status ============
-- Fonte única é tenants (RPC admin_set_tenant_status); a prova de trilha
-- change_plan migra para o escape DBA (T02b). O JWT recebe rótulo fixo.

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa190000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

DO $$
BEGIN
  UPDATE public.profiles SET subscription_status = 'active'
  WHERE id = 'aa190000-0000-4000-8000-0000000000c1';
  RAISE EXCEPTION 'T02 falhou: super_admin JWT alterou status via client';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T02 falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'profiles-status-readonly-use-tenant-rpc' THEN
      RAISE EXCEPTION 'T02 falhou: rótulo errado para freeze (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T02 ok: profiles-status-readonly-use-tenant-rpc sem trilha';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_audit
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000c1';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T02 falhou: chamada bloqueada gerou trilha';
  END IF;
END $$;

-- ============ T02b — escape DBA grava change_plan trial→active ============

UPDATE public.profiles SET subscription_status = 'active'
WHERE id = 'aa190000-0000-4000-8000-0000000000c1';

DO $$
DECLARE
  r public.admin_audit;
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_audit
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000c1';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T02b falhou: esperava 1 linha para a mudança de plano';
  END IF;

  SELECT * INTO r FROM public.admin_audit
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000c1'
  ORDER BY at DESC
  LIMIT 1;

  IF r.action <> 'change_plan' THEN
    RAISE EXCEPTION 'T02b falhou: action incorreta (%)', r.action;
  END IF;
  IF r.from_value <> 'trial' OR r.to_value <> 'active' THEN
    RAISE EXCEPTION 'T02b falhou: transição registrada errada (%→%)', r.from_value, r.to_value;
  END IF;

  RAISE NOTICE 'T02b ok: change_plan trial→active via DBA';
END $$;

-- ============ T03 — UPDATE de full_name não audita ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa190000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

DO $$
DECLARE
  v_rows int;
BEGIN
  UPDATE public.profiles SET full_name = 'Nome Editado'
  WHERE id = 'aa190000-0000-4000-8000-0000000000c1';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'T03 falhou: update de full_name não aplicou';
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_audit
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000c1';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T03 falhou: UPDATE de full_name gerou linha de auditoria';
  END IF;

  RAISE NOTICE 'T03 ok: UPDATE de full_name não audita';
END $$;

-- ============ T04 — authenticated não lê nem escreve ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa190000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);

DO $$
BEGIN
  PERFORM 1 FROM public.admin_audit LIMIT 1;
  RAISE EXCEPTION 'T04a falhou: authenticated conseguiu SELECT em admin_audit';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T04a ok: SELECT negado a authenticated';
END $$;

DO $$
BEGIN
  INSERT INTO public.admin_audit (target_id, action)
  VALUES ('aa190000-0000-4000-8000-0000000000c1', 'other');
  RAISE EXCEPTION 'T04b falhou: authenticated conseguiu INSERT em admin_audit';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T04b ok: INSERT negado a authenticated';
END $$;

DO $$
BEGIN
  UPDATE public.admin_audit SET action = 'other'
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000c1';
  RAISE EXCEPTION 'T04c falhou: authenticated conseguiu UPDATE em admin_audit';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T04c ok: UPDATE negado a authenticated';
END $$;

DO $$
BEGIN
  DELETE FROM public.admin_audit
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000c1';
  RAISE EXCEPTION 'T04d falhou: authenticated conseguiu DELETE em admin_audit';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T04d ok: DELETE negado a authenticated';
END $$;

ROLLBACK;

-- ============ T05 — service_role lê, não escreve ============

BEGIN;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_audit;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'T05 falhou: service_role não lê a trilha';
  END IF;
  RAISE NOTICE 'T05a ok: service_role lê a trilha (% linhas)', v_count;
END $$;

DO $$
BEGIN
  INSERT INTO public.admin_audit (target_id, action)
  VALUES ('aa190000-0000-4000-8000-0000000000c1', 'other');
  RAISE EXCEPTION 'T05b falhou: service_role conseguiu INSERT em admin_audit';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T05b ok: INSERT negado a service_role';
END $$;

ROLLBACK;

-- ============ T06 — reexecução não duplica trigger ============

DO $$
DECLARE
  v_triggers int;
BEGIN
  SELECT count(*) INTO v_triggers
  FROM pg_trigger
  WHERE tgrelid = 'public.profiles'::regclass
    AND tgname = 'profiles_admin_audit'
    AND NOT tgisinternal;
  IF v_triggers <> 1 THEN
    RAISE EXCEPTION 'T06 falhou: trigger duplicado após reexecução';
  END IF;

  RAISE NOTICE 'T06 ok: exatamente 1 trigger profiles_admin_audit';
END $$;

-- ============ T07 — ACL endurecida (0020) ============

DO $$
DECLARE
  v_priv text;
BEGIN
  FOREACH v_priv IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_priv, 'public.profiles_admin_audit_fn()', 'EXECUTE') THEN
      RAISE EXCEPTION 'T07 falhou: % ainda tem EXECUTE em profiles_admin_audit_fn', v_priv;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('service_role', 'public.admin_audit', 'SELECT') THEN
    RAISE EXCEPTION 'T07 falhou: service_role sem SELECT em admin_audit';
  END IF;

  FOREACH v_priv IN ARRAY ARRAY[
    'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ] LOOP
    IF has_table_privilege('service_role', 'public.admin_audit', v_priv) THEN
      RAISE EXCEPTION 'T07 falhou: service_role mantém % em admin_audit', v_priv;
    END IF;
  END LOOP;

  RAISE NOTICE 'T07 ok: função sem EXECUTE para clients; service_role só SELECT';
END $$;

-- ============ T08 — trigger continua gravando após o REVOKE ============
-- O disparo de trigger não checa EXECUTE: a função SECURITY DEFINER roda como o
-- owner da tabela. Escape DBA (freeze BE-03 bloqueia JWT); a auditoria segue
-- gravando. Se parar aqui, o endurecimento quebrou o produto.

UPDATE public.profiles SET subscription_status = 'canceled'
WHERE id = 'aa190000-0000-4000-8000-0000000000c1';

DO $$
DECLARE
  r public.admin_audit;
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_audit
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000c1';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'T08 falhou: trigger parou de gravar após o REVOKE (esperava 2 linhas, achou %)', v_count;
  END IF;

  SELECT * INTO r FROM public.admin_audit
  WHERE target_id = 'aa190000-0000-4000-8000-0000000000c1'
  ORDER BY at DESC
  LIMIT 1;
  IF r.action <> 'change_plan' OR r.from_value <> 'active' OR r.to_value <> 'canceled' THEN
    RAISE EXCEPTION 'T08 falhou: transição registrada errada (% %→%)', r.action, r.from_value, r.to_value;
  END IF;

  RAISE NOTICE 'T08 ok: auditoria continua gravando com a ACL endurecida';
END $$;

-- ============ Cleanup ============

DELETE FROM public.admin_audit
WHERE target_id IN (
  'aa190000-0000-4000-8000-0000000000a1',
  'aa190000-0000-4000-8000-0000000000b1',
  'aa190000-0000-4000-8000-0000000000c1'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'aa190000-0000-4000-8000-0000000000a1',
  'aa190000-0000-4000-8000-0000000000b1',
  'aa190000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  'aa190000-0000-4000-8000-0000000000a1',
  'aa190000-0000-4000-8000-0000000000b1',
  'aa190000-0000-4000-8000-0000000000c1'
);
