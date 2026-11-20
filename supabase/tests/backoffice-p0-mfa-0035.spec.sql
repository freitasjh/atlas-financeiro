-- backoffice-p0-mfa-0035.spec.sql — P0M-BE-01 (migration 0035_remove_admin.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backoffice-p0-mfa-0035.spec.sql
-- Rerunnable: fixtures (users e500*) apagados no início e no fim. O usuário seed
-- admin@atlas.test (00000000-0000-4000-8000-0000000000a1) NUNCA é apagado aqui.
-- Escrito ANTES da migration (TDD): falha sem 0035 (CHECK ainda com 'admin' +
-- is_admin() sem delegação) e passa com 0035 aplicada.
--
-- Prova em banco real (nunca mock — mock não avalia CHECK/trigger/policy/grant),
-- `SET ROLE authenticated` + ROLLBACK por cenário mutante:
--   T00 estrutura: CHECK profiles_role_check = ('user','super_admin') sem o
--       literal legado; is_admin() SECURITY DEFINER STABLE search_path=public
--       delegando a is_super_admin() + asserção negativa (corpo sem literal
--       'admin' com aspas — elimina backdoor 'OR role=admin');
--       admin_audit_action_check mantém grant_admin/revoke_admin (histórico).
--   T-BF backfill: reexecução do UPDATE de promoção (idempotência, 0 linhas,
--       sem duplicar trilha); simulação do estado pré-migração dentro da
--       transação (DROP CHECK → insere 'admin' → UPDATE p/ 'super_admin' →
--       trilha grant_super_admin admin→super_admin com actor NULL, sem
--       rebaixar um super_admin pré-existente; rerun = 0 linhas).
--   T-CHECK apertado: DBA (postgres) tentando voltar a 'admin' → 23514;
--       authenticated via UPDATE direto → rótulo imutável (trigger, não CHECK).
--   T-SA super-only: super_admin livre → is_admin=is_super_admin=true;
--       user → os dois false (nenhum 'admin' legado passa).
--   T-HIST histórico legível: linha grant_admin inserida como DBA lê de volta
--       via list_admin_audit_page('grant_admin') por super_admin (RLS fechada).
--   T-ANON: anon → 42501 em list_admin_audit_page/admin_grant_super_admin e
--       SELECT direto em admin_audit; is_admin() anônimo = false (sem leak).
--   T-SEED: seed admin@atlas.test intacto (super_admin + must_change=true).
-- gate aal2 (mfa-required) é da 0037 — não é provado aqui.
-- Erros por rótulo fixo, sem PII (id/e-mail/hash).

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
DELETE FROM public.admin_audit
WHERE target_id IN (
  'e5000000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000002',
  'e5000000-0000-4000-8000-000000000003',
  'e5000000-0000-4000-8000-000000000099'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e5000000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000002',
  'e5000000-0000-4000-8000-000000000003',
  'e5000000-0000-4000-8000-000000000099'
);

DELETE FROM auth.users
WHERE id IN (
  'e5000000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000002',
  'e5000000-0000-4000-8000-000000000003',
  'e5000000-0000-4000-8000-000000000099'
);

INSERT INTO auth.users (id, email) VALUES
  ('e5000000-0000-4000-8000-000000000001', 'p0m-super@example.com'),
  ('e5000000-0000-4000-8000-000000000002', 'p0m-plain@example.com'),
  ('e5000000-0000-4000-8000-000000000003', 'p0m-target@example.com'),
  ('e5000000-0000-4000-8000-000000000099', 'p0m-temp@example.com');

UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'e5000000-0000-4000-8000-000000000001';
-- plain + target + temp permanecem 'user' (handle_new_user).

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
  'e5000000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000002',
  'e5000000-0000-4000-8000-000000000003',
  'e5000000-0000-4000-8000-000000000099'
);

-- ============ T00 — estrutura pós-0035 ============
DO $$
DECLARE
  v_def text;
  v_src text;
  v_proc pg_proc;
