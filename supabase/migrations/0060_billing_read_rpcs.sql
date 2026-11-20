-- 0060_billing_read_rpcs.sql — control-plane-billing / F1 / ADR-001 (D3/D6; REQ-29..36).
--
-- Motivo: `0055`–`0059` entregam a verdade (`tenant_subscriptions`), as faturas
-- (`tenant_invoices`), o inbox (`psp_events`) e a porta de escrita. Falta a
-- LEITURA por RPC e o override humano. As tabelas continuam deny-all (RLS sem
-- policy, REVOKE de todo DML); nada aqui abre SELECT direto para cliente.
--
-- Entrega (somente RPC DEFINER; nenhuma policy nova):
--   1) `public.get_my_subscription()` — assinatura do tenant do chamador via
--      `private.resolve_user_tenant(auth.uid())`; 0 linhas sem tenant; sem ids
--      de PSP (§4.5/REQ-29). Plano `free` responde como estado "sem cobranca"
--      (`period_*` nulos, sem trial).
--   2) `public.list_my_invoices(p_limit, p_offset)` — envelope
--      `{items:[...], total:int}` do tenant do chamador; clamp 1..100 e
--      offset >= 0; ordem `competencia DESC, id ASC`; sem ids de PSP
--      (§4.5/REQ-30). Sem tenant => `{items:[],total:0}`.
--   3) `public.admin_get_tenant_billing(p_tenant)` — gate `is_super_admin()`,
--      trilha `admin_audit(action='other', reason='internal_admin_read')` na
--      MESMA chamada (precedente 0042), faturas 50 mais recentes e `usage:null`
--      (§4.5/REQ-31). Este e o unico ponto que expoe o lastro de PSP.
--   4) `public.admin_override_subscription(...)` — override humano com motivo
--      (btrim >= 3, precedente 0028:173), enums fechados, upgrade imediato,
--      downgrade diferido (`pending_plan_*`), `free` sem ciclo e matriz de
--      override (§6.3/REQ-33..36). Alvo fora da matriz NAO levanta: devolve
--      `{outcome:'rejected', reason:'subscription-transition-invalid'}` e grava
--      exatamente 1 linha de auditoria, com 0 UPDATE (§6.2/REQ-35).
--
-- Limpeza obrigatoria em `pago -> free` (SPEC §6.2, adendo): a MESMA instrucao
-- `UPDATE` zera `billing_day`, `period_start` e `period_end`; sem isso a
-- `tenant_subscriptions_plan_cycle_check` aborta com `23514` cru.
--
-- Dinheiro: `amount_cents` da fatura manual vem SEMPRE de `get_plan_price`
-- (bigint cents); nunca do chamador. `p_competencia` e normalizada para o dia 1
-- e o vencimento e `clamp_day(competencia, billing_day)` (§4.7).
--
-- Seguranca (REQ-38): todas as funcoes sao `SECURITY DEFINER`, `SET
-- search_path=''` e chamadas qualificadas (`pg_catalog.`/`public.`/`private.`).
-- `REVOKE ALL` de PUBLIC/anon/authenticated/service_role antes do `GRANT`.
-- `EXECUTE` somente para `authenticated` nas 4 RPCs; o gate `is_super_admin()`
-- decide `not-admin`. Rotulos fixos de §4.6; nenhum id/PII em mensagem.
--
-- Desvio declarado de assinatura: `p_reason` usa `DEFAULT NULL` porque o
-- Postgres recusa parametro sem default apos um com default ("input parameters
-- after one with a default value must also have defaults"). O `NOT NULL` de
-- REQ-33 e semantico: NULL/vazio/curto => `tenant-reason-invalid`, sem escrita.
-- A identidade da funcao (nome e tipos `uuid,text,text,text,date`) e a de §4.5.
--
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetiveis.
-- Migrations 0001–0059 intocadas. Sem cron, sem Worker, sem UI, sem referencia
-- a `invoices` (fatura de cartao do usuario).

-- ============ 1. Assinatura do chamador ============

CREATE OR REPLACE FUNCTION public.get_my_subscription()
RETURNS TABLE (
  plan_slug text,
  status text,
  trial_ends_at timestamptz,
  period_start date,
  period_end date,
  pending_plan_slug text,
  cancel_at_period_end boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant uuid := private.resolve_user_tenant(auth.uid());
BEGIN
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT s.plan_slug,
         s.status,
         s.trial_ends_at,
         s.period_start,
         s.period_end,
         s.pending_plan_slug,
         s.cancel_at_period_end
  FROM public.tenant_subscriptions AS s
  WHERE s.tenant_id = v_tenant;
END;
$$;

COMMENT ON FUNCTION public.get_my_subscription() IS
  'ADR-001 §4.5/REQ-29: assinatura do tenant do chamador (resolve_user_tenant). 0 linhas sem tenant; sem ids de PSP; free sem cobranca.';

REVOKE ALL ON FUNCTION public.get_my_subscription()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_subscription() TO authenticated;

-- ============ 2. Faturas do chamador (envelope paginado) ============

CREATE OR REPLACE FUNCTION public.list_my_invoices(
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant uuid := private.resolve_user_tenant(auth.uid());
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_total int;
  v_items jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'total', 0);
  END IF;

  SELECT count(*) INTO v_total
  FROM public.tenant_invoices AS i
  WHERE i.tenant_id = v_tenant;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.to_jsonb(x)
             ORDER BY x.competencia DESC, x.id ASC
           ),
           '[]'::jsonb
         )
    INTO v_items
  FROM (
    SELECT i.id,
           i.competencia,
           i.period_start,
           i.period_end,
           i.due_date,
           i.amount_cents,
           i.status,
           i.paid_at
    FROM public.tenant_invoices AS i
    WHERE i.tenant_id = v_tenant
    ORDER BY i.competencia DESC, i.id ASC
    LIMIT v_limit OFFSET v_offset
  ) AS x;

  RETURN pg_catalog.jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

