-- 0077-tenant-onboarding.spec.sql — tenant-onboarding / F2 / ADR-006 (BE-21/BE-22).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0077-tenant-onboarding.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova em banco real (mock não avalia SECURITY DEFINER, search_path, ACL, RLS,
-- claims, constraint diferida nem transação):
--   T00 estrutura: pré-condições de F1 (`0055` tenant_subscriptions e `0058`
--       trigger tenant_subscriptions_mirror) presentes; UMA única assinatura de
--       `create_tenant_for_invited_user` (15 args, 2 defaults, RETURNS uuid),
--       SECURITY DEFINER, search_path='' travado, EXECUTE só para authenticated.
--   T01 sucesso: dono do tenant = convidado (nunca o operador); membership
--       `owner` e aceite do convidado; `tenant_subscriptions` nasce na MESMA
--       transação (`free` ⇒ `active`, sem período/aniversário, PSP/pending NULL,
--       `cancel_at_period_end=false`); espelho `tenants` ativo + exatamente 1
--       linha `tenant_status_changed` trial→active com reason='onboarding';
--       1 linha de trilha `tenant_onboard_provisioned`.
--   T02 não-admin ⇒ `not-admin`, 0 tenant.
--   T03 (1/2) convidado sem identidade materializada ⇒ `invite-pending`, 0
--       tenant e trilha do convite NÃO duplicada; (2/2) `p_invited_user_id IS
--       NULL` ⇒ mesmo rótulo.
--   T04 retry idêntico ⇒ mesmo `tenant_id`, 1 linha em tenants/tenant_members/
--       contract_acceptances/tenant_subscriptions, 1 trilha `provisioned` +
--       1 trilha `reused`.
--   T04b plano cobrável (`pro`) ⇒ `trial` com `trial_ends_at` ≈ 14 dias,
--       `billing_day` = dia em America/Sao_Paulo, períodos NULL, 0 linha de
--       `tenant_status_changed`.
--   T04c CORRIDA REAL (2 conexões via dblink, como o T19y de `0059`): duas
--       chamadas SIMULTÂNEAS com o mesmo `(owner, documento)` ⇒ `tenants=1`,
--       `tenant_subscriptions=1`, `tenant_onboard_provisioned=1` +
--       `tenant_onboard_reused=1` e MESMO `tenant_id` nas duas sessões (0077
--       REQ-07 — handler de `unique_violation` repete o lookup).
--   T05 autoprovisionamento (convidado = operador) ⇒ `tenant-owner-invalid`.
--   T05b atomicidade em 3 falhas injetadas DEPOIS dos INSERTs: (1/3) plano
--       inválido ⇒ `tenant-plan-invalid` com 0 tenant/0 membership/0 aceite/
--       0 assinatura; (2/3) CHECK temporário em `tenant_subscriptions` ⇒
--       rollback das 4 tabelas; (3/3) CHECK temporário em `admin_audit` (a
--       ÚLTIMA escrita da RPC) ⇒ rollback das 4 tabelas **e** da trilha
--       (`admin_audit` volta à contagem anterior).
--
-- Rastreabilidade 1:1 com `SPEC.md` §12 (rótulos do SPEC ⇒ blocos deste arquivo):
--   T00  ─ REQ-23, REQ-24
--   T01  ─ REQ-01, REQ-16, REQ-17 (`free`), REQ-18
--   T02  ─ REQ-02
--   T03b ─ T03 (1/2)      [perfil ausente ⇒ invite-pending]
--   T03c ─ T05            [convidado = operador ⇒ tenant-owner-invalid]
--   (sem rótulo no §12) ─ T03 (2/2) [`p_invited_user_id IS NULL` ⇒ invite-pending,
--                         exigido por REQ-03 mas com prova própria aqui]
--   T04  ─ REQ-06
--   T04b ─ REQ-06, REQ-17 (`pro`)
--   T04c ─ REQ-07
--   T05  ─ REQ-05         [falha injetada ⇒ 0/0/0/0]
--
-- Erros por rótulo fixo, sem PII/id. Fixtures `c77*` apagadas no início e no
-- fim; todo cenário mutável vive em transação com ROLLBACK, exceto T04c (dblink
-- só enxerga COMMIT ⇒ fixtures permanentes removidas no bloco final).
--
-- BLOCO B2 (0078, BE-23) no fim do arquivo: T06, T06b, T06c, T06d, T07, T07b,
-- T07c, T07d, T11, T11b, T16, T16b, T17 — ledger de convite derivado
-- (`admin_record_invite`, `admin_cancel_invite`, `admin_list_pending_invites`,
-- `admin_invite_quota`). Fixtures `c7800000-*` / `c7810000-*`; todo cenário em
-- BEGIN/ROLLBACK ⇒ 0 resíduo. T07d (0081, review final da F2): alvo com
-- QUALQUER membership (não-owner) ⇒ `invite-not-pending`, 0 escrita.
--
-- BLOCO B3 (0079, BE-25/BE-26): T08..T08h, T18..T21 (drift/reparo). Fixtures
-- `c7900000-*`. T08e (role-drift ⇒ `tenant-onboarding-membership-role-manual`),
-- T08f (`canceled` sem assinatura ⇒ `subscription-canceled-readonly`), T08g
-- (`active` sem assinatura segue reparável) e T08h (`past_due` sem assinatura
-- ⇒ `tenant-onboarding-subscription-state-manual`, 0 escrita — review final da
-- F2) fecham F1/F2 do parecer de 0079.
--
-- BLOCO B4 (0080, BE-27) no fim do arquivo: T09 (estrutura/grants — assinatura
-- única, DEFINER, `search_path=''`, `proacl` só `service_role` + owner; RPCs
-- revogadas de 0052/0053 sem EXECUTE para `anon`/`authenticated`) e T10
-- (comportamento — resolve e-mail, e-mail ausente/NULL ⇒ `NULL` sem erro,
-- leitura não escreve; `anon`/`authenticated` ⇒ `42501` em
-- `admin_resolve_invited_user`, `accept_contract` e `create_tenant_with_owner`).
-- T10b (review final da F2): conta soft-deleted (`auth.users.deleted_at`) NÃO
-- resolve ⇒ a borda convida de novo em vez de responder `state:'existing'`;
-- conta ativa e banida seguem resolvendo.
-- Fixtures `c8000000-*`; cenários em BEGIN/ROLLBACK ⇒ 0 resíduo.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; rerunnable) ============

BEGIN;
SET LOCAL app.card_purge = 'on';
DO $$
DECLARE
  v_users uuid[] := ARRAY[
    'c7700000-0000-4000-8000-0000000000a1',
    'c7700000-0000-4000-8000-0000000000b1',
    'c7700000-0000-4000-8000-0000000000c1',
    'c7700000-0000-4000-8000-0000000000c2',
    'c7700000-0000-4000-8000-0000000000c3',
    'c7700000-0000-4000-8000-0000000000c4',
    'c7700000-0000-4000-8000-0000000000c5'
  ]::uuid[];
  v_has_immutable boolean;
BEGIN
  -- 0055: assinatura sai ANTES do tenant (FK ON DELETE RESTRICT).
  IF to_regclass('public.tenant_subscriptions') IS NOT NULL THEN
    DELETE FROM public.tenant_subscriptions AS s
    USING public.tenants AS t
    WHERE s.tenant_id = t.id
      AND t.owner_user_id = ANY(v_users);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'contract_acceptances_immutable' AND NOT tgisinternal
  ) INTO v_has_immutable;
  IF v_has_immutable THEN
    ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
  END IF;

  DELETE FROM public.admin_audit AS a
  USING public.tenants AS t
  WHERE t.owner_user_id = ANY(v_users)
    AND (a.tenant_id = t.id OR a.target_id = t.id);

  DELETE FROM public.tenants WHERE owner_user_id = ANY(v_users);
  DELETE FROM public.admin_audit WHERE target_id = ANY(v_users);

  IF v_has_immutable THEN
    ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
  END IF;
END $$;
DELETE FROM public.internal_operators
WHERE user_id = ANY (ARRAY[
  'c7700000-0000-4000-8000-0000000000a1',
  'c7700000-0000-4000-8000-0000000000b1',
  'c7700000-0000-4000-8000-0000000000c1',
  'c7700000-0000-4000-8000-0000000000c2',
  'c7700000-0000-4000-8000-0000000000c3',
  'c7700000-0000-4000-8000-0000000000c4',
  'c7700000-0000-4000-8000-0000000000c5'
]::uuid[]);
DELETE FROM auth.users
WHERE id = ANY (ARRAY[
  'c7700000-0000-4000-8000-0000000000a1',
  'c7700000-0000-4000-8000-0000000000b1',
  'c7700000-0000-4000-8000-0000000000c1',
  'c7700000-0000-4000-8000-0000000000c2',
  'c7700000-0000-4000-8000-0000000000c3',
  'c7700000-0000-4000-8000-0000000000c4',
  'c7700000-0000-4000-8000-0000000000c5'
]::uuid[]);
COMMIT;

-- ============ T00 — estrutura (pré-condições de F1 + assinatura única) ============

DO $$
DECLARE
  v_proc pg_proc;
  v_n int;
BEGIN
  -- Pré-condição dura de F1: 0055 e 0058 aplicadas (F12 da SPEC: sem elas a
  -- RPC não pode escrever a assinatura nem observar o espelho).
  IF to_regclass('public.tenant_subscriptions') IS NULL THEN
    RAISE EXCEPTION '0077 T00 falhou: pre-condicao 0055 ausente (tenant_subscriptions)';
  END IF;
  IF to_regprocedure('public.tenant_subscriptions_mirror()') IS NULL THEN
    RAISE EXCEPTION '0077 T00 falhou: pre-condicao 0058 ausente (tenant_subscriptions_mirror)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'tenant_subscriptions_mirror'
      AND tgrelid = 'public.tenant_subscriptions'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0077 T00 falhou: trigger de espelho 0058 ausente';
  END IF;

  -- Uma única assinatura: overload = 2 entradas ⇒ contrato quebrado (P11).
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_proc
  WHERE proname = 'create_tenant_for_invited_user'
    AND pronamespace = 'public'::regnamespace
    AND prokind = 'f';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T00 falhou: % assinatura(s) de create_tenant_for_invited_user (esperado 1)', v_n;
  END IF;

  SELECT * INTO v_proc
  FROM pg_catalog.pg_proc
  WHERE oid = to_regprocedure(
    'public.create_tenant_for_invited_user(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text)');
  IF NOT FOUND THEN
    RAISE EXCEPTION '0077 T00 falhou: assinatura de 15 args ausente';
  END IF;
  IF v_proc.pronargs <> 15 THEN
    RAISE EXCEPTION '0077 T00 falhou: % args (esperado 15)', v_proc.pronargs;
  END IF;
  IF v_proc.pronargdefaults <> 2 THEN
    RAISE EXCEPTION '0077 T00 falhou: % defaults (esperado 2)', v_proc.pronargdefaults;
  END IF;
  IF v_proc.prorettype <> 'uuid'::regtype THEN
    RAISE EXCEPTION '0077 T00 falhou: retorno % (esperado uuid)', v_proc.prorettype::regtype;
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0077 T00 falhou: sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0077 T00 falhou: sem search_path vazio travado';
  END IF;

  IF NOT has_function_privilege('authenticated', v_proc.oid, 'EXECUTE') THEN
    RAISE EXCEPTION '0077 T00 falhou: authenticated sem EXECUTE';
  END IF;
  IF has_function_privilege('anon', v_proc.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_proc.oid, 'EXECUTE') THEN
    RAISE EXCEPTION '0077 T00 falhou: EXECUTE para anon/service_role';
  END IF;

  RAISE NOTICE '0077 T00 ok: 0055/0058 presentes; 1 assinatura (15 args, uuid), DEFINER + search_path vazio, EXECUTE so authenticated';
END $$;

-- ============ Fixtures (após T00; falha de estrutura não deixa fixture) ============

INSERT INTO auth.users (id, email) VALUES
  ('c7700000-0000-4000-8000-0000000000a1', 'operator-0077@example.com'),
  ('c7700000-0000-4000-8000-0000000000b1', 'common-0077@example.com'),
  ('c7700000-0000-4000-8000-0000000000c1', 'invitee-t01-0077@example.com'),
  ('c7700000-0000-4000-8000-0000000000c2', 'invitee-t04-0077@example.com'),
  ('c7700000-0000-4000-8000-0000000000c3', 'invitee-t04b-0077@example.com'),
  ('c7700000-0000-4000-8000-0000000000c4', 'invitee-t05b-0077@example.com'),
  ('c7700000-0000-4000-8000-0000000000c5', 'invitee-t04c-0077@example.com');

UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'c7700000-0000-4000-8000-0000000000a1';

INSERT INTO public.internal_operators (user_id, active)
VALUES ('c7700000-0000-4000-8000-0000000000a1', true);

-- Sem ruído da promoção/ativação nas contagens de trilha.
DELETE FROM public.admin_audit
WHERE target_id = 'c7700000-0000-4000-8000-0000000000a1';

-- ============ T01 — sucesso: dono = convidado + assinatura na mesma transação ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := public.create_tenant_for_invited_user(
    'c7700000-0000-4000-8000-0000000000c1',
    'pf', '77100000106', 'Onboarding 0077', NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'free');
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION '0077 T01 falhou: RPC devolveu NULL';
  END IF;
  PERFORM set_config('test.t01_tenant', v_tenant::text, true);
END $$;
RESET ROLE;

DO $$
DECLARE
  v_tenant uuid := current_setting('test.t01_tenant')::uuid;
  v_owner uuid;
  v_member uuid;
  v_role text;
  v_acc uuid;
  v_sub record;
  v_plan text;
  v_status text;
  v_n int;
BEGIN
  SELECT owner_user_id INTO v_owner FROM public.tenants WHERE id = v_tenant;
  IF v_owner IS DISTINCT FROM 'c7700000-0000-4000-8000-0000000000c1' THEN
    RAISE EXCEPTION '0077 T01 falhou: dono do tenant nao e o convidado (%)', v_owner;
  END IF;
  IF v_owner = 'c7700000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION '0077 T01 falhou: dono do tenant e o operador';
  END IF;

  SELECT user_id, role INTO v_member, v_role
  FROM public.tenant_members WHERE tenant_id = v_tenant;
  IF v_member IS DISTINCT FROM v_owner OR v_role <> 'owner' THEN
    RAISE EXCEPTION '0077 T01 falhou: membership owner ausente/divergente (%,%)', v_member, v_role;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_tenant;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T01 falhou: % membership(s) (esperado 1)', v_n;
  END IF;

  SELECT user_id INTO v_acc FROM public.contract_acceptances WHERE tenant_id = v_tenant;
  IF v_acc IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION '0077 T01 falhou: aceite nao e do convidado (%)', v_acc;
  END IF;

  -- I2/REQ-16/REQ-17: assinatura nasce na mesma transação, `free` sem ciclo.
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions WHERE tenant_id = v_tenant;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T01 falhou: % assinatura(s) (esperado 1)', v_n;
  END IF;
  SELECT * INTO v_sub FROM public.tenant_subscriptions WHERE tenant_id = v_tenant;
  IF v_sub.plan_slug <> 'free' OR v_sub.status <> 'active' THEN
    RAISE EXCEPTION '0077 T01 falhou: free deveria nascer active/free (%,%)', v_sub.plan_slug, v_sub.status;
  END IF;
  IF v_sub.trial_ends_at IS NOT NULL OR v_sub.billing_day IS NOT NULL
     OR v_sub.period_start IS NOT NULL OR v_sub.period_end IS NOT NULL THEN
    RAISE EXCEPTION '0077 T01 falhou: free com periodo/trial/aniversario';
  END IF;
  IF v_sub.psp_subscription_id IS NOT NULL OR v_sub.psp_customer_id IS NOT NULL
     OR v_sub.past_due_since IS NOT NULL
     OR v_sub.pending_plan_slug IS NOT NULL OR v_sub.pending_plan_at IS NOT NULL THEN
    RAISE EXCEPTION '0077 T01 falhou: campos de PSP/pending/carencia nao nulos';
  END IF;
  IF v_sub.cancel_at_period_end IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0077 T01 falhou: cancel_at_period_end <> false';
  END IF;

  -- REQ-18: espelho coerente + exatamente 1 linha de status (trial -> active).
  SELECT plan_id, subscription_status INTO v_plan, v_status
  FROM public.tenants WHERE id = v_tenant;
  IF v_plan <> 'free' OR v_status <> 'active' THEN
    RAISE EXCEPTION '0077 T01 falhou: espelho divergente (%,%)', v_plan, v_status;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE action = 'tenant_status_changed'
    AND target_id = v_tenant
    AND from_value = 'trial' AND to_value = 'active'
    AND reason = 'onboarding';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T01 falhou: % linha(s) tenant_status_changed trial->active/onboarding (esperado 1)', v_n;
  END IF;

  -- Trilha de provisionamento (append-only, sem PII).
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE reason = 'tenant_onboard_provisioned'
    AND target_id = v_tenant
    AND tenant_id = v_tenant
    AND actor_id = 'c7700000-0000-4000-8000-0000000000a1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T01 falhou: % trilha(s) tenant_onboard_provisioned (esperado 1)', v_n;
  END IF;

  RAISE NOTICE '0077 T01 ok: dono=convidado, membership owner, aceite, assinatura free/active sem ciclo, espelho + 1 trilha de status';
END $$;
ROLLBACK;

-- ============ T02 — não-admin ⇒ not-admin, 0 escrita ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      'c7700000-0000-4000-8000-0000000000c1',
      'pf', '77100000106', 'Nao Admin 0077', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free');
    RAISE EXCEPTION '0077 T02 falhou: chamada passou para nao-admin';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0077 T02 falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.errT02', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.errT02');
  v_n int;
BEGIN
  IF v_err <> 'not-admin' THEN
    RAISE EXCEPTION '0077 T02 falhou: rotulo (%)', v_err;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.tenants WHERE owner_user_id = 'c7700000-0000-4000-8000-0000000000c1';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T02 falhou: % tenant(s) escritos por nao-admin', v_n;
  END IF;
  RAISE NOTICE '0077 T02 ok: nao-admin -> not-admin, 0 tenant';
END $$;
ROLLBACK;

-- ============ T03 — convite pendente (sem identidade) ⇒ invite-pending ============