BEGIN
  -- CHECK apertado: user + super_admin, sem o literal legado isolado.
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'profiles_role_check'
    AND conrelid = 'public.profiles'::regclass;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: profiles_role_check ausente';
  END IF;
  IF v_def NOT LIKE '%user%' OR v_def NOT LIKE '%super_admin%'
     OR v_def LIKE '%''admin''%' THEN
    RAISE EXCEPTION 'T00 falhou: profiles_role_check fora de (user, super_admin): %', v_def;
  END IF;

  -- is_admin(): DEFINER + STABLE + search_path=public, delegação estrita.
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('public.is_admin()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: is_admin() ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: is_admin() sem SECURITY DEFINER';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION 'T00 falhou: is_admin() sem STABLE';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c = 'search_path=public'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: is_admin() sem search_path=public travado';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.is_admin()');
  IF v_src IS NULL OR position('is_super_admin' IN v_src) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: is_admin() não delega a is_super_admin()';
  END IF;
  IF v_src LIKE '%''admin''%' THEN
    RAISE EXCEPTION 'T00 falhou: is_admin() contém literal ''admin'' (backdoor legado)';
  END IF;

  -- Histórico preservado: CHECK da trilha mantém grant/revoke_admin.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_audit_action_check'
      AND conrelid = 'public.admin_audit'::regclass
      AND pg_get_constraintdef(oid) LIKE '%grant_admin%'
      AND pg_get_constraintdef(oid) LIKE '%revoke_admin%'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: admin_audit_action_check perdeu grant_admin/revoke_admin';
  END IF;
  IF pg_catalog.pg_get_functiondef('public.list_admin_audit_page(uuid, text, int, int)'::regprocedure)
       NOT LIKE '%grant_admin%' THEN
    RAISE EXCEPTION 'T00 falhou: list_admin_audit_page perdeu grant_admin na whitelist';
  END IF;

  -- Zero 'admin' residual após o backfill.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE role = 'admin') THEN
    RAISE EXCEPTION 'T00 falhou: restou linha com role admin após 0035';
  END IF;

  RAISE NOTICE 'T00 ok: CHECK (user, super_admin) + is_admin delegando + grant_admin histórico';
END $$;

-- ============ T-BF — backfill: idempotência + promoção auditada ============
-- Reexecução do statement da migration = 0 linhas, sem trilha nova.
DO $$
DECLARE
  v_affected int;
  v_audit int;
BEGIN
  SELECT count(*) INTO v_audit FROM public.admin_audit;
  UPDATE public.profiles SET role = 'super_admin', must_change_password = true WHERE role = 'admin';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 0 THEN
    RAISE EXCEPTION 'T-BF falhou: backfill reexecutado tocou % linhas', v_affected;
  END IF;
  IF (SELECT count(*) FROM public.admin_audit) <> v_audit THEN
    RAISE EXCEPTION 'T-BF falhou: backfill reexecutado gerou trilha nova';
  END IF;
  -- super_admin pré-existente não é rebaixado.
  IF (SELECT role FROM public.profiles WHERE id = 'e5000000-0000-4000-8000-000000000001') <> 'super_admin' THEN
    RAISE EXCEPTION 'T-BF falhou: super_admin pré-existente rebaixado';
  END IF;
  RAISE NOTICE 'T-BF ok: backfill idempotente (0 linhas, trilha intacta, super_admin preservado)';
END $$;

-- Simulação do estado pré-migração (a CHECK é DDL transacional; ROLLBACK restaura).
BEGIN;
ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
UPDATE public.profiles SET role = 'admin'
WHERE id = 'e5000000-0000-4000-8000-000000000099';
DELETE FROM public.admin_audit
WHERE target_id = 'e5000000-0000-4000-8000-000000000099';

DO $$
DECLARE
  v_role text;
  v_must boolean;
  v_audit int;
  v_from text;
  v_to text;
  v_actor uuid;
