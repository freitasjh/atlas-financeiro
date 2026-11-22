-- 0103-signup-rpc-happy.spec.sql — ADR-001 / SIGN-08 (+ SIGN-05: profile).
--
-- Uso: supabase test db --local supabase/tests/0103-signup-rpc-happy.spec.sql
--
-- Caminho feliz PF e PJ: 1 linha em cada uma das 5 tabelas; plan_id='free',
-- kind coerente, CPF xor CNPJ, membro owner, aceite versionado,
-- tenant_subscriptions free/active sem trial/PSP/past_due, espelho ativo,
-- auditoria 'signup-public-provisioned' com from_value=request_id.
-- SIGN-05: profile 1:1 com auth.users, role='user', trigger handle_new_user
-- intacto (nenhuma regra de negócio nova em trigger).
--
-- TDD FIRST: escrito ANTES da migration 0101.

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c0103000-0000-4000-8000-000000000001', 'happy-pf-0103@example.com'),
  ('c0103000-0000-4000-8000-000000000002', 'happy-pj-0103@example.com');

-- ===== PF =====
SELECT ok(
  (SELECT set_config('test.happy_pf', public.create_tenant_for_public_signup(
    'b0103000-0000-4000-8000-000000000001'::uuid,
    'c0103000-0000-4000-8000-000000000001'::uuid,
    'pf', '77100000106', 'Happy PF 0103', 'Fantasia', '11999999999',
    '01310100', 'Rua A', '10', 'Apto 1', 'Centro', 'Sao Paulo', 'SP'
  )::text, false) IS NOT NULL),
  'T01 PF: RPC devolveu tenant_id'
);

SELECT ok(
  (SELECT count(*) FROM public.tenants AS t
   WHERE t.id = current_setting('test.happy_pf')::uuid
     AND t.owner_user_id = 'c0103000-0000-4000-8000-000000000001'
     AND t.kind = 'pf' AND t.cpf = '77100000106' AND t.cnpj IS NULL
     AND t.plan_id = 'free' AND t.subscription_status = 'active'
     AND t.razao_social = 'Happy PF 0103') = 1,
  'T02 PF: tenant free/active, kind=pf, CPF xor CNPJ'
);

SELECT ok(
  (SELECT count(*) FROM public.tenant_members AS m
   WHERE m.tenant_id = current_setting('test.happy_pf')::uuid
     AND m.user_id = 'c0103000-0000-4000-8000-000000000001'
     AND m.role = 'owner') = 1,
  'T03 PF: exatamente 1 membro owner = dono da RPC'
);

SELECT ok(
  (SELECT count(*) FROM public.contract_acceptances AS a
   WHERE a.tenant_id = current_setting('test.happy_pf')::uuid
     AND a.user_id = 'c0103000-0000-4000-8000-000000000001'
     AND a.contract_version = 'termos-2026-11-v1'
     AND a.accepted_at IS NOT NULL) = 1,
  'T04 PF: aceite versionado com accepted_at e user_id do dono'
);

SELECT ok(
  (SELECT count(*) FROM public.tenant_subscriptions AS s
   WHERE s.tenant_id = current_setting('test.happy_pf')::uuid
     AND s.plan_slug = 'free' AND s.status = 'active'
     AND s.past_due_since IS NULL AND s.trial_ends_at IS NULL
     AND s.billing_day IS NULL AND s.period_start IS NULL AND s.period_end IS NULL
     AND s.psp_subscription_id IS NULL AND s.psp_customer_id IS NULL
     AND s.pending_plan_slug IS NULL AND s.pending_plan_at IS NULL
     AND s.cancel_at_period_end = false) = 1,
  'T05 PF: assinatura free/active, sem trial/PSP/past_due/ciclo'
);

SELECT ok(
  (SELECT count(*) FROM public.admin_audit AS a
   WHERE a.from_value = 'b0103000-0000-4000-8000-000000000001'
     AND a.reason = 'signup-public-provisioned'
     AND a.action = 'other'
     AND a.target_id = current_setting('test.happy_pf')::uuid
     AND a.actor_id IS NULL) = 1,
  'T06 PF: 1 trilha provisioned com request_id em from_value, sem ator'
);

SELECT ok(
  (SELECT count(*) FROM public.profiles AS p
   WHERE p.id = 'c0103000-0000-4000-8000-000000000001' AND p.role = 'user') = 1,
  'T07 PF: profile 1:1 com auth.users e role=user (handle_new_user intacto)'
);

-- ===== PJ =====
SELECT ok(
  (SELECT set_config('test.happy_pj', public.create_tenant_for_public_signup(
    'b0103000-0000-4000-8000-000000000002'::uuid,
    'c0103000-0000-4000-8000-000000000002'::uuid,
    'pj', '77100000100141', 'Happy PJ 0103', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL
  , NULL)::text, false) IS NOT NULL),
  'T08 PJ: RPC devolveu tenant_id'
);

SELECT ok(
  (SELECT count(*) FROM public.tenants AS t
   WHERE t.id = current_setting('test.happy_pj')::uuid
     AND t.kind = 'pj' AND t.cpf IS NULL AND t.cnpj = '77100000100141'
     AND t.plan_id = 'free' AND t.subscription_status = 'active') = 1,
  'T09 PJ: kind=pj, CNPJ preenchido, CPF nulo, free/active'
);

SELECT ok(
  (SELECT count(*) FROM public.tenant_members AS m
   WHERE m.tenant_id = current_setting('test.happy_pj')::uuid
     AND m.user_id = 'c0103000-0000-4000-8000-000000000002'
     AND m.role = 'owner') = 1
  AND (SELECT count(*) FROM public.contract_acceptances AS a
       WHERE a.tenant_id = current_setting('test.happy_pj')::uuid
         AND a.contract_version = 'termos-2026-11-v1') = 1
  AND (SELECT count(*) FROM public.tenant_subscriptions AS s
       WHERE s.tenant_id = current_setting('test.happy_pj')::uuid
         AND s.plan_slug = 'free' AND s.status = 'active'
         AND s.past_due_since IS NULL) = 1
  AND (SELECT count(*) FROM public.admin_audit AS a
       WHERE a.from_value = 'b0103000-0000-4000-8000-000000000002'
         AND a.reason = 'signup-public-provisioned'
         AND a.target_id = current_setting('test.happy_pj')::uuid) = 1,
  'T10 PJ: 1:1 em membro/aceite/assinatura/trilha (tenant_members_one_owner_uq)'
);

SELECT * FROM finish();

ROLLBACK;