BEGIN;
-- Trilha do convite registrada pela borda antes de a identidade existir;
-- `c7700000-...-0d1` NÃO está em auth.users/profiles de propósito.
INSERT INTO public.admin_audit (actor_id, target_id, action, reason)
VALUES ('c7700000-0000-4000-8000-0000000000a1',
        'c7700000-0000-4000-8000-0000000000d1',
        'other', 'tenant_onboard_invite_requested');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      'c7700000-0000-4000-8000-0000000000d1',
      'pf', '77100000297', 'Pendente 0077', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free');
    RAISE EXCEPTION '0077 T03 falhou: passou com convidado sem profile';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0077 T03 falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.errT03', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.errT03');
  v_n int;
  v_trail int;
BEGIN
  IF v_err <> 'invite-pending' THEN
    RAISE EXCEPTION '0077 T03 falhou: rotulo (%)', v_err;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.tenants WHERE owner_user_id = 'c7700000-0000-4000-8000-0000000000d1';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T03 falhou: % tenant(s) duplicado(s) para convidado pendente', v_n;
  END IF;
  SELECT count(*) INTO v_trail
  FROM public.admin_audit
  WHERE reason = 'tenant_onboard_invite_requested'
    AND target_id = 'c7700000-0000-4000-8000-0000000000d1';
  IF v_trail <> 1 THEN
    RAISE EXCEPTION '0077 T03 falhou: trilha duplicada/sumida (%)', v_trail;
  END IF;
  RAISE NOTICE '0077 T03 ok (1/2): convidado sem profile -> invite-pending, 0 tenant, trilha intacta';
END $$;

-- REQ-03: p_invited_user_id IS NULL também é "sem profile" ⇒ invite-pending.
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      NULL,
      'pf', '77100000297', 'Nulo 0077', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free');
    RAISE EXCEPTION '0077 T03 falhou: passou com p_invited_user_id NULL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0077 T03 falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.errT03b', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.errT03b');
  v_n int;
BEGIN
  IF v_err <> 'invite-pending' THEN
    RAISE EXCEPTION '0077 T03 falhou: rotulo para NULL (%)', v_err;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenants
  WHERE razao_social = 'Nulo 0077';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T03 falhou: tenant escrito com convidado NULL (%)', v_n;
  END IF;
  RAISE NOTICE '0077 T03 ok (2/2): p_invited_user_id NULL -> invite-pending, 0 tenant';
END $$;
ROLLBACK;

-- ============ T04 — retry idêntico ⇒ reuso (mesmo tenant, 1 linha por tabela) ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_first uuid;
  v_second uuid;
BEGIN
  v_first := public.create_tenant_for_invited_user(
    'c7700000-0000-4000-8000-0000000000c2',
    'pf', '77100000378', 'Reuso 0077', NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'free');
  v_second := public.create_tenant_for_invited_user(
    'c7700000-0000-4000-8000-0000000000c2',
    'pf', '77100000378', 'Reuso 0077', NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'free');
  PERFORM set_config('test.t04_first', v_first::text, true);
  PERFORM set_config('test.t04_second', v_second::text, true);
END $$;
RESET ROLE;

DO $$
DECLARE
  v_first uuid := current_setting('test.t04_first')::uuid;
  v_second uuid := current_setting('test.t04_second')::uuid;
  v_n int;
  v_prov int;
  v_reused int;
BEGIN
  IF v_first <> v_second THEN
    RAISE EXCEPTION '0077 T04 falhou: retry criou outro tenant (% vs %)', v_first, v_second;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.tenants WHERE owner_user_id = 'c7700000-0000-4000-8000-0000000000c2';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T04 falhou: % tenant(s) (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_first;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T04 falhou: % membership(s) (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.contract_acceptances WHERE tenant_id = v_first;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T04 falhou: % aceite(s) (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions WHERE tenant_id = v_first;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T04 falhou: % assinatura(s) (esperado 1)', v_n;
  END IF;

  SELECT count(*) INTO v_prov
  FROM public.admin_audit
  WHERE reason = 'tenant_onboard_provisioned' AND target_id = v_first;
  SELECT count(*) INTO v_reused
  FROM public.admin_audit
  WHERE reason = 'tenant_onboard_reused' AND target_id = v_first
    AND tenant_id = v_first;
  IF v_prov <> 1 OR v_reused <> 1 THEN
    RAISE EXCEPTION '0077 T04 falhou: trilha provisioned=% reused=% (esperado 1/1)', v_prov, v_reused;
  END IF;

  RAISE NOTICE '0077 T04 ok: reuso devolve o mesmo tenant_id, 1 linha por tabela, 1 provisioned + 1 reused';
END $$;
ROLLBACK;

-- ============ T04b — plano cobrável ⇒ trial 14d com billing_day SP ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := public.create_tenant_for_invited_user(
    'c7700000-0000-4000-8000-0000000000c3',
    'pf', '77100000459', 'Pago 0077', NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'pro');
  PERFORM set_config('test.t04b_tenant', v_tenant::text, true);
END $$;
RESET ROLE;

DO $$
DECLARE
  v_tenant uuid := current_setting('test.t04b_tenant')::uuid;
  v_sub record;
  v_status text;
  v_plan text;
  v_day int;
  v_n int;
BEGIN
  SELECT * INTO v_sub FROM public.tenant_subscriptions WHERE tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION '0077 T04b falhou: assinatura ausente';
  END IF;
  IF v_sub.plan_slug <> 'pro' OR v_sub.status <> 'trial' THEN
    RAISE EXCEPTION '0077 T04b falhou: plano pago deveria nascer trial/pro (%,%)', v_sub.plan_slug, v_sub.status;
  END IF;
  IF v_sub.trial_ends_at IS NULL
     OR v_sub.trial_ends_at < pg_catalog.now() + interval '13 days'
     OR v_sub.trial_ends_at > pg_catalog.now() + interval '15 days' THEN
    RAISE EXCEPTION '0077 T04b falhou: trial_ends_at fora de 14d (%)', v_sub.trial_ends_at;
  END IF;
  v_day := EXTRACT(day FROM pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now()))::int;
  IF v_sub.billing_day IS DISTINCT FROM v_day THEN
    RAISE EXCEPTION '0077 T04b falhou: billing_day % (esperado dia SP %)', v_sub.billing_day, v_day;
  END IF;
  IF v_sub.period_start IS NOT NULL OR v_sub.period_end IS NOT NULL THEN
    RAISE EXCEPTION '0077 T04b falhou: periodo aberto no nascimento';
  END IF;
  IF v_sub.psp_subscription_id IS NOT NULL OR v_sub.psp_customer_id IS NOT NULL
     OR v_sub.past_due_since IS NOT NULL
     OR v_sub.pending_plan_slug IS NOT NULL OR v_sub.pending_plan_at IS NOT NULL
     OR v_sub.cancel_at_period_end IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0077 T04b falhou: campos de cortesia/pending divergentes';
  END IF;

  SELECT plan_id, subscription_status INTO v_plan, v_status
  FROM public.tenants WHERE id = v_tenant;
  IF v_plan <> 'pro' OR v_status <> 'trial' THEN
    RAISE EXCEPTION '0077 T04b falhou: espelho divergente (%,%)', v_plan, v_status;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE action = 'tenant_status_changed' AND target_id = v_tenant;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T04b falhou: % linha(s) de status para plano pago (esperado 0)', v_n;
  END IF;

  RAISE NOTICE '0077 T04b ok: pro nasce trial 14d, billing_day = dia SP, sem periodo, 0 linha de status';
END $$;
ROLLBACK;

-- ============ T04c — CORRIDA REAL (2 conexões) ⇒ reuso, nunca 2 tenants ============
-- REQ-07 (SPEC §12 T04c) com concorrência DE VERDADE — não é violação simulada:
-- a sessão principal abre a transação, insere o tenant e SEGURA o lock; a 2ª
-- sessão (`dblink`, mesmo padrão do T19y de `0059`) chama a MESMA RPC para o
-- mesmo `(owner, documento)` e bloqueia no índice único `tenants_cpf_active_uq`
-- (`0022:126-132`). Ao acordar no COMMIT, o `unique_violation` cai no handler da
-- `0077`, que repete o lookup: dono casa ⇒ devolve o MESMO `tenant_id` e grava
-- `tenant_onboard_reused`. Fim: 1 tenant, 1 assinatura, 1 provisioned + 1 reused.
-- `dblink` só enxerga COMMIT ⇒ este bloco deixa fixture permanente (c5), removida
-- no cleanup final.

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

SELECT extensions.dblink_connect(
  'c77_conc',
  format(
    'host=%s port=%s dbname=%s user=postgres password=postgres',
    host(inet_server_addr()), inet_server_port(), current_database()
  )
);

SELECT extensions.dblink_exec(
  'c77_conc',
  'SET request.jwt.claims = ''{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'''
);

SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

BEGIN;
SELECT set_config('test.t04c_a', public.create_tenant_for_invited_user(
  'c7700000-0000-4000-8000-0000000000c5',
  'pf', '77100000963', 'Corrida 0077', NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'free')::text, false);

SELECT extensions.dblink_send_query(
  'c77_conc',
  'SELECT public.create_tenant_for_invited_user(''c7700000-0000-4000-8000-0000000000c5'', ''pf'', ''77100000963'', ''Corrida 0077'', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ''free'')'
);

SELECT pg_catalog.pg_sleep(0.5);
COMMIT;

DO $$
DECLARE
  v_a uuid := current_setting('test.t04c_a')::uuid;
  v_b uuid;
  v_err text;
  v_n int;
  v_prov int;
  v_reused int;
BEGIN
  BEGIN
    SELECT t.tenant INTO v_b
    FROM extensions.dblink_get_result('c77_conc') AS t(tenant uuid);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION '0077 T04c falhou: 2a sessao errou (%)', v_err;
  END IF;
  IF v_b IS NULL THEN
    RAISE EXCEPTION '0077 T04c falhou: 2a sessao nao devolveu tenant';
  END IF;
  IF v_b <> v_a THEN
    RAISE EXCEPTION '0077 T04c falhou: sessoes devolveram tenants diferentes (% vs %)', v_a, v_b;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.tenants
  WHERE owner_user_id = 'c7700000-0000-4000-8000-0000000000c5'
    AND cpf = '77100000963';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T04c falhou: % tenant(s) apos a corrida (esperado 1)', v_n;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.tenant_subscriptions AS s
  JOIN public.tenants AS t ON t.id = s.tenant_id
  WHERE t.owner_user_id = 'c7700000-0000-4000-8000-0000000000c5'
    AND t.cpf = '77100000963';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T04c falhou: % assinatura(s) apos a corrida (esperado 1)', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_members WHERE tenant_id = v_a;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T04c falhou: % membership(s) apos a corrida (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.contract_acceptances WHERE tenant_id = v_a;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0077 T04c falhou: % aceite(s) apos a corrida (esperado 1)', v_n;
  END IF;

  SELECT count(*) INTO v_prov
  FROM public.admin_audit
  WHERE reason = 'tenant_onboard_provisioned' AND target_id = v_a;
  SELECT count(*) INTO v_reused
  FROM public.admin_audit
  WHERE reason = 'tenant_onboard_reused' AND target_id = v_a AND tenant_id = v_a;
  IF v_prov <> 1 OR v_reused <> 1 THEN
    RAISE EXCEPTION '0077 T04c falhou: trilha provisioned=% reused=% (esperado 1/1)', v_prov, v_reused;
  END IF;

  RAISE NOTICE '0077 T04c ok: corrida real (2 conexoes) => mesmo tenant_id, 1 tenant/1 assinatura, 1 provisioned + 1 reused';
END $$;

SELECT extensions.dblink_disconnect('c77_conc');

-- ============ T05 — autoprovisionamento ⇒ tenant-owner-invalid ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      'c7700000-0000-4000-8000-0000000000a1',
      'pf', '77100000530', 'Self 0077', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free');
    RAISE EXCEPTION '0077 T05 falhou: self-provision passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0077 T05 falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.errT05', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.errT05');
  v_n int;
BEGIN
  IF v_err <> 'tenant-owner-invalid' THEN
    RAISE EXCEPTION '0077 T05 falhou: rotulo (%)', v_err;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.tenants WHERE owner_user_id = 'c7700000-0000-4000-8000-0000000000a1';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05 falhou: % tenant(s) do operador (esperado 0)', v_n;
  END IF;
  RAISE NOTICE '0077 T05 ok: convidado = operador -> tenant-owner-invalid, 0 tenant';
END $$;
ROLLBACK;

-- ============ T05b — atomicidade ============
-- (1/3) plano inválido: falha de validação ⇒ 0 em todas as tabelas.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      'c7700000-0000-4000-8000-0000000000c4',
      'pf', '77100000530', 'Plano Invalido 0077', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'gold');
    RAISE EXCEPTION '0077 T05b falhou: plano invalido passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0077 T05b falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.errT05b', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.errT05b');
  v_n int;
BEGIN
  IF v_err <> 'tenant-plan-invalid' THEN
    RAISE EXCEPTION '0077 T05b falhou: rotulo (%)', v_err;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.tenants WHERE owner_user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % tenant(s) apos plano invalido', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_members AS tm
  JOIN public.profiles AS p ON p.id = tm.user_id
  WHERE p.id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % membership(s) apos plano invalido', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.contract_acceptances
  WHERE user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % aceite(s) apos plano invalido', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions AS s
  JOIN public.tenants AS t ON t.id = s.tenant_id
  WHERE t.owner_user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % assinatura(s) apos plano invalido', v_n;
  END IF;
  RAISE NOTICE '0077 T05b ok (1/3): plano invalido -> 0 tenant/0 membership/0 aceite/0 assinatura';
END $$;
ROLLBACK;

-- (2/3) falha injetada DEPOIS do INSERT de `tenants` (e do membership e do
-- aceite): um CHECK temporário em tenant_subscriptions obriga o rollback do
-- sub-bloco inteiro ⇒ 0 nas 4 tabelas. A constraint é removida por ROLLBACK.
BEGIN;
ALTER TABLE public.tenant_subscriptions
  ADD CONSTRAINT c77_inject_fail CHECK (false) NOT VALID;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      'c7700000-0000-4000-8000-0000000000c4',
      'pf', '77100000530', 'Falha Injetada 0077', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free');
    RAISE EXCEPTION '0077 T05b falhou: falha injetada nao ocorreu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0077 T05b falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.errT05b2', SQLERRM, true);
  END;
END $$;
RESET ROLE;

ALTER TABLE public.tenant_subscriptions DROP CONSTRAINT c77_inject_fail;

DO $$
DECLARE
  v_n int;
  v_subs int;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.tenants WHERE owner_user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % tenant(s) sobreviveram a falha injetada', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.tenant_members WHERE user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % membership(s) sobreviveram a falha injetada', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.contract_acceptances WHERE user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % aceite(s) sobreviveram a falha injetada', v_n;
  END IF;
  SELECT count(*) INTO v_subs
  FROM public.tenant_subscriptions AS s
  JOIN public.tenants AS t ON t.id = s.tenant_id
  WHERE t.owner_user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_subs <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % assinatura(s) sobreviveram a falha injetada', v_subs;
  END IF;
  RAISE NOTICE '0077 T05b ok (2/3): falha apos INSERT de tenants -> rollback total (0/0/0/0)';
END $$;
ROLLBACK;

-- (3/3) falha injetada na ÚLTIMA escrita da RPC (`admin_audit`), DEPOIS das 4
-- tabelas: um CHECK temporário recusa a trilha `tenant_onboard_provisioned` ⇒
-- rollback das 4 tabelas **e** da trilha (o 5º registro). `NOT VALID` porque o
-- T04c deixou trilha comitada; a constraint vale para INSERTs novos e sai por
-- ROLLBACK. A contagem de `admin_audit` é o assert de que a trilha foi desfeita.
BEGIN;
ALTER TABLE public.admin_audit
  ADD CONSTRAINT c77_inject_fail_audit
  CHECK (reason IS DISTINCT FROM 'tenant_onboard_provisioned') NOT VALID;

DO $$
DECLARE
  v_before bigint;
BEGIN
  SELECT count(*) INTO v_before FROM public.admin_audit;
  PERFORM set_config('test.t05b3_audit', v_before::text, true);
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7700000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7700000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      'c7700000-0000-4000-8000-0000000000c4',
      'pf', '77100000530', 'Trilha Injetada 0077', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free');
    RAISE EXCEPTION '0077 T05b falhou: falha na trilha nao ocorreu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0077 T05b falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.errT05b3', SQLERRM, true);
  END;
END $$;
RESET ROLE;

ALTER TABLE public.admin_audit DROP CONSTRAINT c77_inject_fail_audit;

DO $$
DECLARE
  v_err text := current_setting('test.errT05b3', true);
  v_before bigint := current_setting('test.t05b3_audit')::bigint;
  v_after bigint;
  v_n int;
BEGIN
  IF v_err IS DISTINCT FROM 'tenant-data-invalid' THEN
    RAISE EXCEPTION '0077 T05b falhou: rotulo da falha na trilha (%)', v_err;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.tenants WHERE owner_user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % tenant(s) sobreviveram a falha na trilha', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.tenant_members WHERE user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % membership(s) sobreviveram a falha na trilha', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.contract_acceptances WHERE user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % aceite(s) sobreviveram a falha na trilha', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.tenant_subscriptions AS s
  JOIN public.tenants AS t ON t.id = s.tenant_id
  WHERE t.owner_user_id = 'c7700000-0000-4000-8000-0000000000c4';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0077 T05b falhou: % assinatura(s) sobreviveram a falha na trilha', v_n;
  END IF;

  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0077 T05b falhou: trilha sobreviveu a falha injetada (% -> %)', v_before, v_after;
  END IF;

  RAISE NOTICE '0077 T05b ok (3/3): falha na ULTIMA escrita -> rollback das 4 tabelas + trilha desfeita';
END $$;
ROLLBACK;

-- ============ Fixtures cleanup (fim; rerunnable) ============

BEGIN;
SET LOCAL app.card_purge = 'on';
DO $$
DECLARE
  v_users uuid[] := ARRAY[
    'c7700000-0000-4000-8000-0000000000a1',
    'c7700000-0000-4000-8000-0000000000b1',
    'c7700000-0000-4000-8000-0000000000c1',
    'c7700000-0000-4000-8000-0000000000c2',
    'c7700000-0000-4000-8000-0000000000c3',
    'c7700000-0000-4000-8000-0000000000c4',
    'c7700000-0000-4000-8000-0000000000c5'
  ]::uuid[];
  v_has_immutable boolean;
