-- 0005_sec_hardening.sql — SEC-0 / P2-rls-insert-status (SB-30 follow-up)
-- Endurece deny_admin_insert: barra role <> 'user' OU subscription_status <>
-- 'trial' no INSERT via client (só admin/service_role/DBA passam).
-- Fixa search_path mutável nas duas funções de guarda (deny_admin_insert e
-- deny_role_change). Aditiva: CREATE OR REPLACE + DROP IF EXISTS; NUNCA
-- edita 0001-0004. Dinheiro: inalterado (BIGINT cents). RLS: inalterada.

-- ============ 1. deny_admin_insert: role + subscription_status ============

CREATE OR REPLACE FUNCTION public.deny_admin_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS deny_admin_insert ON public.profiles;
CREATE TRIGGER deny_admin_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_admin_insert();

-- ============ 2. deny_role_change: fixa search_path (lógica preservada) ============

CREATE OR REPLACE FUNCTION public.deny_role_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
    OR NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
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

DROP TRIGGER IF EXISTS deny_role_change ON public.profiles;
CREATE TRIGGER deny_role_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_role_change();
