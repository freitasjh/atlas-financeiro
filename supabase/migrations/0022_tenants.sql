-- 0022_tenants.sql — tenants-cobranca / ADR-001 (entidade de cobrança e RLS).
--
-- Motivo: `profiles` acumula identidade de login (1 linha = 1 auth.users) e
-- entidade cobrável. Uma empresa não pode ser cobrada por seus usuários e
-- pf/pj entram pelo mesmo caminho sem discriminador registrado.
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `public.tenants` — entidade cobrável (documento fiscal, contato, plano).
--   2) `public.tenant_members` — vínculo N:N login × entidade (`owner|admin|member`).
--   3) `private.cpf_dv_ok` / `private.cnpj_dv_ok` — dígito verificador.
--   4) `private.user_tenant_ids()` — helper `SECURITY DEFINER` fora do schema
--      exposto pelo PostgREST (`config.toml`: só `public`/`graphql_public`).
--   5) `public.create_tenant_with_owner(...)` — RPC atômica: dono é sempre
--      `auth.uid()` (o cliente não escolhe dono) e tenant + membership `owner`
--      nascem na mesma transação (invariante I-1/I-5).
--   6) RLS por membership + `REVOKE ALL` antes de `GRANT SELECT`.
--
-- Invariantes provadas em `supabase/tests/tenants-adr001.spec.sql` (banco real,
-- `SET ROLE authenticated`):
--   I-1 todo tenant tem membership `owner` = `owner_user_id`
--   I-2 `kind='pf'` ⇔ `cpf` preenchido e `cnpj` nulo (e o inverso)
--   I-3 `authenticated` só vê tenants em que é membro, exceto `is_admin()`
--   I-4 CPF/CNPJ não se repetem entre tenants não cancelados
--   I-5 falha na RPC não deixa tenant sem dono
--
-- Erros por rótulo fixo, sem id/documento/PII na mensagem:
--   not-authenticated, tenant-kind-invalid, tenant-plan-invalid,
--   tenant-plan-forbidden, tenant-document-invalid,
--   tenant-document-duplicate, tenant-data-invalid.
-- Nenhum `DETAIL`/`HINT` cru do Postgres chega ao cliente: dados inválidos
-- (CHECK/NOT NULL/FK) são pré-validados na RPC e mapeados para
-- `tenant-data-invalid` antes do INSERT.
--
-- Idempotente-safe: CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- DROP POLICY IF EXISTS / DROP TRIGGER IF EXISTS + REVOKE/GRANT repetíveis.
-- Migrations 0001–0021 intocadas. Nenhum valor monetário neste ciclo.

-- ============ 1. Schema privado (fora do PostgREST) ============

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

COMMENT ON SCHEMA private IS
  'Helpers de RLS. Fora de `supabase/config.toml` (schemas = public, graphql_public): não exposto ao PostgREST.';

-- ============ 2. Tabelas ============

CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  cpf char(11),
  cnpj char(14),
  razao_social text NOT NULL,
  nome_fantasia text,
  endereco_cep char(8),
  endereco_logradouro text,
  endereco_numero text,
  endereco_complemento text,
  endereco_bairro text,
  endereco_cidade text,
  endereco_uf char(2),
  phone text,
  plan_id text NOT NULL DEFAULT 'free',
  subscription_status text NOT NULL DEFAULT 'trial',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_kind_check CHECK (kind IN ('pf', 'pj')),
  CONSTRAINT tenants_plan_id_check
    CHECK (plan_id IN ('free', 'standard', 'pro', 'full')),
  CONSTRAINT tenants_subscription_status_check
    CHECK (subscription_status IN ('trial', 'active', 'past_due', 'canceled')),
  CONSTRAINT tenants_kind_document CHECK (
    (kind = 'pf' AND cpf IS NOT NULL AND cnpj IS NULL)
    OR (kind = 'pj' AND cnpj IS NOT NULL AND cpf IS NULL)
  ),
  CONSTRAINT tenants_cpf_format
    CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$'),
  CONSTRAINT tenants_cnpj_format
    CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
  CONSTRAINT tenants_razao_social_len
    CHECK (char_length(btrim(razao_social)) BETWEEN 1 AND 200),
  CONSTRAINT tenants_nome_fantasia_len
    CHECK (nome_fantasia IS NULL OR char_length(btrim(nome_fantasia)) BETWEEN 1 AND 200),
  CONSTRAINT tenants_endereco_cep_format
    CHECK (endereco_cep IS NULL OR endereco_cep ~ '^[0-9]{8}$'),
  CONSTRAINT tenants_endereco_uf_format
    CHECK (endereco_uf IS NULL OR endereco_uf ~ '^[A-Z]{2}$'),
  CONSTRAINT tenants_phone_format
    CHECK (phone IS NULL OR phone ~ '^[0-9]{10,13}$'),
  CONSTRAINT tenants_endereco_fields_len CHECK (
    (endereco_logradouro IS NULL OR char_length(btrim(endereco_logradouro)) BETWEEN 1 AND 120)
    AND (endereco_numero IS NULL OR char_length(btrim(endereco_numero)) BETWEEN 1 AND 120)
    AND (endereco_complemento IS NULL OR char_length(btrim(endereco_complemento)) BETWEEN 1 AND 120)
    AND (endereco_bairro IS NULL OR char_length(btrim(endereco_bairro)) BETWEEN 1 AND 120)
    AND (endereco_cidade IS NULL OR char_length(btrim(endereco_cidade)) BETWEEN 1 AND 120)
  )
);

COMMENT ON TABLE public.tenants IS
  'Entidade cobrável (ADR-001). Escrita exclusiva da RPC create_tenant_with_owner; leitura por membership.';
COMMENT ON COLUMN public.tenants.cpf IS
  'Somente dígitos (11). Máscara é responsabilidade de UI, nunca do banco.';
COMMENT ON COLUMN public.tenants.cnpj IS
  'Somente dígitos (14). Máscara é responsabilidade de UI, nunca do banco.';

CREATE TABLE IF NOT EXISTS public.tenant_members (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT tenant_members_role_check
    CHECK (role IN ('owner', 'admin', 'member'))
);

COMMENT ON TABLE public.tenant_members IS
  'Vínculo N:N login (profiles) × entidade cobrável (tenants). Escrita exclusiva da RPC; leitura por membership.';

-- ============ 3. Índices ============

CREATE INDEX IF NOT EXISTS tenants_owner_idx
  ON public.tenants (owner_user_id);

-- I-4: documento único entre tenants não cancelados (cancelado libera o documento).
CREATE UNIQUE INDEX IF NOT EXISTS tenants_cpf_active_uq
  ON public.tenants (cpf)
  WHERE cpf IS NOT NULL AND subscription_status <> 'canceled';

CREATE UNIQUE INDEX IF NOT EXISTS tenants_cnpj_active_uq
  ON public.tenants (cnpj)
  WHERE cnpj IS NOT NULL AND subscription_status <> 'canceled';

CREATE INDEX IF NOT EXISTS tenant_members_user_idx
  ON public.tenant_members (user_id);

-- I-1: no máximo uma membership `owner` por tenant.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_members_one_owner_uq
  ON public.tenant_members (tenant_id)
  WHERE role = 'owner';

-- ============ 4. updated_at (reutiliza função de 0001) ============

DROP TRIGGER IF EXISTS set_tenants_updated_at ON public.tenants;
CREATE TRIGGER set_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ 5. Dígito verificador (uso interno da RPC) ============
-- Funções puras (`IMMUTABLE`), em schema privado, sem EXECUTE para client:
-- a validação de documento é server-side e não é um endpoint.

