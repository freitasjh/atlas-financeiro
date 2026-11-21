-- supabase/seed.sql — SB-02 seed mínimo DEV LOCAL ONLY.
-- Nunca produção. Idempotente (ON CONFLICT DO NOTHING / WHERE NOT EXISTS).
-- Roda após migrations no `supabase db reset` (config db.seed.sql_paths).
-- Dados demo só inseridos se já existir profile (criado via signup nos testes
-- RLS ou manual no Studio). Sem profile → seed é no-op, nunca falha.
--
-- SEC-05 (bugfix security-p1-hardening): NÃO existe mais senha fixa.
-- A senha do `admin@atlas.test` vem do GUC de sessão `seed.admin_password`,
-- alimentado por `SEED_ADMIN_PASSWORD` na chamada do reset:
--   SEED_ADMIN_PASSWORD='<senha>' \
--     PGOPTIONS="-c seed.admin_password=$SEED_ADMIN_PASSWORD" supabase db reset
-- (equivalente: `npm run db:reset` com `SEED_ADMIN_PASSWORD` exportado).
-- Sem a variável, o seed GERA uma senha aleatória (18 bytes base64) e a
-- imprime UMA ÚNICA VEZ via RAISE NOTICE — o `supabase db reset` engole
-- NOTICE; para vê-la, rode o arquivo por psql (ver runbook §10). O reset
-- NUNCA aborta por falta da variável (H1/H2 e resets de terceiros).
-- Em E2E/H3, exporte `SEED_ADMIN_PASSWORD` para ter credencial conhecida.
-- A flag `must_change_password=true` permanece nos dois caminhos: o primeiro
-- acesso exige troca real de senha (trigger on_auth_user_password_changed,
-- 0050). `complete_first_access()` é server-side e não é passo de cliente.
-- Enquanto a flag for true, nenhuma RPC admin funciona.

DO $$
DECLARE
  dev_user uuid;
BEGIN
  SELECT id INTO dev_user FROM public.profiles ORDER BY created_at LIMIT 1;
  IF dev_user IS NULL THEN
    RAISE NOTICE 'seed: nenhum profile — no-op (crie usuário via signup primeiro)';
    RETURN;
  END IF;

  INSERT INTO public.categories (id, user_id, name, type)
  VALUES
    (gen_random_uuid(), dev_user, 'Alimentação', 'expense'),
    (gen_random_uuid(), dev_user, 'Salário', 'income')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.accounts (id, user_id, name, type, initial_balance_cents, current_balance_cents)
  VALUES
    (gen_random_uuid(), dev_user, 'Conta Demo', 'checking', 100000, 100000)
  ON CONFLICT DO NOTHING;
END
$$;

-- ============ DEV LOCAL ONLY — dono do sistema (ADR-002 P1) ============
-- Roda só em `supabase db reset` local. NUNCA em produção: a senha vem de
-- `SEED_ADMIN_PASSWORD` (GUC `seed.admin_password`) ou é aleatória — nunca
-- existe valor commitado, em `VITE_*`, bundle ou log.
-- Troca no primeiro acesso via Auth (`updateUser`): o trigger
-- on_auth_user_password_changed limpa must_change_password no mesmo COMMIT.
-- Idempotente: e-mail já existente → não reseta senha/flag; só garante o
-- operador ATIVO (bootstrap de DEV, abaixo); dono divergente →
-- seed-admin-conflict.
DO $$
DECLARE
  v_seed_id uuid := '00000000-0000-4000-8000-0000000000a1';
  v_existing uuid;
  v_role text;
  v_password text;
  v_generated boolean := false;
