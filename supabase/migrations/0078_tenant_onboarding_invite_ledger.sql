-- 0078_tenant_onboarding_invite_ledger.sql — tenant-onboarding / F2 / ADR-006 (BE-23).
--
-- Motivo: o convite do backoffice não tinha ledger. A borda `admin-invite-user`
-- convidava por e-mail e, se o painel se perdesse entre o `inviteUserByEmail` e
-- o provisionamento, o convite ficava invisível (F13) — e nada limitava um
-- operador a criar tenants "em nome de terceiro" em série (D9).
--
-- Decisão congelada (ADR-006 D4/D9, SPEC I6): o convite pendente é **DERIVADO**,
-- nunca armazenado. Não há tabela de estado de onboarding: a fonte é a trilha
-- append-only `admin_audit` (`reason='tenant_onboard_invite_requested'`,
-- `target_id`=convidado) somada à ausência de tenant VIVO do convidado.
--
-- Entrega (REQ-09..REQ-11, REQ-14, REQ-21..REQ-23; I5/I6/I7):
--   0) `private.invite_consumption(p_actor uuid) RETURNS integer` — ÚNICA
--      definição de consumo (parecer A4): nº de `tenant_onboard_invite_requested`
--      (`action='other'`) do ator na janela de 1 h. SECURITY DEFINER porque
--      `admin_audit` não é legível por `authenticated`; EXECUTE revogado de
--      todos os papéis de cliente.
--   1) `public.admin_record_invite(p_target uuid) RETURNS void` — gate
--      `is_admin()`; alvo tem de existir em `profiles` (senão
--      `invite-target-invalid`); alvo com tenant VIVO ⇒ no-op sem escrita
--      (parecer A2, contrato `tenant-already-onboarded`; tenant `canceled` não
--      conta, mesma chave do reuso de `0077`); retry do mesmo (ator, alvo) em
--      <60 min é no-op SOMENTE quando o pedido não tem `invite_cancelled`
--      posterior (parecer A1: cancelar e reconvidar grava trilha e devolve o
--      alvo à lista); cota 20/h por operador (senão `invite-rate-limited`,
--      0 escrita); grava `action='other'`, `tenant_id=NULL`, `reason`
--      constante ⇒ sem PII.
--   2) `public.admin_cancel_invite(p_target uuid) RETURNS boolean` — com tenant
--      existente ⇒ `invite-not-pending` (I7: cancelar nunca apaga tenant); sem
--      pendência ⇒ `false`, 0 escrita; senão 1 linha `invite_cancelled` ⇒
--      `true`. Cancelar NÃO devolve cota (decisão C1).
--   3) `public.admin_list_pending_invites(p_limit int DEFAULT 20, p_offset int
--      DEFAULT 0)` — 4 colunas (`invited_user_id, requested_at, age_hours,
--      state`), **sem e-mail/nome/documento**; `state='invite-pending'` (enum de
--      1 valor, forma fechada); `p_limit` clamp `1..100`, `p_offset >= 0`;
--      ordem `requested_at DESC, invited_user_id ASC` (REQ-22). Leitura NÃO
--      escreve trilha (contraste deliberado com ADR-005 §8.3). Tenant do alvo
--      só esconde o convite quando NÃO é `canceled` (parecer A2, alinhado ao
--      reuso de `0077`).
--   4) `public.admin_invite_quota() RETURNS integer` — `GREATEST(20 -
--      private.invite_consumption(auth.uid()), 0)` (parecer C1/A4). Somente
--      leitura; nenhuma trilha.
--
-- Desvio declarado de ADR-006 §11: NÃO cria `tenants_owner_user_idx` — o índice
-- equivalente já existe (`tenants_owner_idx`, 0022:122-123); duplicá-lo seria
-- custo sem ganho. Zero tabela/coluna nova (REQ-24).
--
-- Performance (parecer A3): as buscas por ALVO usam `idx_admin_audit_target_at
-- (target_id, at DESC)` (0019:47-48) e o consumo da cota usa
-- `idx_admin_audit_actor_at (actor_id, at DESC)` (0019:50-51). NÃO existe índice
-- por `reason`: a derivação da lista filtra
-- `reason='tenant_onboard_invite_requested'` sem alvo/ator e percorre
-- `admin_audit` inteiro. Quando a trilha crescer, o índice indicado é
-- `admin_audit (reason, at DESC)` — não criado nesta fatia (REQ-24).
--
-- Cota é advisory com corrida declarada (ADR-006 D9, 🟠): duas chamadas
-- simultâneas do mesmo operador podem gravar 21 na janela. O contador é durável
-- na trilha (nunca memória de isolate); o throttle 10/min por IP da borda é a
-- primeira camada e o `429 invite-rate-limited` da Edge (BE-28) a segunda.
--
-- Ordem interna de `admin_record_invite`: gate → alvo → tenant vivo (no-op) →
-- idempotência (60 min, considerando estado) → cota. O retry idempotente é no-op
-- **mesmo com a cota esgotada** — um reenvio da borda não pode virar `429` por
-- um pedido que já foi contado. Cancelar NÃO devolve cota (C1): o gasto é
-- durável e o desconto de cancelado existe apenas na derivação da lista.
--
-- Idempotente-safe: guard de pré-condição + CREATE OR REPLACE +
-- REVOKE/GRANT/COMMENT repetíveis. Migrations 0001–0077 intocadas.
-- Nenhum valor monetário nesta fatia (só trilha e rótulos).

