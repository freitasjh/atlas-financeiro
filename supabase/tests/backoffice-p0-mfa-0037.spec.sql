-- backoffice-p0-mfa-0037.spec.sql — P0M-BE-03 (migration 0037_mfa_aal2.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backoffice-p0-mfa-0037.spec.sql
-- Rerunnable: fixtures (users e700*) e a linha de auditoria de prova apagados no
-- início e no fim. O usuário seed admin@atlas.test (00000000-0000-4000-8000-0000000000a1)
-- NUNCA é apagado aqui.
-- Escrito ANTES da migration (TDD): falha sem 0037 (sem private.is_aal2(), sem
-- 'mfa-required', sem 'mfa_enrolled' no CHECK) e passa com 0037 aplicada.
--
-- Prova em banco real (`SET ROLE authenticated` + `request.jwt.claims` com `aal` +
-- ROLLBACK por cenário mutante — ROLLBACK restaura, nada persiste salvo fixtures):
--   T00 estrutura: private.is_aal2() STABLE SECURITY DEFINER search_path=''; 
--       is_super_admin() cita is_aal2 + 'mfa-required'; is_admin() delega a
--       is_super_admin(); admin_audit_action_check inclui 'mfa_enrolled'.
--   T-AAL1: super_admin aal1 (must_change=false) → is_super_admin/is_admin e
--       admin_list_tenants levantam 'mfa-required'; a sessão segue viva
--       (auth.uid() não-nulo + is_aal2()=false: enroll route fora do gate).
--   T-PLAIN: user comum aal1 → is_admin()/is_super_admin()=false (sem raise —
--       o gate de mfa só alcança role super_admin; RLS de membro não quebra).
--   T-AAL2: super_admin aal2 → is_super_admin=true; RPC admin passa.
--   T-LOCK: must_change=true + aal2 → 'first-access-password-change-required';
--       must_change=true + aal1 → mesmo rótulo (ordem: first-access antes do mfa,
--       SPEC §3: login → must_change → complete_first_access → enroll → verify).
--   T-SVC: claim role='service_role' (sub=super_admin, sem aal) → is_aal2()=true
--       e is_super_admin=true (isenção por claim, nunca por current_user).
--   T-CHECK: linha 'mfa_enrolled' insere como DBA e lê de volta via
--       list_admin_audit_page('mfa_enrolled') por super_admin aal2.
--   T-ANON: anon → is_super_admin()=false (sem raise, sem leak).
-- Flip de config.toml ([auth.mfa.totp] enroll/verify true) é provado fora do SQL
-- (grep no arquivo, evidência de harness) + runbook de deploy atômico.
-- Erros por rótulo fixo, sem PII.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
DELETE FROM public.admin_audit
WHERE target_id IN (
  'e7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000002'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000002'
);

DELETE FROM auth.users
WHERE id IN (
  'e7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000002'
);

INSERT INTO auth.users (id, email) VALUES
  ('e7000000-0000-4000-8000-000000000001', 'p0m-mfa@example.com'),
  ('e7000000-0000-4000-8000-000000000002', 'p0m-plain-mfa@example.com');

UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'e7000000-0000-4000-8000-000000000001';
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
  'e7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000002'
);

-- ============ T00 — estrutura pós-0037 ============
DO $$
DECLARE
  v_proc pg_proc;
  v_src text;
  v_def text;