BEGIN
  IF to_regclass('public.tenant_subscriptions') IS NOT NULL THEN
    DELETE FROM public.tenant_subscriptions AS s
    USING public.tenants AS t
    WHERE s.tenant_id = t.id
      AND t.owner_user_id = ANY(v_users);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'contract_acceptances_immutable' AND NOT tgisinternal
  ) INTO v_has_immutable;
  IF v_has_immutable THEN
    ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
  END IF;

  DELETE FROM public.admin_audit AS a
  USING public.tenants AS t
  WHERE t.owner_user_id = ANY(v_users)
    AND (a.tenant_id = t.id OR a.target_id = t.id);

  DELETE FROM public.tenants WHERE owner_user_id = ANY(v_users);
  DELETE FROM public.admin_audit WHERE target_id = ANY(v_users);

  IF v_has_immutable THEN
    ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
  END IF;
END $$;
DELETE FROM public.internal_operators
WHERE user_id = ANY (ARRAY[
  'c7700000-0000-4000-8000-0000000000a1',
  'c7700000-0000-4000-8000-0000000000b1',
  'c7700000-0000-4000-8000-0000000000c1',
  'c7700000-0000-4000-8000-0000000000c2',
  'c7700000-0000-4000-8000-0000000000c3',
  'c7700000-0000-4000-8000-0000000000c4',
  'c7700000-0000-4000-8000-0000000000c5'
]::uuid[]);
DELETE FROM auth.users
WHERE id = ANY (ARRAY[
  'c7700000-0000-4000-8000-0000000000a1',
  'c7700000-0000-4000-8000-0000000000b1',
  'c7700000-0000-4000-8000-0000000000c1',
  'c7700000-0000-4000-8000-0000000000c2',
  'c7700000-0000-4000-8000-0000000000c3',
  'c7700000-0000-4000-8000-0000000000c4',
  'c7700000-0000-4000-8000-0000000000c5'
]::uuid[]);
COMMIT;

-- ============================================================================
-- BLOCO B2 — `0078_tenant_onboarding_invite_ledger.sql` (BE-23)
-- T06, T06b, T06c, T07, T07b, T11, T16, T17.
-- Rastreabilidade: REQ-09 (lista derivada), REQ-10 (cancelamento), REQ-11
-- (registro idempotente 60 min), REQ-14 (cota 20/h por operador), REQ-21 (sem
-- PII), REQ-22 (clamp/desempate), REQ-23 (definer/search_path/ACL);
-- invariantes I5 (idempotência), I6 (pendente DERIVADO, sem tabela nova),
-- I7 (cancelar nunca apaga tenant).
--
-- Derivação (I6): `invite-pending` = existe `tenant_onboard_invite_requested`
-- para o alvo, nenhuma `tenant_onboard_invite_cancelled` posterior, nenhum
-- `tenants.owner_user_id` e `profiles` presente. Leitura NÃO escreve trilha.
--
-- Fixtures `c7800000-…` (operadores/alvos, sufixo `0000000000XX`),
-- `…0000000000NN` (alvos numéricos da cota) e `c7810000-…` (lote de 105 do
-- clamp). Todo cenário mutável roda em BEGIN/ROLLBACK ⇒ 0 resíduo.
-- ============================================================================

-- ============ B2.0 — Fixtures cleanup (início; rerunnable) ============

BEGIN;
DO $$
BEGIN
  DELETE FROM public.admin_audit
  WHERE target_id::text LIKE 'c7800000-%'
     OR target_id::text LIKE 'c7810000-%';
  DELETE FROM public.tenants WHERE owner_user_id::text LIKE 'c7800000-%';
  DELETE FROM public.internal_operators WHERE user_id::text LIKE 'c7800000-%';
  DELETE FROM auth.users
  WHERE id::text LIKE 'c7800000-%'
     OR id::text LIKE 'c7810000-%';
END $$;
COMMIT;

-- ============ B2.1 — Fixtures ============

INSERT INTO auth.users (id, email) VALUES
  ('c7800000-0000-4000-8000-0000000000a1', 'op1-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000a2', 'op2-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000a3', 'op3-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000a4', 'op4-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000b1', 'common-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d1', 'invitee-d1-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d2', 'invitee-d2-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d3', 'invitee-d3-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d4', 'invitee-d4-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d5', 'invitee-d5-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d6', 'invitee-d6-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d7', 'invitee-d7-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d8', 'invitee-d8-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000d9', 'invitee-d9-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000f1', 'invitee-f1-0078@example.com'),
  ('c7800000-0000-4000-8000-0000000000f2', 'invitee-f2-0078@example.com');

-- 21 alvos numéricos (cota: 20 registros + a 21ª chamada).
INSERT INTO auth.users (id, email)
SELECT ('c7800000-0000-4000-8000-' || pg_catalog.lpad(i::text, 12, '0'))::uuid,
       'invitee-n78-' || i || '@example.com'
FROM pg_catalog.generate_series(1, 21) AS i;

UPDATE public.profiles SET role = 'super_admin'
WHERE id IN (
  'c7800000-0000-4000-8000-0000000000a1',
  'c7800000-0000-4000-8000-0000000000a2',
  'c7800000-0000-4000-8000-0000000000a3',
  'c7800000-0000-4000-8000-0000000000a4'
);

INSERT INTO public.internal_operators (user_id, active) VALUES
  ('c7800000-0000-4000-8000-0000000000a1', true),
  ('c7800000-0000-4000-8000-0000000000a2', true),
  ('c7800000-0000-4000-8000-0000000000a3', true),
  ('c7800000-0000-4000-8000-0000000000a4', true);

-- Promoção/ativação não entram nas contagens de trilha dos cenários.
DELETE FROM public.admin_audit
WHERE target_id::text LIKE 'c7800000-%';

-- ============ T06 (1/2) — estrutura: 4 RPCs, definer/ACL, forma sem e-mail ============

DO $$
DECLARE
  v_names text[] := ARRAY[
    'admin_invite_quota', 'admin_record_invite',
    'admin_cancel_invite', 'admin_list_pending_invites'
  ];
  v_name text;
  v_proc pg_catalog.pg_proc;
  v_n int;
  v_result text;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT count(*) INTO v_n
    FROM pg_catalog.pg_proc
    WHERE proname = v_name
      AND pronamespace = 'public'::regnamespace
      AND prokind = 'f';
    IF v_n <> 1 THEN
      RAISE EXCEPTION '0078 T06 falhou: % assinatura(s) de % (esperado 1)', v_n, v_name;
    END IF;
  END LOOP;

  FOR v_proc IN
    SELECT * FROM pg_catalog.pg_proc
    WHERE proname = ANY (v_names)
      AND pronamespace = 'public'::regnamespace
  LOOP
    IF v_proc.prosecdef IS DISTINCT FROM true THEN
      RAISE EXCEPTION '0078 T06 falhou: % sem SECURITY DEFINER', v_proc.proname;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION '0078 T06 falhou: % sem search_path vazio travado', v_proc.proname;
    END IF;
    IF NOT has_function_privilege('authenticated', v_proc.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '0078 T06 falhou: authenticated sem EXECUTE em %', v_proc.proname;
    END IF;
    IF has_function_privilege('anon', v_proc.oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_proc.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '0078 T06 falhou: EXECUTE para anon/service_role em %', v_proc.proname;
    END IF;
  END LOOP;

  -- Forma exata da lista: 4 colunas, NENHUMA de e-mail/nome/documento.
  SELECT pg_catalog.pg_get_function_result(
    'public.admin_list_pending_invites(int,int)'::regprocedure
  ) INTO v_result;
  IF v_result IS DISTINCT FROM
     'TABLE(invited_user_id uuid, requested_at timestamp with time zone, age_hours integer, state text)'
  THEN
    RAISE EXCEPTION '0078 T06 falhou: forma da lista (%)', v_result;
  END IF;

  SELECT pronargs INTO v_n
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_list_pending_invites(int,int)'::regprocedure;
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0078 T06 falhou: lista com % args (esperado 2)', v_n;
  END IF;
  SELECT pronargdefaults INTO v_n
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_list_pending_invites(int,int)'::regprocedure;
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0078 T06 falhou: lista com % defaults (esperado 2)', v_n;
  END IF;
  IF (SELECT proargnames FROM pg_catalog.pg_proc
      WHERE oid = 'public.admin_list_pending_invites(int,int)'::regprocedure)
     IS DISTINCT FROM ARRAY[
       'p_limit', 'p_offset', 'invited_user_id', 'requested_at', 'age_hours', 'state'
     ] THEN
    RAISE EXCEPTION '0078 T06 falhou: nomes das colunas divergentes';
  END IF;

  SELECT prorettype::regtype::text INTO v_result
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_record_invite(uuid)'::regprocedure;
  IF v_result <> 'void' THEN
    RAISE EXCEPTION '0078 T06 falhou: admin_record_invite retorna % (esperado void)', v_result;
  END IF;
  SELECT prorettype::regtype::text INTO v_result
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_invite_quota()'::regprocedure;
  IF v_result <> 'integer' THEN
    RAISE EXCEPTION '0078 T06 falhou: admin_invite_quota retorna % (esperado integer)', v_result;
  END IF;
  SELECT prorettype::regtype::text INTO v_result
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_cancel_invite(uuid)'::regprocedure;
  IF v_result <> 'boolean' THEN
    RAISE EXCEPTION '0078 T06 falhou: admin_cancel_invite retorna % (esperado boolean)', v_result;
  END IF;

  -- REQ-24: ledger derivado — nenhuma tabela nova no schema exposto.
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname = 'public'
    AND (c.relname LIKE '%invite%' OR c.relname LIKE '%onboarding%');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0078 T06 falhou: % tabela(s) de convite/onboarding (esperado 0)', v_n;
  END IF;

  RAISE NOTICE '0078 T06 ok (1/2): 4 RPCs DEFINER/search_path vazio/ACL authenticated-only; lista com 4 colunas (sem e-mail); 0 tabela nova';
END $$;

-- ============ T06 (2/2) — lista derivada: só pedidos, ordem e idade ============

BEGIN;
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at) VALUES
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d1',
   'other', 'tenant_onboard_invite_requested', now() - interval '20 minutes'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d2',
   'other', 'tenant_onboard_invite_requested', now() - interval '3 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d2',
   'other', 'tenant_onboard_invite_requested', now() - interval '2 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d3',
   'other', 'tenant_onboard_invite_requested', now() - interval '5 hours');

DO $$
BEGIN
  PERFORM set_config('test.b2_audit_before',
    (SELECT count(*) FROM public.admin_audit)::text, true);
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
  v_arr uuid[];
  v_state text;
  v_age int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_list_pending_invites(20, 0);
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0078 T06 falhou: % pendente(s) (esperado 3)', v_n;
  END IF;

  SELECT pg_catalog.array_agg(x.invited_user_id) INTO v_arr
  FROM public.admin_list_pending_invites(20, 0) AS x;
  IF v_arr <> ARRAY[
    'c7800000-0000-4000-8000-0000000000d1',
    'c7800000-0000-4000-8000-0000000000d2',
    'c7800000-0000-4000-8000-0000000000d3'
  ]::uuid[] THEN
    RAISE EXCEPTION '0078 T06 falhou: ordem (%)', v_arr;
  END IF;
  IF 'c7800000-0000-4000-8000-0000000000d4'::uuid = ANY (v_arr) THEN
    RAISE EXCEPTION '0078 T06 falhou: alvo sem trilha apareceu na lista';
  END IF;

  SELECT x.state, x.age_hours INTO v_state, v_age
  FROM public.admin_list_pending_invites(20, 0) AS x
  WHERE x.invited_user_id = 'c7800000-0000-4000-8000-0000000000d2';
  IF v_state IS DISTINCT FROM 'invite-pending' THEN
    RAISE EXCEPTION '0078 T06 falhou: state (%)', v_state;
  END IF;
  IF v_age <> 2 THEN
    RAISE EXCEPTION '0078 T06 falhou: age_hours % (esperado 2)', v_age;
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_before bigint := current_setting('test.b2_audit_before')::bigint;
  v_after bigint;
BEGIN
  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0078 T06 falhou: leitura escreveu trilha (% -> %)', v_before, v_after;
  END IF;
  RAISE NOTICE '0078 T06 ok (2/2): pendentes derivados (3), requested_at DESC, state/age_hours, leitura sem escrita';
END $$;
ROLLBACK;

-- ============ T06b — clamp 1..100 e desempate por UUID ============

-- (1/2) clamp: 105 pendentes (lote gerado) + limites.
BEGIN;
INSERT INTO auth.users (id, email)
SELECT ('c7810000-0000-4000-8000-' || pg_catalog.lpad(i::text, 12, '0'))::uuid,
       'bulk78-' || i || '@example.com'
FROM pg_catalog.generate_series(1, 105) AS i;

INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at)
SELECT 'c7800000-0000-4000-8000-0000000000a1',
       ('c7810000-0000-4000-8000-' || pg_catalog.lpad(i::text, 12, '0'))::uuid,
       'other', 'tenant_onboard_invite_requested', now() - interval '30 minutes'
FROM pg_catalog.generate_series(1, 105) AS i;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_list_pending_invites(1000, 0);
  IF v_n <> 100 THEN
    RAISE EXCEPTION '0078 T06b falhou: p_limit=1000 devolveu % (esperado 100 pelo clamp)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_list_pending_invites(0, 0);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T06b falhou: p_limit=0 devolveu % (esperado 1 pelo clamp)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_list_pending_invites(-5, -10);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T06b falhou: p_limit negativo/offset negativo devolveu % (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_list_pending_invites(NULL, NULL);
  IF v_n <> 20 THEN
    RAISE EXCEPTION '0078 T06b falhou: defaults devolveram % (esperado 20)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_list_pending_invites(20, 1000);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0078 T06b falhou: offset alem do total devolveu % (esperado 0)', v_n;
  END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE '0078 T06b ok (1/2): clamp 1..100, offset>=0 e defaults (20/0)';
END $$;
ROLLBACK;

-- (2/2) desempate determinístico: mesmo `requested_at` ⇒ UUID ASC.
BEGIN;
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at) VALUES
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d7',
   'other', 'tenant_onboard_invite_requested', now() - interval '2 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d5',
   'other', 'tenant_onboard_invite_requested', now() - interval '2 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d6',
   'other', 'tenant_onboard_invite_requested', now() - interval '2 hours');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_arr uuid[];
  v_ages int[];
BEGIN
  SELECT pg_catalog.array_agg(x.invited_user_id), pg_catalog.array_agg(x.age_hours)
  INTO v_arr, v_ages
  FROM public.admin_list_pending_invites(20, 0) AS x;
  IF v_arr <> ARRAY[
    'c7800000-0000-4000-8000-0000000000d5',
    'c7800000-0000-4000-8000-0000000000d6',
    'c7800000-0000-4000-8000-0000000000d7'
  ]::uuid[] THEN
    RAISE EXCEPTION '0078 T06b falhou: desempate por UUID divergente (%)', v_arr;
  END IF;
  IF v_ages <> ARRAY[2, 2, 2] THEN
    RAISE EXCEPTION '0078 T06b falhou: age_hours (%)', v_ages;
  END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE '0078 T06b ok (2/2): empate de requested_at desempatado por invited_user_id ASC';
END $$;
ROLLBACK;

-- ============ T06c — derivação: cancelado, tenant, profile apagado ============

BEGIN;
-- d1: pedido 3h, cancelado 2h, re-pedido 1h ⇒ PENDENTE (reconvite).
-- d2: pedido 3h, cancelado 2h ⇒ NÃO pendente.
-- d3: pedido 3h + tenant existente ⇒ NÃO pendente (I7).
-- d4: pedido 3h + profile apagado ⇒ NÃO pendente.
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at) VALUES
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d1',
   'other', 'tenant_onboard_invite_requested', now() - interval '3 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d1',
   'other', 'tenant_onboard_invite_cancelled', now() - interval '2 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d1',
   'other', 'tenant_onboard_invite_requested', now() - interval '1 hour'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d2',
   'other', 'tenant_onboard_invite_requested', now() - interval '3 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d2',
   'other', 'tenant_onboard_invite_cancelled', now() - interval '2 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d3',
   'other', 'tenant_onboard_invite_requested', now() - interval '3 hours'),
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d4',
   'other', 'tenant_onboard_invite_requested', now() - interval '3 hours');

INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social)
VALUES ('pf', 'c7800000-0000-4000-8000-0000000000d3', '78000000003', 'Derivacao 0078');

DELETE FROM public.profiles WHERE id = 'c7800000-0000-4000-8000-0000000000d4';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_arr uuid[];
  v_age int;
BEGIN
  SELECT pg_catalog.array_agg(x.invited_user_id) INTO v_arr
  FROM public.admin_list_pending_invites(20, 0) AS x;
  IF v_arr <> ARRAY['c7800000-0000-4000-8000-0000000000d1']::uuid[] THEN
    RAISE EXCEPTION '0078 T06c falhou: pendentes derivados (%)', v_arr;
  END IF;
  SELECT x.age_hours INTO v_age
  FROM public.admin_list_pending_invites(20, 0) AS x;
  IF v_age <> 1 THEN
    RAISE EXCEPTION '0078 T06c falhou: age_hours do reconvite % (esperado 1)', v_age;
  END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE '0078 T06c ok: cancelado excluido, reconvite incluido, tenant excluido (I7), profile apagado excluido';
END $$;
ROLLBACK;

-- ============ T06d — tenant `canceled` NÃO esconde o convite (A2) ============
-- Alinhamento com o REUSO de `0077` (REQ-06): a chave natural `(owner,
-- documento)` só considera tenant NÃO cancelado. Logo, dono de tenant
-- `canceled` continua convite pendente — o mesmo predicado vale na lista.

BEGIN;
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at) VALUES
  ('c7800000-0000-4000-8000-0000000000a1', 'c7800000-0000-4000-8000-0000000000d9',
   'other', 'tenant_onboard_invite_requested', now() - interval '3 hours');

INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, subscription_status)
VALUES ('pf', 'c7800000-0000-4000-8000-0000000000d9', '78000000099',
        'Cancelado 0078', 'canceled');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.admin_list_pending_invites(20, 0) AS x
  WHERE x.invited_user_id = 'c7800000-0000-4000-8000-0000000000d9';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T06d falhou: dono de tenant cancelado fora da lista (%)', v_n;
  END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE '0078 T06d ok: tenant canceled nao esconde o convite (alinha reuso de 0077)';