-- Pré-condição dura (fail-closed na aplicação): sem `admin_audit.reason`
-- (0028/0032), sem `tenant_id` (0032), sem `tenants` (0022) ou sem o gate
-- `is_admin()` (0004/0051) estas RPCs não cumprem o contrato e o erro só
-- apareceria no runtime com DETAIL cru do Postgres.
DO $$
BEGIN
  IF to_regclass('public.admin_audit') IS NULL
    OR to_regclass('public.tenants') IS NULL
    OR to_regclass('public.profiles') IS NULL
    OR to_regprocedure('public.is_admin()') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.admin_audit'::regclass
        AND attname = 'reason'
        AND NOT attisdropped
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.admin_audit'::regclass
        AND attname = 'tenant_id'
        AND NOT attisdropped
    ) THEN
    RAISE EXCEPTION 'tenant-onboarding-invite-ledger-precondition-missing';
  END IF;
END $$;

-- ============ 0. Consumo compartilhado (A4) ============
-- Definição ÚNICA de consumo usada por `admin_record_invite` e
-- `admin_invite_quota` (antes duplicada, com risco de divergir). Decisão C1 do
-- parecer: consumo = `count(requested)` na janela de 1 h; cancelar NÃO devolve
-- cota (o gasto é durável). `action='other'` fecha o domínio da derivação.
--
-- SECURITY DEFINER porque `admin_audit` não é legível por `authenticated`;
-- EXECUTE revogado de PUBLIC/anon/authenticated/service_role — só as RPCs
-- SECURITY DEFINER desta migration (owner) chamam.
CREATE OR REPLACE FUNCTION private.invite_consumption(p_actor uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.count(*)::integer
  FROM public.admin_audit AS a
  WHERE a.actor_id = p_actor
    AND a.action = 'other'
    AND a.reason = 'tenant_onboard_invite_requested'
    AND a.at > pg_catalog.now() - interval '1 hour';
$$;

COMMENT ON FUNCTION private.invite_consumption(uuid) IS
  'ADR-006 D9 / parecer C1+A4 (0078): consumo de convite do ator na janela de 1 h = count(tenant_onboard_invite_requested, action=other). Cancelar NÃO devolve cota (decisão C1); o desconto de cancelado existe apenas na derivação da lista. Interno: EXECUTE revogado de todos os papéis de cliente.';

REVOKE ALL ON FUNCTION private.invite_consumption(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 1. Cota do operador (somente leitura) ============

CREATE OR REPLACE FUNCTION public.admin_invite_quota()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- InitPlan: gate avaliado 1× por statement (precedente 0032/0022).
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  -- Consumo (C1/A4): `count(requested)` da janela de 1 h. Cancelar NÃO
  -- devolve cota — o desconto de cancelado é só da derivação da lista.
  RETURN GREATEST(20 - private.invite_consumption(v_uid), 0);
END;
$$;

COMMENT ON FUNCTION public.admin_invite_quota() IS
  'ADR-006 D9 / parecer C1+A4 (0078): convites restantes na janela de 1 h para auth.uid() — GREATEST(20 - private.invite_consumption(uid), 0); consumo = pedidos (action=other) do ator na janela, SEM desconto por cancelamento (cancelar nao devolve cota). Somente leitura (nenhuma trilha); gate is_admin(); EXECUTE authenticated. Cota advisory com corrida declarada (a borda faz o 429).';

-- ============ 2. Registro do convite (idempotente 60 min + cota) ============

CREATE OR REPLACE FUNCTION public.admin_record_invite(p_target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF p_target IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.profiles AS p WHERE p.id = p_target
    ) THEN
    RAISE EXCEPTION 'invite-target-invalid';
  END IF;

  -- A2 (contrato `tenant-already-onboarded`): alvo já provisionado com tenant
  -- VIVO ⇒ no-op sem escrita e sem consumir cota (o convite não faz sentido).
  -- Tenant `canceled` NÃO conta — mesma chave do reuso de `0077`, senão
  -- cancelar assinatura e reconvidar ficaria bloqueado.
  IF EXISTS (
    SELECT 1
    FROM public.tenants AS t
    WHERE t.owner_user_id = p_target
      AND t.subscription_status <> 'canceled'
  ) THEN
    RETURN;
  END IF;

  -- I5/REQ-11 + A1: retry do mesmo (ator, alvo) em <60 min é no-op — inclusive
  -- com a cota esgotada (reenvio da borda não pode virar 429 de um pedido já
  -- contado). O estado importa: pedido com `invite_cancelled` POSTERIOR não
  -- bloqueia o reconvite (fim do convite invisível).
  IF EXISTS (
    SELECT 1
    FROM public.admin_audit AS a
    WHERE a.actor_id = v_uid
      AND a.target_id = p_target
      AND a.action = 'other'
      AND a.reason = 'tenant_onboard_invite_requested'
      AND a.at > pg_catalog.now() - interval '60 minutes'
      AND NOT EXISTS (
        SELECT 1
        FROM public.admin_audit AS c
        WHERE c.actor_id = a.actor_id
          AND c.target_id = a.target_id
          AND c.action = 'other'
          AND c.reason = 'tenant_onboard_invite_cancelled'
          AND c.at > a.at
      )
  ) THEN
    RETURN;
  END IF;

  -- Cota (C1/A4): definição ÚNICA compartilhada com `admin_invite_quota()`.
  IF private.invite_consumption(v_uid) >= 20 THEN
    RAISE EXCEPTION 'invite-rate-limited';
  END IF;

  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (v_uid, p_target, NULL, 'other', 'tenant_onboard_invite_requested');
END;
$$;

COMMENT ON FUNCTION public.admin_record_invite(uuid) IS
  'ADR-006 §9.1/§10.3 + parecer C1/A1/A2/A4 (0078): grava 1 linha `tenant_onboard_invite_requested` (action=other, tenant_id NULL, reason constante ⇒ sem PII). Gate is_admin(); alvo fora de profiles => invite-target-invalid; alvo com tenant VIVO => no-op sem escrita (tenant-already-onboarded; tenant canceled nao conta); retry por (actor,target,reason) em <60 min sem cancelamento posterior => no-op (mesmo com cota esgotada); cancelado e reconvidado => grava nova trilha; 20/h por operador (private.invite_consumption) => invite-rate-limited com 0 escrita (advisory: corrida declarada em D9).';

-- ============ 3. Cancelamento (nunca apaga tenant) ============

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

  -- I7/D5: com tenant existente "cancelar" é cancelar a ASSINATURA
  -- (`admin_override_subscription`), nunca apagar o tenant.
  IF p_target IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tenants AS t WHERE t.owner_user_id = p_target
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
  'ADR-006 D5/§10.3 + parecer C1 (0078): protocolo RPC-primeiro. Com tenant do alvo => invite-not-pending (I7: cancelamento é assinatura, nunca DELETE); sem pendência derivada => false e 0 escrita (idempotente); senão 1 linha `tenant_onboard_invite_cancelled` => true. Cancelar NÃO devolve cota (o consumo é durável; o desconto é só da lista). Gate is_admin(); sem PII.';

-- ============ 4. Lista derivada de convites pendentes (sem PII) ============

CREATE OR REPLACE FUNCTION public.admin_list_pending_invites(
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  invited_user_id uuid,
  requested_at timestamptz,
  age_hours integer,
  state text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- NFR-05/REQ-22: clamp 1..100 e offset >= 0 (precedente 0031/0032).
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  RETURN QUERY
  WITH last_request AS (
    SELECT a.target_id AS invited_user_id,
           pg_catalog.max(a.at) AS requested_at
    FROM public.admin_audit AS a
    WHERE a.action = 'other'
      AND a.reason = 'tenant_onboard_invite_requested'
    GROUP BY a.target_id
  )
  SELECT r.invited_user_id,
         r.requested_at,
         pg_catalog.floor(
           EXTRACT(epoch FROM (pg_catalog.now() - r.requested_at)) / 3600
         )::integer AS age_hours,
         'invite-pending'::text AS state
  FROM last_request AS r
  WHERE EXISTS (
      SELECT 1 FROM public.profiles AS p WHERE p.id = r.invited_user_id
    )
    -- A2: só tenant VIVO esconde o convite. `canceled` libera (0077 reusa por
    -- (owner, documento) entre NÃO cancelados); o convite continua pendente.
    AND NOT EXISTS (
      SELECT 1 FROM public.tenants AS t
      WHERE t.owner_user_id = r.invited_user_id
        AND t.subscription_status <> 'canceled'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.admin_audit AS c
      WHERE c.target_id = r.invited_user_id
        AND c.action = 'other'
        AND c.reason = 'tenant_onboard_invite_cancelled'
        AND c.at > r.requested_at
    )
  ORDER BY r.requested_at DESC, r.invited_user_id ASC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.admin_list_pending_invites(integer, integer) IS
  'ADR-006 D4/§10.3 + parecer A2/A4 (0078): convite pendente DERIVADO (I6) — último `tenant_onboard_invite_requested` (action=other) por alvo, sem `invite_cancelled` posterior, sem tenant VIVO (tenant canceled NAO esconde: alinha o reuso de 0077) e com profile presente; target sem profile não aparece. 4 colunas (invited_user_id, requested_at, age_hours, state=''invite-pending''), NUNCA e-mail/nome/documento. p_limit clamp 1..100, p_offset>=0, ordem requested_at DESC + invited_user_id ASC. Leitura não escreve trilha. Gate is_admin().';

-- ============ 5. ACL (REVOKE antes do GRANT) ============

REVOKE ALL ON FUNCTION public.admin_invite_quota()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_invite_quota() TO authenticated;

REVOKE ALL ON FUNCTION public.admin_record_invite(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_record_invite(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_cancel_invite(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_invite(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_list_pending_invites(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_invites(integer, integer) TO authenticated;