CREATE OR REPLACE FUNCTION private.cpf_dv_ok(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_sum int;
  v_rest int;
  v_dv int;
BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9]{11}$' THEN
    RETURN false;
  END IF;

  -- Sequências repetidas (000.000.000-00 ... 999.999.999-99) passam no DV e
  -- não são CPF: recusa explícita.
  IF p_value ~ '^([0-9])\1{10}$' THEN
    RETURN false;
  END IF;

  SELECT pg_catalog.sum(pg_catalog.substr(p_value, i, 1)::int * (11 - i))
    INTO v_sum
  FROM pg_catalog.generate_series(1, 9) AS i;

  v_rest := v_sum % 11;
  v_dv := CASE WHEN v_rest < 2 THEN 0 ELSE 11 - v_rest END;
  IF v_dv <> pg_catalog.substr(p_value, 10, 1)::int THEN
    RETURN false;
  END IF;

  SELECT pg_catalog.sum(pg_catalog.substr(p_value, i, 1)::int * (12 - i))
    INTO v_sum
  FROM pg_catalog.generate_series(1, 10) AS i;

  v_rest := v_sum % 11;
  v_dv := CASE WHEN v_rest < 2 THEN 0 ELSE 11 - v_rest END;
  RETURN v_dv = pg_catalog.substr(p_value, 11, 1)::int;
END;
$$;