END $$;
ROLLBACK;

-- ============ T07 — cancelar: true + 1 linha; 2ª chamada false/0 escrita ============

BEGIN;
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at)
VALUES ('c7800000-0000-4000-8000-0000000000a1',
        'c7800000-0000-4000-8000-0000000000d1',
        'other', 'tenant_onboard_invite_requested', now() - interval '30 minutes');

DO $$
BEGIN
  PERFORM set_config('test.t07_before',
    (SELECT count(*) FROM public.admin_audit)::text, true);
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_first boolean;
  v_second boolean;
  v_left int;
BEGIN
  v_first := public.admin_cancel_invite('c7800000-0000-4000-8000-0000000000d1');
  v_second := public.admin_cancel_invite('c7800000-0000-4000-8000-0000000000d1');
  IF v_first IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0078 T07 falhou: 1a chamada devolveu % (esperado true)', v_first;
  END IF;
  IF v_second IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0078 T07 falhou: 2a chamada devolveu % (esperado false)', v_second;
  END IF;
  SELECT count(*) INTO v_left
  FROM public.admin_list_pending_invites(20, 0) AS x
  WHERE x.invited_user_id = 'c7800000-0000-4000-8000-0000000000d1';
  IF v_left <> 0 THEN
    RAISE EXCEPTION '0078 T07 falhou: convite cancelado continua pendente';
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_before bigint := current_setting('test.t07_before')::bigint;
  v_after bigint;
  v_n int;
BEGIN
  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION '0078 T07 falhou: trilha % -> % (esperado +1)', v_before, v_after;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE reason = 'tenant_onboard_invite_cancelled'
    AND target_id = 'c7800000-0000-4000-8000-0000000000d1'
    AND actor_id = 'c7800000-0000-4000-8000-0000000000a1'
    AND tenant_id IS NULL
    AND action = 'other';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T07 falhou: % linha(s) de cancelamento (esperado 1)', v_n;
  END IF;
  RAISE NOTICE '0078 T07 ok: cancelar devolve true + 1 trilha; 2a chamada false e 0 escrita; sai da lista';
END $$;
ROLLBACK;

-- ============ T07b — cancelar sem pendência / com tenant ============

BEGIN;
-- d1: tenant existente ⇒ invite-not-pending (I7: cancelar nunca apaga tenant).
INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social)
VALUES ('pf', 'c7800000-0000-4000-8000-0000000000d1', '78000000011', 'Com Tenant 0078');

DO $$
BEGIN
  PERFORM set_config('test.t07b_before',
    (SELECT count(*) FROM public.admin_audit)::text, true);
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_cancel_invite('c7800000-0000-4000-8000-0000000000d1');
    RAISE EXCEPTION '0078 T07b falhou: cancelou convidado com tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0078 T07b falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.t07b_err', SQLERRM, true);
  END;

  -- d2 sem trilha e p_target NULL ⇒ false, sem erro.
  PERFORM set_config('test.t07b_none',
    public.admin_cancel_invite('c7800000-0000-4000-8000-0000000000d2')::text, true);
  PERFORM set_config('test.t07b_null',
    public.admin_cancel_invite(NULL)::text, true);
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.t07b_err');
  v_none text := current_setting('test.t07b_none');
  v_null text := current_setting('test.t07b_null');
  v_before bigint := current_setting('test.t07b_before')::bigint;
  v_after bigint;
  v_n int;
BEGIN
  IF v_err <> 'invite-not-pending' THEN
    RAISE EXCEPTION '0078 T07b falhou: rotulo com tenant (%)', v_err;
  END IF;
  IF v_none <> 'false' OR v_null <> 'false' THEN
    RAISE EXCEPTION '0078 T07b falhou: sem pendencia devolveu (% / %)', v_none, v_null;
  END IF;
  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0078 T07b falhou: escrita indevida (% -> %)', v_before, v_after;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.tenants WHERE owner_user_id = 'c7800000-0000-4000-8000-0000000000d1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T07b falhou: tenant do convidado foi afetado (%)', v_n;
  END IF;
  RAISE NOTICE '0078 T07b ok: com tenant -> invite-not-pending; sem pendencia/NULL -> false; 0 escrita; tenant intacto';
END $$;
ROLLBACK;

-- ============ T07c — cancelar e reconvidar <60 min grava trilha (A1) ============
-- Fim do convite invisível: o retry idempotente passa a olhar o ESTADO. Pedido
-- com `invite_cancelled` POSTERIOR não bloqueia o reconvite, e o alvo volta à
-- lista derivada. O consumo NÃO é devolvido (C1) — mas o novo pedido consome.

BEGIN;
-- Pedido inicial semeado 30 min atrás (controle de `at`: dentro de uma única
-- transação `now()` é o início, e o predicado "cancelamento posterior" precisa
-- de ordem observável). Cancelamento e reconvite passam pelas RPCs.
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at)
VALUES ('c7800000-0000-4000-8000-0000000000a1',
        'c7800000-0000-4000-8000-0000000000d5',
        'other', 'tenant_onboard_invite_requested', now() - interval '30 minutes');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  PERFORM set_config('test.t07c_cancel',
    public.admin_cancel_invite('c7800000-0000-4000-8000-0000000000d5')::text, true);
  PERFORM public.admin_record_invite('c7800000-0000-4000-8000-0000000000d5');
  PERFORM set_config('test.t07c_q', public.admin_invite_quota()::text, true);
END $$;
RESET ROLE;

DO $$
DECLARE
  v_cancel text := current_setting('test.t07c_cancel');
  v_q int := current_setting('test.t07c_q')::int;
  v_req int;
  v_cancel_rows int;
  v_n int;
BEGIN
  IF v_cancel <> 'true' THEN
    RAISE EXCEPTION '0078 T07c falhou: cancelamento inicial nao ocorreu (%)', v_cancel;
  END IF;

  SELECT count(*) INTO v_req
  FROM public.admin_audit
  WHERE actor_id = 'c7800000-0000-4000-8000-0000000000a1'
    AND target_id = 'c7800000-0000-4000-8000-0000000000d5'
    AND action = 'other'
    AND reason = 'tenant_onboard_invite_requested';
  IF v_req <> 2 THEN
    RAISE EXCEPTION '0078 T07c falhou: % pedido(s) apos reconvite (esperado 2)', v_req;
  END IF;

  SELECT count(*) INTO v_cancel_rows
  FROM public.admin_audit
  WHERE actor_id = 'c7800000-0000-4000-8000-0000000000a1'
    AND target_id = 'c7800000-0000-4000-8000-0000000000d5'
    AND action = 'other'
    AND reason = 'tenant_onboard_invite_cancelled';
  IF v_cancel_rows <> 1 THEN
    RAISE EXCEPTION '0078 T07c falhou: % cancelamento(s) (esperado 1)', v_cancel_rows;
  END IF;

  -- C1: o gasto é durável — 2 pedidos na janela ⇒ cota 18 (cancelar não devolve).
  IF v_q <> 18 THEN
    RAISE EXCEPTION '0078 T07c falhou: cota % (esperado 18: cancelar nao devolve)', v_q;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.admin_list_pending_invites(20, 0) AS x
  WHERE x.invited_user_id = 'c7800000-0000-4000-8000-0000000000d5';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T07c falhou: alvo reconvidado fora da lista (%)', v_n;
  END IF;

  RAISE NOTICE '0078 T07c ok: cancelar+reconvidar <60min grava 2o pedido, alvo volta a lista, exige 2 de cota';
END $$;
ROLLBACK;

-- ============ T07d — alvo com MEMBERSHIP (não-owner) ⇒ invite-not-pending ============
-- O apagamento de membro passava pela borda: `admin_cancel_invite` só recusava
-- quando o alvo era `owner_user_id` de algum tenant; para `member`/`admin`
-- devolvia `false` e a Edge chamava `auth.admin.deleteUser` — o cascade
-- `profiles -> tenant_members` apagava o vínculo sem trilha. A recusa agora é
-- por QUALQUER membership (0081): cancelar/deletar membro é decisão do
-- operador no painel de tenants, nunca um DELETE de usuário.

BEGIN;
INSERT INTO public.tenants (id, kind, owner_user_id, cpf, razao_social)
VALUES ('c7800000-0000-4000-8000-00000000e001', 'pf',
        'c7800000-0000-4000-8000-0000000000b1', '78000000071', 'Membro 0078');
INSERT INTO public.tenant_members (tenant_id, user_id, role)
VALUES ('c7800000-0000-4000-8000-00000000e001',
        'c7800000-0000-4000-8000-0000000000d2', 'member');
-- Pendência derivada criada ANTES da membership: sem ela a recusa poderia ser
-- confundida com "sem convite pendente" (`false`).
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at)
VALUES ('c7800000-0000-4000-8000-0000000000a1',
        'c7800000-0000-4000-8000-0000000000d2',
        'other', 'tenant_onboard_invite_requested', now() - interval '30 minutes');

DO $$
BEGIN
  PERFORM set_config('test.t07d_before',
    (SELECT count(*) FROM public.admin_audit)::text, true);
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_cancel_invite('c7800000-0000-4000-8000-0000000000d2');
    RAISE EXCEPTION '0078 T07d falhou: cancelou convidado que e MEMBRO';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0078 T07d falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.t07d_err', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.t07d_err');
  v_before bigint := current_setting('test.t07d_before')::bigint;
  v_after bigint;
  v_n int;
BEGIN
  IF v_err <> 'invite-not-pending' THEN
    RAISE EXCEPTION '0078 T07d falhou: rotulo do membro (%)', v_err;
  END IF;

  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0078 T07d falhou: escrita indevida (% -> %)', v_before, v_after;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = 'c7800000-0000-4000-8000-00000000e001'::uuid
    AND user_id = 'c7800000-0000-4000-8000-0000000000d2'::uuid
    AND role = 'member';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T07d falhou: membership do alvo alterada (%)', v_n;
  END IF;

  RAISE NOTICE '0078 T07d ok: alvo com membership (member) => invite-not-pending, 0 escrita, vinculo intacto';
END $$;
ROLLBACK;

-- ============ T11 — admin_record_invite: idempotente 60 min, alvo e gate ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  PERFORM public.admin_record_invite('c7800000-0000-4000-8000-0000000000d1');
  PERFORM public.admin_record_invite('c7800000-0000-4000-8000-0000000000d1');
END $$;
RESET ROLE;

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE reason = 'tenant_onboard_invite_requested'
    AND target_id = 'c7800000-0000-4000-8000-0000000000d1'
    AND actor_id = 'c7800000-0000-4000-8000-0000000000a1'
    AND tenant_id IS NULL
    AND action = 'other'
    AND at > now() - interval '60 minutes';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T11 falhou: % linha(s) apos retry <60min (esperado 1)', v_n;
  END IF;
END $$;

-- Alvo inexistente em profiles ⇒ invite-target-invalid, 0 escrita.
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.admin_record_invite('c7800000-0000-4000-8000-0000000000ee');
    RAISE EXCEPTION '0078 T11 falhou: alvo inexistente passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0078 T11 falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.t11_err', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.t11_err');
  v_n int;
BEGIN
  IF v_err <> 'invite-target-invalid' THEN
    RAISE EXCEPTION '0078 T11 falhou: rotulo de alvo inexistente (%)', v_err;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE target_id = 'c7800000-0000-4000-8000-0000000000ee';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0078 T11 falhou: % linha(s) para alvo inexistente', v_n;
  END IF;
END $$;

-- Não-admin ⇒ not-admin, 0 escrita.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.admin_record_invite('c7800000-0000-4000-8000-0000000000d2');
    RAISE EXCEPTION '0078 T11 falhou: nao-admin registrou convite';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0078 T11 falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.t11_err2', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.t11_err2');
  v_n int;
BEGIN
  IF v_err <> 'not-admin' THEN
    RAISE EXCEPTION '0078 T11 falhou: rotulo para nao-admin (%)', v_err;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE target_id = 'c7800000-0000-4000-8000-0000000000d2'
    AND reason = 'tenant_onboard_invite_requested';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0078 T11 falhou: % linha(s) escritas por nao-admin', v_n;
  END IF;
  RAISE NOTICE '0078 T11 ok: 1 linha em retry <60min; alvo inexistente -> invite-target-invalid; nao-admin -> not-admin; 0 escrita nos dois';
END $$;
ROLLBACK;

-- ============ T11b — alvo com tenant VIVO ⇒ curto-circuito (A2) ============
-- `admin_record_invite` não consome cota nem grava para quem já tem tenant vivo
-- (contrato `tenant-already-onboarded`, documentado em COMMENT). Tenant
-- `canceled` NÃO curto-circuita (mesma chave do reuso de `0077`).

BEGIN;
INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social)
VALUES ('pf', 'c7800000-0000-4000-8000-0000000000d9', '78000000099', 'Vivo 0078');

INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social, subscription_status)
VALUES ('pf', 'c7800000-0000-4000-8000-0000000000d8', '78000000088',
        'Cancelado 0078 T11b', 'canceled');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  -- Tenant vivo: no-op silencioso (void), mesmo padrão do retry idempotente.
  PERFORM public.admin_record_invite('c7800000-0000-4000-8000-0000000000d9');
  PERFORM set_config('test.t11b_q1', public.admin_invite_quota()::text, true);

  -- Tenant cancelado: não curto-circuita ⇒ grava e consome.
  PERFORM public.admin_record_invite('c7800000-0000-4000-8000-0000000000d8');
  PERFORM set_config('test.t11b_q2', public.admin_invite_quota()::text, true);
END $$;
RESET ROLE;

DO $$
DECLARE
  v_q1 int := current_setting('test.t11b_q1')::int;
  v_q2 int := current_setting('test.t11b_q2')::int;
  v_n int;
  v_comment text;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE actor_id = 'c7800000-0000-4000-8000-0000000000a1'
    AND target_id = 'c7800000-0000-4000-8000-0000000000d9'
    AND reason = 'tenant_onboard_invite_requested';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0078 T11b falhou: % linha(s) para alvo com tenant vivo (esperado 0)', v_n;
  END IF;
  IF v_q1 <> 20 THEN
    RAISE EXCEPTION '0078 T11b falhou: tenant vivo consumiu cota (%)', v_q1;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE actor_id = 'c7800000-0000-4000-8000-0000000000a1'
    AND target_id = 'c7800000-0000-4000-8000-0000000000d8'
    AND action = 'other'
    AND reason = 'tenant_onboard_invite_requested'
    AND tenant_id IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0078 T11b falhou: tenant cancelado bloqueou o convite (% linha)', v_n;
  END IF;
  IF v_q2 <> 19 THEN
    RAISE EXCEPTION '0078 T11b falhou: tenant cancelado nao consumiu cota (%)', v_q2;
  END IF;

  SELECT pg_catalog.obj_description(
    'public.admin_record_invite(uuid)'::regprocedure, 'pg_proc'
  ) INTO v_comment;
  IF v_comment IS NULL
     OR pg_catalog.strpos(v_comment, 'tenant-already-onboarded') = 0 THEN
    RAISE EXCEPTION '0078 T11b falhou: rotulo tenant-already-onboarded ausente no COMMENT';
  END IF;

  RAISE NOTICE '0078 T11b ok: tenant vivo => 0 escrita e cota intacta; canceled nao curto-circuita; rotulo documentado';
END $$;
ROLLBACK;

-- ============ T16 — cota na escrita: 21º convite/hora ⇒ invite-rate-limited ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a3', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  i int;
BEGIN
  FOR i IN 1..20 LOOP
    PERFORM public.admin_record_invite(
      ('c7800000-0000-4000-8000-' || pg_catalog.lpad(i::text, 12, '0'))::uuid);
  END LOOP;

  BEGIN
    PERFORM public.admin_record_invite(
      ('c7800000-0000-4000-8000-' || pg_catalog.lpad(21::text, 12, '0'))::uuid);
    RAISE EXCEPTION '0078 T16 falhou: 21o convite na mesma hora passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0078 T16 falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.t16_err', SQLERRM, true);
  END;

  -- Retry idempotente do 1º alvo com a cota esgotada: no-op, sem erro (REQ-11).
  PERFORM public.admin_record_invite('c7800000-0000-4000-8000-000000000001');
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.t16_err');
  v_n int;
  v_last int;
BEGIN
  IF v_err <> 'invite-rate-limited' THEN
    RAISE EXCEPTION '0078 T16 falhou: rotulo do 21o convite (%)', v_err;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE actor_id = 'c7800000-0000-4000-8000-0000000000a3'
    AND reason = 'tenant_onboard_invite_requested';
  IF v_n <> 20 THEN
    RAISE EXCEPTION '0078 T16 falhou: % registro(s) na trilha (esperado 20)', v_n;
  END IF;
  SELECT count(*) INTO v_last
  FROM public.admin_audit
  WHERE target_id = ('c7800000-0000-4000-8000-' || pg_catalog.lpad(21::text, 12, '0'))::uuid;
  IF v_last <> 0 THEN
    RAISE EXCEPTION '0078 T16 falhou: % linha(s) do 21o alvo (esperado 0)', v_last;
  END IF;
  RAISE NOTICE '0078 T16 ok: 20 registros, 21o -> invite-rate-limited com 0 escrita; retry idempotente no-op';
END $$;
ROLLBACK;

-- ============ T16b — C1: cancelar NÃO devolve cota (fim da burla 40/h) ============
-- Cenário do parecer: 20 convites, cancelar todos, tentar o 21º (alvo novo).
-- Antes (consumo descontava cancelado) o ciclo cancelar→reconvidar dobrava a
-- cota (40/h). Agora o consumo é `count(requested)` na janela: 21ª ⇒
-- `invite-rate-limited`, 0 escrita, `admin_invite_quota()` = 0.

BEGIN;
-- Pedidos semeados 50 min atrás (controle de `at`: no MESMO BEGIN todos os
-- `now()` coincidem e o desconto antigo não seria observável). Os 20
-- cancelamentos passam pela RPC em `now()` — POSTERIORES a cada pedido, como no
-- ciclo real cancelar→reconvidar.
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at)
SELECT 'c7800000-0000-4000-8000-0000000000a2',
       ('c7800000-0000-4000-8000-' || pg_catalog.lpad(i::text, 12, '0'))::uuid,
       'other', 'tenant_onboard_invite_requested', now() - interval '50 minutes'
FROM pg_catalog.generate_series(1, 20) AS i;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  i int;
  v_cancelled int := 0;
