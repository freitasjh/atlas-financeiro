-- 0070_active_tenant_resolution.sql — internal-control-plane / F4 / ADR-004 (BE-44).
--
-- Motivo: `0069` grava o pin (`user_active_tenants`), mas as duas resoluções de
-- tenant continuam puramente determinísticas. Dar o pin só à leitura
-- (`resolve_user_tenant`) deixaria `switch_tenant` DECORATIVO: a UI mostraria
-- o tenant A e o `INSERT` cairia em B — o cenário que o ADR §8.2 recusou ao
-- rejeitar cookie/localStorage. Por isso esta migration recorta a prioridade
-- em cada função conforme o seu sujeito (SPEC §7.1, O-F4-2):
--
--   resolve_user_tenant    "tenant que o usuário DECLAROU"
--                          pin → owner → created_at → tenant_id
--   resolve_writable_tenant "tenant onde o usuário PODE ESCREVER"
--                          não-cancelado → pin → owner → created_at → tenant_id
--
-- Consequências declaradas:
--   • `get_my_subscription`/`list_my_invoices` (0060) seguem o pin (leitura).
--   • Gate de escrita e consumo (0061/0063/0064) seguem o pin quando ele é
--     GRAVÁVEL; o I1 da F3 (status primeiro) permanece.
--   • Janela O-F4-3: se o tenant pinado virar `canceled` DEPOIS do switch, a
--     leitura mantém o pin e a escrita cai no fallback gravável. Mitigação é
--     trocar de tenant (`switch_tenant` recusa alvo `canceled`, 0069).
--   • Pin órfão (sem membership) é ignorado: o predicado `tm.tenant_id = pin`
--     nunca casa e a ordem determinística volta a valer. Nenhum DELETE
--     automático de pin.
--   • Sem pin, o resultado é IDÊNTICO ao de `0054`/`0061` (regressão provada
--     em T-pin-05 do spec 0069-0071).
--
-- Restrições duras preservadas: assinatura `(uuid) → uuid`, STABLE,
-- SECURITY DEFINER, `search_path=''`, sujeito = PARÂMETRO (proibido
-- `auth.uid()` no corpo — `0061` T08) e SEM GRANT (helpers privados).
-- Nenhum valor monetário tocado. Idempotente-safe: guarda de pré-condição +
-- CREATE OR REPLACE + REVOKE repetíveis. Migrations 0001–0069 e 0077–0081
-- intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regclass('public.user_active_tenants') IS NULL
    OR to_regclass('public.tenant_members') IS NULL
    OR to_regclass('public.tenants') IS NULL
    OR to_regprocedure('private.resolve_user_tenant(uuid)') IS NULL
    OR to_regprocedure('private.resolve_writable_tenant(uuid)') IS NULL THEN
    RAISE EXCEPTION 'internal-control-plane-precondition-missing';
  END IF;
END $$;

-- ============ 1. Leitura: pin → owner → created_at → tenant_id ============
-- O primeiro termo de ORDER BY é uniformemente NULL quando não há pin, logo
-- não altera o desempate antigo (DESC coloca NULLs primeiro, mas todos são
-- NULL). Com pin, a linha que casa vem antes de todas as outras.

CREATE OR REPLACE FUNCTION private.resolve_user_tenant(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT tm.tenant_id
  FROM public.tenant_members AS tm
  WHERE tm.user_id = p_user
  ORDER BY (tm.tenant_id = (
             SELECT uat.tenant_id
             FROM public.user_active_tenants AS uat
             WHERE uat.user_id = p_user
           )) DESC,
           (tm.role = 'owner') DESC,
           tm.created_at ASC,
           tm.tenant_id ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION private.resolve_user_tenant(uuid) IS
  'ADR-004 §8.3 / 0070 (O-F4-2): tenant DECLARADO do usuario — pin de user_active_tenants primeiro, depois owner, created_at, tenant_id. Pin orfao (sem membership) e ignorado. Sem pin = 0054. STABLE/DEFINER/search_path vazio, sujeito = parametro (sem auth.uid), sem EXECUTE para client.';

REVOKE ALL ON FUNCTION private.resolve_user_tenant(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 2. Escrita: não-cancelado → pin → owner → created_at → tenant_id ============
-- `subscription_status <> 'canceled'` continua sendo o PRIMEIRO critério (I1 da
-- F3): pin de tenant cancelado nunca é honrado pela escrita. Dentro da classe
-- gravável, o pin decide.

CREATE OR REPLACE FUNCTION private.resolve_writable_tenant(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT tm.tenant_id
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE tm.user_id = p_user
  ORDER BY (t.subscription_status <> 'canceled') DESC,
           (tm.tenant_id = (
             SELECT uat.tenant_id
             FROM public.user_active_tenants AS uat
             WHERE uat.user_id = p_user
           )) DESC,
           (tm.role = 'owner') DESC,
           tm.created_at ASC,
           tm.tenant_id ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION private.resolve_writable_tenant(uuid) IS
  'ADR-004 §8.3 / 0070 (O-F4-2): tenant GRAVAVEL do usuario — status <> canceled primeiro (I1 da F3 preservado), depois o pin de user_active_tenants, depois owner, created_at, tenant_id. Pin de tenant canceled NAO e honrado pela escrita (janela O-F4-3: leitura mantem, escrita cai no fallback). Sem pin = 0061. STABLE/DEFINER/search_path vazio, sujeito = parametro (sem auth.uid), sem EXECUTE para client.';

REVOKE ALL ON FUNCTION private.resolve_writable_tenant(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
