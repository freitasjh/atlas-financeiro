-- 0075_subscription_past_due_grace.sql — subscription-access / F6 / ADR-002 §16.1.
--
-- Motivo: `0054` só bloqueia `canceled`. O ramo `past_due` (carência de 7 dias
-- de D4) não existe no caminho de escrita, e a decisão de acesso está espalhada
-- (`tenants.subscription_status` em `0054`/`0070`). A1 do ADR-002 congela uma
-- única porta de leitura de billing (`private.subscription_access`), A2 fixa a
-- tabela de decisão (8 linhas) e A4 exige um guard, dois caminhos de chamada.
--
-- Entrega (server-side, sem depender de role/current_user):
--   1) `private.subscription_access(uuid) RETURNS text` — STABLE, DEFINER,
--      search_path='', SEM GRANT. ÚNICO objeto do caminho de escrita que lê
--      `public.tenant_subscriptions`. Retorno fechado em {'ok','grace','readonly'}:
--        trial/active                         -> 'ok'
--        canceled                             -> 'readonly'
--        past_due, past_due_since + 7d > now() -> 'grace'
--        past_due, graça vencida              -> 'readonly'
--        past_due, past_due_since IS NULL     -> 'grace'   (A2 linha 8, O-F6-2)
--        sem linha em tenant_subscriptions    -> 'ok'      (fail-open declarado)
--        p_tenant NULL / tenant inexistente   -> 'ok'      (fail-open declarado)
--   2) `private.assert_subscription_writable()` recriada com a MESMA assinatura
--      (`RETURNS trigger`, sem argumento, sem overload, sem trigger novo):
--      preserva o ramo `canceled` de `0054` e acrescenta
--      `subscription-past-due-grace-expired`. As 4 tabelas decidem pelo CONJUNTO
--      de memberships de `NEW.user_id` em UM statement (CROSS JOIN LATERAL +
--      bool_or); `tenant_members` decide pelo tenant de destino.
--   3) `private.resolve_writable_tenant(uuid)` recriada (desvio D-1): o
--      primeiro termo do ORDER BY passa a ser
--      `private.subscription_access(...) <> 'readonly'`; pin/owner/created_at/
--      tenant_id preservados. Sem isso a linha cairia no tenant com graça
--      vencida mesmo havendo outro gravável (O-F6-1).
--
-- O corpo do guard e da quota NÃO referencia `tenant_subscriptions` (A1): só o
-- helper lê a verdade. Nenhum trigger é criado/recriado. DELETE permanece
-- permitido (O6 aberta). Nenhum valor monetário tocado.
-- Erros por rótulo fixo, sem PII/id. Idempotente-safe: guard de pré-condição +
-- CREATE OR REPLACE + REVOKE repetíveis. Migrations 0001–0074 e 0077–0081
-- intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regprocedure('private.assert_subscription_writable()') IS NULL
    OR to_regprocedure('private.resolve_writable_tenant(uuid)') IS NULL
    OR to_regclass('public.tenant_subscriptions') IS NULL
    OR to_regclass('public.tenants') IS NULL
    OR to_regclass('public.tenant_members') IS NULL THEN
    RAISE EXCEPTION 'subscription-access-precondition-missing';
  END IF;
END $$;

-- ============ 1. Porta única de leitura de billing ============
-- Tabela de decisão A2 (ordem de avaliação):
--   1 trial                          -> ok
--   2 active                         -> ok
--   3 past_due + graça vigente       -> grace
--   4 past_due + graça vencida       -> readonly
--   5 canceled                       -> readonly
--   6 p_tenant NULL                  -> ok (chamador segue para quota-tenant-missing)
--   7 sem linha em tenant_subscriptions (status <> past_due) -> ok (fail-open declarado)
--   8 past_due + past_due_since NULL -> grace (A5 de ADR-001 aberta; O-F6-2)
-- Tenant inexistente -> ok (fail-open declarado; O-F6-4).

