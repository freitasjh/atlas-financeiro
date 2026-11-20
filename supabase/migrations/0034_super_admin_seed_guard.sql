-- 0034_super_admin_seed_guard.sql — backoffice P1 / BE-01 (ADR-002).
--
-- Motivo: o operador dono do sistema (controls all tenants) precisava ser
-- distinguível do `admin` legado de gestão de plano P0 e do cliente comum.
-- Sem seed, a instalação nunca tem dono; sem guard no banco, a senha padrão
-- do seed vira credencial permanente (aviso só na tela nunca a rotaciona).
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `profiles.role` ganha `super_admin` + coluna `must_change_password`
--      (default false; só o seed nasce com true).
--   2) `is_admin()` redefinida: `role IN ('admin','super_admin')` (compat
--      temporária — `admin` legado continua passando até ADR futuro) e
--      LEVANTA `first-access-password-change-required` quando o chamador tem
--      `must_change_password=true`. Toda RPC `admin_*` e toda policy
--      `is_admin()`-gated herda o travamento sem redefinir cada RPC (0 linhas).
--   3) `is_super_admin()` nova: só `role = 'super_admin'` (mesmo travamento).
--   4) `deny_admin_insert`/`deny_role_change`: qualquer transição envolvendo
--      `super_admin` é negada para JWT (`not-super-admin`); só `service_role`
--      e DBA (`postgres`/`supabase_admin`, que inclui as RPCs DEFINER abaixo,
--      cujo owner é postgres) passam. `is_admin()` NÃO concede `super_admin`.
--   5) `complete_first_access()`: única saída do travamento (depois do
--      `supabase.auth.updateUser({ password })` no Auth). Valida
--      `auth.uid() = profiles.id` e flag `true`, faz
--      `UPDATE profiles SET must_change_password = false`, retorna `void`.
--      Sem flag → `first-access-not-required`; sem sessão → `not-authenticated`.
--   6) `admin_grant_super_admin(p_target)` / `admin_revoke_super_admin(p_target)`:
--      só `is_super_admin()` (que já trava primeiro acesso). Idempotentes
--      (alvo já no estado desejado é no-op, sem dupla trilha). `UPDATE` interno
--      roda como owner (postgres): o trigger 4 permite e a trilha nasce no
--      mesmo COMMIT. Alvo ausente → `admin-target-not-found`.
--   7) `admin_audit_action_check` += `grant_super_admin, revoke_super_admin` e
--      `profiles_admin_audit_fn()` mapeia transições `super_admin`; 
--      `list_admin_audit_page()` tem a whitelist expandida (leitura via RPC).
--
-- Erros por rótulo fixo, sem PII (id/e-mail/hash): not-admin, not-super-admin,
-- first-access-password-change-required, first-access-not-required,
-- not-authenticated, admin-target-not-found.
-- `service_role` nunca é concedido nas RPCs novas (só server-side: Edge/seed).
-- Senha padrão só em `supabase/seed.sql` (DEV LOCAL ONLY) — nunca nesta
-- migration, nunca em `VITE_*`, nunca em log.
-- Sem dinheiro (só identidade): nenhum float/double.
-- Idempotente-safe: ADD COLUMN IF NOT EXISTS + DO blocks p/ CHECKs +
-- CREATE OR REPLACE + DROP TRIGGER IF EXISTS + REVOKE/GRANT repetíveis.
-- Migrations 0001–0033 intocadas.

-- ============ 1. profiles: role += super_admin + must_change_password ============

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_role_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
  END IF;

  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('user', 'admin', 'super_admin'));
END $$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.must_change_password IS
  'Primeiro acesso (ADR-002): true bloqueia toda RPC admin (first-access-password-change-required); só complete_first_access() libera (após updateUser no Auth). O seed nasce true; troca feita volta false e o re-seed nunca a redefine.';

-- ============ 2. Gates: is_admin (compat) + is_super_admin ============
-- PL/pgSQL (não SQL) para poder levantar o rótulo de primeiro acesso.
-- STABLE + SECURITY DEFINER + search_path=public travado (ADR-002).
-- Sem sessão → false (nunca levanta); com flag → levanta (0 linhas, sem leak).

CREATE OR REPLACE FUNCTION public.is_admin()
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

  RETURN v_role IN ('admin', 'super_admin');
END;
$$;

COMMENT ON FUNCTION public.is_admin() IS
  'Backoffice P1 (ADR-002): role IN (admin, super_admin) — compat temporária com admin legado. Com must_change_password=true levanta first-access-password-change-required (toda RPC admin_* herda o travamento).';

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

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

  RETURN v_role = 'super_admin';
END;
$$;

COMMENT ON FUNCTION public.is_super_admin() IS
  'Backoffice P1 (ADR-002): só role = super_admin (dono do sistema). Com must_change_password=true levanta first-access-password-change-required.';

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO anon, authenticated, service_role;

-- ============ 3. Guards de escrita de role (super_admin só DBA/RPC DEFINER) ============

-- 3a. INSERT: role='super_admin' negado p/ qualquer JWT.
CREATE OR REPLACE FUNCTION public.deny_admin_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM 'user'
    AND NEW.role = 'super_admin' THEN
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'not-super-admin';
  END IF;

  IF NEW.role IS DISTINCT FROM 'user'
    OR NEW.subscription_status IS DISTINCT FROM 'trial' THEN
    IF public.is_admin() THEN
      RETURN NEW;
    END IF;
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'profiles.role/subscription_status iniciais imutáveis via client (só admin/service_role)';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.deny_admin_insert()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS deny_admin_insert ON public.profiles;
CREATE TRIGGER deny_admin_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_admin_insert();

