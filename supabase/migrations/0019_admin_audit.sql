-- 0019_admin_audit.sql — Frente A / A-AUDIT (ASVS 7.1.3 e 16.4.3).
--
-- Furo medido (auditoria de 2026-11-04): as policies `profiles_select_admin` e
-- `profiles_update_admin` (0004) são `WITH CHECK (is_admin())` sem escopo de
-- coluna nem de alvo — o admin lê e altera qualquer tenant, mas nada deixa
-- rastro. `grep -rln audit supabase/migrations/` não encontrava nenhuma tabela
-- nem trigger de auditoria: promoção a admin e mudança de plano eram mudanças
-- silenciosas.
--
-- Correção (server-side, nunca no client):
-- 1) `public.admin_audit` guarda quem mudou (`actor_id`), quem foi alterado
--    (`target_id`), `action`, valores anterior/novo e o instante.
-- 2) Trigger `profiles_admin_audit` (AFTER UPDATE em `profiles`) grava uma
--    linha por mudança observada em `role` ou `subscription_status`. UPDATE de
--    `full_name`/`updated_at` não gera linha.
-- 3) RLS ligada + nenhuma policy: `authenticated`/`anon` não leem nem escrevem.
--    A escrita é feita pela função do trigger (SECURITY DEFINER); leitura é
--    exclusiva de `service_role` (backoffice/observabilidade).
--
-- Sem FK para `profiles` de propósito: `ON DELETE CASCADE` apagaria a prova de
-- auditoria junto com o tenant auditado. Ids órfãos são preferíveis a evidência
-- destruída (ASVS 7.1.3).
--
-- Mensagens fixas, sem ids. Dinheiro inalterado (BIGINT cents).
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS + CREATE OR REPLACE +
-- DROP TRIGGER IF EXISTS. Migrations 0001–0018 intocadas.

-- ============ 1. Tabela de auditoria ============

CREATE TABLE IF NOT EXISTS public.admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  target_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('grant_admin', 'revoke_admin', 'change_plan', 'other')),
  from_value text,
  to_value text,
  at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.admin_audit IS
  'Trilha de auditoria de profiles (role/subscription_status). Escrita só pelo trigger profiles_admin_audit; leitura só service_role.';
COMMENT ON COLUMN public.admin_audit.actor_id IS
  'auth.uid() de quem executou o UPDATE; NULL quando o ator não é JWT (service_role/DBA).';
COMMENT ON COLUMN public.admin_audit.target_id IS
  'profiles.id alterado. Sem FK: cascade apagaria a evidência junto com o tenant.';

CREATE INDEX IF NOT EXISTS idx_admin_audit_target_at
  ON public.admin_audit (target_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_actor_at
  ON public.admin_audit (actor_id, at DESC);

-- ============ 2. Trigger AFTER UPDATE (role / subscription_status) ============

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

-- ============ 3. RLS + privilégios (leitura só service_role) ============

ALTER TABLE public.admin_audit ENABLE ROW LEVEL SECURITY;

-- Nenhuma policy: sem `service_role` (BYPASSRLS) ou o dono da função, nada é
-- visível. Privilégios são revogados de forma explícita porque o Supabase
-- concede ALL a anon/authenticated/service_role em tabelas novas.
REVOKE ALL ON TABLE public.admin_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_audit FROM anon;
REVOKE ALL ON TABLE public.admin_audit FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.admin_audit FROM service_role;
GRANT SELECT ON TABLE public.admin_audit TO service_role;
