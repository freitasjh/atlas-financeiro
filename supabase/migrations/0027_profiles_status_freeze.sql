-- 0027_profiles_status_freeze.sql — backoffice P0 / BE-03 (ADR-001).
--
-- Motivo: dupla verdade materializada — `profiles.subscription_status` era
-- gravável via client (inclusive por admin JWT, 0004/0005) em paralelo a
-- `tenants.subscription_status` (0022). ADR-001 congela profiles: fonte única
-- de cobrança passa a ser `tenants`; leitura de decisão nunca usa profiles.
--
-- Entrega: `deny_role_change()` passa a tratar as duas colunas em ramos
-- separados — `subscription_status` só via DBA (`postgres`/`supabase_admin`)
-- ou `service_role` (backoffice server-only); qualquer JWT (membro OU admin)
-- recebe `profiles-status-readonly-use-tenant-rpc` e usa a RPC
-- `admin_set_tenant_status` (0028). `role` preserva o contrato 0004/0005
-- (admin/service_role/DBA) e a trilha 0019 (`grant_admin`/`revoke_admin`
-- intacta). INSERT (`deny_admin_insert`, 0005) e `handle_new_user`
-- (user/trial) inalterados.
--
-- Impacto em specs legadas: `ddl.spec` T15-admin, `ddl-0004` T15g e
-- `admin-audit` T02/T08 provavam admin-JWT alternando status — atualizados
-- para o novo contrato (freeze), com a prova de trilha migrada para o escape
-- DBA. Estrutura (trigger `deny_role_change` + `is_admin` no corpo) mantida.
--
-- Idempotente-safe: CREATE OR REPLACE + DROP TRIGGER IF EXISTS + REVOKE
-- repetível. Migrations 0001–0026/0028/0030 intocadas. Sem PII em mensagens.

CREATE OR REPLACE FUNCTION public.deny_role_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Ramo 1 (BE-03): subscription_status congelado para JWT.
  -- Serviço de cobrança lê tenants; profiles nunca entra no caminho decisão.
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'profiles-status-readonly-use-tenant-rpc';
  END IF;

  -- Ramo 2 (contrato 0004/0005 preservado): role mutável via admin.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
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
  'BE-03: subscription_status freeze (só DBA/service_role; JWT usa RPC de tenant). Role preserva 0004 (admin ok).';

-- Trigger é ponto de chamada, não endpoint: sem EXECUTE para clients
-- (precedente 0020). O disparo continua funcionando (roda como owner).
REVOKE ALL ON FUNCTION public.deny_role_change()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS deny_role_change ON public.profiles;
CREATE TRIGGER deny_role_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_role_change();
