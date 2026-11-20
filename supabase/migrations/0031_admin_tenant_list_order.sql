-- 0031_admin_tenant_list_order.sql — backoffice P0 / BE-05 (ADR-005).
--
-- Motivo: `TenantTable` client-side quebra em escala (SPEC ADR-005). Lista
-- server-driven com sort por whitelist, desempate determinístico por `id`,
-- cap 1..100 e contagem separada para paginação (`Mostrando X–Y de Z`).
--
-- Entrega (server-side, só leitura):
--   1) `public.admin_list_tenants(...)` — busca (`razao_social`, `nome_fantasia`,
--      documento), filtro `subscription_status`, sort whitelist
--      (`created_at|name|plan|status` + `asc|desc`, fora disso →
--      `tenant-sort-invalid`), desempate `id ASC`, `p_limit` clamp 1..100.
--   2) `public.admin_count_tenants(...)` — mesmos filtros, retorna `bigint`.
--   3) Índices de ordenação/filtro + `REVOKE ALL` antes de `GRANT EXECUTE`.
--
-- Gate: `(SELECT public.is_admin())` em subquery vira `InitPlan` (1× por
-- statement, nunca por linha). `anon` não tem EXECUTE → `42501`;
-- `authenticated` não-admin → `not-admin`. Erros por rótulo fixo, sem PII.
--
-- Idempotente-safe: CREATE OR REPLACE + CREATE INDEX IF NOT EXISTS +
-- REVOKE/GRANT repetíveis. Migrations 0001–0030 intocadas.
-- Sem dinheiro nesta migration (só leitura de tenants).

-- ============ 1. Índices de lista ============

CREATE INDEX IF NOT EXISTS tenants_list_created_idx
  ON public.tenants (created_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS tenants_list_status_name_idx
  ON public.tenants (subscription_status, razao_social ASC, id ASC);

-- ============ 2. Lista paginada server-driven ============

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
    || 'OR t.nome_fantasia ILIKE $1 OR t.cpf ILIKE $1 OR t.cnpj ILIKE $1) '
    || 'AND ($2 IS NULL OR t.subscription_status = $2) '
    || 'ORDER BY %I %s, t.id ASC LIMIT $3 OFFSET $4',
    v_sort_col, CASE WHEN v_dir = 'asc' THEN 'ASC' ELSE 'DESC' END
  ) USING
    CASE WHEN v_search IS NULL THEN NULL ELSE '%' || v_search || '%' END,
    v_status, v_limit, v_offset;
END;
$$;

COMMENT ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int) IS
  'Backoffice P0 (ADR-005): lista tenants server-driven. Sort por whitelist + desempate id; limit clamp 1..100; só is_admin().';

REVOKE ALL ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int)
  TO authenticated;

-- ============ 3. Contagem com os mesmos filtros ============

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
    OR t.cnpj ILIKE '%' || v_search || '%')
    AND (v_status IS NULL OR t.subscription_status = v_status);

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.admin_count_tenants(text, text) IS
  'Backoffice P0 (ADR-005): total de tenants com os mesmos filtros da lista; só is_admin().';

REVOKE ALL ON FUNCTION public.admin_count_tenants(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_count_tenants(text, text)
  TO authenticated;
