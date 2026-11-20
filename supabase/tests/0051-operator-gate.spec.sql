-- 0051-operator-gate.spec.sql — bugfix security-p1-hardening / SEC-03 (F-13).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0051-operator-gate.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
-- Prova em banco real (mock não avalia SECURITY DEFINER, search_path, trigger,
-- auth.uid()/claims nem transação):
--   T00 estrutura: is_super_admin() cita private.is_internal_operator() e o
--      rótulo operator-inactive, search_path='' travado; is_admin() delega;
--      trigger internal_operators_audit presente (AFTER INSERT OR UPDATE OF
--      active) com função DEFINER/search_path='' e EXECUTE revogado; CHECK
--      admin_audit_action_check aceita 'other'.
--   T00b auditoria: INSERT operador → admin_audit reason=operator_provisioned;
--      UPDATE active=true → operator_activated; UPDATE active=false →
--      operator_deactivated; UPDATE sem mudar active → sem linha nova.
--   T01 super_admin aal2 SEM linha → operator-inactive.
--   T02 super_admin aal2 com linha active=false → operator-inactive.
--   T03 super_admin aal2 com linha active=true → is_super_admin=true e
--      admin_list_tenants/admin_count_tenants passam.
--   T04 super_admin com linha ativa em aal1 → mfa-required (ordem antes do
--      operator gate).
--   T05 must_change_password=true + aal2 + ativo →
--      first-access-password-change-required (ordem).
--   T06 user comum (sem linha, aal1) → false SEM raise (RLS de membro intacta).
--   T07 anon → false (sem raise, sem leak).
--   T08 claim role='service_role': operador inativo → operator-inactive;
--      ativo → true.
--   T09 operador ativo concede super_admin a alvo sem linha; o alvo, aal2,
--      continua operator-inactive (role ≠ provisionamento).
--   T10 operador inativo chama admin_grant_super_admin/admin_set_tenant_status
--      → operator-inactive e ZERO escrita (role do alvo e trilha inalterados),
--      provada DENTRO da transação (RESET ROLE antes do ROLLBACK).
--   T-GUARD guarda de deploy da 0051: super_admin sem operador ativo →
--      operator-bootstrap-required; com operador ativo → passa; reaplicação
--      integral do arquivo da migration na mesma transação → sem erro.
-- Erros por rótulo fixo, sem PII.
-- Rerunnable: fixtures (users f751*) apagadas no início e no fim; a linha
-- internal_operators precisa sair ANTES de auth.users (ON DELETE RESTRICT,
-- 0041). Estado mutável dos cenários vive em transação com ROLLBACK.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
DELETE FROM public.admin_audit
WHERE target_id IN (
  'f7510000-0000-4000-8000-0000000000a1',
  'f7510000-0000-4000-8000-0000000000b1',
  'f7510000-0000-4000-8000-0000000000c1',
  'f7510000-0000-4000-8000-0000000000d1',
  'f7510000-0000-4000-8000-0000000000e1'
);

-- 0041: internal_operators.user_id é ON DELETE RESTRICT → operador sai primeiro.
DELETE FROM public.internal_operators
WHERE user_id IN (
  'f7510000-0000-4000-8000-0000000000a1',
  'f7510000-0000-4000-8000-0000000000b1',
  'f7510000-0000-4000-8000-0000000000c1',
  'f7510000-0000-4000-8000-0000000000d1',
  'f7510000-0000-4000-8000-0000000000e1'
);

DELETE FROM auth.users
WHERE id IN (
  'f7510000-0000-4000-8000-0000000000a1',
  'f7510000-0000-4000-8000-0000000000b1',
  'f7510000-0000-4000-8000-0000000000c1',
  'f7510000-0000-4000-8000-0000000000d1',
  'f7510000-0000-4000-8000-0000000000e1'
);

INSERT INTO auth.users (id, email) VALUES
  ('f7510000-0000-4000-8000-0000000000a1', 'op-active-0051@example.com'),
  ('f7510000-0000-4000-8000-0000000000b1', 'op-norow-0051@example.com'),
  ('f7510000-0000-4000-8000-0000000000c1', 'op-inactive-0051@example.com'),
  ('f7510000-0000-4000-8000-0000000000d1', 'op-common-0051@example.com'),
  ('f7510000-0000-4000-8000-0000000000e1', 'op-target-0051@example.com');