BEGIN
  -- Mesmo statement do backfill em 0035 (roda como postgres: actor NULL).
  UPDATE public.profiles SET role = 'super_admin', must_change_password = true WHERE role = 'admin';
  SELECT role, must_change_password INTO v_role, v_must FROM public.profiles
  WHERE id = 'e5000000-0000-4000-8000-000000000099';
  IF v_role <> 'super_admin' THEN
    RAISE EXCEPTION 'T-BF-sim falhou: admin não virou super_admin (%)', v_role;
  END IF;
  IF v_must IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-BF-sim falhou: promovido sem must_change_password=true (trava first-access)';
  END IF;

  -- Trilha auditada pelo trigger: grant_super_admin admin→super_admin, actor NULL.
  SELECT count(*) INTO v_audit FROM public.admin_audit
  WHERE target_id = 'e5000000-0000-4000-8000-000000000099'
    AND action = 'grant_super_admin';
  IF v_audit <> 1 THEN
    RAISE EXCEPTION 'T-BF-sim falhou: trilha grant_super_admin count=%', v_audit;
  END IF;
  SELECT from_value, to_value, actor_id INTO v_from, v_to, v_actor
  FROM public.admin_audit
  WHERE target_id = 'e5000000-0000-4000-8000-000000000099'
    AND action = 'grant_super_admin';
  IF v_from <> 'admin' OR v_to <> 'super_admin' OR v_actor IS NOT NULL THEN
    RAISE EXCEPTION 'T-BF-sim falhou: trilha errada (%→% actor %)', v_from, v_to, v_actor;
  END IF;
  RAISE NOTICE 'T-BF-sim ok: admin→super_admin auditado (actor NULL) + must_change=true';
END $$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('user', 'super_admin'));
ROLLBACK;

-- ============ T-CHECK — apertado ============
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'admin'
    WHERE id = 'e5000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'T-CHECK falhou: DBA restaurou role admin';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T-CHECK ok: DBA tentando admin → 23514 (CHECK)';
  END;
  IF (SELECT role FROM public.profiles WHERE id = 'e5000000-0000-4000-8000-000000000002') <> 'user' THEN
    RAISE EXCEPTION 'T-CHECK falhou: role mudou apesar do CHECK';
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e5000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e5000000-0000-4000-8000-000000000002","role":"authenticated"}', false);

DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'admin'
    WHERE id = 'e5000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'T-CHECK falhou: authenticated restaurou role admin';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-CHECK falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'profiles.role/subscription_status imutáveis via client (só admin/service_role)' THEN
      RAISE EXCEPTION 'T-CHECK falhou: rótulo errado p/ JWT (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-CHECK ok: authenticated → admin negado pelo trigger (rótulo fixo)';
END $$;
ROLLBACK;

-- ============ T-SA — is_admin super-only ============
-- Claims com "aal":"aal2": pós-0037, super_admin sem aal2 levanta mfa-required —
-- estes cenários provam o alias (a gate aal2 é provada em 0037.spec.sql).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e5000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e5000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE v_admin boolean; v_super boolean;
BEGIN
  SELECT public.is_admin() INTO v_admin;
  SELECT public.is_super_admin() INTO v_super;
  IF v_admin IS DISTINCT FROM true OR v_super IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SA falhou: super_admin livre sem is_admin/is_super_admin=true';
  END IF;
  RAISE NOTICE 'T-SA ok: super_admin → is_admin=true (alias estrito)';
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e5000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e5000000-0000-4000-8000-000000000002","role":"authenticated"}', false);

DO $$
DECLARE v_admin boolean; v_super boolean;
BEGIN
  SELECT public.is_admin() INTO v_admin;
  SELECT public.is_super_admin() INTO v_super;
  IF v_admin IS DISTINCT FROM false OR v_super IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-SA falhou: user comum passou como admin/super_admin';
  END IF;
  RAISE NOTICE 'T-SA ok: user → is_admin=false (super-only, sem legado)';
END $$;
ROLLBACK;