CREATE OR REPLACE FUNCTION private.cnpj_dv_ok(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_weights1 int[] := ARRAY[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  v_weights2 int[] := ARRAY[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  v_sum int := 0;
  v_rest int;
  v_dv int;
  i int;
BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9]{14}$' THEN
    RETURN false;
  END IF;

  IF p_value ~ '^([0-9])\1{13}$' THEN
    RETURN false;
  END IF;

  FOR i IN 1..12 LOOP
    v_sum := v_sum + pg_catalog.substr(p_value, i, 1)::int * v_weights1[i];
  END LOOP;
  v_rest := v_sum % 11;
  v_dv := CASE WHEN v_rest < 2 THEN 0 ELSE 11 - v_rest END;
  IF v_dv <> pg_catalog.substr(p_value, 13, 1)::int THEN
    RETURN false;
  END IF;

  v_sum := 0;
  FOR i IN 1..13 LOOP
    v_sum := v_sum + pg_catalog.substr(p_value, i, 1)::int * v_weights2[i];
  END LOOP;
  v_rest := v_sum % 11;
  v_dv := CASE WHEN v_rest < 2 THEN 0 ELSE 11 - v_rest END;
  RETURN v_dv = pg_catalog.substr(p_value, 14, 1)::int;
END;
$$;

REVOKE ALL ON FUNCTION private.cpf_dv_ok(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.cnpj_dv_ok(text) FROM PUBLIC, anon, authenticated, service_role;

-- ============ 6. Helper de membership ============
-- SECURITY DEFINER: a policy precisa enxergar `tenant_members` sem depender da
-- RLS do chamador (que é a própria tabela consultada — policy recursiva daria
-- `42P17`). `STABLE` + subquery `IN (SELECT ...)`: avaliação única por statement.
-- `search_path = ''` + tudo qualificado: sem sequestro por schema do chamador.

CREATE OR REPLACE FUNCTION private.user_tenant_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT tm.tenant_id
  FROM public.tenant_members AS tm
  WHERE tm.user_id = (SELECT auth.uid());
$$;

REVOKE ALL ON FUNCTION private.user_tenant_ids() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION private.user_tenant_ids() TO authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

-- ============ 7. RPC atômica: tenant + dono ============
-- Dono nunca vem do cliente: `owner_user_id = auth.uid()`.
-- Ordem de validação exigida pela SPEC §5: nulo → kind → plano → documento →
-- dados de contato/endereço.
-- `EXCEPTION WHEN unique_violation` só vira `tenant-document-duplicate` quando
-- o índice violado é um dos índices parciais de documento (I-4); qualquer outra
-- unicidade vira `tenant-data-invalid` — o rótulo nunca mente.
-- Falhas de CHECK/NOT NULL/FK viram `tenant-data-invalid` sem expor o `DETAIL`
-- cru (`Failing row contains ...`), que carregaria documento/telefone/endereço.
-- Qualquer erro desfaz os INSERTs da subtransação (nenhum tenant órfão, I-5).

CREATE OR REPLACE FUNCTION public.create_tenant_with_owner(
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
  p_plan_id text DEFAULT 'free'
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
  -- `admin` (is_admin) e `service_role` (claim do JWT) mantêm o catálogo.
  IF p_plan_id <> 'free'
    AND NOT public.is_admin()
    AND COALESCE((auth.jwt() ->> 'role'), '') <> 'service_role' THEN
    RAISE EXCEPTION 'tenant-plan-forbidden';
  END IF;

  IF (p_kind = 'pf' AND NOT private.cpf_dv_ok(v_document))
    OR (p_kind = 'pj' AND NOT private.cnpj_dv_ok(v_document)) THEN
    RAISE EXCEPTION 'tenant-document-invalid';
  END IF;

  -- Pré-validação espelha exatamente os CHECK/NOT NULL da tabela. Sem ela, o
  -- `DETAIL` cru do Postgres (`Failing row contains ...`) devolveria documento,
  -- telefone e endereço ao cliente via PostgREST.
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

  RETURN v_tenant_id;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IN ('tenants_cpf_active_uq', 'tenants_cnpj_active_uq') THEN
      RAISE EXCEPTION 'tenant-document-duplicate';
    END IF;
    RAISE EXCEPTION 'tenant-data-invalid';
  WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'tenant-data-invalid';
END;
$$;

REVOKE ALL ON FUNCTION public.create_tenant_with_owner(
  text, text, text, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_tenant_with_owner(
  text, text, text, text, text, text, text, text, text, text, text, text, text
) TO authenticated;

-- ============ 8. RLS ============

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;

-- Leitura: admin (backoffice) ou membro do tenant. `is_admin()` e o helper são
-- avaliados em subquery/EXISTS: viram `InitPlan`/semi-join e são executados 1×
-- por statement, nunca por linha candidata. Nenhuma policy de
-- INSERT/UPDATE/DELETE: escrita é exclusiva da RPC.

DROP POLICY IF EXISTS tenants_select_member ON public.tenants;
CREATE POLICY tenants_select_member ON public.tenants
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin())
    OR EXISTS (
      SELECT 1 FROM private.user_tenant_ids() AS u WHERE u = tenants.id
    )
  );

DROP POLICY IF EXISTS tenant_members_select_member ON public.tenant_members;
CREATE POLICY tenant_members_select_member ON public.tenant_members
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin())
    OR EXISTS (
      SELECT 1 FROM private.user_tenant_ids() AS u WHERE u = tenant_members.tenant_id
    )
  );

-- ============ 9. Privilégios ============
-- Supabase concede ALL a anon/authenticated/service_role em tabelas novas de
-- `public` (default privileges). REVOKE ALL antes do GRANT SELECT: sem grant de
-- escrita, nenhuma policy "salva" o cliente (T06 prova `42501`).

REVOKE ALL ON TABLE public.tenants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tenant_members FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.tenants TO authenticated;
GRANT SELECT ON TABLE public.tenant_members TO authenticated;

-- Default privileges de FUNÇÕES para o role que aplica as migrations
-- (`postgres`): sem isto, uma função nova em `private` nasce com o default
-- hardwired do Postgres (`PUBLIC=X`), pois `private` não tem entrada em
-- `pg_default_acl`. O `IN SCHEMA private` era no-op medido (`pg_default_acl`
-- sem linha para o schema). O escopo global do role `postgres` não altera
-- `public`/`storage`, que têm entrada por schema com grants explícitos.
-- O helper continua recebendo GRANT explícito para `authenticated`.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