-- Promoção via DBA (current_user=postgres; trilha apagada para as contagens).
UPDATE public.profiles SET role = 'super_admin'
WHERE id IN (
  'f7510000-0000-4000-8000-0000000000a1',
  'f7510000-0000-4000-8000-0000000000b1',
  'f7510000-0000-4000-8000-0000000000c1'
);

-- a1 = ativo; b1 = SEM linha; c1 = inativo; d1 = user comum; e1 = user alvo.
INSERT INTO public.internal_operators (user_id, active) VALUES
  ('f7510000-0000-4000-8000-0000000000a1', true),
  ('f7510000-0000-4000-8000-0000000000c1', false);

DELETE FROM public.admin_audit
WHERE target_id IN (
  'f7510000-0000-4000-8000-0000000000a1',
  'f7510000-0000-4000-8000-0000000000b1',
  'f7510000-0000-4000-8000-0000000000c1',
  'f7510000-0000-4000-8000-0000000000d1',
  'f7510000-0000-4000-8000-0000000000e1'
);

-- ============ T00 — estrutura ============

DO $$
DECLARE
  v_src text;
  v_proc pg_proc;
  v_tgdef text;
  v_def text;
BEGIN
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE oid = to_regprocedure('public.is_super_admin()');
  SELECT * INTO v_proc
  FROM pg_proc WHERE oid = to_regprocedure('public.is_super_admin()');
  IF v_src IS NULL THEN
    RAISE EXCEPTION '0051 T00 falhou: is_super_admin() ausente';
  END IF;
  IF position('is_internal_operator' IN v_src) = 0 THEN
    RAISE EXCEPTION '0051 T00 falhou: is_super_admin() não chama is_internal_operator()';
  END IF;
  IF v_src NOT LIKE '%operator-inactive%' THEN
    RAISE EXCEPTION '0051 T00 falhou: is_super_admin() sem rótulo operator-inactive';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true OR v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION '0051 T00 falhou: is_super_admin() sem DEFINER/STABLE';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0051 T00 falhou: is_super_admin() sem search_path='' travado';
  END IF;

  -- is_admin() continua alias estrito (herda o gate por transitividade).
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.is_admin()');
  IF v_src IS NULL OR position('is_super_admin' IN v_src) = 0 THEN
    RAISE EXCEPTION '0051 T00 falhou: is_admin() não delega a is_super_admin()';
  END IF;

  -- Trigger de auditoria + função do trigger.
  SELECT * INTO v_proc FROM pg_proc
  WHERE oid = to_regprocedure('public.internal_operators_audit_fn()');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0051 T00 falhou: internal_operators_audit_fn() ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true OR v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0051 T00 falhou: função de auditoria sem DEFINER/search_path vazio';
  END IF;
  IF has_function_privilege('authenticated',
       'public.internal_operators_audit_fn()', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.internal_operators_audit_fn()', 'EXECUTE') THEN
    RAISE EXCEPTION '0051 T00 falhou: função de auditoria com EXECUTE para client';
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_tgdef
  FROM pg_trigger AS t
  WHERE t.tgname = 'internal_operators_audit'
    AND t.tgrelid = 'public.internal_operators'::regclass
    AND NOT t.tgisinternal;
  IF v_tgdef IS NULL
     OR v_tgdef NOT LIKE '%AFTER INSERT OR UPDATE OF active%' THEN
    RAISE EXCEPTION '0051 T00 falhou: trigger internal_operators_audit ausente/errado';
  END IF;

  -- A constraint existente aceita 'other' (nenhuma ação nova inventada).
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'admin_audit_action_check'
    AND conrelid = 'public.admin_audit'::regclass;
  IF v_def IS NULL OR v_def NOT LIKE '%''other''%' THEN
    RAISE EXCEPTION '0051 T00 falhou: admin_audit_action_check sem other (%)', v_def;
  END IF;

  RAISE NOTICE '0051 T00 ok: gate global + search_path vazio + trigger de auditoria + other no CHECK';
END $$;

-- ============ T00b — auditoria de provisionamento/ativação (ROLLBACK) ============
BEGIN;
DO $$
DECLARE
  v_n int;
  v_from text;
  v_to text;
BEGIN
  INSERT INTO public.internal_operators (user_id, active)
  VALUES ('f7510000-0000-4000-8000-0000000000e1', false);

  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE target_id = 'f7510000-0000-4000-8000-0000000000e1'
    AND reason = 'operator_provisioned';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0051 T00b falhou: provisionamento sem 1 trilha (%)', v_n;
  END IF;

  UPDATE public.internal_operators SET active = true
  WHERE user_id = 'f7510000-0000-4000-8000-0000000000e1';
  SELECT count(*), min(from_value), min(to_value) INTO v_n, v_from, v_to
  FROM public.admin_audit
  WHERE target_id = 'f7510000-0000-4000-8000-0000000000e1'
    AND reason = 'operator_activated';
  IF v_n <> 1 OR v_from IS DISTINCT FROM 'false' OR v_to IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '0051 T00b falhou: ativação sem trilha correta (%,%,%)', v_n, v_from, v_to;
  END IF;

  UPDATE public.internal_operators SET active = false
  WHERE user_id = 'f7510000-0000-4000-8000-0000000000e1';
  SELECT count(*), min(from_value), min(to_value) INTO v_n, v_from, v_to
  FROM public.admin_audit
  WHERE target_id = 'f7510000-0000-4000-8000-0000000000e1'
    AND reason = 'operator_deactivated';
  IF v_n <> 1 OR v_from IS DISTINCT FROM 'true' OR v_to IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION '0051 T00b falhou: desativação sem trilha correta (%,%,%)', v_n, v_from, v_to;
  END IF;

  -- UPDATE OF active com valor igual: nenhuma trilha nova.
  UPDATE public.internal_operators SET active = false
  WHERE user_id = 'f7510000-0000-4000-8000-0000000000e1';
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE target_id = 'f7510000-0000-4000-8000-0000000000e1';
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0051 T00b falhou: no-op gerou trilha extra (%)', v_n;
  END IF;

  RAISE NOTICE '0051 T00b ok: provisioned/activated/deactivated + no-op sem trilha';
END $$;
ROLLBACK;

-- ============ T01 — super_admin aal2 SEM linha → operator-inactive ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION '0051 T01 falhou: sem linha passou em is_super_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T01 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'operator-inactive' THEN
      RAISE EXCEPTION '0051 T01 falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0051 T01 ok: sem linha → operator-inactive';
END $$;
ROLLBACK;

-- ============ T02 — linha active=false → operator-inactive ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION '0051 T02 falhou: operador inativo passou em is_super_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T02 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'operator-inactive' THEN
      RAISE EXCEPTION '0051 T02 falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0);
    RAISE EXCEPTION '0051 T02 falhou: inativo passou em admin_list_tenants';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T02 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'operator-inactive' THEN
      RAISE EXCEPTION '0051 T02 falhou: rótulo errado na RPC (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0051 T02 ok: active=false → operator-inactive (gate + RPC)';
END $$;
ROLLBACK;

-- ============ T03 — ativo + aal2 passa (RPC admin_* incluída) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_super boolean;
  v_rows int;
  v_count bigint;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF v_super IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0051 T03 falhou: operador ativo aal2 sem is_super_admin=true';
  END IF;
  SELECT count(*) INTO v_rows
  FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0);
  SELECT public.admin_count_tenants(NULL, NULL) INTO v_count;
  IF v_rows IS NULL OR v_count IS NULL THEN
    RAISE EXCEPTION '0051 T03 falhou: RPC admin sem retorno';
  END IF;
  RAISE NOTICE '0051 T03 ok: ativo + aal2 → true; admin_list_tenants/count passam';
