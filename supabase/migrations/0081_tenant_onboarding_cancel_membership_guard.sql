-- 0081_tenant_onboarding_cancel_membership_guard.sql — tenant-onboarding / F2 / ADR-006 (BE-30).
--
-- Motivo (review final da F2): `admin_cancel_invite` (`0078`) só recusava quando
-- o alvo era `tenants.owner_user_id`. Para MEMBRO de tenant (`member`/`admin`)
-- ela devolvia `false` sem erro e a borda `admin-invite-user` seguia para
-- `auth.admin.deleteUser` — o cascade `profiles -> tenant_members` apagava o
-- vínculo do usuário com o workspace SEM trilha (`antes_membership 1 ->
-- depois 0, audit 0`). Cancelar convite nunca é apagar conta: recusar é a
-- decisão segura, e remover membro pertence ao painel de tenants.
--
-- Decisão congelada (ADR-006 D5, SPEC I7 estendido):
--   `admin_cancel_invite(p_target)` recusa com `invite-not-pending` quando o
--   alvo tem **qualquer** membership (`EXISTS tenant_members WHERE
--   user_id = p_target`), não apenas quando é owner de algum tenant. Mesmo
--   rótulo do caso de tenant (a interface congelada não distingue
--   `invite-not-pending` de "alvo vinculado"), 0 escrita em qualquer recusa.
--
-- A correção vive no SQL de propósito: protege QUALQUER chamador (painel, Edge,
-- console). A borda mantém o guard próprio (só prossegue com
-- `canceled === true`), defesa em profundidade — este arquivo não depende dele.
--
-- Membros legados de tenant `canceled` também recusam: o vínculo continua sendo
-- o registro de quem já pertence ao workspace; reativar/cancelar é ato do
-- painel (`admin_override_subscription`), nunca um DELETE de usuário.
--
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT/COMMENT repetíveis.
-- Migrations 0001–0080 intocadas. Zero tabela/coluna nova; nenhum valor
-- monetário nesta fatia.

-- Pré-condição dura (fail-closed na aplicação): sem `tenant_members` a recusa
-- por membership não existe e o buraco volta silenciosamente.
DO $$
BEGIN
  IF to_regclass('public.tenant_members') IS NULL
    OR to_regclass('public.tenants') IS NULL
    OR to_regclass('public.admin_audit') IS NULL
    OR to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'tenant-onboarding-cancel-membership-guard-precondition-missing';
  END IF;
END $$;

-- ============ 1. Cancelamento (nunca apaga tenant nem desvincula membro) ============

CREATE OR REPLACE FUNCTION public.admin_cancel_invite(p_target uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_requested_at timestamptz;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  -- Review F2 / I7: alvo VINCULADO (qualquer role, inclusive `owner`) nunca é
  -- "convite pendente" — cancelar aqui viraria DELETE de conta na borda e o
  -- cascade apagaria o vínculo sem trilha. Decisão é do painel de tenants.
  IF p_target IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.tenants AS t WHERE t.owner_user_id = p_target
    )
    OR EXISTS (
      SELECT 1 FROM public.tenant_members AS tm WHERE tm.user_id = p_target
    )
  ) THEN
    RAISE EXCEPTION 'invite-not-pending';
  END IF;

  -- Pendência derivada: último pedido do alvo (independe do ator) e nenhum
  -- cancelamento posterior. `p_target` NULL ⇒ nenhum pedido ⇒ `false`.
  -- `action='other'` fecha o domínio da derivação (A4).
  SELECT pg_catalog.max(a.at) INTO v_requested_at
  FROM public.admin_audit AS a
  WHERE a.target_id = p_target
    AND a.action = 'other'
    AND a.reason = 'tenant_onboard_invite_requested';

  IF v_requested_at IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.admin_audit AS c
    WHERE c.target_id = p_target
      AND c.action = 'other'
      AND c.reason = 'tenant_onboard_invite_cancelled'
      AND c.at > v_requested_at
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (v_uid, p_target, NULL, 'other', 'tenant_onboard_invite_cancelled');

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.admin_cancel_invite(uuid) IS
  'ADR-006 D5/§10.3 + parecer C1 (0078) + review F2 (0081): protocolo RPC-primeiro. Recusa com invite-not-pending quando o alvo e owner de algum tenant OU tem QUALQUER membership (tenant_members.user_id = p_target) — cancelar nunca desvincula membro nem apaga tenant (0 escrita). Sem vinculo e sem pendencia derivada => false e 0 escrita (idempotente); senao 1 linha `tenant_onboard_invite_cancelled` => true. Cancelar NAO devolve cota. Gate is_admin(); sem PII.';

-- ============ 2. ACL (REVOKE antes do GRANT — precedente 0078/0079) ============

REVOKE ALL ON FUNCTION public.admin_cancel_invite(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_invite(uuid) TO authenticated;
