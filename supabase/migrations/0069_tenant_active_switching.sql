-- 0069_tenant_active_switching.sql — internal-control-plane / F4 / ADR-004 (BE-43).
--
-- Motivo: o tenant "ativo" do usuário precisa ser uma escolha explícita e
-- auditada (ADR-004 §8, D-B1-MULTI-TENANT). Hoje a resolução é puramente
-- determinística (`0054`/`0061`); sem pin persistido, a UI mostraria um tenant
-- e o `INSERT` cairia em outro. Cookie/localStorage foram recusados no ADR
-- §8.2 — o pin mora em tabela e só é escrito por RPC DEFINER.
--
-- Entrega (server-side; nenhuma escrita direta de `authenticated`):
--   1) `public.user_active_tenants` — PK `user_id` (1 pin por usuário),
--      `tenant_id` NOT NULL, `switched_at`. FKs `ON DELETE CASCADE`
--      (profile/tenant apagados ⇒ pin apagado). RLS habilitada SEM policy
--      (deny-all) + `REVOKE ALL` dos 4 papéis: escrita só pela RPC.
--   2) `public.tenant_switches` — trilha append-only, SEM FK nos três ids
--      (precedente `0019:19-22`: cascade apagaria a prova). `from_tenant_id`
--      NULL quando não havia pin; `source` emitido nesta fatia = 'selector'.
--      RLS deny-all + `REVOKE ALL`. 2 índices: `(actor_id, switched_at DESC)`
--      e `(to_tenant_id, switched_at DESC)`.
--   3) `public.switch_tenant(p_tenant uuid)` — VOLATILE, DEFINER,
--      search_path=''. Ordem: sem sessão ⇒ `not-authenticated`; sem
--      membership ⇒ `tenant-not-member` (cobre uuid inexistente, sem id na
--      mensagem); alvo `subscription_status='canceled'` ⇒
--      `subscription-canceled-readonly` (O-F4-1: pin só nasce gravável);
--      alvo = pin atual ⇒ RETURN (no-op SEM trilha); senão
--      `INSERT ... ON CONFLICT (user_id) DO UPDATE` + `INSERT tenant_switches`
--      na MESMA transação (pin sem prova nunca existe).
--   4) `public.list_my_tenants()` — STABLE; só memberships de `auth.uid()`;
--      `name = COALESCE(nome_fantasia, razao_social)`; sem documento/PII;
--      `is_active` = `private.resolve_user_tenant(auth.uid())`; ordem
--      `is_active DESC, name ASC, tenant_id ASC`.
--   5) `public.admin_list_tenant_switches(p_tenant, p_limit, p_offset)` —
--      STABLE; gate `is_super_admin()` ⇒ `not-admin`; clamp 1..100 e offset
--      ≥ 0; `p_tenant` filtra `from_tenant_id = p OR to_tenant_id = p`; ordem
--      `switched_at DESC, id DESC`; sem trilha própria (agregado de trilha,
--      precedente `0042:78-95`).
--
-- Erros por rótulo fixo, sem PII/id: internal-control-plane-precondition-missing,
-- not-authenticated, tenant-not-member, subscription-canceled-readonly,
-- not-admin. Nenhum valor monetário tocado.
-- Idempotente-safe: guarda de pré-condição (fail-closed) + CREATE TABLE IF NOT
-- EXISTS + CREATE INDEX IF NOT EXISTS + CREATE OR REPLACE + REVOKE/GRANT
-- repetíveis. Migrations 0001–0064 e 0077–0081 intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL
    OR to_regclass('public.tenants') IS NULL
    OR to_regclass('public.tenant_members') IS NULL
    OR to_regprocedure('public.is_super_admin()') IS NULL
    OR to_regprocedure('private.resolve_user_tenant(uuid)') IS NULL THEN
    RAISE EXCEPTION 'internal-control-plane-precondition-missing';
  END IF;
END $$;

-- ============ 1. Pin do tenant ativo ============
-- 1 linha por usuário (PK). `switched_at` é o carimbo da última troca real
-- (no-op não reescreve). Sem policy: nenhum caminho de cliente lê/escreve.

CREATE TABLE IF NOT EXISTS public.user_active_tenants (
  user_id     uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  switched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_active_tenants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_active_tenants
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.user_active_tenants IS
  'ADR-004 §8.3: tenant ativo escolhido pelo usuário (1 linha por user_id). Escrita só por public.switch_tenant (DEFINER); RLS deny-all + REVOKE dos 4 papéis. FK CASCADE em profile/tenant.';

-- ============ 2. Trilha de trocas (append-only, sem FK) ============
-- Sem FK de propósito: `ON DELETE CASCADE` apagaria a prova da troca quando o
-- usuário ou o tenant fosse removido (precedente 0019:19-22). `actor_id` e
-- `from_tenant_id` são NULLable; `to_tenant_id` é NOT NULL.

CREATE TABLE IF NOT EXISTS public.tenant_switches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id       uuid,
  from_tenant_id uuid,
  to_tenant_id   uuid NOT NULL,
  switched_at    timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL DEFAULT 'selector'
);