CREATE OR REPLACE FUNCTION private.subscription_access(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_past_due_since timestamptz;
BEGIN
  IF p_tenant IS NULL THEN
    RETURN 'ok';
  END IF;

  SELECT t.subscription_status
    INTO v_status
  FROM public.tenants AS t
  WHERE t.id = p_tenant;

  IF NOT FOUND OR v_status IS NULL THEN
    RETURN 'ok';
  END IF;

  IF v_status = 'canceled' THEN
    RETURN 'readonly';
  END IF;

  IF v_status <> 'past_due' THEN
    RETURN 'ok';
  END IF;

  SELECT ts.past_due_since
    INTO v_past_due_since
  FROM public.tenant_subscriptions AS ts
  WHERE ts.tenant_id = p_tenant;

  IF NOT FOUND OR v_past_due_since IS NULL THEN
    RETURN 'grace';
  END IF;

  IF v_past_due_since + interval '7 days' > pg_catalog.now() THEN
    RETURN 'grace';
  END IF;

  RETURN 'readonly';
END;
$$;

COMMENT ON FUNCTION private.subscription_access(uuid) IS
  'A1/A2 (ADR-002 §16.1): porta unica de leitura de billing. Retorna ok|grace|readonly. trial/active=ok; canceled=readonly; past_due com past_due_since+7d>now()=grace; graca vencida=readonly; past_due_since NULL=grace (linha 8); sem linha em tenant_subscriptions=ok (fail-open declarado); p_tenant NULL ou tenant inexistente=ok. STABLE/DEFINER/search_path vazio, sem EXECUTE para client.';

REVOKE ALL ON FUNCTION private.subscription_access(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 2. Guard recriado (mesma assinatura, sem overload) ============
-- `NEW.tenant_id` é lido UMA vez, só no ramo `tenant_members` (sujeito = tenant
-- de destino). Nas 4 tabelas o sujeito é o conjunto de memberships do autor:
-- `NEW.tenant_id` ali ainda é valor do cliente/NULL (a `0063` só grava depois),
-- logo decidir por ele seria forjável. `v_has_any` vem antes de `v_any_writable`
-- porque `bool_or` sobre zero linhas é NULL.

CREATE OR REPLACE FUNCTION private.assert_subscription_writable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target uuid;
  v_access text;
  v_label text;
  v_has_any boolean;
  v_any_writable boolean;
  v_any_past_due boolean;
BEGIN
  IF TG_TABLE_NAME = 'tenant_members' THEN
    v_target := NEW.tenant_id;
    v_access := private.subscription_access(v_target);

    IF v_access = 'readonly' THEN
      SELECT CASE
               WHEN t.subscription_status = 'past_due'
                 THEN 'subscription-past-due-grace-expired'
               ELSE 'subscription-canceled-readonly'
             END
        INTO v_label
      FROM public.tenants AS t
      WHERE t.id = v_target;

      RAISE EXCEPTION USING MESSAGE = v_label;
    END IF;

    RETURN NEW;
  END IF;

  SELECT count(*) > 0,
         pg_catalog.bool_or(a.access <> 'readonly'),
         pg_catalog.bool_or(a.access = 'readonly' AND t.subscription_status = 'past_due')
    INTO v_has_any, v_any_writable, v_any_past_due
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  CROSS JOIN LATERAL (
    SELECT private.subscription_access(tm.tenant_id) AS access
  ) AS a
  WHERE tm.user_id = NEW.user_id;

  -- Sem membership: libera (legado P0; a quota responde quota-tenant-missing).
  IF v_has_any IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Membership existe e NENHUM tenant é gravável: somente-leitura.
  IF v_any_writable IS NOT TRUE THEN
    v_label := CASE
                 WHEN v_any_past_due
                   THEN 'subscription-past-due-grace-expired'
                 ELSE 'subscription-canceled-readonly'
               END;
    RAISE EXCEPTION USING MESSAGE = v_label;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION private.assert_subscription_writable() IS
  'A4 (ADR-002 §16.1): um guard, dois caminhos. 4 tabelas decidem pelo CONJUNTO de memberships de NEW.user_id em um statement (bool_or de subscription_access); nenhum gravavel -> subscription-past-due-grace-expired (se algum past_due) senao subscription-canceled-readonly. tenant_members decide por NEW.tenant_id. Sem membership -> libera (legado P0). DELETE nao coberto (O6). Mesma assinatura de 0054, sem overload.';

REVOKE ALL ON FUNCTION private.assert_subscription_writable()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 3. Consistência de destino (D-1) ============
-- Primeiro termo: tenant gravável (subscription_access <> 'readonly') vence.
-- Depois: pin da 0070, owner, created_at, tenant_id. O JOIN em `tenants` deixa
-- de ser necessário (só servia ao termo de status) e é removido.

CREATE OR REPLACE FUNCTION private.resolve_writable_tenant(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT tm.tenant_id
  FROM public.tenant_members AS tm
  WHERE tm.user_id = p_user
  ORDER BY (private.subscription_access(tm.tenant_id) <> 'readonly') DESC,
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
  'A1+A5/D-1 (0075): tenant GRAVAVEL do usuario — subscription_access <> readonly primeiro (past_due vencido demovido), depois o pin de user_active_tenants (0070), owner, created_at, tenant_id. Assinatura/STABLE/DEFINER/search_path vazio e sem EXECUTE preservados. Sem readonly/pin = 0070.';

REVOKE ALL ON FUNCTION private.resolve_writable_tenant(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
