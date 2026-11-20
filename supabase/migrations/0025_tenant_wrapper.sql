-- 0025_tenant_wrapper.sql — tenants-cobranca MVP (primeiro cadastro fim-a-fim).
--
-- Motivo: o MVP exige que todo cadastro concluído tenha tenant + membership
-- owner + aceite contratual na MESMA transação (invariante M-1). A RPC base
-- `create_tenant_with_owner` (0022) cria tenant + dono, e `accept_contract`
-- (0024) grava o aceite; chamadas separadas pelo cliente deixariam janela
-- para tenant sem aceite (só barrada no COMMIT pela trigger diferida, com
-- erro tardio). Este wrapper executa os dois passos numa única transação
-- server-side e devolve `tenant_id`.
--
-- Decisão humana 2026-11-05: plano fixo `free`, sem seletor, sem checkout.
-- A RPC base já barra `authenticated` não-admin com `tenant-plan-forbidden`;
-- o wrapper preserva a ordem de validação e repassa todos os rótulos.
--
-- Versão vigente do contrato (constante do app, exibida na UI, nunca editada
-- na UI): `termos-2026-11-v1`.
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `public.create_tenant_with_owner_and_acceptance(...)` — mesmos 13
--      params da RPC base (mesma ordem) + `p_contract_version text`.
--      Ordem de validação: not-authenticated → kind → plano → plano-forbidden
--      → documento → dados → tenant → membership → versão → aceite.
--   2) `REVOKE ALL` + `GRANT EXECUTE TO authenticated`; `search_path=''`.
--
-- Erros por rótulo fixo, sem id/documento/PII na mensagem:
--   todos os da RPC base (not-authenticated, tenant-kind-invalid,
--   tenant-plan-invalid, tenant-plan-forbidden, tenant-document-invalid,
--   tenant-document-duplicate, tenant-data-invalid)
--   + acceptance-version-invalid / acceptance-duplicate.
-- Qualquer falha desfaz tudo (nenhum tenant órfão, nenhum aceite órfão).
--
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0024 intocadas. Nenhum valor monetário neste ciclo.

-- ============ 1. RPC atômica: tenant + dono + aceite ============
-- Dono nunca vem do cliente: `owner_user_id = auth.uid()`.
-- `accepted_at = now()` e `user_id = auth.uid()` no servidor (como accept_contract).
-- A trigger diferida `tenant_acceptance_required` (0024) valida no COMMIT:
-- o INSERT do aceite ocorre antes do fim da transação, então o COMMIT passa.

CREATE OR REPLACE FUNCTION public.create_tenant_with_owner_and_acceptance(
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

  IF p_kind IS NULL OR p_kind NOT IN ('pf', 'pj') THEN
    RAISE EXCEPTION 'tenant-kind-invalid';
  END IF;

  IF p_plan_id IS NULL OR p_plan_id NOT IN ('free', 'standard', 'pro', 'full') THEN
    RAISE EXCEPTION 'tenant-plan-invalid';
  END IF;

  -- Plano pago é decisão de backoffice: `authenticated` comum só cria `free`.
  IF p_plan_id <> 'free'
    AND NOT public.is_admin()
    AND COALESCE((auth.jwt() ->> 'role'), '') <> 'service_role' THEN
    RAISE EXCEPTION 'tenant-plan-forbidden';
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
    v_uid,
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
  VALUES (v_tenant_id, v_uid, 'owner');

  -- Ordem 0024: versão antes do INSERT; formato slug 1..64 [A-Za-z0-9._-].
  IF pg_catalog.char_length(v_version) NOT BETWEEN 1 AND 64
    OR v_version !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'acceptance-version-invalid';
  END IF;

  INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
  VALUES (v_tenant_id, v_version, pg_catalog.now(), v_uid);

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

COMMENT ON FUNCTION public.create_tenant_with_owner_and_acceptance(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text
) IS
  'MVP tenants-cobranca: cria tenant + membership owner + aceite contratual na mesma transação. Plano fixo free no cliente; servidor barra não-free via tenant-plan-forbidden. Versão vigente: termos-2026-11-v1.';

REVOKE ALL ON FUNCTION public.create_tenant_with_owner_and_acceptance(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_tenant_with_owner_and_acceptance(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text
) TO authenticated;
