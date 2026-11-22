-- 0101_signup_public_rpc.sql — ADR-001 / SIGN-06..SIGN-11 (cadastro público).
--
-- Motivo: a borda pública `signup-public` cria a identidade no GoTrue com a
-- chave publicável; o negócio nasce aqui, em UMA transação, por uma RPC
-- `security definer` executável SÓ por `service_role` (nunca `authenticated`).
-- Nenhuma tabela/coluna/índice novo: reaproveita 0022 (tenants, tenant_members,
-- DVs, índices parciais de documento), 0024 (aceite), 0055 (assinatura),
-- 0058 (espelho), 0019/0028/0032 (admin_audit).
--
-- Entrega:
--   1) public.create_tenant_for_public_signup(15 args, RETURNS uuid) — 5
--      INSERTs atômicos (tenant, membro owner, aceite, assinatura free/active,
--      auditoria provisioned), com reuso por (owner, documento) e tratamento
--      de unique_violation por re-checagem de dono.
--   2) public.record_public_signup_audit(3 args, RETURNS void) — eventos
--      constantes, target_id=COALESCE(user_id, request_id), sem PII.
--
-- Fronteira qualificada (NFR-03): as 5 escritas acima são atômicas; `auth.users`
-- lives na transação do GoTrue, FORA daqui, e é compensado por
-- `admin.deleteUser` na borda (chamada separada, não transacional). Nunca
-- afirmar "100% atômico" incluindo a identidade.
--
-- Rótulos internos (nunca vazam ao cliente): signup-request-invalid,
-- signup-owner-invalid, tenant-kind-invalid, tenant-document-invalid,
-- tenant-data-invalid, tenant-document-duplicate, acceptance-version-invalid,
-- acceptance-duplicate, signup-audit-event-invalid.
--
-- Idempotente-safe: guarda de pré-condição, CREATE OR REPLACE, COMMENT e
-- REVOKE/GRANT repetíveis. Zero CREATE TABLE / ALTER TABLE.

-- F12: pré-condições duras. Sem elas a RPC deixaria de cumprir o contrato e
-- o erro só apareceria no runtime com DETAIL cru.
DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL
    OR to_regclass('public.tenant_members') IS NULL
    OR to_regclass('public.contract_acceptances') IS NULL
    OR to_regclass('public.tenant_subscriptions') IS NULL
    OR to_regclass('public.admin_audit') IS NULL
    OR to_regprocedure('private.cpf_dv_ok(text)') IS NULL
    OR to_regprocedure('private.cnpj_dv_ok(text)') IS NULL
    OR to_regprocedure('public.tenant_subscriptions_mirror()') IS NULL THEN
    RAISE EXCEPTION 'signup-public-rpc-precondition-missing';
  END IF;
END $$;

-- ============ 1. RPC de provisionamento ============