COMMENT ON FUNCTION public.list_my_invoices(int, int) IS
  'ADR-001 §4.5/REQ-30: faturas do tenant do chamador em {items,total}; clamp 1..100, offset >= 0; ordem competencia DESC, id ASC; sem ids de PSP.';

REVOKE ALL ON FUNCTION public.list_my_invoices(int, int)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_my_invoices(int, int) TO authenticated;

-- ============ 3. Leitura auditada do operador ============

CREATE OR REPLACE FUNCTION public.admin_get_tenant_billing(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub jsonb;
  v_items jsonb;
  v_total int;
BEGIN
  -- InitPlan: gate avaliado 1x por statement (precedente 0042).
  IF NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tenants AS t WHERE t.id = p_tenant) THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  -- Trilha de leitura auditada (SPEC T07/REQ-31), sem PII.
  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (auth.uid(), p_tenant, p_tenant, 'other', 'internal_admin_read');

  SELECT pg_catalog.to_jsonb(sq)
    INTO v_sub
  FROM (
    SELECT s.plan_slug,
           s.status,
           s.trial_ends_at,
           s.billing_day,
           s.period_start,
           s.period_end,
           s.past_due_since,
           s.pending_plan_slug,
           s.pending_plan_at,
           s.cancel_at_period_end,
           s.psp_subscription_id,
           s.psp_customer_id,
           s.created_at,
           s.updated_at
    FROM public.tenant_subscriptions AS s
    WHERE s.tenant_id = p_tenant
  ) AS sq;

  SELECT count(*) INTO v_total
  FROM public.tenant_invoices AS i
  WHERE i.tenant_id = p_tenant;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.to_jsonb(y)
             ORDER BY y.competencia DESC, y.id ASC
           ),
           '[]'::jsonb
         )
    INTO v_items
  FROM (
    SELECT i.id,
           i.competencia,
           i.period_start,
           i.period_end,
           i.due_date,
           i.amount_cents,
           i.status,
           i.psp_invoice_id,
           i.psp_payment_id,
           i.paid_at,
           i.created_at
    FROM public.tenant_invoices AS i
    WHERE i.tenant_id = p_tenant
    ORDER BY i.competencia DESC, i.id ASC
    LIMIT 50
  ) AS y;

  RETURN pg_catalog.jsonb_build_object(
    'subscription', v_sub,
    'invoices', pg_catalog.jsonb_build_object('items', v_items, 'total', v_total),
    'usage', NULL::jsonb
  );
END;
$$;

COMMENT ON FUNCTION public.admin_get_tenant_billing(uuid) IS
  'ADR-001 §4.5/REQ-31: leitura auditada do operador (gate is_super_admin; trilha internal_admin_read). Lastro de PSP so aqui; 50 faturas mais recentes; usage null (quota e ADR-002).';

