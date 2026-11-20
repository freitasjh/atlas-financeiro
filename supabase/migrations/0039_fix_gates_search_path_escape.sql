-- 0039_fix_gates_search_path_escape.sql — review Batch 2 🟡1 (0037:70) + 🟡3 (0036:113-115,165-172).
--
-- Motivo: dois desvios do padrão search_path='' travado das RPCs SECURITY DEFINER:
--   1) `is_super_admin()` (0037) ficou com `SET search_path = public` — hijack
--      por schema do chamador (mesma classe do `deny_admin_insert`/pg_trgm em
--      public que ADR-004 recusa). A 0035 (`is_admin()`, alias) também tem
--      `search_path = public`, mas NÃO é tocada aqui (escopo do review).
--   2) `admin_list_tenants`/`admin_count_tenants` (0036) interpolavam `p_search`
--      cru no ILIKE (`'%' || p_search || '%'`): `%`/`_` do termo agem como
--      wildcard (e `\` vira escape), casando tenants que o operador não digitou.
--
-- Entrega (server-side, só leitura; nenhuma escrita direta de `authenticated`):
--   1) `public.is_super_admin()` redefinida com `SET search_path = ''` e todas
--      as chamadas qualificadas (`auth.uid()`, `public.profiles`,
--      `private.is_aal2()`). Semântica 0037 preservada verbatim: sem sessão →
--      false; sem profile → false; `must_change_password` levanta
--      `first-access-password-change-required` (antes do mfa); só
--      `role='super_admin'` sem aal2 levanta `mfa-required`; resto → false.
--      `is_admin()` (0035) NÃO é redefinida: delega e herda o mesmo gate.
--   2) `admin_list_tenants` + `admin_count_tenants` redefinidas juntas (o
--      invariante count==len é preservado): mesmo predicado byte a byte, com
--      `v_search_esc := regexp_replace(v_search, '([\\%_])', '\\\1', 'g')` e
--      `ILIKE ... ESCAPE '\'` em todos os ramos (razao_social, nome_fantasia,
--      cpf, cnpj e email do owner via EXISTS em auth.users). Termo com
--      `%`/`_`/`\` casa literal; termo normal continua casando por substring
--      (GIN trigram para >=3, Seq Scan para <3, por desenho).
--
-- Erros por rótulo fixo, sem PII: mfa-required, first-access-… (0034/0037),
-- not-admin, tenant-sort-invalid, tenant-status-invalid. O termo de busca
-- nunca aparece nas mensagens. Sem dinheiro (só identidade/leitura).
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis (sem objeto
-- novo). Migrations 0001–0037 intocadas; `mfa_enrolled` não é tocado (produtor
-- é FE-02, fora do escopo).

-- ============ 1. is_super_admin() com search_path='' (🟡1) ============
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_must boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.role, p.must_change_password INTO v_role, v_must
  FROM public.profiles AS p
  WHERE p.id = v_uid;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_must THEN
    RAISE EXCEPTION 'first-access-password-change-required';
  END IF;

  IF v_role = 'super_admin' AND NOT private.is_aal2() THEN
    RAISE EXCEPTION 'mfa-required';
  END IF;

  RETURN v_role = 'super_admin';
END;
$$;

COMMENT ON FUNCTION public.is_super_admin() IS
  'Backoffice P0 MFA (ADR-001, 0037/0039): só role = super_admin com aal2, search_path='' travado e chamadas qualificadas (auth.uid/public.profiles/private.is_aal2). must_change_password=true levanta first-access-password-change-required (antes do mfa); super_admin sem aal2 levanta mfa-required; user comum retorna false sem raise. service_role isento por claim via private.is_aal2().';

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO anon, authenticated, service_role;

-- ============ 2. Lista paginada com escape de LIKE (🟡3) ============
-- Corpo 0036 preservado (assinatura, ordem, clamp, gates) + escape: o padrão
-- passa a usar v_search_esc com ESCAPE '\' (termo %/_/\ casa literal).
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
  v_search_esc text := regexp_replace(v_search, '([\\%_])', '\\\1', 'g');
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
    || 'WHERE ($1 IS NULL OR t.razao_social ILIKE $1 ESCAPE ''\'' '
    || 'OR t.nome_fantasia ILIKE $1 ESCAPE ''\'' OR t.cpf ILIKE $1 ESCAPE ''\'' '
    || 'OR t.cnpj ILIKE $1 ESCAPE ''\'' '
    || 'OR EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = t.owner_user_id AND u.email ILIKE $1 ESCAPE ''\'')) '
    || 'AND ($2 IS NULL OR t.subscription_status = $2) '
    || 'ORDER BY %I %s, t.id ASC LIMIT $3 OFFSET $4',
    v_sort_col, CASE WHEN v_dir = 'asc' THEN 'ASC' ELSE 'DESC' END
  ) USING
    CASE WHEN v_search IS NULL THEN NULL ELSE '%' || v_search_esc || '%' END,
    v_status, v_limit, v_offset;
END;
$$;

COMMENT ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int) IS
  'Backoffice P0 MFA (ADR-003/004, 0036/0039): lista tenants server-driven. Mesmo p_search casa razao_social, nome_fantasia, documento e auth.users.email do owner (EXISTS), com escape de LIKE (regexp_replace + ESCAPE ''\''): termo %/_/\ casa literal; termo >=3 usa GIN trigram em extensions, <3 cai no ILIKE; sort por whitelist + desempate id; limit clamp 1..100; só is_admin().';

REVOKE ALL ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_list_tenants(text, text, text, text, int, int)
  TO authenticated;

-- ============ 3. Contagem com o mesmo predicado (🟡3) ============
-- Invariante (SPEC §7.1): count(admin_count_tenants) == len(admin_list_tenants)
-- para todo p_search/p_status — predicado idêntico, incluindo o escape.
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
  v_search_esc text := regexp_replace(v_search, '([\\%_])', '\\\1', 'g');
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
    OR t.razao_social ILIKE '%' || v_search_esc || '%' ESCAPE '\'
    OR t.nome_fantasia ILIKE '%' || v_search_esc || '%' ESCAPE '\'
    OR t.cpf ILIKE '%' || v_search_esc || '%' ESCAPE '\'
    OR t.cnpj ILIKE '%' || v_search_esc || '%' ESCAPE '\'
    OR EXISTS (
      SELECT 1 FROM auth.users AS u
      WHERE u.id = t.owner_user_id
        AND u.email ILIKE '%' || v_search_esc || '%' ESCAPE '\'
    ))
    AND (v_status IS NULL OR t.subscription_status = v_status);

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.admin_count_tenants(text, text) IS
  'Backoffice P0 MFA (ADR-003/004, 0036/0039): total de tenants com o mesmo predicado da lista (incl. email do owner via auth.users), com escape de LIKE (regexp_replace + ESCAPE ''\''): termo %/_/\ casa literal; só is_admin().';

REVOKE ALL ON FUNCTION public.admin_count_tenants(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_count_tenants(text, text)
  TO authenticated;