BEGIN
  FOR i IN 1..20 LOOP
    IF public.admin_cancel_invite(
         ('c7800000-0000-4000-8000-' || pg_catalog.lpad(i::text, 12, '0'))::uuid
       ) THEN
      v_cancelled := v_cancelled + 1;
    END IF;
  END LOOP;
  PERFORM set_config('test.t16b_cancelled', v_cancelled::text, true);

  BEGIN
    PERFORM public.admin_record_invite(
      ('c7800000-0000-4000-8000-' || pg_catalog.lpad(21::text, 12, '0'))::uuid);
    RAISE EXCEPTION '0078 T16b falhou: 21o convite passou apos cancelar os 20';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0078 T16b falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.t16b_err', SQLERRM, true);
  END;

  -- O próprio ciclo cancelar→reconvidar do 1º alvo também é barrado: 20 já
  -- gastos na janela (C1) ⇒ no máximo 20 tentativas/h por operador.
  BEGIN
    PERFORM public.admin_record_invite('c7800000-0000-4000-8000-000000000001');
    RAISE EXCEPTION '0078 T16b falhou: ciclo cancelar->reconvite furou a cota';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0078 T16b falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.t16b_err2', SQLERRM, true);
  END;

  PERFORM set_config('test.t16b_q', public.admin_invite_quota()::text, true);
END $$;
RESET ROLE;

DO $$
DECLARE
  v_err text := current_setting('test.t16b_err');
  v_err2 text := current_setting('test.t16b_err2');
  v_cancelled int := current_setting('test.t16b_cancelled')::int;
  v_q int := current_setting('test.t16b_q')::int;
  v_n int;
  v_last int;
BEGIN
  IF v_cancelled <> 20 THEN
    RAISE EXCEPTION '0078 T16b falhou: % cancelamento(s) (esperado 20)', v_cancelled;
  END IF;
  IF v_err <> 'invite-rate-limited' THEN
    RAISE EXCEPTION '0078 T16b falhou: rotulo do 21o convite (%)', v_err;
  END IF;
  IF v_err2 <> 'invite-rate-limited' THEN
    RAISE EXCEPTION '0078 T16b falhou: reconvite do 1o alvo (%)', v_err2;
  END IF;
  IF v_q <> 0 THEN
    RAISE EXCEPTION '0078 T16b falhou: cota apos 20 pedidos cancelados = % (esperado 0)', v_q;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE actor_id = 'c7800000-0000-4000-8000-0000000000a2'
    AND action = 'other'
    AND reason = 'tenant_onboard_invite_requested';
  IF v_n <> 20 THEN
    RAISE EXCEPTION '0078 T16b falhou: % pedido(s) (esperado 20: cancelar nao consome nem devolve)', v_n;
  END IF;
  SELECT count(*) INTO v_last
  FROM public.admin_audit
  WHERE target_id = ('c7800000-0000-4000-8000-' || pg_catalog.lpad(21::text, 12, '0'))::uuid;
  IF v_last <> 0 THEN
    RAISE EXCEPTION '0078 T16b falhou: % linha(s) do 21o alvo (esperado 0)', v_last;
  END IF;
  RAISE NOTICE '0078 T16b ok: 20 convites + 20 cancelamentos => 21o e reconvite barrados, cota 0 (max 20/h)';
END $$;
ROLLBACK;

-- ============ T17 — cota: leitura, cancelar não devolve e janela ============
-- Os pedidos são semeados com `at` controlado (DBA) porque `now()` é o início da
-- transação. Decisão C1: cancelar NÃO devolve cota — o consumo é
-- `count(requested)` na janela; o cancelamento só muda a LISTA derivada (o
-- desconto por cancelado saiu do consumo).

BEGIN;
-- a4 pediu f1 há 10 min; a2 (OUTRO ator) cancela ⇒ não desconta.
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at)
VALUES ('c7800000-0000-4000-8000-0000000000a4',
        'c7800000-0000-4000-8000-0000000000f1',
        'other', 'tenant_onboard_invite_requested', now() - interval '10 minutes');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a4', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}', false);
DO $$
BEGIN
  PERFORM set_config('test.t17_q0', public.admin_invite_quota()::text, true);
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', false);
DO $$
BEGIN
  PERFORM set_config('test.t17_cancel_other',
    public.admin_cancel_invite('c7800000-0000-4000-8000-0000000000f1')::text, true);
  PERFORM set_config('test.t17_q_other', public.admin_invite_quota()::text, true);
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a4', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}', false);
DO $$
BEGIN
  PERFORM set_config('test.t17_q1', public.admin_invite_quota()::text, true);
END $$;
RESET ROLE;

-- a4 pediu f2 há 9 min e cancela ele mesmo ⇒ desconta 1 (cota volta a subir).
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at)
VALUES ('c7800000-0000-4000-8000-0000000000a4',
        'c7800000-0000-4000-8000-0000000000f2',
        'other', 'tenant_onboard_invite_requested', now() - interval '9 minutes');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000a4', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}', false);
DO $$
BEGIN
  PERFORM set_config('test.t17_q2', public.admin_invite_quota()::text, true);
  PERFORM set_config('test.t17_list_before',
    (SELECT count(*) FROM public.admin_list_pending_invites(20, 0) AS x
      WHERE x.invited_user_id = 'c7800000-0000-4000-8000-0000000000f2')::text, true);
  PERFORM set_config('test.t17_cancel_self',
    public.admin_cancel_invite('c7800000-0000-4000-8000-0000000000f2')::text, true);
  PERFORM set_config('test.t17_q3', public.admin_invite_quota()::text, true);
  PERFORM set_config('test.t17_list_after',
    (SELECT count(*) FROM public.admin_list_pending_invites(20, 0) AS x
      WHERE x.invited_user_id = 'c7800000-0000-4000-8000-0000000000f2')::text, true);
END $$;
RESET ROLE;

-- Pedido fora da janela de 1h (inserido direto pelo DBA) não consome cota.
INSERT INTO public.admin_audit (actor_id, target_id, action, reason, at)
VALUES ('c7800000-0000-4000-8000-0000000000a4',
        'c7800000-0000-4000-8000-0000000000f1',
        'other', 'tenant_onboard_invite_requested', now() - interval '2 hours');

DO $$
BEGIN
  PERFORM set_config('test.t17_before',
    (SELECT count(*) FROM public.admin_audit)::text, true);
END $$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM set_config('test.t17_q4', public.admin_invite_quota()::text, true);
  PERFORM set_config('test.t17_q5', public.admin_invite_quota()::text, true);
END $$;
RESET ROLE;

-- Não-admin ⇒ not-admin (leitura também é gateada).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7800000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7800000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.admin_invite_quota();
    RAISE EXCEPTION '0078 T17 falhou: nao-admin leu a cota';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0078 T17 falhou%' THEN RAISE; END IF;
    PERFORM set_config('test.t17_err', SQLERRM, true);
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_q0 int := current_setting('test.t17_q0')::int;
  v_q_other int := current_setting('test.t17_q_other')::int;
  v_q1 int := current_setting('test.t17_q1')::int;
  v_q2 int := current_setting('test.t17_q2')::int;
  v_q3 int := current_setting('test.t17_q3')::int;
  v_q4 int := current_setting('test.t17_q4')::int;
  v_q5 int := current_setting('test.t17_q5')::int;
  v_list_before int := current_setting('test.t17_list_before')::int;
  v_list_after int := current_setting('test.t17_list_after')::int;
  v_cancel_other text := current_setting('test.t17_cancel_other');
  v_cancel_self text := current_setting('test.t17_cancel_self');
  v_err text := current_setting('test.t17_err');
  v_before bigint := current_setting('test.t17_before')::bigint;
  v_after bigint;
BEGIN
  IF v_q0 <> 19 THEN
    RAISE EXCEPTION '0078 T17 falhou: cota apos 1 pedido na janela % (esperado 19)', v_q0;
  END IF;
  IF v_cancel_other <> 'true' THEN
    RAISE EXCEPTION '0078 T17 falhou: cancelamento por outro operador nao ocorreu (%)', v_cancel_other;
  END IF;
  IF v_q_other <> 20 THEN
    RAISE EXCEPTION '0078 T17 falhou: cota do operador 2 % (esperado 20)', v_q_other;
  END IF;
  IF v_q1 <> 19 THEN
    RAISE EXCEPTION '0078 T17 falhou: cancelamento de OUTRO ator mexeu na cota (%)', v_q1;
  END IF;
  IF v_q2 <> 18 THEN
    RAISE EXCEPTION '0078 T17 falhou: apos 2 pedidos % (esperado 18)', v_q2;
  END IF;
  IF v_cancel_self <> 'true' THEN
    RAISE EXCEPTION '0078 T17 falhou: cancelamento proprio nao ocorreu (%)', v_cancel_self;
  END IF;
  IF v_q3 <> 18 THEN
    RAISE EXCEPTION '0078 T17 falhou: cancelar devolveu cota (% , esperado 18)', v_q3;
  END IF;
  IF v_list_before <> 1 OR v_list_after <> 0 THEN
    RAISE EXCEPTION '0078 T17 falhou: cancelar nao mudou a lista (% -> %)', v_list_before, v_list_after;
  END IF;
  IF v_q4 <> 18 OR v_q5 <> 18 THEN
    RAISE EXCEPTION '0078 T17 falhou: pedido fora da janela de 1h consumiu cota (% / %)', v_q4, v_q5;
  END IF;
  IF v_err <> 'not-admin' THEN
    RAISE EXCEPTION '0078 T17 falhou: rotulo para nao-admin (%)', v_err;
  END IF;
  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0078 T17 falhou: leitura de cota escreveu trilha (% -> %)', v_before, v_after;
  END IF;
  RAISE NOTICE '0078 T17 ok: 19 -> 19 -> 18 -> 18 (cancelar nao devolve; lista muda); janela 1h; leitura sem escrita; nao-admin barrado';
END $$;
ROLLBACK;

-- ============ B2.2 — Fixtures cleanup (fim; rerunnable) ============

BEGIN;
DO $$
BEGIN
  DELETE FROM public.admin_audit
  WHERE target_id::text LIKE 'c7800000-%'
     OR target_id::text LIKE 'c7810000-%';
  DELETE FROM public.tenants WHERE owner_user_id::text LIKE 'c7800000-%';
  DELETE FROM public.internal_operators WHERE user_id::text LIKE 'c7800000-%';
  DELETE FROM auth.users
  WHERE id::text LIKE 'c7800000-%'
     OR id::text LIKE 'c7810000-%';
END $$;
COMMIT;

-- ============================================================================
-- BLOCO B3 — `0079_tenant_onboarding_drift_repair.sql` (BE-25/BE-26)
-- T08, T08b, T08c, T08d, T08e, T08f, T08g, T18, T19, T20, T21.
-- Rastreabilidade: REQ-12 (estado derivado + tenant-not-found), REQ-13 (reparo
-- preenche só o que falta, 2ª chamada no-op), REQ-20 (reparo NUNCA concede
-- trial), REQ-21 (sem PII em trilha/erro), REQ-23 (definer/search_path/ACL),
-- REQ-24 (zero tabela/coluna nova); invariantes I7 (cancelar/RESTRICT nunca
-- apaga negócio), I8 (reparo nunca UPDATE/DELETE ⇒ role-drift e tenant
-- `canceled` são pré-validados com rótulo fixo, 0 escrita, nunca 23505 cru),
-- I11 (operador não ganha acesso ao tenant — RLS por membership).
--
-- Fixtures `c7900000-…` (operadores/owners/alvos). Todo cenário mutável roda
-- em BEGIN/ROLLBACK ⇒ 0 resíduo; fixtures permanentes só em auth.users /
-- profiles / internal_operators, apagadas nos cleanups.
-- ============================================================================

-- ============ B3.0 — Fixtures cleanup (início; rerunnable) ============

BEGIN;
DO $$
DECLARE
  v_has_immutable boolean;
BEGIN
  -- 0055: assinatura sai ANTES do tenant (FK ON DELETE RESTRICT).
  IF to_regclass('public.tenant_subscriptions') IS NOT NULL THEN
    DELETE FROM public.tenant_subscriptions AS s
    USING public.tenants AS t
    WHERE s.tenant_id = t.id
      AND t.owner_user_id::text LIKE 'c7900000-%';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'contract_acceptances_immutable' AND NOT tgisinternal
  ) INTO v_has_immutable;
  IF v_has_immutable THEN
    ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
  END IF;

  DELETE FROM public.admin_audit AS a
  USING public.tenants AS t
  WHERE t.owner_user_id::text LIKE 'c7900000-%'
    AND (a.tenant_id = t.id OR a.target_id = t.id);

  DELETE FROM public.tenants WHERE owner_user_id::text LIKE 'c7900000-%';
  DELETE FROM public.admin_audit WHERE target_id::text LIKE 'c7900000-%';

  IF v_has_immutable THEN
    ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
  END IF;
END $$;
DELETE FROM public.internal_operators WHERE user_id::text LIKE 'c7900000-%';
DELETE FROM auth.users WHERE id::text LIKE 'c7900000-%';
COMMIT;

-- ============ B3.1 — Fixtures ============

INSERT INTO auth.users (id, email) VALUES
  ('c7900000-0000-4000-8000-0000000000a1', 'op1-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000a2', 'op2-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000b1', 'owner-a-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000b2', 'owner-b-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c1', 'drift-complete-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c2', 'drift-all-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c3', 'drift-sub-free-trial-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c4', 'drift-sub-free-active-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c5', 'drift-membership-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c6', 'drift-acceptance-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c7', 'drift-sub-paid-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c8', 'delete-guard-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000c9', 'owner-drift-self-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000ca', 'owner-drift-intruder-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000cb', 'owner-drift-second-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000cc', 'drift-sub-past-due-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000d1', 'invite-trail-0079@example.com'),
  ('c7900000-0000-4000-8000-0000000000d2', 'invite-no-trail-0079@example.com');

UPDATE public.profiles SET role = 'super_admin'
WHERE id IN (
  'c7900000-0000-4000-8000-0000000000a1',
  'c7900000-0000-4000-8000-0000000000a2'
);

INSERT INTO public.internal_operators (user_id, active) VALUES
  ('c7900000-0000-4000-8000-0000000000a1', true),
  ('c7900000-0000-4000-8000-0000000000a2', true);

-- Promoção/ativação não entram nas contagens de trilha dos cenários.
DELETE FROM public.admin_audit WHERE target_id::text LIKE 'c7900000-%';

-- Helper de drift: insere tenant e, opcionalmente, membership/aceite/assinatura
-- (sempre `free`/`active`). Rodado como postgres (invoker), sem RLS.
CREATE OR REPLACE FUNCTION pg_temp.seed_drift_tenant(
  p_id uuid,
  p_owner uuid,
  p_cpf text,
  p_plan text,
  p_status text,
  p_membership boolean,
  p_acceptance boolean,
  p_subscription boolean
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.tenants (
    id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status
  ) VALUES (
    p_id, 'pf', p_owner, p_cpf, 'Fixture 0079', p_plan, p_status
  );

  IF p_membership THEN
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (p_id, p_owner, 'owner');
  END IF;

  IF p_acceptance THEN
    INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    VALUES (p_id, 'termos-2026-11-v1', pg_catalog.now(), p_owner);
  END IF;

  IF p_subscription THEN
    INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
    VALUES (p_id, 'free', 'active', NULL);
  END IF;
END $$;

-- Helper de role-drift: tenant ativo com aceite + assinatura, e UMA membership
-- cujo `(tenant_id, user_id, role)` NÃO é `(p_tenant, p_owner, 'owner')` —
-- `p_member_user = p_owner` com `p_member_role <> 'owner'` (colisão de
-- `tenant_members_pkey`) ou `p_member_user <> p_owner` com `role='owner'`
-- (colisão de `tenant_members_one_owner_uq`). Rodado como postgres.
CREATE OR REPLACE FUNCTION pg_temp.seed_drift_role_drift(
  p_id uuid,
  p_owner uuid,
  p_cpf text,
  p_member_user uuid,
  p_member_role text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.tenants (
    id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status
  ) VALUES (
    p_id, 'pf', p_owner, p_cpf, 'Fixture 0079', 'free', 'active'
  );

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (p_id, p_member_user, p_member_role);

  INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
  VALUES (p_id, 'termos-2026-11-v1', pg_catalog.now(), p_owner);

  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (p_id, 'free', 'active', NULL);
END $$;

-- ============ T08 (1/2) — estrutura: 2 RPCs, definer/ACL, forma, zero tabela ============

DO $$
DECLARE
  v_proc pg_catalog.pg_proc;
  v_n int;
  v_res text;
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.tenant_members') IS NULL
     OR to_regclass('public.contract_acceptances') IS NULL
     OR to_regclass('public.tenant_subscriptions') IS NULL THEN
    RAISE EXCEPTION '0079 T08 falhou: pre-condicao de F1/F2 ausente';
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_proc
  WHERE proname IN ('admin_tenant_onboarding_state', 'admin_repair_tenant_onboarding')
    AND pronamespace = 'public'::regnamespace
    AND prokind = 'f';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0079 T08 falhou: % assinatura(s) das RPCs (esperado 2)', v_n;
  END IF;

  SELECT * INTO v_proc
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_tenant_onboarding_state(uuid)'::regprocedure;
  IF NOT FOUND THEN
    RAISE EXCEPTION '0079 T08 falhou: admin_tenant_onboarding_state(uuid) ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0079 T08 falhou: state sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0079 T08 falhou: state sem search_path vazio travado';
  END IF;
  SELECT pg_catalog.pg_get_function_result(
    'public.admin_tenant_onboarding_state(uuid)'::regprocedure
  ) INTO v_res;
  IF v_res IS DISTINCT FROM 'TABLE(tenant_id uuid, state text, missing text[])' THEN
    RAISE EXCEPTION '0079 T08 falhou: forma do state (%)', v_res;
  END IF;
  IF (SELECT proargnames FROM pg_catalog.pg_proc
      WHERE oid = 'public.admin_tenant_onboarding_state(uuid)'::regprocedure)
     IS DISTINCT FROM ARRAY['p_tenant', 'tenant_id', 'state', 'missing'] THEN
    RAISE EXCEPTION '0079 T08 falhou: nomes/args do state divergentes';
  END IF;

  SELECT * INTO v_proc
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_repair_tenant_onboarding(uuid,text)'::regprocedure;
  IF NOT FOUND THEN
    RAISE EXCEPTION '0079 T08 falhou: admin_repair_tenant_onboarding(uuid,text) ausente';
  END IF;
  IF v_proc.pronargs <> 2 OR v_proc.pronargdefaults <> 1 THEN
    RAISE EXCEPTION '0079 T08 falhou: repair com % args / % defaults (esperado 2/1)',
      v_proc.pronargs, v_proc.pronargdefaults;
  END IF;
  IF v_proc.prorettype <> 'text'::regtype THEN
    RAISE EXCEPTION '0079 T08 falhou: repair retorna % (esperado text)', v_proc.prorettype::regtype;
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0079 T08 falhou: repair sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0079 T08 falhou: repair sem search_path vazio travado';
  END IF;
  IF v_proc.proargnames IS DISTINCT FROM ARRAY['p_tenant', 'p_contract_version'] THEN
    RAISE EXCEPTION '0079 T08 falhou: nomes/args do repair divergentes (%)', v_proc.proargnames;
  END IF;

  IF NOT has_function_privilege('authenticated',
       'public.admin_tenant_onboarding_state(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.admin_repair_tenant_onboarding(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0079 T08 falhou: authenticated sem EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.admin_tenant_onboarding_state(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_repair_tenant_onboarding(uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.admin_tenant_onboarding_state(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.admin_repair_tenant_onboarding(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0079 T08 falhou: EXECUTE para anon/service_role';
  END IF;

  -- REQ-24: zero tabela/coluna nova.
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname = 'public'
    AND (c.relname LIKE '%onboarding%' OR c.relname LIKE '%repair%');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08 falhou: % tabela(s) nova(s) de onboarding/reparo', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (column_name LIKE '%onboarding%' OR column_name LIKE '%repair%');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08 falhou: % coluna(s) nova(s) de onboarding/reparo', v_n;
  END IF;

  RAISE NOTICE '0079 T08 ok (1/2): 2 RPCs DEFINER/search_path vazio/ACL authenticated-only; state com 3 colunas; zero tabela/coluna nova';
END $$;

-- ============ T08 (2/2) — state: complete, missing[] em ordem fixa, leitura ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001001'::uuid,
  'c7900000-0000-4000-8000-0000000000c1'::uuid, '79000000001', 'free', 'active', true, true, true);
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001002'::uuid,
  'c7900000-0000-4000-8000-0000000000c2'::uuid, '79000000002', 'free', 'active', false, false, false);
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001005'::uuid,
  'c7900000-0000-4000-8000-0000000000c5'::uuid, '79000000005', 'free', 'active', false, true, true);
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001006'::uuid,
  'c7900000-0000-4000-8000-0000000000c6'::uuid, '79000000006', 'free', 'active', true, false, true);

