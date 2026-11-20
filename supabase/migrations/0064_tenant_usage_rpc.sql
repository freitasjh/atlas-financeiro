-- 0064_tenant_usage_rpc.sql — tenant-quota / F3 / ADR-002 (BE-40).
--
-- Motivo: `0061`–`0063` fecham o enforcement, mas o cliente não tem como saber
-- o consumo sem recalcular quota (proibido: RF-QT-06/NFR-01). `plan_limits`
-- segue fechada; `used`/`limit_max` só podem vir de RPC DEFINER.
--
-- Entrega (server-side; nenhuma tabela nova, nenhuma escrita de cliente):
--   1) `public.get_tenant_usage(p_tenant uuid DEFAULT NULL)` — RETURNS TABLE
--      `(resource text, used bigint, limit_max integer)`, `VOLATILE` (grava
--      trilha no caminho operador — lição `0043`: STABLE recusa escrita),
--      `SECURITY DEFINER`, `search_path=''`.
--      • 5 linhas FIXAS nesta ordem: transactions, accounts, credit_cards,
--        budgets, members.
--      • `used`: `count(*)` da tabela viva; `transactions` na MESMA janela do
--        gate (`private.sp_month_start()` — uma definição, dois consumidores).
--      • `limit_max`: de `plan_limits` pelo `tenants.plan_id`; NULL =
--        ilimitado. Plano sem linha ⇒ `plan-limits-missing` (I9).
--      • Autorização (ordem): sem sessão ⇒ `not-authenticated`; `p_tenant`
--        NULL ⇒ tenant GRAVÁVEL do chamador (`private.resolve_writable_tenant`,
--        o MESMO sujeito que o gate de escrita — I-2 do review F3) e, sem
--        tenant, 0 linhas (O-F3-4, precedente `0060`); `p_tenant` explícito ⇒
--        operador (`is_admin`) lê qualquer tenant COM trilha
--        `admin_audit(action='other', reason='internal_admin_read',
--        target_id=tenant_id=p_tenant)` — tenant inexistente ⇒
--        `tenant-not-found` sem trilha; não-operador exige membership
--        (`private.user_tenant_ids`) ⇒ `tenant-not-member` (cobre tenant
--        inexistente, NFR-04).
--      • `REVOKE ALL` antes do `GRANT EXECUTE TO authenticated`; `anon` e
--        `service_role` sem EXECUTE.
--
-- Nenhum valor monetário tocado; `used` é bigint (contagem) e `limit_max`
-- integer (quota). Erros por rótulo fixo, sem PII/id: not-authenticated,
-- tenant-not-found, tenant-not-member, plan-limits-missing.
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0063 e 0077–0081 intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regprocedure('private.resolve_writable_tenant(uuid)') IS NULL
    OR to_regprocedure('private.sp_month_start()') IS NULL
    OR to_regprocedure('private.user_tenant_ids()') IS NULL
    OR to_regprocedure('public.is_admin()') IS NULL
    OR to_regclass('public.plan_limits') IS NULL
    OR to_regclass('public.tenant_members') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_attribute AS a
      WHERE a.attrelid = 'public.plan_limits'::regclass
        AND a.attname = 'max_members'
        AND NOT a.attisdropped
    ) THEN
    RAISE EXCEPTION 'tenant-quota-precondition-missing';
  END IF;
END $$;

-- ============ 1. get_tenant_usage ============

CREATE OR REPLACE FUNCTION public.get_tenant_usage(p_tenant uuid DEFAULT NULL)
RETURNS TABLE (
  resource text,
  used bigint,
  limit_max integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_plan text;
  v_limit_tx integer;
  v_limit_acc integer;
  v_limit_cc integer;
  v_limit_bg integer;
  v_limit_mem integer;
  v_used_tx bigint;
  v_used_acc bigint;
  v_used_cc bigint;
  v_used_bg bigint;
  v_used_mem bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  IF p_tenant IS NULL THEN
    v_tenant := private.resolve_writable_tenant(v_uid);
    IF v_tenant IS NULL THEN
      RETURN;
    END IF;
  ELSIF public.is_admin() THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenants AS t WHERE t.id = p_tenant) THEN
      RAISE EXCEPTION 'tenant-not-found';
    END IF;

    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
    VALUES (v_uid, p_tenant, p_tenant, 'other', 'internal_admin_read');

    v_tenant := p_tenant;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM private.user_tenant_ids() AS u WHERE u = p_tenant
    ) THEN
      RAISE EXCEPTION 'tenant-not-member';
    END IF;
    v_tenant := p_tenant;
  END IF;

  SELECT t.plan_id INTO v_plan
  FROM public.tenants AS t
  WHERE t.id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  SELECT pl.max_transactions_month, pl.max_accounts, pl.max_credit_cards,
         pl.max_budgets, pl.max_members
    INTO v_limit_tx, v_limit_acc, v_limit_cc, v_limit_bg, v_limit_mem
  FROM public.plan_limits AS pl
  WHERE pl.plan_slug = v_plan;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan-limits-missing';
  END IF;

  SELECT count(*) INTO v_used_tx
  FROM public.transactions AS tx
  WHERE tx.tenant_id = v_tenant
    AND tx.created_at >= private.sp_month_start();

  SELECT count(*) INTO v_used_acc
  FROM public.accounts AS acc
  WHERE acc.tenant_id = v_tenant;

  SELECT count(*) INTO v_used_cc
  FROM public.credit_cards AS cc
  WHERE cc.tenant_id = v_tenant;

  SELECT count(*) INTO v_used_bg
  FROM public.budgets AS bg
  WHERE bg.tenant_id = v_tenant;

  SELECT count(*) INTO v_used_mem
  FROM public.tenant_members AS tm
  WHERE tm.tenant_id = v_tenant;

  RETURN QUERY VALUES
    ('transactions'::text, v_used_tx, v_limit_tx),
    ('accounts'::text, v_used_acc, v_limit_acc),
    ('credit_cards'::text, v_used_cc, v_limit_cc),
    ('budgets'::text, v_used_bg, v_limit_bg),
    ('members'::text, v_used_mem, v_limit_mem);
END;
$$;

COMMENT ON FUNCTION public.get_tenant_usage(uuid) IS
  'RF-QT-06/ADR-002 §4.5: consumo do tenant (5 linhas fixas: transactions, accounts, credit_cards, budgets, members). used = count(*) da tabela viva (transactions na janela private.sp_month_start); limit_max de plan_limits (NULL = ilimitado). p_tenant NULL = tenant GRAVAVEL do chamador (resolve_writable_tenant, mesmo sujeito do gate; 0 linhas sem tenant); p_tenant explicito = membership ou operador (trilha internal_admin_read). VOLATILE porque audita.';

REVOKE ALL ON FUNCTION public.get_tenant_usage(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_tenant_usage(uuid) TO authenticated;