CREATE OR REPLACE FUNCTION public.create_tenant_for_public_signup(
  p_request_id uuid,
  p_owner_user_id uuid,
  p_kind text,
  p_document text,
  p_razao_social text,
  p_nome_fantasia text,
  p_phone text,
  p_cep text,
  p_logradouro text,
  p_numero text,
  p_complemento text,
  p_bairro text,
  p_cidade text,
  p_uf text,
  p_contract_version text DEFAULT 'termos-2026-11-v1'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_document text := pg_catalog.btrim(COALESCE(p_document, ''));
  v_razao_social text := pg_catalog.btrim(COALESCE(p_razao_social, ''));
  v_nome_fantasia text := NULLIF(pg_catalog.btrim(p_nome_fantasia), '');
  v_cep text := NULLIF(pg_catalog.btrim(p_cep), '');
  v_logradouro text := NULLIF(pg_catalog.btrim(p_logradouro), '');
  v_numero text := NULLIF(pg_catalog.btrim(p_numero), '');
  v_complemento text := NULLIF(pg_catalog.btrim(p_complemento), '');
  v_bairro text := NULLIF(pg_catalog.btrim(p_bairro), '');
  v_cidade text := NULLIF(pg_catalog.btrim(p_cidade), '');
  v_uf text := NULLIF(pg_catalog.upper(pg_catalog.btrim(p_uf)), '');
  v_phone text := NULLIF(pg_catalog.btrim(p_phone), '');
  v_version text := pg_catalog.btrim(COALESCE(p_contract_version, ''));
  v_tenant_id uuid;
  v_existing uuid;
  v_constraint text;
BEGIN
  -- Ordem congelada (ADR §6.3): request → owner → kind → documento →
  -- dados → aceite → REUSO → 5 INSERTs.
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'signup-request-invalid';
  END IF;

  IF p_owner_user_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.profiles AS pr WHERE pr.id = p_owner_user_id
    ) THEN
    RAISE EXCEPTION 'signup-owner-invalid';
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('pf', 'pj') THEN
    RAISE EXCEPTION 'tenant-kind-invalid';
  END IF;

  IF (p_kind = 'pf' AND NOT private.cpf_dv_ok(v_document))
    OR (p_kind = 'pj' AND NOT private.cnpj_dv_ok(v_document)) THEN
    RAISE EXCEPTION 'tenant-document-invalid';
  END IF;

  -- Pré-validação espelha CHECK/NOT NULL de 0022: sem ela o DETAIL cru do
  -- Postgres devolveria documento/telefone/endereço ao chamador.
  IF pg_catalog.char_length(v_razao_social) NOT BETWEEN 1 AND 200
    OR (v_nome_fantasia IS NOT NULL AND pg_catalog.char_length(v_nome_fantasia) > 200)
    OR (v_phone IS NOT NULL AND v_phone !~ '^[0-9]{10,13}$')
    OR (v_cep IS NOT NULL AND v_cep !~ '^[0-9]{8}$')
    OR (v_uf IS NOT NULL AND v_uf !~ '^[A-Z]{2}$')
    OR (v_logradouro IS NOT NULL AND pg_catalog.char_length(v_logradouro) > 120)
    OR (v_numero IS NOT NULL AND pg_catalog.char_length(v_numero) > 120)
    OR (v_complemento IS NOT NULL AND pg_catalog.char_length(v_complemento) > 120)
    OR (v_bairro IS NOT NULL AND pg_catalog.char_length(v_bairro) > 120)
    OR (v_cidade IS NOT NULL AND pg_catalog.char_length(v_cidade) > 120) THEN
    RAISE EXCEPTION 'tenant-data-invalid';
  END IF;

  IF pg_catalog.char_length(v_version) NOT BETWEEN 1 AND 64
    OR v_version !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'acceptance-version-invalid';
  END IF;

  -- D4: chave natural (owner, documento) entre tenants não cancelados.
  SELECT t.id INTO v_existing
  FROM public.tenants AS t
  WHERE t.owner_user_id = p_owner_user_id
    AND t.subscription_status <> 'canceled'
    AND (
      (p_kind = 'pf' AND t.cpf = v_document)
      OR (p_kind = 'pj' AND t.cnpj = v_document)
    )
  ORDER BY t.created_at, t.id
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason, from_value, to_value)
    VALUES (NULL, v_existing, v_existing, 'other', 'signup-reused', p_request_id::text, NULL);
    RETURN v_existing;
  END IF;

  -- Caminho intencional de escrita (0028) e motivo do espelho (0058).
  PERFORM pg_catalog.set_config('app.tenant_write', 'on', true);
  PERFORM pg_catalog.set_config('app.tenant_reason', 'onboarding', true);

  -- 1/5 — tenant (free; status vira 'active' no espelho da assinatura).
  INSERT INTO public.tenants (
    kind, owner_user_id, cpf, cnpj, razao_social, nome_fantasia,
    endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento,
    endereco_bairro, endereco_cidade, endereco_uf, phone, plan_id
  ) VALUES (
    p_kind, p_owner_user_id,
    CASE WHEN p_kind = 'pf' THEN v_document END,
    CASE WHEN p_kind = 'pj' THEN v_document END,
    v_razao_social, v_nome_fantasia, v_cep, v_logradouro, v_numero,
    v_complemento, v_bairro, v_cidade, v_uf, v_phone, 'free'
  )
  RETURNING id INTO v_tenant_id;

  -- 2/5 — membro owner (tenant_members_one_owner_uq, 0022:138).
  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (v_tenant_id, p_owner_user_id, 'owner');

  -- 3/5 — aceite versionado (0024, append-only).
  INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
  VALUES (v_tenant_id, v_version, pg_catalog.now(), p_owner_user_id);

  -- 4/5 — assinatura free/active, sem trial, sem PSP, sem ciclo (ADR-006).
  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, trial_ends_at, billing_day,
    period_start, period_end, psp_subscription_id, psp_customer_id,
    past_due_since, pending_plan_slug, pending_plan_at, cancel_at_period_end
  ) VALUES (
    v_tenant_id, 'free', 'active', NULL, NULL,
    NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, false
  );

  -- 5/5 — auditoria da transação (sem PII; request_id em from_value).
  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason, from_value, to_value)
  VALUES (NULL, v_tenant_id, v_tenant_id, 'other', 'signup-public-provisioned', p_request_id::text, NULL);

  RETURN v_tenant_id;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

    IF v_constraint IN ('tenants_cpf_active_uq', 'tenants_cnpj_active_uq') THEN
      -- Corrida: o INSERT falhou; repete o lookup. Mesmo dono ⇒ reuso;
      -- dono diferente ⇒ rótulo INTERNO que a Edge mapeia a 201 genérico
      -- com compensação silenciosa (D8/🟡-1). Nunca segundo tenant.
      SELECT t.id INTO v_existing
      FROM public.tenants AS t
      WHERE t.owner_user_id = p_owner_user_id
        AND t.subscription_status <> 'canceled'
        AND (
          (p_kind = 'pf' AND t.cpf = v_document)
          OR (p_kind = 'pj' AND t.cnpj = v_document)
        )
      ORDER BY t.created_at, t.id
      LIMIT 1;

      IF v_existing IS NOT NULL THEN
        INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason, from_value, to_value)
        VALUES (NULL, v_existing, v_existing, 'other', 'signup-reused', p_request_id::text, NULL);
        RETURN v_existing;
      END IF;

      RAISE EXCEPTION 'tenant-document-duplicate';
    END IF;

    IF v_constraint = 'contract_acceptances_tenant_version_uq' THEN
      RAISE EXCEPTION 'acceptance-duplicate';
    END IF;
    RAISE EXCEPTION 'tenant-data-invalid';
  WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'tenant-data-invalid';
