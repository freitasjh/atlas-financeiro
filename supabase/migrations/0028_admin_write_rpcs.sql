-- 0028_admin_write_rpcs.sql — backoffice P0 / BE-02 (ADR-002/ADR-006).
--
-- Motivo: `tenants` (0022) só tinha SELECT; não havia caminho server-side para
-- o backoffice mudar plano/status com trilha. Escrita direta futura seria
-- fantasma (sem audit). ADR-002 exige escrita admin só via RPC auditada.
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `public.admin_set_tenant_status(p_tenant, p_status, p_plan, p_reason)` —
--      RPC atômica: gate `is_admin()`, trava a linha (FOR UPDATE), atualiza e
--      a trilha nasce no mesmo COMMIT. Erros por rótulo fixo, sem PII:
--      not-admin, tenant-status-invalid, tenant-plan-invalid,
--      tenant-reason-invalid, tenant-not-found.
--   2) `tenants_write_guard` (BEFORE INSERT/UPDATE/DELETE em tenants) — fora
--      da RPC/DBA, escrita direta → `tenant-write-via-rpc-only`. Na prática o
--      grant (0022: só SELECT p/ authenticated) responde `42501` antes; o guard
--      é defesa em profundidade p/ service_role e caminhos futuros.
--   3) `tenants_admin_audit` (AFTER UPDATE OF subscription_status, plan_id) —
--      1 linha por dimensão alterada em `admin_audit` (actor, from/to, reason).
--   4) `admin_audit`: coluna `reason` + action `tenant_status_changed` no CHECK
--      + `tenants_audit_reject` (UPDATE/DELETE → `audit-immutable`; escape DBA
--      p/ runbook purge, como 0004).
--
-- Desvio documentado do padrão 0014–0018 (guard sem current_user): o bypass
-- `current_user IN (postgres,supabase_admin)` é exigido porque as RPCs
-- 0022/0025 (SECURITY DEFINER como postgres, já aplicadas e intocáveis)
-- escrevem tenants sem GUC de escape — sem o bypass, o guard quebraria o
-- cadastro. A RPC nova também seta `app.tenant_write='on'` por higiene.
--
-- Idempotente-safe: CREATE OR REPLACE + DROP TRIGGER/CONSTRAINT IF EXISTS +
-- ADD COLUMN IF NOT EXISTS + REVOKE/GRANT repetíveis. Migrations 0001–0027
-- intocadas. Ordem-independente de 0030: valida plano por enum literal (o
-- mesmo do CHECK 0022 e do seed 0030), sem ler `plan_catalog`.

-- ============ 1. admin_audit: coluna reason + action tenant_status_changed ============

ALTER TABLE public.admin_audit
  ADD COLUMN IF NOT EXISTS reason text;

COMMENT ON COLUMN public.admin_audit.reason IS
  'Motivo informado na RPC admin (btrim, len>=3). Sem PII por disciplina de UI; nunca documento/email.';

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
      'tenant_status_changed', 'other'
    ));
END $$;

-- ============ 2. tenants_write_guard (defesa em profundidade) ============

CREATE OR REPLACE FUNCTION public.tenants_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Caminho RPC/Edge intencional (GUC setado pela função chamadora).
  IF pg_catalog.current_setting('app.tenant_write', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- RPCs 0022/0025 (SECURITY DEFINER como owner) + manutenção DBA/runbook.
  IF current_user IN ('postgres', 'supabase_admin') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'tenant-write-via-rpc-only';
END;
$$;

REVOKE ALL ON FUNCTION public.tenants_write_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenants_write_guard ON public.tenants;
CREATE TRIGGER tenants_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.tenants_write_guard();

COMMENT ON FUNCTION public.tenants_write_guard() IS
  'Guarda escrita em tenants: só RPC (GUC) ou DBA. Direto → tenant-write-via-rpc-only (grants 0022 respondem 42501 antes p/ authenticated).';

-- ============ 3. tenants_admin_audit (trilha atômica da RPC) ============
-- Sem current_user (padrão 0014–0018): só INSERT auditado; actor via auth.uid
-- preservado na cadeia RPC→trigger. REVOKE total de EXECUTE (só trigger chama).

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
    INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value, reason)
    VALUES (v_actor, NEW.id, 'tenant_status_changed',
      OLD.subscription_status, NEW.subscription_status, v_reason);
  END IF;

  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value, reason)
    VALUES (v_actor, NEW.id, 'tenant_status_changed',
      OLD.plan_id, NEW.plan_id, v_reason);
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.tenants_admin_audit_fn()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenants_admin_audit ON public.tenants;
CREATE TRIGGER tenants_admin_audit
  AFTER UPDATE OF subscription_status, plan_id ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.tenants_admin_audit_fn();

-- ============ 4. tenants_audit_reject (append-only p/ trilha de tenants) ============
-- UPDATE/DELETE em admin_audit → audit-immutable. Escape DBA (postgres/
-- supabase_admin) para purge de runbook e limpeza de fixtures — service_role
-- e JWT ficam barrados. INSERTs do trigger 0019/0028 não passam aqui.

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

-- ============ 5. RPC admin_set_tenant_status ============
-- Ordem de validação (espelha 0022): sessão → admin → status → plano →
-- motivo → existência. `FOR UPDATE` serializa transições concorrentes.
-- Enum literal = CHECK 0022 = seed 0030 (ordem-independente de 0030).

CREATE OR REPLACE FUNCTION public.admin_set_tenant_status(
  p_tenant uuid,
  p_status text,
  p_plan text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text := pg_catalog.btrim(COALESCE(p_status, ''));
  v_plan text := NULLIF(pg_catalog.btrim(COALESCE(p_plan, '')), '');
  v_reason text := pg_catalog.btrim(COALESCE(p_reason, ''));
  v_found boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF v_status NOT IN ('trial', 'active', 'past_due', 'canceled') THEN
    RAISE EXCEPTION 'tenant-status-invalid';
  END IF;

  IF v_plan IS NOT NULL AND v_plan NOT IN ('free', 'standard', 'pro', 'full') THEN
    RAISE EXCEPTION 'tenant-plan-invalid';
  END IF;

  IF pg_catalog.char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'tenant-reason-invalid';
  END IF;

  SELECT true INTO v_found
  FROM public.tenants
  WHERE id = p_tenant
  FOR UPDATE;

  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  PERFORM pg_catalog.set_config('app.tenant_write', 'on', true);
  PERFORM pg_catalog.set_config('app.tenant_reason', v_reason, true);

  UPDATE public.tenants
  SET subscription_status = v_status,
      plan_id = COALESCE(v_plan, plan_id),
      updated_at = pg_catalog.now()
  WHERE id = p_tenant;
END;
$$;

COMMENT ON FUNCTION public.admin_set_tenant_status(uuid, text, text, text) IS
  'Backoffice: muda status/plano do tenant com trilha atômica. Só is_admin(); motivo len>=3; erros por rótulo fixo.';

REVOKE ALL ON FUNCTION public.admin_set_tenant_status(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_set_tenant_status(uuid, text, text, text)
  TO authenticated;

-- ============ 6. Reafirma grants de leitura (0022) ============
-- Idempotente: sem grant de escrita para anon/authenticated — nenhuma policy
-- "salva" escrita direta (T-G2 prova 42501).

REVOKE ALL ON TABLE public.tenants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tenants TO authenticated;

REVOKE ALL ON TABLE public.tenant_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tenant_members TO authenticated;
