-- 0042_internal_admin_reads.sql — internal-admin L3 / T07 (ADR-03).
--
-- Motivo (SPEC §8.4): o detalhe do tenant hoje lê via PostgREST direto
-- (`admin.service.ts .from('tenants')` / `.from('tenant_members')`), sem
-- RPC auditada — leitura cross-tenant silenciosa. ADR-03: gates `is_admin()`/
-- `is_aal2()` preservados, sem reescrita das RPCs `admin_*`; a área interna
-- (`/internal-admin/*`) passa a ler só via RPC auditada (gate L4 T08:
-- grep 0 `.from('tenants|profiles')` em `src/internal-admin/*`).
--
-- Entrega (server-side, só leitura; nenhuma escrita direta de `authenticated`):
--   1) `public.admin_get_tenant(p_tenant uuid)` — órgão do tenant
--      (id, kind, documentos mascarados na borda, razao/nome, plan/status,
--      created_at). Gate `is_admin()` InitPlan (precedente 0031/0032).
--      Trilha: INSERT em `admin_audit` (actor=auth.uid(), target/tenant=
--      p_tenant, action='other', reason='internal_admin_read') no mesmo
--      COMMIT — leitura auditada (SPEC T07). Sem PII na trilha.
--      tenant inexistente → `tenant-not-found` (rótulo fixo, sem id).
--   2) `public.admin_list_members(p_tenant uuid)` — vínculo
--      (user_id, role, created_at) ordenado por created_at ASC.
--      Mesmo gate; sem trilha própria (o get já auditou a visita).
--
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0041 intocadas. Sem dinheiro (só leitura).

-- ============ 1. Detalhe auditado ============
CREATE OR REPLACE FUNCTION public.admin_get_tenant(p_tenant uuid)
RETURNS TABLE (
  id uuid,
  kind text,
  document text,
  razao_social text,
  nome_fantasia text,
  plan_id text,
  subscription_status text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_found boolean := false;
BEGIN
  -- InitPlan: gate avaliado 1× por statement (precedente 0031/0032).
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  SELECT true INTO v_found FROM public.tenants AS t WHERE t.id = p_tenant;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  -- Trilha de leitura auditada (SPEC T07): sem documento/PII, só escopo.
  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (auth.uid(), p_tenant, p_tenant, 'other', 'internal_admin_read');

  RETURN QUERY
  SELECT t.id, t.kind,
    CASE WHEN t.kind = 'pj' THEN t.cnpj WHEN t.kind = 'pf' THEN t.cpf ELSE NULL END,
    t.razao_social, t.nome_fantasia, t.plan_id, t.subscription_status, t.created_at
  FROM public.tenants AS t
  WHERE t.id = p_tenant;
END;
$$;

COMMENT ON FUNCTION public.admin_get_tenant(uuid) IS
  'Internal-admin L3 (ADR-03): detalhe do tenant via RPC auditada (trilha admin_audit internal_admin_read). Gate is_admin(); só is_admin(); sem PII na trilha.';

REVOKE ALL ON FUNCTION public.admin_get_tenant(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_get_tenant(uuid)
  TO authenticated;

-- ============ 2. Membros auditados (gate, sem trilha duplicada) ============
CREATE OR REPLACE FUNCTION public.admin_list_members(p_tenant uuid)
RETURNS TABLE (
  user_id uuid,
  role text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  RETURN QUERY
  SELECT tm.user_id, tm.role, tm.created_at
  FROM public.tenant_members AS tm
  WHERE tm.tenant_id = p_tenant
  ORDER BY tm.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.admin_list_members(uuid) IS
  'Internal-admin L3 (ADR-03): membros do tenant via RPC (sem .from tenant_members). Gate is_admin().';

REVOKE ALL ON FUNCTION public.admin_list_members(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_list_members(uuid)
  TO authenticated;