END $$;
ROLLBACK;

-- ============ T04 — aal1 + ativo → mfa-required (antes do operador) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION '0051 T04 falhou: aal1 passou em is_super_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T04 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-required' THEN
      RAISE EXCEPTION '0051 T04 falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0051 T04 ok: aal1 → mfa-required (mfa antes de operator-inactive)';
END $$;
ROLLBACK;

-- ============ T05 — first-access antes de tudo ============
BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'f7510000-0000-4000-8000-0000000000a1';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION '0051 T05 falhou: travado passou em is_super_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T05 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-password-change-required' THEN
      RAISE EXCEPTION '0051 T05 falhou: rótulo errado (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0051 T05 ok: must_change → first-access-password-change-required';
END $$;
ROLLBACK;

-- ============ T06 — user comum → false sem raise ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000d1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000d1","role":"authenticated","aal":"aal1"}', false);

DO $$
DECLARE v_super boolean; v_admin boolean;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  SELECT public.is_admin() INTO v_admin;
  IF v_super IS DISTINCT FROM false OR v_admin IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0051 T06 falhou: user comum não retornou false';
  END IF;
  RAISE NOTICE '0051 T06 ok: user comum → false sem raise (RLS de membro intacta)';
END $$;
ROLLBACK;

-- ============ T07 — anon → false ============
SET ROLE anon;
DO $$
DECLARE v_super boolean;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF v_super IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0051 T07 falhou: anon não retornou false';
  END IF;
  RAISE NOTICE '0051 T07 ok: anon → false sem raise';
