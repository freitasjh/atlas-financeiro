-- 0077_tenant_onboarding_provisioning.sql — tenant-onboarding / F2 / ADR-006 (BE-22).
--
-- Motivo: `create_tenant_for_invited_user` (0029) cria tenant + membership owner
-- + aceite, mas NÃO cria a assinatura (ADR-001 nasceu depois) e não conhece
-- reuso nem convite pendente. Resultado: tenant novo sem objeto de cobrança
-- (fail-open de `private.subscription_access`, ADR-005 §18.3 T-A6) e retry da
-- borda duplicando tentativa em `tenant-document-duplicate`.
--
-- Entrega (REQ-01..07, REQ-16..19; I1/I2/I3/I4/I10):
--   1) `CREATE OR REPLACE public.create_tenant_for_invited_user(...)` com a
--      assinatura IDÊNTICA de `0029:27` (15 args, RETURNS uuid).
--   2) Ordem de validação de SPEC §4.2: not-authenticated → is_admin() →
--      invite-pending (sem identidade materializada) → tenant-owner-invalid
--      (convidado = operador) → kind → plan → documento → dados → aceite →
--      REUSO por `(owner_user_id, documento)` entre não-cancelados.
--   3) REUSO (ADR-006 D3): tenant já existente devolve o mesmo `uuid`, 0 INSERT
--      em tenants/membership/aceite/assinatura e 1 linha de trilha
--      `tenant_onboard_reused`. Corrida em `tenants_cpf_active_uq`/
--      `tenants_cnpj_active_uq` repete o lookup: dono casa ⇒ reuso; não casa ⇒
--      `tenant-document-duplicate` (REQ-07).
--   4) Assinatura nasce na MESMA transação (A2/O1): `free` ⇒ `active` sem
--      período/aniversário; plano cobrável ⇒ `trial` 14 dias com
--      `billing_day` = dia da ativação em `America/Sao_Paulo`.
--   5) GUCs `app.tenant_write='on'` + `app.tenant_reason='onboarding'` para
--      `tenants_write_guard` (0028) e para a trilha do espelho (0058).
--   6) Trilha append-only em `admin_audit` (`action='other'`,
--      `reason='tenant_onboard_provisioned'|'tenant_onboard_reused'`), sem PII.
--
-- Contrato do reuso (D3): devolve o tenant existente e **ignora** `p_plan_id` do
-- payload — o plano não é reescrito por esta RPC. A troca real de plano é
-- `admin_override_subscription` (0060); o painel deve reler plano/estado
-- efetivo depois de provisionar (ver `COMMENT ON FUNCTION`).
--
-- Sem tabela nova, sem coluna nova, sem índice novo (o lookup do reuso usa
-- `tenants_owner_idx`, 0022:122-123 — desvio declarado O-F1-3). Migrations
-- 0001–0060 intocadas.
--
-- Idempotente-safe: guard de pré-condição + CREATE OR REPLACE +
-- REVOKE/GRANT/COMMENT repetíveis.
-- Nenhum valor monetário neste ciclo (a fatia não emite fatura).