BEGIN
  -- Helper private.is_aal2(): STABLE + SECURITY DEFINER + search_path=''.
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('private.is_aal2()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: private.is_aal2() ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: is_aal2() sem SECURITY DEFINER';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION 'T00 falhou: is_aal2() sem STABLE';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: is_aal2() sem search_path='' travado';
  END IF;
  -- Isenção por claim JWT (service_role / aal2), nunca por current_user.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('private.is_aal2()');
  IF v_src IS NULL OR v_src NOT LIKE '%aal2%' THEN
    RAISE EXCEPTION 'T00 falhou: is_aal2() sem checagem de claim aal2';
  END IF;
  IF v_src LIKE '%current_user%' THEN
    RAISE EXCEPTION 'T00 falhou: is_aal2() usa current_user (isenção errada)';
  END IF;

  -- is_super_admin() exige aal2 para super_admin (rótulo fixo mfa-required).
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.is_super_admin()');
  IF v_src IS NULL OR v_src NOT LIKE '%is_aal2%' THEN
    RAISE EXCEPTION 'T00 falhou: is_super_admin() não chama is_aal2()';
  END IF;
  IF v_src NOT LIKE '%mfa-required%' THEN
    RAISE EXCEPTION 'T00 falhou: is_super_admin() sem rótulo mfa-required';
  END IF;

  -- is_admin() continua delegando (0035) — herda gate aal2 por transitividade.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.is_admin()');
  IF v_src IS NULL OR position('is_super_admin' IN v_src) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: is_admin() não delega a is_super_admin()';
  END IF;

  -- CHECK da trilha aceita a nova ação de auditoria do enroll.
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'admin_audit_action_check'
    AND conrelid = 'public.admin_audit'::regclass;
  IF v_def IS NULL OR v_def NOT LIKE '%mfa_enrolled%' THEN
    RAISE EXCEPTION 'T00 falhou: admin_audit_action_check sem mfa_enrolled (%)', v_def;
  END IF;

  RAISE NOTICE 'T00 ok: is_aal2() + gate mfa-required + is_admin delegando + mfa_enrolled no CHECK';
END $$;

-- ============ T-AAL1 — super_admin aal1 levanta mfa-required ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e7000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e7000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);

DO $$
DECLARE v_ok boolean;
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION 'T-AAL1 falhou: aal1 passou em is_super_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-AAL1 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-required' THEN
      RAISE EXCEPTION 'T-AAL1 falhou: rótulo errado em is_super_admin (% )', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.is_admin();
    RAISE EXCEPTION 'T-AAL1 falhou: aal1 passou em is_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-AAL1 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-required' THEN
      RAISE EXCEPTION 'T-AAL1 falhou: rótulo errado em is_admin (% )', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0);
    RAISE EXCEPTION 'T-AAL1 falhou: aal1 passou em admin_list_tenants';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-AAL1 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-required' THEN
      RAISE EXCEPTION 'T-AAL1 falhou: rótulo errado em admin_list_tenants (% )', SQLERRM;
    END IF;
  END;

  -- Enroll route fora do gate: sessão viva (uid presente) + is_aal2()=false sem raise.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'T-AAL1 falhou: sessão sumiu em aal1 (enroll inalcançável)';
  END IF;
  SELECT private.is_aal2() INTO v_ok;
  IF v_ok IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-AAL1 falhou: is_aal2() em aal1 <> false';
  END IF;
  RAISE NOTICE 'T-AAL1 ok: aal1 → mfa-required nas RPCs, sessão viva p/ enroll';
END $$;
ROLLBACK;

-- ============ T-PLAIN — user comum aal1 não levanta (RLS de membro intacta) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e7000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e7000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', false);

DO $$
DECLARE v_admin boolean; v_super boolean;
BEGIN
  SELECT public.is_admin() INTO v_admin;
  SELECT public.is_super_admin() INTO v_super;
  IF v_admin IS DISTINCT FROM false OR v_super IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-PLAIN falhou: user comum aal1 levantou ou passou';
  END IF;
  RAISE NOTICE 'T-PLAIN ok: user aal1 → false sem raise (gate só alcança super_admin)';
END $$;
ROLLBACK;