END $$;
RESET ROLE;

-- ============ T08 — claim service_role respeita o operador ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000c1","role":"service_role"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION '0051 T08 falhou: service_role inativo passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T08 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'operator-inactive' THEN
      RAISE EXCEPTION '0051 T08 falhou: rótulo errado p/ inativo (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0051 T08 ok: service_role inativo → operator-inactive';
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000a1","role":"service_role"}', false);

DO $$
DECLARE v_super boolean;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF v_super IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0051 T08 falhou: service_role ativo não passou (%)', v_super;
  END IF;
  RAISE NOTICE '0051 T08 ok: service_role ativo → true (isenção aal2 preservada)';
END $$;
ROLLBACK;

-- ============ T09 — conceder role ≠ ativar operador ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_role text;
BEGIN
  PERFORM public.admin_grant_super_admin('f7510000-0000-4000-8000-0000000000e1');
  SELECT p.role INTO v_role FROM public.profiles AS p
  WHERE p.id = 'f7510000-0000-4000-8000-0000000000e1';
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION '0051 T09 falhou: alvo não foi promovido (%)', v_role;
  END IF;
END $$;

-- O alvo promovido, agora aal2, continua sem linha → operator-inactive.
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000e1', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION '0051 T09 falhou: alvo promovido sem operador passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T09 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'operator-inactive' THEN
      RAISE EXCEPTION '0051 T09 falhou: rótulo errado no alvo (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0051 T09 ok: grant de role não provisiona operador (alvo operator-inactive)';
END $$;
ROLLBACK;

-- ============ T10 — operador inativo não escreve ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7510000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"f7510000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_grant_super_admin('f7510000-0000-4000-8000-0000000000e1');
    RAISE EXCEPTION '0051 T10 falhou: inativo executou admin_grant_super_admin';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T10 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'operator-inactive' THEN
      RAISE EXCEPTION '0051 T10 falhou: rótulo errado no grant (%)', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.admin_set_tenant_status(
      'f7510000-0000-4000-8000-0000000000ff', 'active', NULL, 'audit-probe');
    RAISE EXCEPTION '0051 T10 falhou: inativo executou admin_set_tenant_status';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL; -- 0058: EXECUTE revogado de authenticated (42501 antes do gate)
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0051 T10 falhou%' THEN RAISE; END IF;
      RAISE EXCEPTION '0051 T10 falhou: erro diferente de 42501 no status deprecado (%)', SQLERRM;
  END;
END $$;

-- Prova de zero escrita DENTRO da transação, antes do ROLLBACK: como owner
-- (superuser bypassa RLS), o estado de `profiles` e de `admin_audit` é
-- exatamente o que as chamadas acima deixaram na transação corrente.
RESET ROLE;

DO $$
DECLARE
  v_role text;
  v_audit bigint;
BEGIN
  SELECT p.role INTO v_role FROM public.profiles AS p
  WHERE p.id = 'f7510000-0000-4000-8000-0000000000e1';
  IF v_role IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION '0051 T10 falhou: grant escreveu role (%)', v_role;
  END IF;

  SELECT count(*) INTO v_audit FROM public.admin_audit AS a
  WHERE a.target_id IN (
    'f7510000-0000-4000-8000-0000000000e1',
    'f7510000-0000-4000-8000-0000000000c1'
  );
  IF v_audit <> 0 THEN
    RAISE EXCEPTION '0051 T10 falhou: escrita de auditoria pelo inativo (%)', v_audit;
  END IF;

  RAISE NOTICE '0051 T10 ok: inativo → operator-inactive (grant) e 42501 na RPC deprecada; zero escrita';
