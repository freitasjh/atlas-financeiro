-- 0037_mfa_aal2.sql — backoffice-p0-mfa / P0M-BE-03 (ADR-001).
--
-- Motivo: área sensível cross-tenant alcançável por qualquer JWT com
-- `role='super_admin'`; senha + cookie 8h insuficientes. O gate de MFA tem
-- que viver no banco (herdado por todas as RPCs `admin_*` via
-- `is_super_admin()`, sem reescrita de cada RPC) — UI (`RequireSuperAdmin`
-- + `/mfa/*`) apenas redireciona. Sem isso, bypass da UI não bloqueia RPC
-- nem PostgREST.
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `private.is_aal2()` — helper STABLE SECURITY DEFINER search_path=''
--      (precedente `private.cpf_dv_ok` 0022): true quando o JWT tem
--      `aal='aal2'` OU claim `role='service_role'` (isenção para Edge/seed
--      por claim, nunca por `current_user` — SPEC ADR-001). Sem sessão ou
--      sem claim → false. Schema `private` fora do PostgREST (config.toml:
--      só `public`/`graphql_public`).
--   2) `public.is_super_admin()` redefinida: corpo 0034 preservado (sem
--      sessão → false; sem profile → false; `must_change_password` levanta
--      `first-access-password-change-required` — ordem SPEC §3: must antes
--      do mfa) + gate novo: `role='super_admin'` sem aal2 levanta
--      `mfa-required`. User comum nunca levanta (role check antes do gate):
--      RLS de membro (policies `is_admin()`-gated) não quebra com login aal1.
--      `is_admin()` (0035, alias da 0034) NÃO é redefinida: delega e herda
--      o gate por transitividade.
--   3) `public.admin_audit.action` ganha `mfa_enrolled` (SPEC §6: produtor do
--      enroll/verify, consumidor `list_admin_audit_page` — a whitelist da
--      RPC é redefinida junto para o histórico ficar legível).
--   4) `supabase/config.toml`: `[auth.mfa.totp] enroll_enabled/verify_enabled
--      = true` (fora desta migration — deploy atômico config+DB, runbook
--      `.doc/runbook-operacoes.md`; sem isso, MFA quebra em prod/DESKTOP).
--
-- Erros por rótulo fixo, sem PII: mfa-required, first-access-… (0034).
-- Sem dinheiro (só identidade): nenhum float/double.
-- Idempotente-safe: CREATE IF NOT EXISTS + CREATE OR REPLACE (helper e
-- is_super_admin) + DO block p/ CHECK + REVOKE/GRANT repetíveis.
-- Migrations 0001–0036 intocadas.

-- ============ 1. Helper private.is_aal2() (ADR-001) ============
CREATE OR REPLACE FUNCTION private.is_aal2()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (
    COALESCE(auth.jwt() ->> 'aal', '') = 'aal2'
    OR (auth.jwt() ->> 'role') = 'service_role'
  );
$$;

COMMENT ON FUNCTION private.is_aal2() IS
  'Backoffice P0 MFA (ADR-001, 0037): JWT com aal2 ou claim role service_role (isenção Edge/seed por claim, nunca current_user). Sem sessão retorna false. Chamado apenas por is_super_admin().';

-- EXECUTE só para os dois papéis que chamam a cadeia de gates: `authenticated`
-- (JWT de operador) e `service_role` (Edge/seed). `anon` não alcança o helper
-- (is_super_admin() sem sessão retorna false antes de chamá-lo — fail-closed).
REVOKE ALL ON FUNCTION private.is_aal2() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_aal2() TO authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

-- ============ 2. is_super_admin() + gate aal2 ============
-- Corpo 0034 preservado verbatim, com a inserção do gate entre o travamento
-- de primeiro acesso e o retorno: só `role='super_admin'` sem aal2 levanta.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
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
  'Backoffice P0 MFA (ADR-001, 0037): só role = super_admin com aal2. must_change_password=true levanta first-access-password-change-required (antes do mfa); super_admin sem aal2 levanta mfa-required; user comum retorna false sem raise. service_role isento por claim via private.is_aal2().';

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO anon, authenticated, service_role;

-- ============ 3. Auditoria: ação mfa_enrolled ============
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_audit_action_check'
      AND conrelid = 'public.admin_audit'::regclass
  ) THEN
    ALTER TABLE public.admin_audit
      DROP CONSTRAINT admin_audit_action_check;
  END IF;

  ALTER TABLE public.admin_audit
    ADD CONSTRAINT admin_audit_action_check
    CHECK (action IN (
      'grant_admin', 'revoke_admin', 'change_plan',
      'tenant_status_changed', 'quota_override',
      'grant_super_admin', 'revoke_super_admin', 'mfa_enrolled', 'other'
    ));
END $$;

-- ============ 4. list_admin_audit_page: whitelist += mfa_enrolled ============
-- Corpo idêntico a 0034 (assinatura, ordem, clamp, gates) + ação nova, para
-- o consumidor (SPEC §6) enxergar a trilha do enroll. O gate is_admin()
-- herda o gate aal2 automaticamente (0035 alias → is_super_admin 0037).
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
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF v_action IS NOT NULL
    AND v_action NOT IN (
      'grant_admin', 'revoke_admin', 'change_plan',
      'tenant_status_changed', 'quota_override',
      'grant_super_admin', 'revoke_super_admin', 'mfa_enrolled', 'other'
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
  'Backoffice P0 MFA (ADR-001, 0037): trilha legível sem abrir a tabela. Filtros tenant/ação; limit clamp 1..100; só is_admin() (travado primeiro acesso + aal2); sem PII.';

REVOKE ALL ON FUNCTION public.list_admin_audit_page(uuid, text, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.list_admin_audit_page(uuid, text, int, int)
  TO authenticated;