-- ============ T-AAL2 — super_admin aal2 passa ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e7000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e7000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_super boolean; v_count bigint;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF v_super IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-AAL2 falhou: super_admin aal2 sem is_super_admin=true';
  END IF;
  SELECT public.admin_count_tenants(NULL, NULL) INTO v_count;
  IF v_count IS NULL OR v_count < 0 THEN
    RAISE EXCEPTION 'T-AAL2 falhou: admin_count_tenants inválido por aal2 (%)', v_count;
  END IF;
  RAISE NOTICE 'T-AAL2 ok: super_admin aal2 passa no gate e na RPC';
END $$;
ROLLBACK;

-- ============ T-LOCK — travado de primeiro acesso (antes do mfa) ============
BEGIN;
-- must=true dentro da transação (ROLLBACK restaura a flag).
UPDATE public.profiles SET must_change_password = true
WHERE id = 'e7000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e7000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e7000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION 'T-LOCK falhou: travado aal2 passou em is_super_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-LOCK falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-password-change-required' THEN
      RAISE EXCEPTION 'T-LOCK falhou: rótulo errado p/ travado aal2 (% )', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-LOCK ok: travado + aal2 → first-access-password-change-required';
END $$;
ROLLBACK;

BEGIN;
UPDATE public.profiles SET must_change_password = true
WHERE id = 'e7000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e7000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e7000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.is_super_admin();
    RAISE EXCEPTION 'T-LOCK falhou: travado aal1 passou em is_super_admin()';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-LOCK falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'first-access-password-change-required' THEN
      RAISE EXCEPTION 'T-LOCK falhou: rótulo errado p/ travado aal1 (% )', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-LOCK ok: travado + aal1 → first-access (ordem must antes do mfa)';
END $$;
ROLLBACK;

-- ============ T-SVC — service_role isento por claim (nunca current_user) ============
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'e7000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e7000000-0000-4000-8000-000000000001","role":"service_role"}', false);

DO $$
DECLARE v_aal boolean; v_super boolean;
BEGIN
  SELECT private.is_aal2() INTO v_aal;
  IF v_aal IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SVC falhou: is_aal2() com claim service_role <> true';
  END IF;
  SELECT public.is_super_admin() INTO v_super;
  IF v_super IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SVC falhou: service_role (sub=super_admin, sem aal) sem is_super_admin=true';
  END IF;
  RAISE NOTICE 'T-SVC ok: service_role isento por claim, sem aal, passa no gate';
END $$;
ROLLBACK;

-- ============ T-CHECK — mfa_enrolled insere e lê via RPC ============
INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value)
VALUES ('e7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000001', 'mfa_enrolled', 'aal1', 'aal2');

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e7000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e7000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.list_admin_audit_page(
    'e7000000-0000-4000-8000-000000000001', 'mfa_enrolled', 20, 0) AS a;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-CHECK falhou: mfa_enrolled count=% via RPC', v_n;
  END IF;
  RAISE NOTICE 'T-CHECK ok: mfa_enrolled insere (CHECK) e lê via RPC de auditoria';
END $$;
ROLLBACK;

DELETE FROM public.admin_audit
WHERE target_id = 'e7000000-0000-4000-8000-000000000001' AND action = 'mfa_enrolled';

-- ============ T-ANON — anon sem raise, sem leak ============
BEGIN;
SET LOCAL ROLE anon;

DO $$
BEGIN
  IF public.is_super_admin() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-ANON falhou: is_super_admin() anônimo ≠ false';
  END IF;
  RAISE NOTICE 'T-ANON ok: is_super_admin() anônimo = false';
END $$;
ROLLBACK;

-- ============ Limpeza final (rerun não duplica; seed preservado) ============
DELETE FROM public.admin_audit
WHERE target_id IN (
  'e7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000002'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000002'
);

DELETE FROM auth.users
WHERE id IN (
  'e7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000002'
);

DO $$
DECLARE v_users int; v_seed int;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users WHERE id IN (
    'e7000000-0000-4000-8000-000000000001',
    'e7000000-0000-4000-8000-000000000002'
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
