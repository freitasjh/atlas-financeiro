-- 0054_subscription_canceled_readonly.sql — security-debts-49-50 / DEBT-50 (adendo ADR-002).
--
-- Motivo: PRD §9 exige somente-leitura para tenant `canceled`, mas nada no
-- banco impedia INSERT/UPDATE — a regra vivia só no cliente. ADR-002 (adendo)
-- aprova checagem de status ANTES da quota, com rótulo fixo
-- `subscription-canceled-readonly`. Escopo desta migration: APENAS `canceled`
-- (`past_due`/carência ficam no adendo, migration 0075 planejada).
--
-- Fonte do status: espelho `public.tenants.subscription_status` (0022, enum
-- `trial|active|past_due|canceled`). NÃO usa `tenant_subscriptions` (não existe;
-- chega na 0055).
--
-- Entrega (server-side, sem depender de role/current_user):
--   1) `private.resolve_user_tenant(uuid)` — versão BASE: resolve o tenant do
--      usuário por `tenant_members` (NÃO é interface final de leitura).
--      Determinística: owner primeiro, depois membership mais antiga
--      (`created_at, tenant_id`). search_path='' e EXECUTE revogado de tudo.
--      ADR-002/0061 fará `CREATE OR REPLACE` adicionando a prioridade do pin
--      (`user_active_tenants`); o contrato (uuid -> uuid) não muda.
--   2) `private.assert_subscription_writable()` — BEFORE INSERT OR UPDATE,
--      SECURITY DEFINER + search_path='': avalia o CONJUNTO de memberships do
--      `NEW.user_id`, não um único tenant "resolvido". Sem membership ⇒
--      RETURN NEW (legado P0; a 0061 troca por `quota-tenant-missing`); com
--      ao menos um tenant gravável (`subscription_status <> 'canceled'`) ⇒
--      RETURN NEW; com membership e NENHUM tenant gravável ⇒
--      `subscription-canceled-readonly`, 0 linhas. Em `tenant_members` o
--      sujeito é o tenant de destino (`NEW.tenant_id`), nunca o do convidado.
--      (C1 do parecer `security-debts-49-50`: owner de tenant `canceled` que
--      também é membro de um tenant `trial` segue gravando — cenário do
--      convite do ADR-006; `resolve_user_tenant` devolveria o `canceled` por
--      ser o owner mais antigo e negaria a escrita indevidamente.)
--   3) Triggers `aa_subscription_readonly` em transactions, accounts,
--      credit_cards, budgets e tenant_members. O ordinal de triggers BEFORE
--      homônimos no Postgres é ALFABÉTICO por nome: `aa_...` ordena antes de
--      `plan_quota_*` (e de `accounts_*`/`created_at_*`), garantindo "status
--      antes de quota" — provado em T06 (accounts) e T06b (transactions) do
--      spec: tenant cancelado com quota estourada devolve o rótulo de status,
--      não `plan-quota-exceeded`.
--   4) DELETE permanece PERMITIDO em todas as 5 tabelas: LGPD/cascata e
--      remoção de histórico de tenant cancelado dependem de DELETE; o
--      somente-leitura alcança apenas INSERT/UPDATE.
--
-- Erros por rótulo fixo, sem PII/id: subscription-canceled-readonly.
-- Sem `current_user`: vale para cliente, console e RPC (mesmo padrão de
-- `enforce_plan_quota`/`reject_mutation`). Nenhum valor monetário tocado.
-- Idempotente-safe: CREATE OR REPLACE / DROP TRIGGER IF EXISTS / REVOKE
-- repetíveis. Migrations 0001–0053 intocadas.

-- ============ 1. Resolução base do tenant do usuário ============
-- Dono primeiro; desempate por membership mais antiga e, por fim, tenant_id
-- (a PK de `tenant_members` é `(tenant_id, user_id)`, não há coluna `id`).
-- `STABLE` como `private.user_tenant_ids()`: leitura pura por statement.
-- ADR-002/0061: esta é a versão BASE — o pin de `user_active_tenants` entra
-- por `CREATE OR REPLACE`; não tratar como interface final de leitura.
-- O guard de escrita NÃO usa esta função (um único tenant "resolvido" nega
-- escrita de quem tem outro tenant gravável — C1 do parecer); ela permanece
-- como utilitário base até a 0061.

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
  ORDER BY (tm.role = 'owner') DESC,
           tm.created_at ASC,
           tm.tenant_id ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION private.resolve_user_tenant(uuid) IS
  'Versão BASE (0054): tenant do usuário por tenant_members — owner primeiro, depois membership mais antiga (created_at, tenant_id). ADR-002/0061 substitui por CREATE OR REPLACE com prioridade do pin (user_active_tenants); não é interface final de leitura.';