END;
$$;

COMMENT ON FUNCTION public.create_tenant_for_public_signup(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text
) IS
  'ADR-001 SIGN-06..10: provisionamento do cadastro público. 5 INSERTs numa transação (tenants/free, membro owner, aceite versionado, assinatura free/active sem trial/PSP, admin_audit signup-public-provisioned). Reuso por (owner, documento) entre não-cancelados ⇒ mesmo tenant_id + signup-reused, zero INSERT; documento de outro dono ⇒ tenant-document-duplicate (rótulo interno; a Edge compensa e responde 201 genérico). RAISE EXCEPTION desfaz as 5 escritas; auth.users fica fora e é compensado por admin.deleteUser na borda. SECURITY DEFINER, search_path="", EXECUTE só service_role. Sem is_admin(). Sem PII em mensagens.';

REVOKE ALL ON FUNCTION public.create_tenant_for_public_signup(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_tenant_for_public_signup(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text
) TO service_role;

-- ============ 2. RPC de auditoria (throttle/compensação) ============

CREATE OR REPLACE FUNCTION public.record_public_signup_audit(
  p_request_id uuid,
  p_event text,
  p_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reason text := CASE p_event
    WHEN 'signup-public-throttled' THEN p_event
    WHEN 'signup-public-compensated' THEN p_event
    ELSE NULL
  END;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'signup-request-invalid';
  END IF;

  -- Enum fechado: nada de texto livre do cliente em `reason` (NFR-02).
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'signup-audit-event-invalid';
  END IF;

  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason, from_value, to_value)
  VALUES (
    NULL,
    COALESCE(p_user_id, p_request_id),
    NULL,
    'other',
    v_reason,
    p_request_id::text,
    NULL
  );
END;
$$;

COMMENT ON FUNCTION public.record_public_signup_audit(uuid, text, uuid) IS
  'ADR-001 SIGN-11: trilha do anti-abuso e da compensação. p_event ∈ {signup-public-throttled, signup-public-compensated} validado por CASE; action=other, target_id=COALESCE(p_user_id,p_request_id), from_value=request_id, to_value=NULL, actor_id=NULL. Zero PII. SECURITY DEFINER, search_path="", EXECUTE só service_role (authenticated ⇒ 42501).';

REVOKE ALL ON FUNCTION public.record_public_signup_audit(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_public_signup_audit(uuid, text, uuid)
  TO service_role;