-- ============ T-HIST — grant_admin histórico legível ============
INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value)
VALUES ('e5000000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000003', 'grant_admin', 'user', 'admin');

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e5000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e5000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
  v_action text;
  v_from text;
  v_to text;
  v_target uuid;
BEGIN
  SELECT count(*) INTO v_n FROM public.list_admin_audit_page(
    'e5000000-0000-4000-8000-000000000003', 'grant_admin', 20, 0) AS a;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-HIST falhou: grant_admin histórico count=%', v_n;
  END IF;
  SELECT a.action, a.from_value, a.to_value, a.target_id INTO v_action, v_from, v_to, v_target
  FROM public.list_admin_audit_page(
    'e5000000-0000-4000-8000-000000000003', 'grant_admin', 20, 0) AS a;
  IF v_action <> 'grant_admin' OR v_from <> 'user' OR v_to <> 'admin'
     OR v_target <> 'e5000000-0000-4000-8000-000000000003'::uuid THEN
    RAISE EXCEPTION 'T-HIST falhou: linha histórica errada (% %→%)', v_action, v_from, v_to;
  END IF;
  RAISE NOTICE 'T-HIST ok: grant_admin histórico legível via RPC por super_admin';
END $$;
ROLLBACK;

DELETE FROM public.admin_audit
WHERE target_id = 'e5000000-0000-4000-8000-000000000003' AND action = 'grant_admin';

-- ============ T-ANON — anon 42501, sem leak ============
BEGIN;
SET LOCAL ROLE anon;

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.list_admin_audit_page(NULL, 'grant_admin', 20, 0);
    RAISE EXCEPTION 'T-ANON falhou: anon passou em list_admin_audit_page';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-ANON ok: anon → 42501 em list_admin_audit_page';
  END;

  BEGIN
    PERFORM public.admin_grant_super_admin('e5000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'T-ANON falhou: anon passou em admin_grant_super_admin';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-ANON ok: anon → 42501 em admin_grant_super_admin';
  END;

  BEGIN
    PERFORM 1 FROM public.admin_audit LIMIT 1;
    RAISE EXCEPTION 'T-ANON falhou: anon passou em SELECT direto em admin_audit';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-ANON ok: anon → 42501 em SELECT em admin_audit';
  END;

  -- is_admin() anônimo é legível e retorna false (sem uid, sem leak).
  IF public.is_admin() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T-ANON falhou: is_admin() anônimo ≠ false';
  END IF;
  RAISE NOTICE 'T-ANON ok: is_admin() anônimo = false';
END $$;
ROLLBACK;

-- ============ T-SEED — dono travado intacto (sem rebaixamento) ============
DO $$
DECLARE v_role text; v_must boolean;
BEGIN
  SELECT p.role, p.must_change_password INTO v_role, v_must
  FROM public.profiles AS p
  JOIN auth.users AS u ON u.id = p.id
  WHERE u.email = 'admin@atlas.test';
  IF NOT FOUND OR v_role <> 'super_admin' OR v_must IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T-SEED falhou: seed admin@atlas.test sem super_admin + must_change=true';
  END IF;
  RAISE NOTICE 'T-SEED ok: seed super_admin travado intacto';
END $$;

-- ============ Limpeza final (rerun não duplica; seed preservado) ============
DELETE FROM public.admin_audit
WHERE target_id IN (
  'e5000000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000002',
  'e5000000-0000-4000-8000-000000000003',
  'e5000000-0000-4000-8000-000000000099'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e5000000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000002',
  'e5000000-0000-4000-8000-000000000003',
  'e5000000-0000-4000-8000-000000000099'
);

DELETE FROM auth.users
WHERE id IN (
  'e5000000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000002',
  'e5000000-0000-4000-8000-000000000003',
  'e5000000-0000-4000-8000-000000000099'
);

DO $$
DECLARE v_users int; v_seed int;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users WHERE id IN (
    'e5000000-0000-4000-8000-000000000001',
    'e5000000-0000-4000-8000-000000000002',
    'e5000000-0000-4000-8000-000000000003',
    'e5000000-0000-4000-8000-000000000099'
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