-- 3b. UPDATE: transição envolvendo super_admin negada p/ qualquer JWT.
-- Ramo subscription_status (freeze 0027) preservado verbatim; ramo role:
-- envolvendo super_admin → só service_role/DBA (incl. RPC DEFINER como owner);
-- demais casos → contrato 0004/0005 (is_admin/service_role/DBA).
CREATE OR REPLACE FUNCTION public.deny_role_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'profiles-status-readonly-use-tenant-rpc';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NEW.role = 'super_admin' OR OLD.role = 'super_admin' THEN
      IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
        RETURN NEW;
      END IF;
      IF current_user IN ('postgres', 'supabase_admin') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'not-super-admin';
    END IF;

    IF public.is_admin() THEN
      RETURN NEW;
    END IF;
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'profiles.role/subscription_status imutáveis via client (só admin/service_role)';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.deny_role_change() IS
  'ADR-002: transição envolvendo super_admin só service_role/DBA (RPC DEFINER); subscription_status freeze 0027 preservado; role demais casos 0004 (admin ok).';

REVOKE ALL ON FUNCTION public.deny_role_change()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS deny_role_change ON public.profiles;
CREATE TRIGGER deny_role_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_role_change();

-- ============ 4. complete_first_access: única saída do travamento ============

CREATE OR REPLACE FUNCTION public.complete_first_access()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  -- Só o próprio profile, só com flag true. Sem linha ou sem flag → rótulo
  -- fixo (nunca revela se o id existe em outro tenant).
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = v_uid AND p.must_change_password = true
  ) THEN
    RAISE EXCEPTION 'first-access-not-required';
  END IF;

  -- UPDATE só da flag: deny_role_change não dispara (role/status intactos).
  UPDATE public.profiles SET must_change_password = false
  WHERE id = v_uid;
END;
$$;

COMMENT ON FUNCTION public.complete_first_access() IS
  'Primeiro acesso (ADR-002): após updateUser no Auth, valida auth.uid()=profiles.id + flag true e libera (must_change_password=false). Sem flag → first-access-not-required.';

REVOKE ALL ON FUNCTION public.complete_first_access()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.complete_first_access() TO authenticated;

-- ============ 5. Grant/revoke super_admin só por is_super_admin ============

CREATE OR REPLACE FUNCTION public.admin_grant_super_admin(p_target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not-super-admin';
  END IF;

  SELECT p.role INTO v_role FROM public.profiles AS p
  WHERE p.id = p_target
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin-target-not-found';
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN;
  END IF;

  UPDATE public.profiles SET role = 'super_admin' WHERE id = p_target;
END;
$$;

COMMENT ON FUNCTION public.admin_grant_super_admin(uuid) IS
  'Backoffice P1 (ADR-002): concede super_admin. Só is_super_admin() (travado primeiro acesso); trilha grant_super_admin via trigger; idempotente.';

REVOKE ALL ON FUNCTION public.admin_grant_super_admin(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_grant_super_admin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_revoke_super_admin(p_target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not-super-admin';
  END IF;

  SELECT p.role INTO v_role FROM public.profiles AS p
  WHERE p.id = p_target
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin-target-not-found';
  END IF;

  IF v_role <> 'super_admin' THEN
    RETURN;
  END IF;

  UPDATE public.profiles SET role = 'user' WHERE id = p_target;
END;
$$;

COMMENT ON FUNCTION public.admin_revoke_super_admin(uuid) IS
  'Backoffice P1 (ADR-002): revoga super_admin (volta a user). Só is_super_admin(); trilha revoke_super_admin via trigger; idempotente.';

REVOKE ALL ON FUNCTION public.admin_revoke_super_admin(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_revoke_super_admin(uuid) TO authenticated;

-- ============ 6. Auditoria: grant/revoke_super_admin ============

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
      'grant_super_admin', 'revoke_super_admin', 'other'
    ));
END $$;

CREATE OR REPLACE FUNCTION public.profiles_admin_audit_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value)
    VALUES (
      v_actor,
      NEW.id,
      CASE
        WHEN NEW.role = 'super_admin' THEN 'grant_super_admin'
        WHEN OLD.role = 'super_admin' THEN 'revoke_super_admin'
        WHEN NEW.role = 'admin' THEN 'grant_admin'
        WHEN OLD.role = 'admin' THEN 'revoke_admin'
        ELSE 'other'
      END,
      OLD.role,
      NEW.role
    );
  END IF;

  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
    INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value)
    VALUES (
      v_actor,
      NEW.id,
      'change_plan',
      OLD.subscription_status,
      NEW.subscription_status
    );
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_admin_audit_fn() FROM PUBLIC;

DROP TRIGGER IF EXISTS profiles_admin_audit ON public.profiles;
CREATE TRIGGER profiles_admin_audit
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role
        OR OLD.subscription_status IS DISTINCT FROM NEW.subscription_status)
  EXECUTE FUNCTION public.profiles_admin_audit_fn();

-- ============ 7. list_admin_audit_page: whitelist expandida ============
-- Corpo idêntico a 0033 (assinatura, ordem, clamp, gates) + ações novas.
-- O gate is_admin() herda o travamento de primeiro acesso automaticamente.

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
      'grant_super_admin', 'revoke_super_admin', 'other'
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
  'Backoffice P0 (ADR-006, whitelist 0034): trilha legível sem abrir a tabela. Filtros tenant/ação; limit clamp 1..100; só is_admin() (travado primeiro acesso); sem PII.';

REVOKE ALL ON FUNCTION public.list_admin_audit_page(uuid, text, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.list_admin_audit_page(uuid, text, int, int)
  TO authenticated;