END $$;

ROLLBACK;

-- ============ T-GUARD — guarda de deploy da 0051 ============
-- (a) super_admin sem operador ativo → operator-bootstrap-required;
-- (b) com operador ativo → guarda passa;
-- (c) reaplicação integral do arquivo da migration (guarda + backfill +
--     funções/trigger) com operador ativo → sem erro.
-- Tudo em UMA transação: nenhum DDL nem estado de fixture persiste.
BEGIN;

-- (a) desliga todos os operadores (inclui o ativo do fixture) → guarda recusa.
UPDATE public.internal_operators SET active = false;

DO $$
BEGIN
  BEGIN
    IF EXISTS (
      SELECT 1 FROM public.profiles AS p WHERE p.role = 'super_admin'
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.profiles AS p
      JOIN public.internal_operators AS io ON io.user_id = p.id
      WHERE p.role = 'super_admin'
        AND io.active = true
    ) THEN
      RAISE EXCEPTION 'operator-bootstrap-required';
    END IF;
    RAISE EXCEPTION '0051 T-GUARD falhou: base sem operador ativo passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0051 T-GUARD falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'operator-bootstrap-required' THEN
      RAISE EXCEPTION '0051 T-GUARD falhou: rótulo errado sem operador ativo (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE '0051 T-GUARD ok: super_admin sem operador ativo → operator-bootstrap-required';
END $$;

-- (b) reativa o operador do fixture → a guarda passa.
UPDATE public.internal_operators SET active = true, disabled_at = NULL
WHERE user_id = 'f7510000-0000-4000-8000-0000000000a1';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles AS p WHERE p.role = 'super_admin'
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    JOIN public.internal_operators AS io ON io.user_id = p.id
    WHERE p.role = 'super_admin'
      AND io.active = true
  ) THEN
    RAISE EXCEPTION '0051 T-GUARD falhou: base com operador ativo recusada';
  END IF;
  RAISE NOTICE '0051 T-GUARD ok: super_admin com operador ativo → guarda passa';
END $$;

-- (c) reaplicação integral da 0051 (\ir resolve relativo a este arquivo).
\ir ../migrations/0051_operator_gate.sql

DO $$
DECLARE
  v_active bigint;
BEGIN
  SELECT count(*) INTO v_active
  FROM public.profiles AS p
  JOIN public.internal_operators AS io ON io.user_id = p.id
  WHERE p.role = 'super_admin'
    AND io.active = true;
  IF v_active < 1 THEN
    RAISE EXCEPTION '0051 T-GUARD falhou: reaplicação perdeu o operador ativo (%)', v_active;
  END IF;
  RAISE NOTICE '0051 T-GUARD ok: 0051 reaplicada com operador ativo → sem erro (idempotente)';
END $$;

ROLLBACK;

-- ============ Cleanup final ============
DELETE FROM public.admin_audit
WHERE target_id IN (
  'f7510000-0000-4000-8000-0000000000a1',
  'f7510000-0000-4000-8000-0000000000b1',
  'f7510000-0000-4000-8000-0000000000c1',
  'f7510000-0000-4000-8000-0000000000d1',
  'f7510000-0000-4000-8000-0000000000e1'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'f7510000-0000-4000-8000-0000000000a1',
  'f7510000-0000-4000-8000-0000000000b1',
  'f7510000-0000-4000-8000-0000000000c1',
  'f7510000-0000-4000-8000-0000000000d1',
  'f7510000-0000-4000-8000-0000000000e1'
);

DELETE FROM auth.users
WHERE id IN (
  'f7510000-0000-4000-8000-0000000000a1',
  'f7510000-0000-4000-8000-0000000000b1',
  'f7510000-0000-4000-8000-0000000000c1',
  'f7510000-0000-4000-8000-0000000000d1',
  'f7510000-0000-4000-8000-0000000000e1'
);
