-- 0058_subscription_mirror.sql — control-plane-billing / F1 / ADR-001 (D5; REQ-25..28).
--
-- Motivo: `tenants.plan_id`/`subscription_status` precisam continuar sendo o
-- retrato que o resto do sistema (RLS de quota, guards de cancelamento, ADR-002)
-- ja consome. A verdade e `tenant_subscriptions` (0055); sem espelho derivado,
-- os dois divergem. O espelho e o trigger AFTER INSERT OR UPDATE abaixo, na
-- MESMA transacao da escrita da verdade.
--
-- Entrega (REQ-25..28, I5/I15):
--   1) `tenant_subscriptions_mirror` — SECURITY DEFINER, search_path='',
--      owner postgres. Seta `app.tenant_write='on'` (libera
--      `tenants_write_guard`, 0028) e atualiza `tenants.plan_id`/
--      `subscription_status`/`updated_at` SO quando ha diferenca. No-op nao
--      bumpa `updated_at` nem audita.
--   2) A trilha continua sendo `tenants_admin_audit` (0028/0032): 1 linha por
--      dimensao alterada, com `reason = current_setting('app.tenant_reason')`
--      setado pela RPC chamadora (psp:*, onboarding, override).
--   3) `admin_set_tenant_status` perde EXECUTE de PUBLIC/anon/authenticated/
--      service_role. O caminho de override passa a ser
--      `admin_override_subscription` (0060). A funcao permanece no schema
--      (historico/rollback), apenas nao executavel por cliente.
--
-- A GUC `app.tenant_write` permanece 'on' ate o fim da transacao (precedente
-- 0028:216; declarado — nao e restaurada).
--
-- Idempotente-safe: CREATE OR REPLACE / DROP TRIGGER IF EXISTS / REVOKE /
-- COMMENT repetiveis. Migrations 0001–0057 intocadas.

-- ============ 1. Trigger de espelho ============

CREATE OR REPLACE FUNCTION public.tenant_subscriptions_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan text;
  v_status text;
BEGIN
  SELECT t.plan_id, t.subscription_status
    INTO v_plan, v_status
  FROM public.tenants AS t
  WHERE t.id = NEW.tenant_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- REQ-26: sem diferenca nao ha UPDATE (nem updated_at, nem auditoria).
  IF v_plan IS NOT DISTINCT FROM NEW.plan_slug
     AND v_status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;

  -- Libera `tenants_write_guard` (0028) para a escrita derivada.
  PERFORM pg_catalog.set_config('app.tenant_write', 'on', true);

  UPDATE public.tenants
  SET plan_id = NEW.plan_slug,
      subscription_status = NEW.status,
      updated_at = pg_catalog.now()
  WHERE id = NEW.tenant_id;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.tenant_subscriptions_mirror() IS
  'REQ-25/REQ-26/I5: deriva tenants.plan_id/subscription_status de tenant_subscriptions na mesma transacao. No-op silencioso quando ja iguais. Trilha em tenants_admin_audit com app.tenant_reason do chamador.';

REVOKE ALL ON FUNCTION public.tenant_subscriptions_mirror()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenant_subscriptions_mirror ON public.tenant_subscriptions;
CREATE TRIGGER tenant_subscriptions_mirror
  AFTER INSERT OR UPDATE ON public.tenant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.tenant_subscriptions_mirror();

-- ============ 2. Deprecacao da porta antiga (REQ-28 / I15) ============

REVOKE ALL ON FUNCTION public.admin_set_tenant_status(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.admin_set_tenant_status(uuid, text, text, text) IS
  'DEPRECADA em 0058 (ADR-001 §6.4): sem EXECUTE para cliente. Escrita de plano/status passa por admin_override_subscription (0060), que grava a verdade em tenant_subscriptions e deixa o espelho para tenant_subscriptions_mirror.';