SELECT set_config('test.b3_audit_before', (SELECT count(*) FROM public.admin_audit)::text, true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_state text;
  v_missing text[];
BEGIN
  SELECT s.tenant_id, s.state, s.missing INTO v_tenant, v_state, v_missing
  FROM public.admin_tenant_onboarding_state('c7900000-0000-4000-8000-000000001001'::uuid) AS s;
  IF v_tenant <> 'c7900000-0000-4000-8000-000000001001'::uuid THEN
    RAISE EXCEPTION '0079 T08 falhou: tenant_id devolvido (%)', v_tenant;
  END IF;
  IF v_state IS DISTINCT FROM 'onboarding-complete' THEN
    RAISE EXCEPTION '0079 T08 falhou: tenant completo com state %', v_state;
  END IF;
  IF v_missing IS DISTINCT FROM ARRAY[]::text[] THEN
    RAISE EXCEPTION '0079 T08 falhou: tenant completo com missing %', v_missing;
  END IF;

  SELECT s.state, s.missing INTO v_state, v_missing
  FROM public.admin_tenant_onboarding_state('c7900000-0000-4000-8000-000000001002'::uuid) AS s;
  IF v_state IS DISTINCT FROM 'tenant-provision-failed' THEN
    RAISE EXCEPTION '0079 T08 falhou: tenant sem nada com state %', v_state;
  END IF;
  IF v_missing IS DISTINCT FROM ARRAY['membership', 'acceptance', 'subscription']::text[] THEN
    RAISE EXCEPTION '0079 T08 falhou: missing fora de ordem (%)', v_missing;
  END IF;

  SELECT s.missing INTO v_missing
  FROM public.admin_tenant_onboarding_state('c7900000-0000-4000-8000-000000001005'::uuid) AS s;
  IF v_missing IS DISTINCT FROM ARRAY['membership']::text[] THEN
    RAISE EXCEPTION '0079 T08 falhou: missing de 1005 (%)', v_missing;
  END IF;

  SELECT s.missing INTO v_missing
  FROM public.admin_tenant_onboarding_state('c7900000-0000-4000-8000-000000001006'::uuid) AS s;
  IF v_missing IS DISTINCT FROM ARRAY['acceptance']::text[] THEN
    RAISE EXCEPTION '0079 T08 falhou: missing de 1006 (%)', v_missing;
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_before bigint := current_setting('test.b3_audit_before')::bigint;
  v_after bigint;
BEGIN
  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0079 T08 falhou: leitura escreveu trilha (% -> %)', v_before, v_after;
  END IF;
  RAISE NOTICE '0079 T08 ok (2/2): complete/missing[] (membership,acceptance,subscription) e leitura sem escrita';
END $$;
ROLLBACK;

-- ============ T08b — gate: não-admin, tenant inexistente ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001001'::uuid,
  'c7900000-0000-4000-8000-0000000000c1'::uuid, '79000000001', 'free', 'active', true, true, true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_tenant_onboarding_state('c7900000-0000-4000-8000-000000001001'::uuid);
    RAISE EXCEPTION '0079 T08b falhou: nao-admin leu o estado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'not-admin' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.admin_repair_tenant_onboarding('c7900000-0000-4000-8000-000000001001'::uuid);
    RAISE EXCEPTION '0079 T08b falhou: nao-admin reparou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'not-admin' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_tenant_onboarding_state(
      'c7900000-0000-4000-8000-000000009999'::uuid);
    RAISE EXCEPTION '0079 T08b falhou: tenant inexistente nao levantou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'tenant-not-found' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.admin_repair_tenant_onboarding(
      'c7900000-0000-4000-8000-000000009999'::uuid);
    RAISE EXCEPTION '0079 T08b falhou: reparo de tenant inexistente nao levantou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'tenant-not-found' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE '0079 T08b ok: nao-admin => not-admin; tenant inexistente => tenant-not-found (state e repair)';
END $$;
ROLLBACK;

-- ============ T08c — reparo preenche só o que falta; 2ª chamada no-op ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001002'::uuid,
  'c7900000-0000-4000-8000-0000000000c2'::uuid, '79000000002', 'free', 'active', false, false, false);
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001005'::uuid,
  'c7900000-0000-4000-8000-0000000000c5'::uuid, '79000000005', 'free', 'active', false, true, true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.admin_repair_tenant_onboarding(
      'c7900000-0000-4000-8000-000000001002'::uuid);
    RAISE EXCEPTION '0079 T08c falhou: aceite sem versao passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'tenant-onboarding-acceptance-manual' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08c falhou: membership escrita antes do erro de aceite (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.contract_acceptances
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08c falhou: aceite escrito antes do erro (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08c falhou: assinatura escrita antes do erro (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid
    AND reason LIKE 'tenant_onboard_repaired:%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08c falhou: trilha escrita antes do erro (%)', v_n;
  END IF;
END $$;

SET LOCAL ROLE authenticated;

SELECT set_config('test.t08c_ret1',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001002'::uuid, 'termos-2026-11-v1'), true);
SELECT set_config('test.t08c_ret2',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001005'::uuid), true);
RESET ROLE;

SELECT set_config('test.t08c_acc', (
  SELECT accepted_at::text FROM public.contract_acceptances
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid), true);
SELECT set_config('test.t08c_audit', (
  SELECT count(*)::text FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid
    AND reason LIKE 'tenant_onboard_repaired:%'), true);

SET LOCAL ROLE authenticated;
SELECT set_config('test.t08c_ret3',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001002'::uuid, 'termos-2026-11-v1'), true);
RESET ROLE;

DO $$
DECLARE
  v_n int;
  v_text text;
  v_owner uuid;
  v_role text;
  v_status text;
  v_plan text;
  v_trial timestamptz;
  v_reasons text[];
BEGIN
  IF current_setting('test.t08c_ret1') IS DISTINCT FROM 'onboarding-complete'
     OR current_setting('test.t08c_ret2') IS DISTINCT FROM 'onboarding-complete'
     OR current_setting('test.t08c_ret3') IS DISTINCT FROM 'onboarding-complete' THEN
    RAISE EXCEPTION '0079 T08c falhou: retornos (%)/(%)/(%)',
      current_setting('test.t08c_ret1'), current_setting('test.t08c_ret2'),
      current_setting('test.t08c_ret3');
  END IF;

  SELECT tm.user_id, tm.role INTO v_owner, v_role
  FROM public.tenant_members AS tm
  WHERE tm.tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid;
  IF v_owner IS DISTINCT FROM 'c7900000-0000-4000-8000-0000000000c2'::uuid
     OR v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION '0079 T08c falhou: membership reparada (%, %)', v_owner, v_role;
  END IF;

  SELECT count(*) INTO v_n FROM public.contract_acceptances
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid
    AND contract_version = 'termos-2026-11-v1'
    AND user_id = 'c7900000-0000-4000-8000-0000000000c2'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08c falhou: aceite reparado (%)', v_n;
  END IF;

  SELECT s.status, s.plan_slug, s.trial_ends_at INTO v_status, v_plan, v_trial
  FROM public.tenant_subscriptions AS s
  WHERE s.tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid;
  IF v_status IS DISTINCT FROM 'active' OR v_plan IS DISTINCT FROM 'free'
     OR v_trial IS NOT NULL THEN
    RAISE EXCEPTION '0079 T08c falhou: assinatura reparada (%/%)', v_status, v_plan;
  END IF;

  SELECT pg_catalog.array_agg(a.reason ORDER BY a.reason) INTO v_reasons
  FROM public.admin_audit AS a
  WHERE a.tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid
    AND a.reason LIKE 'tenant_onboard_repaired:%';
  IF v_reasons IS DISTINCT FROM ARRAY[
       'tenant_onboard_repaired:acceptance',
       'tenant_onboard_repaired:membership',
       'tenant_onboard_repaired:subscription'
     ]::text[] THEN
    RAISE EXCEPTION '0079 T08c falhou: trilha do reparo (%)', v_reasons;
  END IF;

  -- 1005: só membership faltava ⇒ só membership foi escrito.
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001005'::uuid
    AND reason LIKE 'tenant_onboard_repaired:%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08c falhou: reparo de 1005 escreveu % trilha(s)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.contract_acceptances
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001005'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08c falhou: aceite de 1005 duplicado (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001005'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08c falhou: assinatura de 1005 duplicada (%)', v_n;
  END IF;

  -- 2ª chamada: 0 escrita e sem UPDATE no aceite.
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid
    AND reason LIKE 'tenant_onboard_repaired:%';
  IF v_n <> current_setting('test.t08c_audit')::int THEN
    RAISE EXCEPTION '0079 T08c falhou: 2a chamada escreveu trilha (% -> %)',
      current_setting('test.t08c_audit'), v_n;
  END IF;
  SELECT accepted_at::text INTO v_text FROM public.contract_acceptances
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid;
  IF v_text IS DISTINCT FROM current_setting('test.t08c_acc') THEN
    RAISE EXCEPTION '0079 T08c falhou: 2a chamada alterou o aceite';
  END IF;

  RAISE NOTICE '0079 T08c ok: aceite sem versao => manual + 0 escrita; reparo preenche so o que falta; 2a chamada no-op';
END $$;
ROLLBACK;

-- ============ T08d — reparo NUNCA concede trial (free e plano pago) ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001003'::uuid,
  'c7900000-0000-4000-8000-0000000000c3'::uuid, '79000000003', 'free', 'trial', true, true, false);
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001007'::uuid,
  'c7900000-0000-4000-8000-0000000000c7'::uuid, '79000000007', 'pro', 'trial', true, true, false);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

SELECT set_config('test.t08d_ret3',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001003'::uuid), true);
SELECT set_config('test.t08d_ret7',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001007'::uuid), true);
RESET ROLE;

DO $$
DECLARE
  v_status text;
  v_plan text;
  v_trial timestamptz;
  v_day smallint;
  v_period_start date;
  v_period_end date;
  v_past timestamptz;
  v_cancel boolean;
  v_tenant_status text;
  v_n int;
BEGIN
  IF current_setting('test.t08d_ret3') IS DISTINCT FROM 'onboarding-complete'
     OR current_setting('test.t08d_ret7') IS DISTINCT FROM 'onboarding-complete' THEN
    RAISE EXCEPTION '0079 T08d falhou: retornos (%)/(%)',
      current_setting('test.t08d_ret3'), current_setting('test.t08d_ret7');
  END IF;

  SELECT s.status, s.plan_slug, s.trial_ends_at, s.billing_day,
         s.period_start, s.period_end, s.past_due_since, s.cancel_at_period_end
    INTO v_status, v_plan, v_trial, v_day, v_period_start, v_period_end, v_past, v_cancel
  FROM public.tenant_subscriptions AS s
  WHERE s.tenant_id = 'c7900000-0000-4000-8000-000000001003'::uuid;
  IF v_status IS DISTINCT FROM 'active' OR v_plan IS DISTINCT FROM 'free'
     OR v_trial IS NOT NULL OR v_day IS NOT NULL
     OR v_period_start IS NOT NULL OR v_period_end IS NOT NULL
     OR v_past IS NOT NULL OR v_cancel IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0079 T08d falhou: reparo free (%/%) — trial/periodo/day nao nulos',
      v_status, v_plan;
  END IF;

  SELECT s.status, s.plan_slug, s.trial_ends_at, s.billing_day,
         s.period_start, s.period_end, s.past_due_since
    INTO v_status, v_plan, v_trial, v_day, v_period_start, v_period_end, v_past
  FROM public.tenant_subscriptions AS s
  WHERE s.tenant_id = 'c7900000-0000-4000-8000-000000001007'::uuid;
  IF v_status IS DISTINCT FROM 'active' OR v_plan IS DISTINCT FROM 'pro'
     OR v_trial IS NOT NULL OR v_past IS NOT NULL
     OR v_period_start IS NOT NULL OR v_period_end IS NOT NULL
     OR v_day IS NULL THEN
    RAISE EXCEPTION '0079 T08d falhou: reparo pro (%/%, day=%) — esperado active sem trial',
      v_status, v_plan, v_day;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id IN (
    'c7900000-0000-4000-8000-000000001003'::uuid,
    'c7900000-0000-4000-8000-000000001007'::uuid)
    AND status = 'trial';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08d falhou: reparo criou % assinatura(s) em trial', v_n;
  END IF;

  SELECT t.subscription_status INTO v_tenant_status FROM public.tenants AS t
  WHERE t.id = 'c7900000-0000-4000-8000-000000001003'::uuid;
  IF v_tenant_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0079 T08d falhou: espelho do free reparado (%)', v_tenant_status;
  END IF;

  RAISE NOTICE '0079 T08d ok: reparo free/pro nasce active, trial_ends_at NULL, sem periodo (nunca trial)';
END $$;
ROLLBACK;

-- ============ T08e — role-drift ⇒ manual + 0 escrita (nunca 23505) ============
-- `missing` marca membership quando não existe `(tenant_id, owner_user_id,
-- role='owner')`; o INSERT cego do reparo estourava `tenant_members_pkey`
-- (dono já com role `member`) ou `tenant_members_one_owner_uq` (outro owner) —
-- 23505 CRU com DETAIL/CONTEXTO. I8 proíbe UPDATE ⇒ role-drift é runbook:
-- a RPC pré-valida e levanta o rótulo fixo ANTES de qualquer INSERT.

BEGIN;
-- (1/2) dono vinculado como `member` ⇒ colisão de pkey no INSERT.
SELECT pg_temp.seed_drift_role_drift(
  'c7900000-0000-4000-8000-000000001011'::uuid,
  'c7900000-0000-4000-8000-0000000000c9'::uuid, '79000000011',
  'c7900000-0000-4000-8000-0000000000c9'::uuid, 'member');
-- (2/2) outro usuário como `owner` ⇒ colisão do índice único de owner.
SELECT pg_temp.seed_drift_role_drift(
  'c7900000-0000-4000-8000-000000001012'::uuid,
  'c7900000-0000-4000-8000-0000000000cb'::uuid, '79000000012',
  'c7900000-0000-4000-8000-0000000000ca'::uuid, 'owner');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_msg text;
  v_state text;
  v_missing text[];
  v_part text;
BEGIN
  FOREACH v_part IN ARRAY ARRAY['1011', '1012']::text[]
  LOOP
    v_msg := NULL;
    BEGIN
      PERFORM public.admin_repair_tenant_onboarding(
        ('c7900000-0000-4000-8000-00000000' || v_part)::uuid);
      RAISE EXCEPTION '0079 T08e falhou: role-drift passou (%)', v_part;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '0079 T08e falhou%' THEN RAISE; END IF;
      v_msg := SQLERRM;
      IF SQLSTATE <> 'P0001' THEN
        RAISE EXCEPTION '0079 T08e falhou: SQLSTATE cru (%) para % — %',
          SQLSTATE, v_part, v_msg;
      END IF;
    END;
    IF v_msg IS DISTINCT FROM 'tenant-onboarding-membership-role-manual' THEN
      RAISE EXCEPTION '0079 T08e falhou: rotulo de % (%)', v_part, v_msg;
    END IF;
  END LOOP;

  -- Diagnóstico segue derivado: o buraco permanece (nada foi "consertado").
  SELECT s.state, s.missing INTO v_state, v_missing
  FROM public.admin_tenant_onboarding_state('c7900000-0000-4000-8000-000000001011'::uuid) AS s;
  IF v_state IS DISTINCT FROM 'tenant-provision-failed'
     OR v_missing IS DISTINCT FROM ARRAY['membership']::text[] THEN
    RAISE EXCEPTION '0079 T08e falhou: diagnostico pos-erro (%/%)', v_state, v_missing;
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_n int;
  v_role text;
  v_role_t12 text;
BEGIN
  -- 0 escrita em 1011: a membership de role `member` intacta, nenhum owner novo.
  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001011'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08e falhou: 1011 com % membership(s) (esperado 1)', v_n;
  END IF;
  SELECT tm.role INTO v_role FROM public.tenant_members AS tm
  WHERE tm.tenant_id = 'c7900000-0000-4000-8000-000000001011'::uuid;
  IF v_role IS DISTINCT FROM 'member' THEN
    RAISE EXCEPTION '0079 T08e falhou: role-drift alterado para %', v_role;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_members AS tm
  WHERE tm.tenant_id = 'c7900000-0000-4000-8000-000000001011'::uuid
    AND tm.role = 'owner';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08e falhou: 1011 ganhou owner por INSERT cego';
  END IF;

  -- 0 escrita em 1012: continua o owner intruso, nenhum owner novo.
  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001012'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08e falhou: 1012 com % membership(s) (esperado 1)', v_n;
  END IF;
  SELECT tm.role INTO v_role_t12 FROM public.tenant_members AS tm
  WHERE tm.tenant_id = 'c7900000-0000-4000-8000-000000001012'::uuid;
  IF v_role_t12 IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION '0079 T08e falhou: 1012 sem o owner intruso (%)', v_role_t12;
  END IF;

  -- 0 escrita nas demais peças e na trilha.
  SELECT count(*) INTO v_n FROM public.contract_acceptances
  WHERE tenant_id IN ('c7900000-0000-4000-8000-000000001011'::uuid,
                      'c7900000-0000-4000-8000-000000001012'::uuid);
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0079 T08e falhou: aceites (%) (esperado 2)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id IN ('c7900000-0000-4000-8000-000000001011'::uuid,
                      'c7900000-0000-4000-8000-000000001012'::uuid);
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0079 T08e falhou: assinaturas (%) (esperado 2)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id IN ('c7900000-0000-4000-8000-000000001011'::uuid,
                      'c7900000-0000-4000-8000-000000001012'::uuid)
    AND reason LIKE 'tenant_onboard_repaired:%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08e falhou: % trilha(s) de reparo no role-drift', v_n;
  END IF;

  RAISE NOTICE '0079 T08e ok: role-drift (dono member / outro owner) => tenant-onboarding-membership-role-manual, 0 escrita, nenhum 23505';
END $$;
ROLLBACK;

-- ============ T08f — tenant `canceled` sem assinatura ⇒ readonly, 0 escrita ============
-- `.subscription` em `missing` + espelho `canceled`: o reparo antigo inseria
-- `active` e o espelho (`0058`) reescrevia `canceled -> active` — acesso pago
-- sem pagamento. Pré-valida ⇒ `subscription-canceled-readonly` e NADA escrito.

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001013'::uuid,
  'c7900000-0000-4000-8000-0000000000c4'::uuid, '79000000013', 'free', 'active', true, true, false);
-- Membership/aceite entram com o tenant ativo (guard `aa_subscription_readonly`
-- de `0054`); depois o espelho vira `canceled` como o legado congelado.
UPDATE public.tenants SET subscription_status = 'canceled'
WHERE id = 'c7900000-0000-4000-8000-000000001013'::uuid;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_msg text;
  v_state text;
  v_missing text[];
BEGIN
  SELECT s.state, s.missing INTO v_state, v_missing
  FROM public.admin_tenant_onboarding_state('c7900000-0000-4000-8000-000000001013'::uuid) AS s;
  IF v_missing IS DISTINCT FROM ARRAY['subscription']::text[] THEN
    RAISE EXCEPTION '0079 T08f falhou: missing do cancelado (%)', v_missing;
  END IF;

  BEGIN
    PERFORM public.admin_repair_tenant_onboarding(
      'c7900000-0000-4000-8000-000000001013'::uuid);
    RAISE EXCEPTION '0079 T08f falhou: reparo de tenant canceled passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0079 T08f falhou%' THEN RAISE; END IF;
    v_msg := SQLERRM;
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION '0079 T08f falhou: SQLSTATE cru (%) — %', SQLSTATE, v_msg;
    END IF;
  END;
  IF v_msg IS DISTINCT FROM 'subscription-canceled-readonly' THEN
    RAISE EXCEPTION '0079 T08f falhou: rotulo (%)', v_msg;
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_status text;
  v_n int;
BEGIN
  -- `canceled` INTACTO — a falha do lembrete F2 era virar `active`.
  SELECT t.subscription_status INTO v_status FROM public.tenants AS t
  WHERE t.id = 'c7900000-0000-4000-8000-000000001013'::uuid;
  IF v_status IS DISTINCT FROM 'canceled' THEN
    RAISE EXCEPTION '0079 T08f falhou: status virou % (esperado canceled)', v_status;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001013'::uuid;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08f falhou: % assinatura(s) escritas no cancelado', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001013'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08f falhou: membership alterada (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.contract_acceptances
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001013'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08f falhou: aceite alterado (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001013'::uuid
    AND reason LIKE 'tenant_onboard_repaired:%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08f falhou: % trilha(s) de reparo no cancelado', v_n;
  END IF;

  RAISE NOTICE '0079 T08f ok: canceled sem assinatura => subscription-canceled-readonly, 0 escrita e espelho intacto (canceled)';
END $$;
ROLLBACK;

-- ============ T08g — `active` sem assinatura segue reparável (não regride) ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001014'::uuid,
  'c7900000-0000-4000-8000-0000000000c3'::uuid, '79000000014', 'free', 'active', true, true, false);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);
SELECT set_config('test.t08g_ret',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001014'::uuid), true);
RESET ROLE;

DO $$
DECLARE
  v_n int;
  v_status text;
  v_plan text;
BEGIN
  IF current_setting('test.t08g_ret') IS DISTINCT FROM 'onboarding-complete' THEN
    RAISE EXCEPTION '0079 T08g falhou: retorno (%)', current_setting('test.t08g_ret');
  END IF;
  SELECT s.status, s.plan_slug INTO v_status, v_plan
  FROM public.tenant_subscriptions AS s
  WHERE s.tenant_id = 'c7900000-0000-4000-8000-000000001014'::uuid;
  IF v_status IS DISTINCT FROM 'active' OR v_plan IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION '0079 T08g falhou: assinatura reparada (%/%)', v_status, v_plan;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001014'::uuid
    AND action = 'tenant_status_changed';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08g falhou: % linha(s) de status (esperado 0)', v_n;
  END IF;
  RAISE NOTICE '0079 T08g ok: tenant active sem assinatura continua reparavel (1 assinatura active, 0 status)';
END $$;
ROLLBACK;

-- ============ T08h — tenant `past_due` sem assinatura ⇒ manual, 0 escrita ============
-- `past_due` é carência ATIVA com dívida: `past_due_since` só nasce da aresta
-- `active + payment_overdue` (`0059`), então reparar a assinatura ausente
-- criaria `active`/`past_due_since NULL` — o espelho (`0058`) reescreveria
-- `tenants.subscription_status` de `past_due` para `active` e o tenant sairia
-- da carência sem pagamento (mesma classe do `canceled` de T08f). Não há como
-- reconstruir plano/ciclo/carência sem inventar dado ⇒ runbook.

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001015'::uuid,
  'c7900000-0000-4000-8000-0000000000cc'::uuid, '79000000015', 'free', 'active', true, true, false);
UPDATE public.tenants SET subscription_status = 'past_due'
WHERE id = 'c7900000-0000-4000-8000-000000001015'::uuid;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_msg text;
  v_missing text[];
BEGIN
  SELECT s.missing INTO v_missing
  FROM public.admin_tenant_onboarding_state('c7900000-0000-4000-8000-000000001015'::uuid) AS s;
  IF v_missing IS DISTINCT FROM ARRAY['subscription']::text[] THEN
    RAISE EXCEPTION '0079 T08h falhou: missing do past_due (%)', v_missing;
  END IF;

  BEGIN
    PERFORM public.admin_repair_tenant_onboarding(
      'c7900000-0000-4000-8000-000000001015'::uuid);
    RAISE EXCEPTION '0079 T08h falhou: reparo de tenant past_due passou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0079 T08h falhou%' THEN RAISE; END IF;
    v_msg := SQLERRM;
    IF SQLSTATE <> 'P0001' THEN
      RAISE EXCEPTION '0079 T08h falhou: SQLSTATE cru (%) — %', SQLSTATE, v_msg;
    END IF;
  END;
  IF v_msg IS DISTINCT FROM 'tenant-onboarding-subscription-state-manual' THEN
    RAISE EXCEPTION '0079 T08h falhou: rotulo (%)', v_msg;
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_status text;
  v_n int;
BEGIN
  -- `past_due` INTACTO: a falha era o reparo devolver o tenant a `active`.
  SELECT t.subscription_status INTO v_status FROM public.tenants AS t
  WHERE t.id = 'c7900000-0000-4000-8000-000000001015'::uuid;
  IF v_status IS DISTINCT FROM 'past_due' THEN
    RAISE EXCEPTION '0079 T08h falhou: status virou % (esperado past_due)', v_status;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001015'::uuid;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08h falhou: % assinatura(s) escritas no past_due', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001015'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08h falhou: membership alterada (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.contract_acceptances
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001015'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T08h falhou: aceite alterado (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001015'::uuid
    AND reason LIKE 'tenant_onboard_repaired:%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T08h falhou: % trilha(s) de reparo no past_due', v_n;
  END IF;

  RAISE NOTICE '0079 T08h ok: past_due sem assinatura => tenant-onboarding-subscription-state-manual, 0 escrita e status intacto';
END $$;
ROLLBACK;

-- ============ T19 — espelho do reparo: free trial->active (1 linha) e no-op ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001003'::uuid,
  'c7900000-0000-4000-8000-0000000000c3'::uuid, '79000000003', 'free', 'trial', true, true, false);
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001004'::uuid,
  'c7900000-0000-4000-8000-0000000000c4'::uuid, '79000000004', 'free', 'active', true, true, false);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);
