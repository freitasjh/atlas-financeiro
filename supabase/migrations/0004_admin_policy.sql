-- 0004_admin_policy.sql — Fase 4 Backoffice (SB-30)
-- Admin via RLS is_admin() + trigger duplo role/status + INSERT nunca auto-admin.
-- Idempotente (OR REPLACE / DROP IF EXISTS). NÃO edita 0001/0002/0003.
-- Dinheiro: inalterado (BIGINT cents). Tenant: RLS herdada + policies admin.
-- Segurança: nenhum auto-admin por payload; exceção só admin/service_role/DBA.

-- ============ 1. is_admin(): sessão atual é profile role='admin' ============
-- SECURITY DEFINER para o lookup em profiles furar a própria RLS (sem leak:
-- retorna só boolean, nunca linhas). STABLE para uso em policies.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- ============ 2. Policies admin em profiles (SELECT lista + UPDATE status) ============

DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
CREATE POLICY profiles_select_admin ON public.profiles
  FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS profiles_update_admin ON public.profiles;
CREATE POLICY profiles_update_admin ON public.profiles
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============ 3. Trigger duplo role+status (substitui o só-role da 0001) ============
-- Client não-admin: qualquer mudança em role OU subscription_status é negada.
-- Exceções: sessão admin (is_admin), service_role (backoffice/Edge futuro),
-- DBA postgres/supabase_admin (promoção manual, nunca via client).

CREATE OR REPLACE FUNCTION public.deny_role_change()
RETURNS trigger
LANGUAGE plpgsql
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

-- ============ 4. INSERT nunca auto-admin por payload ============
-- INSERT com role <> 'user' negado, salvo admin/service_role/DBA.
-- Signup normal (role='user' via handle_new_user) passa intacto.

CREATE OR REPLACE FUNCTION public.deny_admin_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM 'user' THEN
    IF public.is_admin() THEN
      RETURN NEW;
    END IF;
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'profiles.role inicial deve ser user via client (só admin/service_role cria admin)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deny_admin_insert ON public.profiles;
CREATE TRIGGER deny_admin_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_admin_insert();

-- ============ 5. Signup força role='user' (reafirma 0001 contra payload) ============

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role, subscription_status)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'full_name', NULL), 'user', 'trial')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