-- F12 (SPEC §14 D2/D3): pré-condição dura, fail-closed na aplicação. Sem a
-- tabela de assinatura (`0055`) ou sem o trigger de espelho (`0058`) a RPC
-- abaixo não cumpre REQ-16..REQ-18 e o erro só apareceria no runtime, com o
-- DETAIL cru do Postgres. Aplicar 0077 fora de ordem ⇒ este rótulo fixo.
DO $$
BEGIN
  IF to_regclass('public.tenant_subscriptions') IS NULL
    OR to_regprocedure('public.tenant_subscriptions_mirror()') IS NULL THEN
    RAISE EXCEPTION 'tenant-onboarding-precondition-missing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.create_tenant_for_invited_user(
  p_invited_user_id uuid,
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
  p_plan_id text DEFAULT 'free',
  p_contract_version text DEFAULT 'termos-2026-11-v1'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
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
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  -- Só backoffice convida com dono terceiro; cadastro próprio segue fechado
  -- (0052/0053). Erros herdados de is_admin() propagam sem tradução (REQ-02).
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  -- REQ-03: sem identidade materializada (convite ainda não aceito/registrado)
  -- não há dono possível. `NULL` cai no mesmo ramo.
  IF p_invited_user_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.profiles AS p WHERE p.id = p_invited_user_id
    ) THEN
    RAISE EXCEPTION 'invite-pending';
  END IF;

  -- Dono = convidado (ADR-006 D1): nunca o operador (autoprovisionamento).
  IF p_invited_user_id = v_uid THEN
    RAISE EXCEPTION 'tenant-owner-invalid';
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('pf', 'pj') THEN
    RAISE EXCEPTION 'tenant-kind-invalid';
  END IF;

  IF p_plan_id IS NULL OR p_plan_id NOT IN ('free', 'standard', 'pro', 'full') THEN
    RAISE EXCEPTION 'tenant-plan-invalid';
  END IF;

  IF (p_kind = 'pf' AND NOT private.cpf_dv_ok(v_document))
    OR (p_kind = 'pj' AND NOT private.cnpj_dv_ok(v_document)) THEN
    RAISE EXCEPTION 'tenant-document-invalid';
  END IF;

  -- Pré-validação espelha os CHECK/NOT NULL da tabela (como 0022/0029): sem ela
  -- o DETAIL cru do Postgres devolveria documento/telefone/endereço.
  IF char_length(v_razao_social) NOT BETWEEN 1 AND 200
    OR (v_nome_fantasia IS NOT NULL AND char_length(v_nome_fantasia) > 200)
    OR (v_phone IS NOT NULL AND v_phone !~ '^[0-9]{10,13}$')
    OR (v_cep IS NOT NULL AND v_cep !~ '^[0-9]{8}$')
    OR (v_uf IS NOT NULL AND v_uf !~ '^[A-Z]{2}$')
    OR (v_logradouro IS NOT NULL AND char_length(v_logradouro) > 120)
    OR (v_numero IS NOT NULL AND char_length(v_numero) > 120)
    OR (v_complemento IS NOT NULL AND char_length(v_complemento) > 120)
    OR (v_bairro IS NOT NULL AND char_length(v_bairro) > 120)
    OR (v_cidade IS NOT NULL AND char_length(v_cidade) > 120) THEN
    RAISE EXCEPTION 'tenant-data-invalid';
  END IF;

  -- Ordem 0024: versão do aceite antes de qualquer INSERT.
  IF pg_catalog.char_length(v_version) NOT BETWEEN 1 AND 64
    OR v_version !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'acceptance-version-invalid';
  END IF;

  -- REQ-06/I4: retry convergente. Chave natural `(owner, documento)` entre
  -- tenants não cancelados (o índice parcial de 0022 libera o documento quando
  -- o tenant é cancelado, então o predicado precisa excluir `canceled`).
  SELECT t.id INTO v_existing
  FROM public.tenants AS t
  WHERE t.owner_user_id = p_invited_user_id
    AND t.subscription_status <> 'canceled'
    AND (
      (p_kind = 'pf' AND t.cpf = v_document)
      OR (p_kind = 'pj' AND t.cnpj = v_document)
    )
  ORDER BY t.created_at, t.id
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
    VALUES (v_uid, v_existing, v_existing, 'other', 'tenant_onboard_reused');
    RETURN v_existing;
  END IF;

  -- Caminho de escrita intencional da RPC (0028) e motivo da trilha do espelho
  -- (0058): `free` gera exatamente 1 linha `tenant_status_changed`.
  PERFORM pg_catalog.set_config('app.tenant_write', 'on', true);
  PERFORM pg_catalog.set_config('app.tenant_reason', 'onboarding', true);

  -- `tenants.plan_id` já nasce = plan_slug (REQ-18): o espelho só muda o
  -- status, nunca a dimensão de plano.
  INSERT INTO public.tenants (
    kind,
    owner_user_id,
    cpf,
    cnpj,
    razao_social,
    nome_fantasia,
    endereco_cep,
    endereco_logradouro,
    endereco_numero,
    endereco_complemento,
    endereco_bairro,
    endereco_cidade,
    endereco_uf,
    phone,
    plan_id
  ) VALUES (
    p_kind,
    p_invited_user_id,
    CASE WHEN p_kind = 'pf' THEN v_document END,
    CASE WHEN p_kind = 'pj' THEN v_document END,
    v_razao_social,
    v_nome_fantasia,
    v_cep,
    v_logradouro,
    v_numero,
    v_complemento,
    v_bairro,
    v_cidade,
    v_uf,
    v_phone,
    p_plan_id
  )
  RETURNING id INTO v_tenant_id;

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (v_tenant_id, p_invited_user_id, 'owner');

  -- I3: a constraint trigger diferida `tenant_acceptance_required` (0024)
  -- valida no COMMIT; o dono responde pelo aceite.
  INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
  VALUES (v_tenant_id, v_version, pg_catalog.now(), p_invited_user_id);

  -- I2/REQ-16/REQ-17 (A2/O1): a assinatura nasce com o tenant. `free` sem ciclo;
  -- plano cobrável em trial de 14 dias com aniversário no dia corrente de
  -- São Paulo. Períodos ficam NULL até o 1º `payment_confirmed` (0059).
  INSERT INTO public.tenant_subscriptions (
    tenant_id,
    plan_slug,
    status,
    trial_ends_at,
    billing_day,
    period_start,
    period_end,
    psp_subscription_id,
    psp_customer_id,
    past_due_since,
    pending_plan_slug,
    pending_plan_at,
    cancel_at_period_end
  ) VALUES (
    v_tenant_id,
    p_plan_id,
    CASE WHEN p_plan_id = 'free' THEN 'active' ELSE 'trial' END,
    CASE WHEN p_plan_id = 'free' THEN NULL ELSE pg_catalog.now() + interval '14 days' END,
    CASE
      WHEN p_plan_id = 'free' THEN NULL
      ELSE EXTRACT(day FROM pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now()))::smallint
    END,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    false
  );

  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (v_uid, v_tenant_id, v_tenant_id, 'other', 'tenant_onboard_provisioned');

  RETURN v_tenant_id;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

    -- REQ-07: corrida no documento. O INSERT de tenants falhou, então o lookup
    -- do reuso é repetido: dono casa ⇒ reuso (retry convergente); dono não
    -- casa ⇒ duplicata de domínio. Nunca segundo tenant.
    IF v_constraint IN ('tenants_cpf_active_uq', 'tenants_cnpj_active_uq') THEN
      SELECT t.id INTO v_existing
      FROM public.tenants AS t
      WHERE t.owner_user_id = p_invited_user_id
        AND t.subscription_status <> 'canceled'
        AND (
          (p_kind = 'pf' AND t.cpf = v_document)
          OR (p_kind = 'pj' AND t.cnpj = v_document)
        )
      ORDER BY t.created_at, t.id
      LIMIT 1;

      IF v_existing IS NOT NULL THEN
        INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
        VALUES (v_uid, v_existing, v_existing, 'other', 'tenant_onboard_reused');
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

COMMENT ON FUNCTION public.create_tenant_for_invited_user(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text
) IS
  'ADR-006 D1/D3 (0077): admin cria tenant com dono=convidado + membership owner + aceite + assinatura na MESMA transação (free=>active sem ciclo; pago=>trial 14d com billing_day SP). Retry idêntico reusa por (owner, documento) entre não-cancelados e devolve o mesmo tenant_id; convite sem identidade => invite-pending. REUSO IGNORA p_plan_id: o plano do payload não reescreve o tenant existente (troca real de plano = admin_override_subscription, 0060); o painel deve reler plano/estado efetivo após provisionar. Erros por rótulo fixo, sem PII.';

REVOKE ALL ON FUNCTION public.create_tenant_for_invited_user(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_tenant_for_invited_user(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text
) TO authenticated;
