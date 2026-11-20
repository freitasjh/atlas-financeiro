-- 0035_remove_admin.sql — backoffice-p0-mfa / P0M-BE-01 (ADR-002).
--
-- Motivo: compat temporária da 0034 com dois donos transitórios ('admin'
-- legado de gestão de plano P0 + 'super_admin' dono do sistema). ADR-002
-- remove o legado com alias semântico (menor blast radius).
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) Backfill auditado `admin -> super_admin` + trava de primeiro acesso:
--      UPDATE como postgres — `deny_role_change` permite transição
--      envolvendo super_admin só para service_role/DBA (0034) e
--      `profiles_admin_audit_fn` grava a trilha `grant_super_admin` (from
--      'admin', to 'super_admin', actor NULL) no mesmo COMMIT. O mesmo
--      UPDATE força `must_change_password=true` no promovido (A2): herdada
--      em `is_super_admin()`, nenhum promovido acumula acesso direto sem
--      rotacionar a credencial antes. Idempotente: sem linha 'admin', o
--      UPDATE toca 0 linhas e não duplica trilha; super_admin
--      pré-existente nunca é rebaixado.
--      ⚠️ ESCALAÇÃO DE PRIVILÉGIO: promover 'admin' a 'super_admin' exige
--      aprovação humana explícita pré-merge (STRIDE Elevation of Privilege,
--      ADR-002). Backfill aguardando aprovação humana explícita.
--   2) CHECK `profiles.role IN ('user','super_admin')` (DROP/ADD idempotente
--      em DO block, precedente 0033/0034) — 'admin' voltar pelo canal normal
--      vira 23514 (CHECK) ou rótulo fixo (trigger, para JWT).
--   3) `is_admin()` vira alias estrito de `is_super_admin()` (PL/pgSQL
--      delegando): policies e RPCs que chamam `is_admin()` (0022/0024/
--      0028/0032/0033/0034) apertam sem reescrita; o travamento de primeiro
--      acesso e o futuro gate aal2 (0037) herdam via delegação. DEFINER +
--      STABLE + search_path=public + REVOKE/GRANT preservados da 0034.
-- NÃO alterado aqui (histórico append-only, ADR-002): `admin_audit_action_check`
--   mantém 'grant_admin'/'revoke_admin' e `list_admin_audit_page` mantém a
--   whitelist — o histórico de promoções pré-0035 segue legível via RPC.
--   `deny_role_change`/`deny_admin_insert`/`profiles_admin_audit_fn` também
--   permanecem: o ramo 'admin' fica inalcançável pelo CHECK.
--
-- Erros por rótulo fixo, sem PII (id/e-mail/hash): nenhum rótulo novo.
-- Sem dinheiro (só identidade): nenhum float/double.
-- Idempotente-safe: UPDATE condicional (0 linhas no rerun) + DO block p/
-- CHECK + CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0034 intocadas.

-- ============ 1. Backfill auditado (antes do CHECK apertado) ============
-- Rode como postgres (owner da migration): deny_role_change (0034) permite
-- transição envolvendo 'super_admin' e a trilha nasce com actor NULL.
UPDATE public.profiles SET role = 'super_admin', must_change_password = true WHERE role = 'admin';

-- ============ 2. CHECK apertado ============
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
    CHECK (role IN ('user', 'super_admin'));
END $$;

COMMENT ON CONSTRAINT profiles_role_check ON public.profiles IS
  'ADR-002 pós-0035: role ∈ (user, super_admin). O admin legado foi backfillado para super_admin com trilha grant_super_admin (actor NULL); histórico grant_admin/revoke_admin permanece legível em admin_audit.';

-- ============ 3. is_admin() = alias estrito de is_super_admin() ============
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.is_super_admin();
END;
$$;

COMMENT ON FUNCTION public.is_admin() IS
  'Backoffice P0 MFA (ADR-002, 0035): alias estrito de is_super_admin() — só role = super_admin, com must_change_password=true levanta first-access-password-change-required. Políticas e RPCs is_admin()-gated apertam sem reescrita.';

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;
