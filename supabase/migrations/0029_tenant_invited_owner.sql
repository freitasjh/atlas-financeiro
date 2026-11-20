-- 0029_tenant_invited_owner.sql — backoffice P0 / BE-04 (ADR-003).
--
-- Motivo: o fluxo atual (0022/0025) faz dono=`auth.uid()` do operador — um
-- admin que cadastra um convidado vira dono do tenant e o convidado fica sem
-- membership (invisível pós P0-01). ADR-003 exige dono=convidado: o admin
-- informa `p_invited_user_id` e tenant + membership `owner` + aceite nascem
-- na mesma transação, com o dono sendo o convidado, nunca o chamador.
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `public.create_tenant_for_invited_user(...)` — RPC atômica: gate
--      `is_admin()`, valida o convidado (`profiles`), insere tenant com
--      `owner_user_id = convidado`, membership `owner` do convidado e aceite
--      (`user_id = convidado`) na mesma transação (senão
--      `tenant-acceptance-required` 0024). Dono nunca é o operador.
--      Mesma ordem/validação de 0022/0025 + versão do aceite de 0024.
--   2) `REVOKE ALL` antes de `GRANT EXECUTE TO authenticated`.
--
-- Erros por rótulo fixo, sem id/documento/PII na mensagem:
--   not-authenticated, not-admin, tenant-owner-invalid, tenant-kind-invalid,
--   tenant-plan-invalid, tenant-document-invalid, tenant-document-duplicate,
--   tenant-data-invalid, acceptance-version-invalid, acceptance-duplicate.
-- Qualquer falha desfaz tudo (nenhum tenant órfão, nenhum aceite órfão).
--
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0028/0030 intocadas. Nenhum valor monetário neste ciclo.

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
  v_constraint text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  -- Só backoffice convida com dono terceiro; cadastro próprio usa 0022/0025.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  -- Dono=convidado (ADR-003): existe em profiles, nunca é o operador.
  IF p_invited_user_id IS NULL
    OR p_invited_user_id = v_uid
    OR NOT EXISTS (
      SELECT 1 FROM public.profiles AS p WHERE p.id = p_invited_user_id
    ) THEN
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

  -- Pré-validação espelha exatamente os CHECK/NOT NULL da tabela (como 0022):
  -- sem ela o DETAIL cru do Postgres devolveria documento/telefone/endereço.
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

  -- Ordem 0024: versão do aceite antes dos INSERTs; formato slug 1..64.
  IF pg_catalog.char_length(v_version) NOT BETWEEN 1 AND 64
    OR v_version !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'acceptance-version-invalid';
  END IF;

  -- Higiene (precedente 0028): o guard 0028 já libera DBA/owner, o GUC marca
  -- o caminho intencional da RPC.
  PERFORM pg_catalog.set_config('app.tenant_write', 'on', true);

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

  -- O dono responde pelo aceite (user_id = convidado, accepted_at no servidor).
  -- A trigger diferida `tenant_acceptance_required` (0024) valida no COMMIT.
  INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
  VALUES (v_tenant_id, v_version, pg_catalog.now(), p_invited_user_id);

  RETURN v_tenant_id;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IN ('tenants_cpf_active_uq', 'tenants_cnpj_active_uq') THEN
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
  'Backoffice P0 (ADR-003): admin cria tenant com dono=convidado + membership owner + aceite na mesma transação. Dono nunca é o operador; erros por rótulo fixo.';

REVOKE ALL ON FUNCTION public.create_tenant_for_invited_user(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_tenant_for_invited_user(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text
) TO authenticated;