BEGIN
  SELECT u.id INTO v_existing FROM auth.users AS u
  WHERE u.email = 'admin@atlas.test';

  IF v_existing IS NOT NULL THEN
    SELECT p.role INTO v_role FROM public.profiles AS p
    WHERE p.id = v_existing;
    IF v_role IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'seed-admin-conflict';
    END IF;
    -- SEC-03/SEC-05: bootstrap de DEV — o backoffice local nasce acessível.
    -- Produção NÃO usa este caminho (seed não roda lá); lá a ativação é
    -- DBA/psql (runbook §10). Idempotente e nunca rebaixa/desativa.
    INSERT INTO public.internal_operators (user_id, active, disabled_at)
    VALUES (v_existing, true, NULL)
    ON CONFLICT (user_id) DO UPDATE SET active = true, disabled_at = NULL;
    RETURN;
  END IF;

  -- Senha: GUC de sessão (SEED_ADMIN_PASSWORD via PGOPTIONS) ou aleatória.
  v_password := NULLIF(pg_catalog.current_setting('seed.admin_password', true), '');
  IF v_password IS NULL THEN
    v_password := encode(gen_random_bytes(18), 'base64');
    v_generated := true;
  END IF;

  -- Campos que o GoTrue exige para signInWithPassword (medido no signup real:
  -- instance_id da instância, aud/role 'authenticated', bcrypt cost 10 e
  -- tokens vazios NOT-NULL; sem eles: invalid_credentials ou scan error).
  -- A senha entra aqui (INSERT não dispara o trigger de troca de senha).
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change_token_new, email_change, email_change_token_current,
    phone_change_token, phone_change, reauthentication_token,
    created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  )
  VALUES (
    v_seed_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'admin@atlas.test',
    crypt(v_password, gen_salt('bf', 10)),
    now(), '', '', '', '', '', '', '', '',
    now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb
  );

  -- handle_new_user (trigger) criou o profile como 'user'; o promote roda
  -- como DBA (postgres) — deny_role_change permite e a trilha grant_super_admin
  -- nasce, como em qualquer grant. A flag de primeiro acesso vem DEPOIS da
  -- senha (INSERT acima), no mesmo UPDATE do role.
  UPDATE public.profiles
  SET role = 'super_admin', must_change_password = true
  WHERE id = v_seed_id;

  -- SEC-03/SEC-05: operador ATIVO do admin de dev (bootstrap local).
  -- O trigger internal_operators_audit registra operator_provisioned.
  INSERT INTO public.internal_operators (user_id, active, disabled_at)
  VALUES (v_seed_id, true, NULL)
  ON CONFLICT (user_id) DO UPDATE SET active = true, disabled_at = NULL;

  IF v_generated THEN
    RAISE NOTICE 'seed: SEED_ADMIN_PASSWORD ausente — senha aleatória de admin@atlas.test (exibida UMA única vez): %', v_password;
  ELSE
    RAISE NOTICE 'seed: admin@atlas.test criado com a senha de SEED_ADMIN_PASSWORD (must_change_password=true)';
  END IF;
END
$$;

-- ============ DEMO USER (demonstração) ============
-- Roda só em `supabase db reset` local. Idempotente por e-mail.
-- Senha via GUC `seed.demo_password` (SEED_DEMO_PASSWORD) ou aleatória (notice).
-- must_change_password=false para login direto de demonstração.
DO $$
DECLARE
  v_seed_id uuid := '00000000-0000-4000-8000-0000000000c1';
  v_existing uuid;
  v_password text;
  v_generated boolean := false;
BEGIN
  SELECT u.id INTO v_existing FROM auth.users AS u
  WHERE u.email = 'demo@atlasfinanceiro.com';

  IF v_existing IS NOT NULL THEN
    RAISE NOTICE 'seed: demo@atlasfinanceiro.com já existe — no-op';
    RETURN;
  END IF;

  v_password := NULLIF(pg_catalog.current_setting('seed.demo_password', true), '');
  IF v_password IS NULL THEN
    v_password := encode(gen_random_bytes(18), 'base64');
    v_generated := true;
  END IF;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change_token_new, email_change, email_change_token_current,
    phone_change_token, phone_change, reauthentication_token,
    created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  )
  VALUES (
    v_seed_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'demo@atlasfinanceiro.com',
    crypt(v_password, gen_salt('bf', 10)),
    now(), '', '', '', '', '', '', '', '',
    now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb
  );

  UPDATE public.profiles
  SET role = 'user', must_change_password = false
  WHERE id = v_seed_id;

  IF v_generated THEN
    RAISE NOTICE 'seed: SEED_DEMO_PASSWORD ausente — senha aleatória de demo@atlasfinanceiro.com (exibida UMA única vez): %', v_password;
  ELSE
    RAISE NOTICE 'seed: demo@atlasfinanceiro.com criado com a senha de SEED_DEMO_PASSWORD (must_change_password=false)';
  END IF;
END
$$;

-- ============ ADMIN CONTROL PLANE (esticagrana) ============
-- Roda só em `supabase db reset` local. Idempotente por e-mail.
-- Senha via GUC `seed.admin_password` (SEED_ADMIN_PASSWORD) ou aleatória (notice).
DO $$
DECLARE
  v_seed_id uuid := '00000000-0000-4000-8000-0000000000b1';
  v_existing uuid;
  v_role text;
  v_password text;
  v_generated boolean := false;
BEGIN
  SELECT u.id INTO v_existing FROM auth.users AS u
  WHERE u.email = 'admin@esticagrana.com';

  IF v_existing IS NOT NULL THEN
    SELECT p.role INTO v_role FROM public.profiles AS p
    WHERE p.id = v_existing;
    IF v_role IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'seed-admin-conflict';
    END IF;
    INSERT INTO public.internal_operators (user_id, active, disabled_at)
    VALUES (v_existing, true, NULL)
    ON CONFLICT (user_id) DO UPDATE SET active = true, disabled_at = NULL;
    RAISE NOTICE 'seed: admin@esticagrana.com já existe — operador garantido ativo';
    RETURN;
  END IF;

  v_password := NULLIF(pg_catalog.current_setting('seed.admin_password', true), '');
  IF v_password IS NULL THEN
    v_password := encode(gen_random_bytes(18), 'base64');
    v_generated := true;
  END IF;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change_token_new, email_change, email_change_token_current,
    phone_change_token, phone_change, reauthentication_token,
    created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  )
  VALUES (
    v_seed_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'admin@esticagrana.com',
    crypt(v_password, gen_salt('bf', 10)),
    now(), '', '', '', '', '', '', '', '',
    now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb
  );

  UPDATE public.profiles
  SET role = 'super_admin', must_change_password = true
  WHERE id = v_seed_id;

  INSERT INTO public.internal_operators (user_id, active, disabled_at)
  VALUES (v_seed_id, true, NULL)
  ON CONFLICT (user_id) DO UPDATE SET active = true, disabled_at = NULL;

  IF v_generated THEN
    RAISE NOTICE 'seed: SEED_ADMIN_PASSWORD ausente — senha aleatória de admin@esticagrana.com (exibida UMA única vez): %', v_password;
  ELSE
    RAISE NOTICE 'seed: admin@esticagrana.com criado com a senha de SEED_ADMIN_PASSWORD (must_change_password=true)';
  END IF;