REVOKE ALL ON FUNCTION public.admin_get_tenant_billing(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_tenant_billing(uuid) TO authenticated;

-- ============ 4. Override humano ============

CREATE OR REPLACE FUNCTION public.admin_override_subscription(
  p_tenant uuid,
  p_plan text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_competencia date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub public.tenant_subscriptions%ROWTYPE;
  v_reason text := pg_catalog.btrim(COALESCE(p_reason, ''));
  v_plan text := NULLIF(pg_catalog.btrim(COALESCE(p_plan, '')), '');
  v_status text := NULLIF(pg_catalog.btrim(COALESCE(p_status, '')), '');
  v_hoje date := (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_target_plan text;
  v_target_status text;
  v_new_plan text;
  v_new_status text;
  v_new_billing smallint;
  v_new_start date;
  v_new_end date;
  v_new_trial timestamptz;
  v_new_past_due timestamptz;
  v_new_pending_plan text;
  v_new_pending_at date;
  v_old_price bigint;
  v_new_price bigint;
  v_has_period boolean;
  v_from text;
  v_to text;
  v_audit_reason text;
  v_comp date;
  v_period_end date;
  v_last_day int;
  v_due date;
  v_amount bigint;
  v_invoice_id uuid;
BEGIN
  -- 1. Gate, motivo, tenant e assinatura (§6.3 passos 1).
  IF NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF pg_catalog.char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'tenant-reason-invalid';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tenants AS t WHERE t.id = p_tenant) THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  SELECT * INTO v_sub
  FROM public.tenant_subscriptions AS s
  WHERE s.tenant_id = p_tenant
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription-not-found';
  END IF;

  -- 2. Enums fechados (§4.1/§4.2), antes de qualquer escrita.
  IF v_plan IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.plan_catalog AS pc WHERE pc.slug = v_plan
  ) THEN
    RAISE EXCEPTION 'tenant-plan-invalid';
  END IF;

  IF v_status IS NOT NULL
     AND v_status NOT IN ('trial', 'active', 'past_due', 'canceled') THEN
    RAISE EXCEPTION 'tenant-status-invalid';
  END IF;

  v_target_plan := COALESCE(v_plan, v_sub.plan_slug);
  v_target_status := COALESCE(v_status, v_sub.status);

  -- Plano free nao tem aniversario, dunning nem fatura (REQ-05/REQ-10).
  IF v_target_plan = 'free' AND v_sub.status = 'past_due' THEN
    RAISE EXCEPTION 'tenant-status-invalid';
  END IF;
  IF v_target_plan = 'free' AND v_sub.status = 'trial' THEN
    v_target_status := 'active';
  END IF;
  IF v_target_status = 'past_due' AND v_target_plan = 'free' THEN
    RAISE EXCEPTION 'tenant-status-invalid';
  END IF;
  IF v_target_plan = 'free'
     AND v_target_status NOT IN ('active', 'canceled') THEN
    RAISE EXCEPTION 'tenant-status-invalid';
  END IF;

  -- 3. Matriz de override (REQ-35). Invalida => envelope + 1 trilha, 0 UPDATE.
  IF v_target_status IS DISTINCT FROM v_sub.status AND NOT (
       (v_sub.status = 'trial' AND v_target_status IN ('active', 'canceled'))
    OR (v_sub.status = 'active' AND v_target_status = 'past_due')
    OR (v_sub.status = 'past_due' AND v_target_status = 'active')
  ) THEN
    PERFORM private.billing_audit(
      p_tenant, 'subscription-transition-invalid', v_sub.status, NULL
    );
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'rejected',
      'reason', 'subscription-transition-invalid',
      'plan_slug', NULL,
      'status', NULL,
      'invoice_id', NULL
    );
  END IF;

  v_old_price := public.get_plan_price(v_sub.plan_slug);
  v_new_price := public.get_plan_price(v_target_plan);
  v_has_period := (v_sub.period_start IS NOT NULL AND v_sub.period_end IS NOT NULL);

  v_new_plan := v_sub.plan_slug;
  v_new_status := v_target_status;
  v_new_billing := v_sub.billing_day;
  v_new_start := v_sub.period_start;
  v_new_end := v_sub.period_end;
  v_new_trial := v_sub.trial_ends_at;
  v_new_past_due := v_sub.past_due_since;
  v_new_pending_plan := v_sub.pending_plan_slug;
  v_new_pending_at := v_sub.pending_plan_at;

  -- 4. Semantica de plano (REQ-34/D6).
  IF v_target_plan IS DISTINCT FROM v_sub.plan_slug THEN
    IF v_new_price < v_old_price AND v_has_period THEN
      -- Downgrade diferido: entra no roll do ciclo corrente.
      v_new_pending_plan := v_target_plan;
      v_new_pending_at := v_sub.period_end;
    ELSE
      -- Upgrade (ou troca sem ciclo aberto) e imediato.
      v_new_plan := v_target_plan;
      v_new_pending_plan := NULL;
      v_new_pending_at := NULL;
      IF v_target_plan = 'free' THEN
        -- MESMA instrucao UPDATE: zera ciclo e aniversario (sem 23514).
        v_new_billing := NULL;
        v_new_start := NULL;
        v_new_end := NULL;
      ELSIF v_new_billing IS NULL THEN
        v_new_billing := EXTRACT(DAY FROM v_hoje)::smallint;
      END IF;
    END IF;
  END IF;

  -- 5. Efeitos de status (REQ-34/REQ-06).
  IF v_new_status = 'active' THEN
    v_new_trial := NULL;
    v_new_past_due := NULL;
  ELSIF v_new_status = 'past_due' THEN
    v_new_past_due := pg_catalog.now();
  END IF;

  -- 6. Fatura manual: valida ANTES do UPDATE (0 escrita em duplicata/free).
  IF p_competencia IS NOT NULL THEN
    v_comp := pg_catalog.date_trunc('month', p_competencia)::date;
    v_period_end := (v_comp + interval '1 month' - interval '1 day')::date;

    IF EXISTS (
      SELECT 1 FROM public.tenant_invoices AS i
      WHERE i.tenant_id = p_tenant AND i.competencia = v_comp
    ) THEN
      RAISE EXCEPTION 'tenant-invoice-duplicate';
    END IF;

    IF v_new_plan = 'free' THEN
      RAISE EXCEPTION 'tenant-plan-invalid';
    END IF;

    v_amount := public.get_plan_price(v_new_plan);
    IF v_amount IS NULL THEN
      RAISE EXCEPTION 'tenant-plan-invalid';
    END IF;

    v_last_day := EXTRACT(DAY FROM v_period_end)::int;
    v_due := v_comp + (
      LEAST(
        COALESCE(v_new_billing::int, EXTRACT(DAY FROM v_hoje)::int),
        v_last_day
      ) - 1
    );
  END IF;

  v_from := 'plan:' || v_sub.plan_slug || ';status:' || v_sub.status;
  v_to := 'plan:' || v_new_plan || ';status:' || v_new_status;

  -- Motivo humano viaja para a trilha do espelho (REQ-27).
  PERFORM pg_catalog.set_config('app.tenant_reason', v_reason, true);

  -- 7. Uma unica instrucao de UPDATE (ciclo limpo junto com o free).
  UPDATE public.tenant_subscriptions AS s
  SET plan_slug = v_new_plan,
      status = v_new_status,
      billing_day = v_new_billing,
      period_start = v_new_start,
      period_end = v_new_end,
      trial_ends_at = v_new_trial,
      past_due_since = v_new_past_due,
      pending_plan_slug = v_new_pending_plan,
      pending_plan_at = v_new_pending_at
  WHERE s.id = v_sub.id;

  -- 8. Fatura manual (competencia ja normalizada, valor do catalogo).
  IF p_competencia IS NOT NULL THEN
    BEGIN
      INSERT INTO public.tenant_invoices (
        tenant_id, subscription_id, kind, competencia,
        period_start, period_end, due_date, amount_cents, status
      ) VALUES (
        p_tenant, v_sub.id, 'manual', v_comp,
        v_comp, v_period_end, v_due, v_amount, 'open'
      ) RETURNING id INTO v_invoice_id;
    EXCEPTION WHEN unique_violation THEN
      -- TOCTOU defensivo: a pre-checagem acima cobre o caminho serial.
      RAISE EXCEPTION 'tenant-invoice-duplicate';
    END;
  END IF;

  -- 9. Trilha explicita da operacao (prefixo fixo, motivo <= 200).
  v_audit_reason := 'subscription_override:' || pg_catalog.left(
    pg_catalog.regexp_replace(v_reason, '\s+', ' ', 'g'), 200
  );
  PERFORM private.billing_audit(p_tenant, v_audit_reason, v_from, v_to);

  RETURN pg_catalog.jsonb_build_object(
    'outcome', 'applied',
    'reason', NULL,
    'plan_slug', v_new_plan,
    'status', v_new_status,
    'invoice_id', v_invoice_id
  );
END;
$$;

COMMENT ON FUNCTION public.admin_override_subscription(uuid, text, text, text, date) IS
  'ADR-001 §6.3/REQ-33..36: override humano. Gate is_super_admin; motivo btrim>=3 (p_reason DEFAULT NULL por exigencia do Postgres; NOT NULL semantico); upgrade imediato; downgrade diferido; free sem ciclo limpo na mesma instrucao; matriz invalida => outcome rejected + 1 auditoria, 0 UPDATE.';

REVOKE ALL ON FUNCTION public.admin_override_subscription(uuid, text, text, text, date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_override_subscription(uuid, text, text, text, date)
  TO authenticated;