SELECT set_config('test.t19_ret3',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001003'::uuid), true);
SELECT set_config('test.t19_ret4',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001004'::uuid), true);
RESET ROLE;

DO $$
DECLARE
  v_n int;
  v_from text;
  v_to text;
  v_reason text;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001003'::uuid
    AND action = 'tenant_status_changed';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T19 falhou: reparo free trial->active gerou % linha(s) de status (esperado 1)', v_n;
  END IF;
  SELECT a.from_value, a.to_value, a.reason INTO v_from, v_to, v_reason
  FROM public.admin_audit AS a
  WHERE a.tenant_id = 'c7900000-0000-4000-8000-000000001003'::uuid
    AND a.action = 'tenant_status_changed';
  IF v_from IS DISTINCT FROM 'trial' OR v_to IS DISTINCT FROM 'active'
     OR v_reason IS DISTINCT FROM 'onboarding' THEN
    RAISE EXCEPTION '0079 T19 falhou: espelho (% -> %, reason=%)', v_from, v_to, v_reason;
  END IF;

  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001004'::uuid
    AND action = 'tenant_status_changed';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T19 falhou: reparo de tenant ja active gerou % linha(s) (esperado 0)', v_n;
  END IF;

  RAISE NOTICE '0079 T19 ok: free trial->active => exatamente 1 tenant_status_changed reason=onboarding; ja active => 0';
END $$;
ROLLBACK;

-- ============ T18 — DELETE de usuário com tenant é bloqueado (RESTRICT) ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001008'::uuid,
  'c7900000-0000-4000-8000-0000000000c8'::uuid, '79000000008', 'free', 'active', true, true, true);

-- (1/2) primeira barreira: o aceite é append-only (`reject_mutation`, 0024) —
-- a cascata do DELETE não apaga prova de consentimento. Qualquer erro bloqueia,
-- mas o dado precisa continuar intacto.
DO $$
DECLARE
  v_blocked boolean := false;
BEGIN
  BEGIN
    DELETE FROM auth.users WHERE id = 'c7900000-0000-4000-8000-0000000000c8'::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION '0079 T18 falhou: DELETE de usuario com tenant passou';
  END IF;
END $$;

-- (2/2) com a imutabilidade do aceite fora do caminho (DBA), a barreira passa a
-- ser o `ON DELETE RESTRICT` de `tenant_subscriptions` (`0055`): o tenant não
-- pode ser apagado por cascata enquanto houver objeto de cobrança.
ALTER TABLE public.contract_acceptances
  DISABLE TRIGGER contract_acceptances_immutable;

DO $$
DECLARE
  v_blocked boolean := false;
BEGIN
  BEGIN
    DELETE FROM auth.users WHERE id = 'c7900000-0000-4000-8000-0000000000c8'::uuid;
  EXCEPTION WHEN foreign_key_violation THEN
    v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION '0079 T18 falhou: DELETE passou sem o RESTRICT de tenant_subscriptions';
  END IF;
END $$;

ALTER TABLE public.contract_acceptances
  ENABLE TRIGGER contract_acceptances_immutable;

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM auth.users
  WHERE id = 'c7900000-0000-4000-8000-0000000000c8'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T18 falhou: auth.users alterado (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenants
  WHERE id = 'c7900000-0000-4000-8000-000000001008'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T18 falhou: tenant apagado (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001008'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T18 falhou: assinatura apagada (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.contract_acceptances
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001008'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T18 falhou: aceite apagado (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_members
  WHERE tenant_id = 'c7900000-0000-4000-8000-000000001008'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T18 falhou: membership apagada (%)', v_n;
  END IF;

  RAISE NOTICE '0079 T18 ok: DELETE do convidado com tenant => foreign_key_violation (RESTRICT), negocio intacto';
END $$;
ROLLBACK;

-- ============ T20 — sem PII em trilha, mensagens e forma da lista ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001002'::uuid,
  'c7900000-0000-4000-8000-0000000000c2'::uuid, '79000000002', 'free', 'active', false, false, false);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);
SELECT set_config('test.t20_ret',
  public.admin_repair_tenant_onboarding(
    'c7900000-0000-4000-8000-000000001002'::uuid, 'termos-2026-11-v1'), true);

DO $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    PERFORM public.admin_repair_tenant_onboarding(
      'c7900000-0000-4000-8000-000000009998'::uuid);
    RAISE EXCEPTION '0079 T20 falhou: tenant-not-found nao levantou';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'tenant-not-found' THEN
    RAISE EXCEPTION '0079 T20 falhou: mensagem (%)', v_msg;
  END IF;
  IF v_msg ~ '@' OR v_msg ~* 'cpf|cnpj|telefone|documento|valor' THEN
    RAISE EXCEPTION '0079 T20 falhou: PII na mensagem';
  END IF;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
DO $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    PERFORM public.admin_tenant_onboarding_state(
      'c7900000-0000-4000-8000-000000001002'::uuid);
    RAISE EXCEPTION '0079 T20 falhou: nao-admin nao levantou';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'not-admin' THEN
    RAISE EXCEPTION '0079 T20 falhou: mensagem do gate (%)', v_msg;
  END IF;
  IF v_msg ~ '@' OR v_msg ~* 'cpf|cnpj|telefone|documento|valor' THEN
    RAISE EXCEPTION '0079 T20 falhou: PII na mensagem do gate';
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_n int;
  v_res text;
  v_args text;
BEGIN
  -- Sem PII na trilha do reparo: reason constante, from/to nulos.
  SELECT count(*) INTO v_n FROM public.admin_audit AS a
  WHERE a.tenant_id = 'c7900000-0000-4000-8000-000000001002'::uuid
    AND (
      a.action IS DISTINCT FROM 'other'
      OR a.reason !~ '^tenant_onboard_repaired:(membership|acceptance|subscription)$'
      OR a.from_value IS NOT NULL
      OR a.to_value IS NOT NULL
      OR a.reason ~ '@'
      OR a.reason ~* 'cpf|cnpj|telefone|documento|valor'
    );
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T20 falhou: % linha(s) de trilha com PII/forma invalida', v_n;
  END IF;

  -- Revalidação de forma: a lista de pendentes continua sem e-mail/nome/documento.
  SELECT pg_catalog.pg_get_function_result(
    'public.admin_list_pending_invites(integer,integer)'::regprocedure) INTO v_res;
  SELECT pg_catalog.array_to_string(proargnames, ',') INTO v_args
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_list_pending_invites(integer,integer)'::regprocedure;
  IF pg_catalog.lower(v_res) ~ 'email|nome|documento'
     OR pg_catalog.lower(v_args) ~ 'email|nome|documento' THEN
    RAISE EXCEPTION '0079 T20 falhou: lista de pendentes expoe PII (%)', v_res;
  END IF;

  RAISE NOTICE '0079 T20 ok: trilha com reason constante e sem PII; mensagens fixas; lista de pendentes sem e-mail';
END $$;
ROLLBACK;

-- ============ T21 — isolamento multi-tenant (owner A != B; RLS por membership) ============

BEGIN;
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001010'::uuid,
  'c7900000-0000-4000-8000-0000000000b1'::uuid, '79000000010', 'free', 'active', true, true, true);
SELECT pg_temp.seed_drift_tenant('c7900000-0000-4000-8000-000000001009'::uuid,
  'c7900000-0000-4000-8000-0000000000b2'::uuid, '79000000009', 'free', 'active', true, true, true);

INSERT INTO public.admin_audit (actor_id, target_id, action, reason)
VALUES ('c7900000-0000-4000-8000-0000000000a1',
        'c7900000-0000-4000-8000-0000000000d1', 'other',
        'tenant_onboard_invite_requested');

-- T21a: owner A (não-admin) só enxerga o próprio tenant; state exige gate.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
DO $$
DECLARE
  v_n int;
  v_only uuid;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenants;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T21a falhou: owner A ve % tenants (esperado 1)', v_n;
  END IF;
  SELECT t.id INTO v_only FROM public.tenants AS t;
  IF v_only IS DISTINCT FROM 'c7900000-0000-4000-8000-000000001010'::uuid THEN
    RAISE EXCEPTION '0079 T21a falhou: owner A ve o tenant errado (%)', v_only;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_members;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T21a falhou: owner A ve % memberships (esperado 1)', v_n;
  END IF;

  BEGIN
    PERFORM public.admin_tenant_onboarding_state(
      'c7900000-0000-4000-8000-000000001009'::uuid);
    RAISE EXCEPTION '0079 T21a falhou: owner A leu estado de B';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'not-admin' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;

-- T21b: owner B não enxerga o tenant de A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000b2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000b2","role":"authenticated"}', false);
DO $$
DECLARE
  v_n int;
  v_only uuid;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenants;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T21b falhou: owner B ve % tenants (esperado 1)', v_n;
  END IF;
  SELECT t.id INTO v_only FROM public.tenants AS t;
  IF v_only IS DISTINCT FROM 'c7900000-0000-4000-8000-000000001009'::uuid THEN
    RAISE EXCEPTION '0079 T21b falhou: owner B ve o tenant errado (%)', v_only;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenants AS t
    WHERE t.id = 'c7900000-0000-4000-8000-000000001010'::uuid
  ) THEN
    RAISE EXCEPTION '0079 T21b falhou: owner B leu o tenant de A';
  END IF;
