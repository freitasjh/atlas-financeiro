-- 0032_admin_audit_readable.sql — backoffice P0 / BE-06 (ADR-006).
--
-- Motivo: `admin_audit` (0019/0020/0028) só é legível por `service_role`;
-- `authenticated` (inclusive admin JWT) fica cego. A trilha precisa ser
-- legível no app sem abrir a tabela (ADR-006: RPC preferida, nunca Edge nova).
--
-- Entrega (server-side, só leitura via RPC):
--   1) `admin_audit.tenant_id uuid NULL` — escopo por tenant SEM FK (a prova
--      sobrevive ao tenant auditado, como `target_id` em 0019) + índice
--      `(tenant_id, at DESC)` + backfill das linhas `tenant_status_changed`.
--   2) `tenants_admin_audit_fn()` substituída: passa a gravar `tenant_id`.
--      (`tenants_audit_reject` — trigger append-only + escape DBA — nasceu em
--      0028 e é reafirmado aqui de forma idempotente, sem mudar semântica.)
--   3) `public.list_admin_audit_page(...)` — filtro `tenant_id`/`action`,
--      whitelist de ação (fora disso → `tenant-audit-action-invalid`),
--      `p_limit` clamp 1..100, ordem `at DESC, id ASC`. Só `is_admin()`
--      interno; `anon` sem EXECUTE → `42501`; não-admin → `not-admin`.
--      Sem PII: só agregados/UUIDs/rótulos — a tabela nunca guarda documento,
--      email ou telefone.
--
-- Idempotente-safe: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE +
-- DROP TRIGGER IF EXISTS + REVOKE/GRANT repetíveis.
-- Migrations 0001–0031 intocadas. Sem dinheiro (só trilha).

-- ============ 1. Coluna tenant_id (sem FK, como target_id) ============

ALTER TABLE public.admin_audit
  ADD COLUMN IF NOT EXISTS tenant_id uuid;

COMMENT ON COLUMN public.admin_audit.tenant_id IS
  'Escopo da trilha por tenant (ADR-006). Sem FK de propósito: ON DELETE CASCADE apagaria a prova junto com o tenant (ASVS 7.1.3).';

CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant_at
  ON public.admin_audit (tenant_id, at DESC);

-- Backfill: tenant_status_changed carrega o tenant em target_id (0028).
DO $$
BEGIN
  UPDATE public.admin_audit AS a
  SET tenant_id = a.target_id
  WHERE a.action = 'tenant_status_changed'
    AND a.tenant_id IS NULL
    AND EXISTS (SELECT 1 FROM public.tenants AS t WHERE t.id = a.target_id);
END $$;

-- ============ 2. Audit fn com tenant_id + reject reafirmado ============

CREATE OR REPLACE FUNCTION public.tenants_admin_audit_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := NULLIF(pg_catalog.current_setting('app.tenant_reason', true), '');
BEGIN
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, from_value, to_value, reason)
    VALUES (v_actor, NEW.id, NEW.id, 'tenant_status_changed',
      OLD.subscription_status, NEW.subscription_status, v_reason);
  END IF;

  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, from_value, to_value, reason)
    VALUES (v_actor, NEW.id, NEW.id, 'tenant_status_changed',
      OLD.plan_id, NEW.plan_id, v_reason);
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.tenants_admin_audit_fn()
  FROM PUBLIC, anon, authenticated, service_role;

-- Append-only (dono 0028, reafirmado idempotente): UPDATE/DELETE em
-- admin_audit → audit-immutable. Escape DBA (postgres/supabase_admin) para
-- purge de runbook e limpeza de fixtures — service_role e JWT ficam barrados.
CREATE OR REPLACE FUNCTION public.tenants_audit_reject()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('postgres', 'supabase_admin') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit-immutable';
END;
$$;

REVOKE ALL ON FUNCTION public.tenants_audit_reject()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenants_audit_reject ON public.admin_audit;
CREATE TRIGGER tenants_audit_reject
  BEFORE UPDATE OR DELETE ON public.admin_audit
  FOR EACH ROW EXECUTE FUNCTION public.tenants_audit_reject();

-- ============ 3. RPC de leitura paginada ============

CREATE OR REPLACE FUNCTION public.list_admin_audit_page(
  p_tenant uuid DEFAULT NULL,
  p_action text DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  actor_id uuid,
  target_id uuid,
  tenant_id uuid,
  action text,
  from_value text,
  to_value text,
  reason text,
  at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action text := NULLIF(pg_catalog.btrim(COALESCE(p_action, '')), '');
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  -- InitPlan: gate avaliado 1× por statement (precedente 0022/0024).
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF v_action IS NOT NULL
    AND v_action NOT IN (
      'grant_admin', 'revoke_admin', 'change_plan',
      'tenant_status_changed', 'other'
    ) THEN
    RAISE EXCEPTION 'tenant-audit-action-invalid';
  END IF;

  RETURN QUERY
  SELECT a.id, a.actor_id, a.target_id, a.tenant_id,
    a.action, a.from_value, a.to_value, a.reason, a.at
  FROM public.admin_audit AS a
  WHERE (p_tenant IS NULL OR a.tenant_id = p_tenant OR a.target_id = p_tenant)
    AND (v_action IS NULL OR a.action = v_action)
  ORDER BY a.at DESC, a.id ASC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.list_admin_audit_page(uuid, text, int, int) IS
  'Backoffice P0 (ADR-006): trilha legível sem abrir a tabela. Filtros tenant/ação; limit clamp 1..100; só is_admin(); sem PII.';

REVOKE ALL ON FUNCTION public.list_admin_audit_page(uuid, text, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.list_admin_audit_page(uuid, text, int, int)
  TO authenticated;

-- ============ 4. Tabela segue fechada p/ client ============
-- RLS ligada (0019) sem policy p/ authenticated: leitura só via RPC.
-- service_role mantém só SELECT (0020); escrita segue barrada (0020/0028).

REVOKE ALL ON TABLE public.admin_audit FROM PUBLIC, anon, authenticated;