CREATE INDEX IF NOT EXISTS tenant_switches_actor_idx
  ON public.tenant_switches (actor_id, switched_at DESC);
CREATE INDEX IF NOT EXISTS tenant_switches_to_idx
  ON public.tenant_switches (to_tenant_id, switched_at DESC);

ALTER TABLE public.tenant_switches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenant_switches
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.tenant_switches IS
  'ADR-004 §8.4: trilha append-only de trocas de tenant (sem FK nos 3 ids; cascade apagaria a prova). source desta fatia = selector. Escrita só por switch_tenant; leitura só por admin_list_tenant_switches (gate is_super_admin).';

-- ============ 3. switch_tenant ============
-- Ordem interna fixa: sessão → membership → gravabilidade → no-op → escrita.
-- A trilha nasce na MESMA transação do pin: pin sem prova é impossível.

CREATE OR REPLACE FUNCTION public.switch_tenant(p_tenant uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_current uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  IF p_tenant IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.tenant_members AS tm
    WHERE tm.user_id = v_uid
      AND tm.tenant_id = p_tenant
  ) THEN
    RAISE EXCEPTION 'tenant-not-member';
  END IF;

  SELECT t.subscription_status INTO v_status
  FROM public.tenants AS t
  WHERE t.id = p_tenant;

  IF v_status = 'canceled' THEN
    RAISE EXCEPTION 'subscription-canceled-readonly';
  END IF;

  SELECT uat.tenant_id INTO v_current
  FROM public.user_active_tenants AS uat
  WHERE uat.user_id = v_uid;

  IF v_current IS NOT DISTINCT FROM p_tenant THEN
    RETURN;
  END IF;

  INSERT INTO public.user_active_tenants AS uat (user_id, tenant_id, switched_at)
  VALUES (v_uid, p_tenant, pg_catalog.now())
  ON CONFLICT (user_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        switched_at = EXCLUDED.switched_at;

  INSERT INTO public.tenant_switches (actor_id, from_tenant_id, to_tenant_id, source)
  VALUES (v_uid, v_current, p_tenant, 'selector');
END;
$$;

COMMENT ON FUNCTION public.switch_tenant(uuid) IS
  'ADR-004 §8.3/§10.5 + O-F4-1: troca o tenant ativo do chamador. not-authenticated sem sessão; tenant-not-member sem membership (sem id na mensagem); subscription-canceled-readonly em alvo canceled; alvo = pin atual = no-op sem trilha; caso contrário pin (ON CONFLICT user_id) + 1 linha em tenant_switches na MESMA transação.';

REVOKE ALL ON FUNCTION public.switch_tenant(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.switch_tenant(uuid) TO authenticated;

-- ============ 4. list_my_tenants ============
-- Só memberships do chamador; sem documento/PII. `is_active` vem da MESMA
-- resolução usada pela leitura de assinatura/faturas (private.resolve_user_tenant).

CREATE OR REPLACE FUNCTION public.list_my_tenants()
RETURNS TABLE (
  tenant_id uuid,
  name text,
  role text,
  is_active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_active uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  v_active := private.resolve_user_tenant(v_uid);

  RETURN QUERY
  SELECT tm.tenant_id,
         COALESCE(t.nome_fantasia, t.razao_social),
         tm.role,
         (tm.tenant_id = v_active)
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE tm.user_id = v_uid
  ORDER BY (tm.tenant_id = v_active) DESC,
           COALESCE(t.nome_fantasia, t.razao_social) ASC,
           tm.tenant_id ASC;
END;
$$;

COMMENT ON FUNCTION public.list_my_tenants() IS
  'ADR-004 §10.5: memberships do chamador com is_active = private.resolve_user_tenant(auth.uid()). name = COALESCE(nome_fantasia, razao_social); sem documento/PII. Ordem is_active DESC, name ASC, tenant_id ASC. not-authenticated sem sessão.';

REVOKE ALL ON FUNCTION public.list_my_tenants()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.list_my_tenants() TO authenticated;

-- ============ 5. admin_list_tenant_switches ============
-- Agregado de trilha: não grava trilha própria (precedente 0042:78-95).

CREATE OR REPLACE FUNCTION public.admin_list_tenant_switches(
  p_tenant uuid DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  actor_id uuid,
  from_tenant_id uuid,
  to_tenant_id uuid,
  switched_at timestamptz,
  source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  RETURN QUERY
  SELECT s.actor_id, s.from_tenant_id, s.to_tenant_id, s.switched_at, s.source
  FROM public.tenant_switches AS s
  WHERE p_tenant IS NULL
     OR s.from_tenant_id = p_tenant
     OR s.to_tenant_id = p_tenant
  ORDER BY s.switched_at DESC, s.id DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.admin_list_tenant_switches(uuid, int, int) IS
  'ADR-004 §10.5: trilha de trocas de tenant. Gate is_super_admin() (not-admin); clamp 1..100, offset >= 0; p_tenant filtra from OR to; ordem switched_at DESC, id DESC. Sem trilha própria (agregado).';

REVOKE ALL ON FUNCTION public.admin_list_tenant_switches(uuid, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_list_tenant_switches(uuid, int, int)
  TO authenticated;