END
$$;

-- ============ TENANT DO USUÁRIO DEMO (quota por tenant: 0061/0076) ============
-- Replica, como DBA no seed, o caminho de provisionamento da RPC
-- create_tenant_for_invited_user (0077:174-259): GUCs de escrita/motivo,
-- tenant pf + membership owner + aceite + assinatura free ACTIVE na MESMA
-- transação + trilha admin_audit. Sem isto, INSERT de accounts/transactions
-- com JWT do demo falha com `quota-tenant-missing` (nenhum membership
-- resolvível para private.resolve_writable_tenant).
-- Idempotente: tenant do dono com mesmo CPF entre não-cancelados ⇒ no-op.
-- Sem segredo novo (senha continua via GUC) e sem PII real (CPF de teste).
DO $$
DECLARE
  v_demo_id uuid;
  v_existing uuid;
  v_tenant_id uuid := '00000000-0000-4000-8000-0000000000d1';
  v_document text := '52998224725';
BEGIN
  SELECT u.id INTO v_demo_id FROM auth.users AS u
  WHERE u.email = 'demo@atlasfinanceiro.com';

  IF v_demo_id IS NULL THEN
    RAISE NOTICE 'seed: demo@atlasfinanceiro.com ausente — tenant demo no-op';
    RETURN;
  END IF;

  -- Chave de reuso da 0077: (owner, documento) entre tenants não cancelados.
  SELECT t.id INTO v_existing
  FROM public.tenants AS t
  WHERE t.owner_user_id = v_demo_id
    AND t.subscription_status <> 'canceled'
    AND t.cpf = v_document
  ORDER BY t.created_at, t.id
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE NOTICE 'seed: tenant demo já existe (%) — no-op', v_existing;
    RETURN;
  END IF;

  -- Defesa extra: documento de teste pertence a outro dono (não cancelado) ⇒
  -- nunca duplicar CPF nem estourar tenants_cpf_active_uq; aborta com NOTICE.
  IF EXISTS (
    SELECT 1 FROM public.tenants AS t
    WHERE t.cpf = v_document AND t.subscription_status <> 'canceled'
  ) THEN
    RAISE NOTICE 'seed: CPF demo em uso por outro tenant — tenant demo no-op';
    RETURN;
  END IF;

  -- UUID fixo só quando livre; colisão ⇒ UUID aleatório (não falha o reset).
  IF EXISTS (SELECT 1 FROM public.tenants AS t WHERE t.id = v_tenant_id) THEN
    v_tenant_id := gen_random_uuid();
  END IF;

  -- Caminho de escrita intencional (0028) + motivo do espelho (0058).
  PERFORM pg_catalog.set_config('app.tenant_write', 'on', true);
  PERFORM pg_catalog.set_config('app.tenant_reason', 'onboarding', true);

  INSERT INTO public.tenants (
    id, kind, owner_user_id, cpf, razao_social, phone,
    endereco_cep, endereco_logradouro, endereco_numero,
    endereco_bairro, endereco_cidade, endereco_uf, plan_id
  ) VALUES (
    v_tenant_id, 'pf', v_demo_id, v_document, 'Demonstração Atlas', '11999999999',
    '01310100', 'Avenida Paulista', '1000',
    'Bela Vista', 'São Paulo', 'SP', 'free'
  )
  RETURNING id INTO v_tenant_id;

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (v_tenant_id, v_demo_id, 'owner');

  -- Constraint trigger diferida 0024 exige aceite no COMMIT.
  INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
  VALUES (v_tenant_id, 'termos-2026-11-v1', pg_catalog.now(), v_demo_id);

  -- free ⇒ active sem ciclo, sem trial, sem billing_day (0077:222-256).
  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, trial_ends_at, billing_day,
    period_start, period_end, psp_subscription_id, psp_customer_id,
    past_due_since, pending_plan_slug, pending_plan_at, cancel_at_period_end
  ) VALUES (
    v_tenant_id, 'free', 'active', NULL, NULL,
    NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, false
  );

  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (v_demo_id, v_tenant_id, v_tenant_id, 'other', 'tenant_onboard_provisioned');

  RAISE NOTICE 'seed: tenant demo free provisionado (%) para demo@atlasfinanceiro.com', v_tenant_id;
END
$$;
