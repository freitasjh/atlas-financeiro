-- 0036_tenants_trgm.sql — backoffice-p0-mfa / P0M-BE-02 (ADR-003/004).
--
-- Motivo: `TenantTable`/`AdminService` já são server-driven (`?q=`), mas a
-- busca só casa `razao_social`/`nome_fantasia`/documento — sem índice
-- trigram, termo longo faz Seq Scan; sem match de `auth.users.email` do
-- owner, operador não encontra tenant pelo e-mail do dono (SPEC §7.2,
-- RF-P0-02). ADR-003: mesmo `p_search`, sem parâmetro novo (zero quebra no
-- client). ADR-004: extensão em schema `extensions` (RPCs com
-- `search_path=''`; extensão em `public` quebraria o invariante e abriria
-- hijack).
--
-- Entrega (server-side, só leitura):
--   1) `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions`.
--   2) Índices GIN `gin_trgm_ops` em `tenants.razao_social` e
--      `tenants.nome_fantasia` (termo >=3: ILIKE '%...%' é servido pelo GIN;
--      termo <3: mesmo ILIKE, Seq Scan por desenho — nunca fingido de GIN,
--      SPEC §7.2).
--   3) `admin_list_tenants` + `admin_count_tenants` redefinidas juntas (a
--      contagem nunca diverge): predicado idêntico de busca, acrescido do
--      match `EXISTS (SELECT 1 FROM auth.users u WHERE u.id =
--      t.owner_user_id AND u.email ILIKE <padrão>)`. Sem índice novo em
--      `auth.users` (tentativa 2: DDL em schema `auth` pode ser recusado no
--      hosted — seq scan inicial aceitável pela escala, SPEC ADR-003).
--
-- Gate preservado: `(SELECT public.is_admin())` InitPlan (1× por statement);
-- `anon` sem EXECUTE → `42501`; não-admin → `not-admin`. Erros por rótulo
-- fixo, sem PII (o termo de busca nunca aparece nas mensagens).
--
-- Sem dinheiro nesta migration (só leitura de tenants).
-- Idempotente-safe: CREATE EXTENSION IF NOT EXISTS + CREATE INDEX IF NOT
-- EXISTS + CREATE OR REPLACE + REVOKE/GRANT repetíveis. Migrations
-- 0001–0035 intocadas.

-- ============ 1. pg_trgm em extensions (ADR-004) ============
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- ============ 2. Índices GIN trigram ============
CREATE INDEX IF NOT EXISTS tenants_razao_social_trgm
  ON public.tenants USING gin (razao_social gin_trgm_ops);

CREATE INDEX IF NOT EXISTS tenants_nome_fantasia_trgm
  ON public.tenants USING gin (nome_fantasia gin_trgm_ops);

-- ============ 3. Lista paginada + email do owner (ADR-003) ============
-- Predicado de busca idêntico ao de `admin_count_tenants` abaixo (incl. o
-- EXISTS em auth.users): um termo casa razao_social, nome_fantasia, cpf,
-- cnpj e o email do owner. Termo >=3 usa o GIN trigram via ILIKE
-- '%...%'; termo <3 cai no mesmo ILIKE sem índice (Seq Scan por desenho).
-- Placeholder/cópia não mudam aqui (P0M-FE-03).