REVOKE ALL ON FUNCTION private.resolve_user_tenant(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 2. Guarda de escrita (somente-leitura em `canceled`) ============
-- SECURITY DEFINER + search_path='' + SEM current_user: a negação não depende
-- da via de escrita (cliente, console, RPC/service_role). DELETE não é coberto
-- por este trigger (declarado no cabeçalho).
-- Decisão por CONJUNTO de memberships (C1 do parecer): só nega quando o
-- usuário tem membership e TODOS os tenants dele estão `canceled`. Um tenant
-- gravável (`trial|active|past_due`) libera a escrita — o status é do
-- subscription, não do "tenant principal" do usuário.
-- `tenant_members` é o único caso em que o sujeito é a linha escrita: um
-- convite/membership para tenant cancelado deve ser recusado pelo tenant de
-- destino (`NEW.tenant_id`), não pelo conjunto de tenants do convidado.

CREATE OR REPLACE FUNCTION private.assert_subscription_writable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_has_any boolean;
  v_any_writable boolean;
BEGIN
  IF TG_TABLE_NAME = 'tenant_members' THEN
    SELECT t.subscription_status
      INTO v_status
    FROM public.tenants AS t
    WHERE t.id = NEW.tenant_id;

    IF v_status = 'canceled' THEN
      RAISE EXCEPTION 'subscription-canceled-readonly';
    END IF;

    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_members AS tm
    WHERE tm.user_id = NEW.user_id
  )
  INTO v_has_any;

  -- Sem membership: libera (legado P0; a 0061 troca por quota-tenant-missing).
  IF v_has_any IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT pg_catalog.bool_or(t.subscription_status <> 'canceled')
    INTO v_any_writable
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE tm.user_id = NEW.user_id;

  -- Membership existe e nenhum tenant é gravável: somente-leitura.
  IF v_any_writable IS NOT TRUE THEN
    RAISE EXCEPTION 'subscription-canceled-readonly';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION private.assert_subscription_writable() IS
  'ADR-002/DEBT-50 + C1 (security-debts-49-50): INSERT/UPDATE com membership e NENHUM tenant gravavel -> subscription-canceled-readonly, 0 linhas; ao menos um tenant <> canceled -> libera. tenant_members decide pelo NEW.tenant_id. Sem membership -> libera (legado; 0061 troca por quota-tenant-missing). DELETE permanece permitido.';

REVOKE ALL ON FUNCTION private.assert_subscription_writable()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 3. Triggers (nome ordena ANTES de plan_quota_*) ============
-- Postgres dispara triggers BEFORE de mesmo evento em ordem alfabética de
-- nome. `aa_subscription_readonly` < `accounts_*` < `created_at_*` <
-- `plan_quota_*`: status sempre avaliado primeiro (T6 prova).

DROP TRIGGER IF EXISTS aa_subscription_readonly ON public.transactions;
CREATE TRIGGER aa_subscription_readonly
  BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION private.assert_subscription_writable();

DROP TRIGGER IF EXISTS aa_subscription_readonly ON public.accounts;
CREATE TRIGGER aa_subscription_readonly
  BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION private.assert_subscription_writable();

DROP TRIGGER IF EXISTS aa_subscription_readonly ON public.credit_cards;
CREATE TRIGGER aa_subscription_readonly
  BEFORE INSERT OR UPDATE ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION private.assert_subscription_writable();

DROP TRIGGER IF EXISTS aa_subscription_readonly ON public.budgets;
CREATE TRIGGER aa_subscription_readonly
  BEFORE INSERT OR UPDATE ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION private.assert_subscription_writable();

DROP TRIGGER IF EXISTS aa_subscription_readonly ON public.tenant_members;
CREATE TRIGGER aa_subscription_readonly
  BEFORE INSERT OR UPDATE ON public.tenant_members
  FOR EACH ROW EXECUTE FUNCTION private.assert_subscription_writable();