END $$;
RESET ROLE;

-- T21c: operador vê o estado (gate is_admin) e a lista só devolve alvo com trilha.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7900000-0000-4000-8000-0000000000a2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7900000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', false);
DO $$
DECLARE
  v_state text;
  v_n int;
BEGIN
  SELECT s.state INTO v_state
  FROM public.admin_tenant_onboarding_state(
    'c7900000-0000-4000-8000-000000001009'::uuid) AS s;
  IF v_state IS DISTINCT FROM 'onboarding-complete' THEN
    RAISE EXCEPTION '0079 T21c falhou: operador nao leu estado (%)', v_state;
  END IF;

  SELECT count(*) INTO v_n FROM public.admin_list_pending_invites(20, 0) AS l
  WHERE l.invited_user_id = 'c7900000-0000-4000-8000-0000000000d1'::uuid;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0079 T21c falhou: alvo com trilha ausente da lista (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_list_pending_invites(20, 0) AS l
  WHERE l.invited_user_id = 'c7900000-0000-4000-8000-0000000000d2'::uuid;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0079 T21c falhou: alvo sem trilha apareceu na lista (%)', v_n;
  END IF;

  RAISE NOTICE '0079 T21 ok: RLS por membership (A!=B), state exige is_admin; lista sem alvo sem trilha';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ B3.2 — Fixtures cleanup (fim; rerunnable) ============

BEGIN;
DO $$
DECLARE
  v_has_immutable boolean;
BEGIN
  IF to_regclass('public.tenant_subscriptions') IS NOT NULL THEN
    DELETE FROM public.tenant_subscriptions AS s
    USING public.tenants AS t
    WHERE s.tenant_id = t.id
      AND t.owner_user_id::text LIKE 'c7900000-%';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'contract_acceptances_immutable' AND NOT tgisinternal
  ) INTO v_has_immutable;
  IF v_has_immutable THEN
    ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
  END IF;

  DELETE FROM public.admin_audit AS a
  USING public.tenants AS t
  WHERE t.owner_user_id::text LIKE 'c7900000-%'
    AND (a.tenant_id = t.id OR a.target_id = t.id);

  DELETE FROM public.tenants WHERE owner_user_id::text LIKE 'c7900000-%';
  DELETE FROM public.admin_audit WHERE target_id::text LIKE 'c7900000-%';

  IF v_has_immutable THEN
    ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
  END IF;
END $$;
DELETE FROM public.internal_operators WHERE user_id::text LIKE 'c7900000-%';
DELETE FROM auth.users WHERE id::text LIKE 'c7900000-%';
COMMIT;

-- ============================================================================
-- BLOCO B4 — `0080_tenant_onboarding_edge_support.sql` (BE-27)
-- T09 (estrutura/grants) e T10 (comportamento/42501/neutralidade).
-- Rastreabilidade: REQ-04 (`42501` nas RPCs revogadas), REQ-15 (nenhum
-- `EXECUTE` novo a `anon`), REQ-21 (sem PII em resposta/erro), REQ-23
-- (definer/search_path), REQ-24 (zero tabela/coluna nova) e I5 (e-mail
-- resolvido no servidor — a borda recebe e-mail, o banco devolve o id).
--
-- `admin_resolve_invited_user` é apoio à Edge: `service_role`-only, retorna
-- SÓ `uuid` (ou `NULL` quando o e-mail não existe — resposta neutra, sem
-- confirmação de existência a cliente algum). Nenhum e-mail em retorno,
-- `COMMENT` ou mensagem de erro.
--
-- Fixtures `c8000000-…`; todo cenário em BEGIN/ROLLBACK ⇒ 0 resíduo.
-- ============================================================================

-- ============ B4.0 — Fixtures cleanup (início; rerunnable) ============

BEGIN;
DELETE FROM public.admin_audit WHERE target_id::text LIKE 'c8000000-%';
DELETE FROM auth.users WHERE id::text LIKE 'c8000000-%';
COMMIT;

-- ============ B4.1 — Fixtures ============

-- E-mail com caixa mista + espaços internos: prova o `lower(btrim(...))` e
-- NÃO normaliza o meio da string.
INSERT INTO auth.users (id, email) VALUES
  ('c8000000-0000-4000-8000-0000000000a1', 'Invitee.C80@Example.com'),
  ('c8000000-0000-4000-8000-0000000000a2', 'resolve-target-c80@example.com');

-- ============ T09 (1/2) — estrutura/grants: assinatura única, definer, proacl ============

DO $$
DECLARE
  v_proc pg_catalog.pg_proc;
  v_n int;
  v_bad int;
  v_exec int;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION '0080 T09 falhou: pre-condicao auth.users ausente';
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_proc
  WHERE proname = 'admin_resolve_invited_user'
    AND pronamespace = 'public'::regnamespace
    AND prokind = 'f';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0080 T09 falhou: % assinatura(s) de admin_resolve_invited_user (esperado 1)', v_n;
  END IF;

  SELECT * INTO v_proc
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.admin_resolve_invited_user(text)'::regprocedure;
  IF NOT FOUND THEN
    RAISE EXCEPTION '0080 T09 falhou: admin_resolve_invited_user(text) ausente';
  END IF;
  IF v_proc.pronargs <> 1 OR v_proc.pronargdefaults <> 0 THEN
    RAISE EXCEPTION '0080 T09 falhou: % args / % defaults (esperado 1/0)',
      v_proc.pronargs, v_proc.pronargdefaults;
  END IF;
  IF v_proc.proargnames IS DISTINCT FROM ARRAY['p_email'] THEN
    RAISE EXCEPTION '0080 T09 falhou: nomes/args divergentes (%)', v_proc.proargnames;
  END IF;
  IF v_proc.prorettype <> 'uuid'::regtype THEN
    RAISE EXCEPTION '0080 T09 falhou: retorna % (esperado uuid)', v_proc.prorettype::regtype;
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0080 T09 falhou: sem SECURITY DEFINER';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION '0080 T09 falhou: volatilidade % (esperado STABLE)', v_proc.provolatile;
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION '0080 T09 falhou: sem search_path vazio travado';
  END IF;

  -- ACL: `service_role` sim; `anon`/`authenticated`/PUBLIC não.
  IF NOT has_function_privilege('service_role',
       'public.admin_resolve_invited_user(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0080 T09 falhou: service_role sem EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.admin_resolve_invited_user(text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
          'public.admin_resolve_invited_user(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0080 T09 falhou: EXECUTE para anon/authenticated';
  END IF;

  -- `proacl` explícito depois do REVOKE: exatamente 2 EXECUTE (owner + service_role).
  IF v_proc.proacl IS NULL THEN
    RAISE EXCEPTION '0080 T09 falhou: proacl nulo (REVOKE nao aplicado)';
  END IF;
  SELECT count(*) INTO v_exec
  FROM pg_catalog.aclexplode(v_proc.proacl) AS acl
  WHERE acl.privilege_type = 'EXECUTE';
  IF v_exec <> 2 THEN
    RAISE EXCEPTION '0080 T09 falhou: % grant(s) EXECUTE (esperado 2: owner + service_role)', v_exec;
  END IF;
  SELECT count(*) INTO v_bad
  FROM pg_catalog.aclexplode(v_proc.proacl) AS acl
  WHERE acl.privilege_type = 'EXECUTE'
    AND acl.grantee <> v_proc.proowner
    AND acl.grantee <> 'service_role'::regrole::oid;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '0080 T09 falhou: % grant(s) EXECUTE fora de owner/service_role', v_bad;
  END IF;

  -- REQ-04/REQ-15: RPCs revogadas de 0052/0053 seguem sem EXECUTE a cliente.
  IF has_function_privilege('authenticated', 'public.accept_contract(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.accept_contract(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
          'public.create_tenant_with_owner(text,text,text,text,text,text,text,text,text,text,text,text,text)',
          'EXECUTE')
     OR has_function_privilege('anon',
          'public.create_tenant_with_owner(text,text,text,text,text,text,text,text,text,text,text,text,text)',
          'EXECUTE') THEN
    RAISE EXCEPTION '0080 T09 falhou: RPC revogada (0052/0053) com EXECUTE a cliente';
  END IF;

  -- REQ-24: zero tabela/coluna nova.
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname = 'public'
    AND (c.relname LIKE '%resolve%' OR c.relname LIKE '%edge%');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0080 T09 falhou: % tabela(s) nova(s) de resolucao/borda', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (column_name LIKE '%invited_email%' OR column_name LIKE '%resolve%');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0080 T09 falhou: % coluna(s) nova(s) de resolucao/borda', v_n;
  END IF;

  -- Nenhum grant novo a `anon` (REQ-15).
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_proc AS p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND p.proname IN ('admin_resolve_invited_user', 'admin_record_invite',
                      'admin_cancel_invite', 'admin_list_pending_invites',
                      'admin_invite_quota', 'admin_tenant_onboarding_state',
                      'admin_repair_tenant_onboarding');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0080 T09 falhou: % RPC(s) de onboarding com EXECUTE para anon', v_n;
  END IF;

  RAISE NOTICE '0080 T09 ok (1/2): 1 assinatura (text->uuid), DEFINER/STABLE/search_path vazio, proacl so owner+service_role; RPCs revogadas sem EXECUTE a cliente; zero tabela/coluna nova';
END $$;

-- ============ T09 (2/2) — proacl literal: nenhum grantee PUBLIC (0) ============

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_proc AS p
  CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
  WHERE p.oid = 'public.admin_resolve_invited_user(text)'::regprocedure
    AND acl.grantee = 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0080 T09 falhou: % grant(s) a PUBLIC (grantee 0)', v_n;
  END IF;

  -- Nenhuma execução concedida a `service_role` nas RPCs de painel (0077..0079).
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_proc AS p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.proname IN ('create_tenant_for_invited_user', 'admin_record_invite',
                      'admin_cancel_invite', 'admin_list_pending_invites',
                      'admin_invite_quota', 'admin_tenant_onboarding_state',
                      'admin_repair_tenant_onboarding')
    AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0080 T09 falhou: % RPC(s) de painel executavel por service_role', v_n;
  END IF;

  RAISE NOTICE '0080 T09 ok (2/2): zero grant a PUBLIC; service_role sem EXECUTE no painel (so na RPC de apoio a Edge)';
END $$;

-- ============ T10 (1/2) — comportamento: resolve, neutro, leitura ============

DO $$
BEGIN
  -- Session-scoped: o assert roda em statement posterior; `RESET` no fim do B4.
  PERFORM set_config('test.b4_audit_before',
    (SELECT count(*) FROM public.admin_audit)::text, false);
END $$;

BEGIN;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_id uuid;
BEGIN
  -- Sucesso: e-mail exato.
  v_id := public.admin_resolve_invited_user('Invitee.C80@Example.com');
  IF v_id IS DISTINCT FROM 'c8000000-0000-4000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION '0080 T10 falhou: e-mail exato resolveu % (esperado a1)', v_id;
  END IF;

  -- Case-insensitive + trim nas bordas (nunca no meio).
  v_id := public.admin_resolve_invited_user('   invitee.c80@example.COM   ');
  IF v_id IS DISTINCT FROM 'c8000000-0000-4000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION '0080 T10 falhou: trim/caixa resolveu % (esperado a1)', v_id;
  END IF;

  v_id := public.admin_resolve_invited_user('Resolve-Target-C80@Example.com');
  IF v_id IS DISTINCT FROM 'c8000000-0000-4000-8000-0000000000a2'::uuid THEN
    RAISE EXCEPTION '0080 T10 falhou: segundo e-mail resolveu % (esperado a2)', v_id;
  END IF;

  -- Borda: e-mail inexistente ⇒ NULL, sem excecao (resposta neutra).
  v_id := public.admin_resolve_invited_user('absent-c80@example.com');
  IF v_id IS NOT NULL THEN
    RAISE EXCEPTION '0080 T10 falhou: e-mail ausente devolveu %', v_id;
  END IF;

  -- Borda: NULL e vazio ⇒ NULL, sem excecao.
  v_id := public.admin_resolve_invited_user(NULL);
  IF v_id IS NOT NULL THEN
    RAISE EXCEPTION '0080 T10 falhou: NULL devolveu %', v_id;
  END IF;
  v_id := public.admin_resolve_invited_user('   ');
  IF v_id IS NOT NULL THEN
    RAISE EXCEPTION '0080 T10 falhou: vazio devolveu %', v_id;
  END IF;

  -- Nao normaliza o meio: espaco interno nao casa.
  v_id := public.admin_resolve_invited_user('invitee.c80 @example.com');
  IF v_id IS NOT NULL THEN
    RAISE EXCEPTION '0080 T10 falhou: espaco interno casou';
  END IF;
END $$;

RESET ROLE;
ROLLBACK;

DO $$
DECLARE
  v_before bigint := current_setting('test.b4_audit_before')::bigint;
  v_after bigint;
  v_n int;
BEGIN
  SELECT count(*) INTO v_after FROM public.admin_audit;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '0080 T10 falhou: leitura escreveu trilha (% -> %)', v_before, v_after;
  END IF;

  SELECT count(*) INTO v_n
  FROM auth.users WHERE id::text LIKE 'c8000000-%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0080 T10 falhou: % fixture(s) (esperado 2)', v_n;
  END IF;

  RAISE NOTICE '0080 T10 ok (1/2): resolve case/trim, ausente/NULL/vazio => NULL sem erro; leitura nao escreve';
END $$;

RESET test.b4_audit_before;

-- ============ T10 (2/2) — anon/authenticated ⇒ 42501 (sem PII no erro) ============

BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claims', NULL, false);

DO $$
DECLARE
  v_err text;
BEGIN
  BEGIN
    PERFORM public.admin_resolve_invited_user('invitee.c80@example.com');
    RAISE EXCEPTION '0080 T10 falhou: anon executou admin_resolve_invited_user';
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := SQLERRM;
  END;
  IF v_err LIKE '%@%' OR v_err LIKE '%c8000000-%' THEN
    RAISE EXCEPTION '0080 T10 falhou: erro do anon vazou PII/id (%)', v_err;
  END IF;
END $$;

RESET ROLE;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c8000000-0000-4000-8000-0000000000a2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"c8000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_err text;
BEGIN
  BEGIN
    PERFORM public.admin_resolve_invited_user('invitee.c80@example.com');
    RAISE EXCEPTION '0080 T10 falhou: authenticated executou admin_resolve_invited_user';
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := SQLERRM;
  END;
  IF v_err LIKE '%@%' OR v_err LIKE '%c8000000-%' THEN
    RAISE EXCEPTION '0080 T10 falhou: erro do authenticated vazou PII/id (%)', v_err;
  END IF;

  -- REQ-04: as RPCs revogadas de 0052/0053 seguem 42501 para o cliente.
  BEGIN
    PERFORM public.accept_contract(
      '00000000-0000-4000-8000-000000000000'::uuid, 'test-v1'
    );
    RAISE EXCEPTION '0080 T10 falhou: authenticated executou accept_contract';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION '0080 T10 falhou: authenticated executou create_tenant_with_owner';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  RAISE NOTICE '0080 T10 ok (2/2): anon/authenticated => 42501 em admin_resolve_invited_user; RPCs revogadas (accept_contract/create_tenant_with_owner) => 42501; erro sem PII';
END $$;

RESET ROLE;
ROLLBACK;

-- ============ T10b — conta soft-deleted NÃO resolve; ativa/banida resolve ============
-- `auth.users.deleted_at` é preenchido pelo soft delete (`auth.admin.deleteUser`
-- com `shouldSoftDelete`). Resolver a conta apagada devolvia `state:'existing'`
-- na borda: nenhum convite era enviado e o e-mail ficava inutilizável. A
-- resolução filtra `deleted_at IS NULL`; `banned_until` NÃO filtra (conta
-- banida continua sendo a mesma conta — convidar de novo criaria duplicata).

BEGIN;
-- Conta soft-deleted: `auth.users.email` continua único (`users_email_partial_key`
-- só ignora SSO), então a prova usa um e-mail próprio — a linha é a ÚNICA com
-- esse e-mail e, sem o filtro, resolveria (retorno da borda sem convite).
INSERT INTO auth.users (id, email, created_at, deleted_at) VALUES
  ('c8000000-0000-4000-8000-0000000000a3', 'Deleted.C80@Example.com',
   pg_catalog.now() - interval '30 days', pg_catalog.now() - interval '2 days');

-- Banido: decisão documentada no COMMENT — resolve (a conta existe).
UPDATE auth.users SET banned_until = now() + interval '7 days'
WHERE id = 'c8000000-0000-4000-8000-0000000000a2'::uuid;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_id uuid;
BEGIN
  -- Soft-deleted é invisível: NULL ⇒ a borda convida de novo.
  v_id := public.admin_resolve_invited_user('deleted.c80@example.com');
  IF v_id IS NOT NULL THEN
    RAISE EXCEPTION '0080 T10b falhou: conta apagada resolveu %', v_id;
  END IF;

  -- Conta ativa continua resolvendo (o filtro não nega todos).
  v_id := public.admin_resolve_invited_user('invitee.c80@example.com');
  IF v_id IS DISTINCT FROM 'c8000000-0000-4000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION '0080 T10b falhou: conta ativa nao resolveu (%)', v_id;
  END IF;

  -- Banida também resolve: mesmo id, nunca conta duplicada.
  v_id := public.admin_resolve_invited_user('resolve-target-c80@example.com');
  IF v_id IS DISTINCT FROM 'c8000000-0000-4000-8000-0000000000a2'::uuid THEN
    RAISE EXCEPTION '0080 T10b falhou: conta banida nao resolveu (%)', v_id;
  END IF;

  RAISE NOTICE '0080 T10b ok: deleted_at preenchido => NULL; conta ativa/banida segue resolvendo';
END $$;

RESET ROLE;
ROLLBACK;

-- ============ B4.2 — Fixtures cleanup (fim; rerunnable) ============

BEGIN;
DELETE FROM public.admin_audit WHERE target_id::text LIKE 'c8000000-%';
DELETE FROM auth.users WHERE id::text LIKE 'c8000000-%';
COMMIT;