CREATE OR REPLACE FUNCTION public.admin_list_tenants(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_sort text DEFAULT 'created_at',
  p_dir text DEFAULT 'desc',
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  kind text,
  cpf char(11),
  cnpj char(14),
  razao_social text,
  nome_fantasia text,
  plan_id text,
  subscription_status text,
  created_at timestamptz,
  owner_user_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_search text := NULLIF(pg_catalog.btrim(COALESCE(p_search, '')), '');
  v_status text := NULLIF(pg_catalog.btrim(COALESCE(p_status, '')), '');
  v_sort text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_sort, 'created_at')));
  v_dir text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_dir, 'desc')));
  v_sort_col text;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  -- InitPlan: gate avaliado 1× por statement (precedente 0022/0024).
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  CASE v_sort
    WHEN 'created_at' THEN v_sort_col := 'created_at';
    WHEN 'name' THEN v_sort_col := 'razao_social';
    WHEN 'plan' THEN v_sort_col := 'plan_id';
    WHEN 'status' THEN v_sort_col := 'subscription_status';
    ELSE RAISE EXCEPTION 'tenant-sort-invalid';
  END CASE;

  IF v_dir NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'tenant-sort-invalid';
  END IF;

  IF v_status IS NOT NULL
    AND v_status NOT IN ('trial', 'active', 'past_due', 'canceled') THEN
    RAISE EXCEPTION 'tenant-status-invalid';
  END IF;

  -- Coluna e direção vêm de whitelist validada acima: interpolação segura.
  -- Filtros via USING (nunca concatenados). Desempate fixo `id ASC`.
  RETURN QUERY EXECUTE format(
    'SELECT t.id, t.kind, t.cpf, t.cnpj, t.razao_social, t.nome_fantasia, '
    || 't.plan_id, t.subscription_status, t.created_at, t.owner_user_id '
    || 'FROM public.tenants AS t '
    || 'WHERE ($1 IS NULL OR t.razao_social ILIKE $1 '
    || 'OR t.nome_fantasia ILIKE $1 OR t.cpf ILIKE $1 OR t.cnpj ILIKE $1 '
    || 'OR EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = t.owner_user_id AND u.email ILIKE $1)) '
    || 'AND ($2 IS NULL OR t.subscription_status = $2) '
    || 'ORDER BY %I %s, t.id ASC LIMIT $3 OFFSET $4',
    v_sort_col, CASE WHEN v_dir = 'asc' THEN 'ASC' ELSE 'DESC' END
  ) USING
    CASE WHEN v_search IS NULL THEN NULL ELSE '%' || v_search || '%' END,
    v_status, v_limit, v_offset;
END;
$$;

COMMENT ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int) IS
  'Backoffice P0 MFA (ADR-003/004, 0036): lista tenants server-driven. Mesmo p_search casa razao_social, nome_fantasia, documento e auth.users.email do owner (EXISTS); termo >=3 usa GIN trigram em extensions, <3 cai no ILIKE; sort por whitelist + desempate id; limit clamp 1..100; só is_admin().';

REVOKE ALL ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int)
  TO authenticated;

-- ============ 4. Contagem com o mesmo predicado ============
-- Invariante (SPEC §7.1): count(admin_count_tenants) == len(admin_list_tenants)
-- para todo p_search/p_status — o predicado de busca é byte a byte o mesmo.

CREATE OR REPLACE FUNCTION public.admin_count_tenants(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_search text := NULLIF(pg_catalog.btrim(COALESCE(p_search, '')), '');
  v_status text := NULLIF(pg_catalog.btrim(COALESCE(p_status, '')), '');
  v_total bigint;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF v_status IS NOT NULL
    AND v_status NOT IN ('trial', 'active', 'past_due', 'canceled') THEN
    RAISE EXCEPTION 'tenant-status-invalid';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.tenants AS t
  WHERE (v_search IS NULL
    OR t.razao_social ILIKE '%' || v_search || '%'
    OR t.nome_fantasia ILIKE '%' || v_search || '%'
    OR t.cpf ILIKE '%' || v_search || '%'
    OR t.cnpj ILIKE '%' || v_search || '%'
    OR EXISTS (
      SELECT 1 FROM auth.users AS u
      WHERE u.id = t.owner_user_id
        AND u.email ILIKE '%' || v_search || '%'
    ))
    AND (v_status IS NULL OR t.subscription_status = v_status);

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.admin_count_tenants(text, text) IS
  'Backoffice P0 MFA (ADR-003/004, 0036): total de tenants com o mesmo predicado da lista (incl. email do owner via auth.users); só is_admin().';

REVOKE ALL ON FUNCTION public.admin_count_tenants(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_count_tenants(text, text)
  TO authenticated;
