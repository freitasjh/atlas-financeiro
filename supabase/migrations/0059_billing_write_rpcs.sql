-- 0059_billing_write_rpcs.sql — control-plane-billing / F1 / ADR-001 (D3/D4/D6/D7; REQ-07..REQ-24).
--
-- Motivo: `tenant_subscriptions` (0055), `tenant_invoices` (0056) e
-- `psp_events` (0057) existem, mas NAO ha porta de escrita. Sem ela, a matriz
-- evento->transicao (§4.4) nao e aplicada, o ciclo nao abre/avanca, a fatura
-- nao nasce paga e o inbox nao tem dreno idempotente. Esta migration e a unica
-- porta de escrita na fatia (tabelas sem DML de cliente; RLS deny-all).
--
-- Entrega:
--   1) `private.billing_next_cycle_start(date, smallint)` — calendario de §4.7
--      (clamp do dia de aniversario no mes seguinte).
--   2) `private.billing_ensure_invoice(...)` — helper PRIVADO de fatura do ciclo:
--      valor SEMPRE de `get_plan_price`, competencia dia 1, `UNIQUE
--      (tenant_id, competencia)` como idempotencia de emissao e uniques de PSP
--      para idempotencia de pagamento (REQ-12/REQ-13/REQ-20).
--   3) `private.billing_audit(...)` — 1 linha de `admin_audit` com rótulo fixo
--      (actor = auth.uid(); sem id/valor em mensagem).
--   4) `public.apply_psp_event(p_event_id text)` — matriz §4.4 + classificacao
--      de §4.4 + envelope `rejected` (§6.2). Nunca aceita tenant/subscription/
--      amount/valor/status/plano do chamador (REQ-23); tudo vem da linha do
--      inbox.
--   5) `public.expire_subscriptions(p_limit int)` — trial vencido -> canceled,
--      lote clampado 1..100, `FOR UPDATE SKIP LOCKED`, idempotente (REQ-07).
--   6) `public.roll_period(p_subscription uuid)` — avanca UM ciclo somente com
--      lastro (fatura `paid` da competencia encerrada), aplica
--      `pending_plan_slug`, limpa ciclo no `free` e devolve envelope de borda
--      (REQ-08; `period-not-paid` sem lastro). Nao cria fatura nem cancela.
--
-- Invariantes:
--   - Nenhuma transicao invalida escreve estado: §6.2 (0 UPDATE + 1 auditoria
--     + `process_outcome='rejected'`), porque RAISE desfaria a auditoria.
--   - Colisao de chave de PSP: lock consultivo (transacao) por chave ANTES da
--     pre-checagem e fatura emitida ANTES da escrita de estado, de modo que
--     `rejected/psp-key-conflict` deixa a assinatura intacta (sem promocao e
--     sem ciclo aberto), mesmo com o evento concorrente commitando no meio.
--   - Estorno nunca e resolvido por `competencia`: primeiro `psp_payment_id`,
--     depois `psp_invoice_id`; ids apontando para faturas diferentes => `noop`
--     auditado e ZERO UPDATE.
--   - Dinheiro nunca vem do payload: `payload.payment.value` e apenas comparado
--     (D7/ADR-003) e divergencia vai para `admin_audit`; `amount_cents` continua
--     vindo de `get_plan_price`.
--   - `past_due_since` so e escrito na aresta `active + payment_overdue` e
--     limpo em `-> active` (REQ-06/I12).
--   - Nenhuma funcao aceita PII; rotulos fixos de §4.6.
--
-- Seguranca (REQ-38): todas as funcoes sao `SECURITY DEFINER`, `SET
-- search_path=''` e chamadas qualificadas (`pg_catalog.`/`public.`/`private.`).
-- `REVOKE ALL` de PUBLIC/anon/authenticated/service_role antes do GRANT.
-- `apply_psp_event`/`roll_period`: somente `service_role`;
-- `expire_subscriptions`: somente `service_role` (o chamador de cliente gravava
-- `actor_id` de tenant e devolvia contagem global — O-F1-1 encerrado).
--
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetiveis.
-- Migrations 0001–0058 intocadas. Sem cron, sem Worker, sem UI, sem referencia
-- a `invoices` (fatura de cartao do usuario).

-- ============ 1. Calendario de §4.7 ============

CREATE OR REPLACE FUNCTION private.billing_next_cycle_start(
  p_anchor date,
  p_day smallint
)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_first date := (pg_catalog.date_trunc('month', p_anchor)::date + interval '1 month')::date;
  v_last date := (v_first + interval '1 month' - interval '1 day')::date;
BEGIN
  RETURN v_first + (LEAST(p_day::int, EXTRACT(DAY FROM v_last)::int) - 1);
END;
$$;

COMMENT ON FUNCTION private.billing_next_cycle_start(date, smallint) IS
  'ADR-001 §4.7: proximo inicio de ciclo = dia de aniversario clampado no mes seguinte.';

REVOKE ALL ON FUNCTION private.billing_next_cycle_start(date, smallint)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 2. Auditoria de sistema (rótulo fixo, sem PII) ============

CREATE OR REPLACE FUNCTION private.billing_audit(
  p_tenant uuid,
  p_reason text,
  p_from text,
  p_to text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.admin_audit (
    actor_id, target_id, tenant_id, action, from_value, to_value, reason
  ) VALUES (
    auth.uid(), p_tenant, p_tenant, 'other', p_from, p_to, p_reason
  );
END;
$$;

COMMENT ON FUNCTION private.billing_audit(uuid, text, text, text) IS
  'Trilha de sistema de billing: action=other, target/tenant = tenant, rótulo fixo; from_value/to_value só com valor monetário do payload e o valor calculado (§4.6/§6.1 item 8). Nunca interpola id ou PII.';

REVOKE ALL ON FUNCTION private.billing_audit(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 3. Helper privado de fatura do ciclo ============
-- Retorno: {outcome: applied|duplicate|noop|invalid|skip, invoice_id, amount_cents}
--   - applied   : fatura criada ou regularizada para `paid`/`overdue`.
--   - duplicate : fatura `paid` ja tinha o MESMO `psp_payment_id` (T19).
--   - noop      : fatura existente nao mudou (pagamento repetido/terminal).
--   - invalid   : fatura terminal (`canceled`/`refunded`) impediu o pagamento.
--   - skip      : plano `free` nao tem fatura.
-- O valor NUNCA vem do chamador: `get_plan_price(p_plan)`.

CREATE OR REPLACE FUNCTION private.billing_ensure_invoice(
  p_subscription uuid,
  p_tenant uuid,
  p_plan text,
  p_period_start date,
  p_period_end date,
  p_mark_paid boolean,
  p_psp_invoice_id text,
  p_psp_payment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_competencia date := pg_catalog.date_trunc('month', p_period_start)::date;
  v_id uuid;
  v_status text;
  v_psp_payment text;
  v_amount bigint;
BEGIN
  IF p_plan = 'free' THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'skip', 'invoice_id', NULL::uuid, 'amount_cents', NULL::bigint
    );
  END IF;

  -- Idempotencia de pagamento: mesmo `psp_payment_id` nunca gera 2a fatura.
  -- Filtro por tenant: um id de PSP de outro tenant nunca e tocado aqui.
  IF p_psp_payment_id IS NOT NULL THEN
    SELECT i.id, i.status, i.psp_payment_id, i.amount_cents
      INTO v_id, v_status, v_psp_payment, v_amount
    FROM public.tenant_invoices AS i
    WHERE i.tenant_id = p_tenant
      AND i.psp_payment_id = p_psp_payment_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_status = 'paid' THEN
        RETURN pg_catalog.jsonb_build_object(
          'outcome', 'duplicate', 'invoice_id', v_id, 'amount_cents', v_amount
        );
      ELSIF v_status IN ('open', 'overdue') AND p_mark_paid THEN
        UPDATE public.tenant_invoices
        SET status = 'paid',
            paid_at = pg_catalog.now(),
            psp_invoice_id = COALESCE(psp_invoice_id, p_psp_invoice_id)
        WHERE id = v_id;
        RETURN pg_catalog.jsonb_build_object(
          'outcome', 'applied', 'invoice_id', v_id, 'amount_cents', v_amount
        );
      ELSE
        RETURN pg_catalog.jsonb_build_object(
          'outcome', 'noop', 'invoice_id', v_id, 'amount_cents', v_amount
        );
      END IF;
    END IF;
  END IF;

  -- Fatura do ciclo: a existencia nesta competencia (de qualquer `kind`) e a
  -- fatura do ciclo (UNIQUE tenant_id+competencia).
  SELECT i.id, i.status, i.psp_payment_id, i.amount_cents
    INTO v_id, v_status, v_psp_payment, v_amount
  FROM public.tenant_invoices AS i
  WHERE i.tenant_id = p_tenant
    AND i.competencia = v_competencia
  FOR UPDATE;

  IF NOT FOUND THEN
    v_amount := public.get_plan_price(p_plan);
    BEGIN
      INSERT INTO public.tenant_invoices (
        tenant_id, subscription_id, kind, competencia, period_start, period_end,
        due_date, amount_cents, status, paid_at, psp_invoice_id, psp_payment_id
      ) VALUES (
        p_tenant, p_subscription, 'cycle', v_competencia, p_period_start, p_period_end,
        p_period_start, v_amount,
        CASE WHEN p_mark_paid THEN 'paid' ELSE 'open' END,
        CASE WHEN p_mark_paid THEN pg_catalog.now() ELSE NULL END,
        p_psp_invoice_id, p_psp_payment_id
      ) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      -- Defesa em profundidade (TOCTOU): a chave de PSP pertence a outro tenant.
      -- Nunca deixa o `23505` cru escapar; o chamador audita e marca o evento.
      RETURN pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'reason', 'psp-key-conflict',
        'invoice_id', NULL::uuid,
        'amount_cents', NULL::bigint
      );
    END;

    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'applied', 'invoice_id', v_id, 'amount_cents', v_amount
    );
  END IF;

  IF v_status = 'paid' THEN
    IF p_psp_payment_id IS NOT NULL
       AND v_psp_payment IS NOT DISTINCT FROM p_psp_payment_id THEN
      RETURN pg_catalog.jsonb_build_object(
        'outcome', 'duplicate', 'invoice_id', v_id, 'amount_cents', v_amount
      );
    END IF;
    -- Segunda cobranca do mesmo ciclo: nao cria outra, nao reescreve valor.
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'noop', 'invoice_id', v_id, 'amount_cents', v_amount
    );
  END IF;

  IF p_mark_paid AND v_status IN ('open', 'overdue') THEN
    UPDATE public.tenant_invoices
    SET status = 'paid',
        paid_at = pg_catalog.now(),
        psp_invoice_id = COALESCE(psp_invoice_id, p_psp_invoice_id),
        psp_payment_id = COALESCE(psp_payment_id, p_psp_payment_id)
    WHERE id = v_id;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'applied', 'invoice_id', v_id, 'amount_cents', v_amount
    );
  END IF;

  IF p_mark_paid AND v_status IN ('canceled', 'refunded') THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'invalid', 'invoice_id', v_id, 'amount_cents', v_amount
    );
  END IF;

  IF NOT p_mark_paid AND v_status = 'open' THEN
    UPDATE public.tenant_invoices SET status = 'overdue' WHERE id = v_id;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'applied', 'invoice_id', v_id, 'amount_cents', v_amount
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'outcome', 'noop', 'invoice_id', v_id, 'amount_cents', v_amount
  );
END;
$$;

COMMENT ON FUNCTION private.billing_ensure_invoice(uuid, uuid, text, date, date, boolean, text, text) IS
  'Fatura do ciclo: valor de get_plan_price, competencia dia 1, idempotencia por tenant+competencia e por psp_payment_id. Nunca escreve valor do payload.';

REVOKE ALL ON FUNCTION private.billing_ensure_invoice(
  uuid, uuid, text, date, date, boolean, text, text
) FROM PUBLIC, anon, authenticated, service_role;

-- ============ 4. apply_psp_event ============

CREATE OR REPLACE FUNCTION public.apply_psp_event(p_event_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.psp_events%ROWTYPE;
  v_sub public.tenant_subscriptions%ROWTYPE;
  v_found boolean := false;
  v_kind text;
  v_hoje date := (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_customer text;
  v_customer_count int;
  v_billing smallint;
  v_old_status text;
  v_new_status text;
  v_new_trial timestamptz;
  v_new_past timestamptz;
  v_new_start date;
  v_new_end date;
  v_new_psp text;
  v_new_cancel boolean;
  v_new_plan text;
  v_new_billing smallint;
  v_new_pending text;
  v_new_pending_at date;
  v_psp_owner uuid;
  v_norm text;
  v_frac text;
  v_dot int;
  v_sign int := 1;
  v_do_update boolean := false;
  v_need_invoice boolean := false;
  v_audit_invalid boolean := false;
  v_outcome text := 'applied';
  v_transition text;
  v_invoice_id uuid;
  v_invoice_amount bigint;
  v_inv jsonb;
  v_tmp_invoice uuid;
  v_tmp_status text;
  v_pay_invoice uuid;
  v_pay_status text;
  v_inv_invoice uuid;
  v_inv_status text;
  v_cycles int;
  v_raw_value text;
  v_raw_int bigint;
  v_value_cents bigint;
BEGIN
  -- §6.1 (1): trava a linha do inbox. Erros pré-escrita continuam por RAISE.
  SELECT * INTO v_event
  FROM public.psp_events
  WHERE event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'psp-event-not-found';
  END IF;
  IF v_event.processed_at IS NOT NULL THEN
    RAISE EXCEPTION 'psp-event-already-processed';
  END IF;
  IF v_event.provider IS DISTINCT FROM 'asaas' THEN
    RAISE EXCEPTION 'psp-event-invalid';
  END IF;

  -- §6.1 (2) + §4.4: classificacao fechada por `event_type`.
  v_kind := CASE
    WHEN v_event.event_type IN ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') THEN 'payment_confirmed'
    WHEN v_event.event_type = 'PAYMENT_OVERDUE' THEN 'payment_overdue'
    WHEN v_event.event_type IN ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED') THEN 'payment_refunded'
    WHEN v_event.event_type IN ('SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED') THEN 'subscription_canceled'
    ELSE 'unmapped'
  END;

  IF v_kind = 'unmapped' THEN
    UPDATE public.psp_events
    SET event_kind = 'unmapped',
        processed_at = pg_catalog.now(),
        process_outcome = 'noop'
    WHERE id = v_event.id;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'noop', 'transition', NULL, 'invoice_id', NULL
    );
  END IF;

  -- §6.1 (3): resolucao da assinatura (id do PSP -> fatura -> customer).
  IF v_event.psp_subscription_id IS NOT NULL THEN
    SELECT * INTO v_sub
    FROM public.tenant_subscriptions
    WHERE psp_subscription_id = v_event.psp_subscription_id
    FOR UPDATE;
    v_found := FOUND;
  END IF;

  -- Prioridade fixa: `psp_payment_id` e a identidade do pagamento; o
  -- `psp_invoice_id` so entra quando o payment nao casa. `competencia` NUNCA
  -- desempata (SPEC §4.4) — ids cruzados sao tratados na resolucao da fatura.
  IF NOT v_found AND v_kind IN ('payment_refunded', 'payment_overdue') THEN
    IF v_event.psp_payment_id IS NOT NULL THEN
      SELECT s.* INTO v_sub
      FROM public.tenant_invoices AS i
      JOIN public.tenant_subscriptions AS s ON s.id = i.subscription_id
      WHERE i.tenant_id = s.tenant_id
        AND i.psp_payment_id = v_event.psp_payment_id
      ORDER BY i.id ASC
      LIMIT 1
      FOR UPDATE OF s;
      v_found := FOUND;
    END IF;

    IF NOT v_found AND v_event.psp_invoice_id IS NOT NULL THEN
      SELECT s.* INTO v_sub
      FROM public.tenant_invoices AS i
      JOIN public.tenant_subscriptions AS s ON s.id = i.subscription_id
      WHERE i.tenant_id = s.tenant_id
        AND i.psp_invoice_id = v_event.psp_invoice_id
      ORDER BY i.id ASC
      LIMIT 1
      FOR UPDATE OF s;
      v_found := FOUND;
    END IF;
  END IF;

  IF NOT v_found AND v_kind = 'payment_confirmed' THEN
    v_customer := COALESCE(
      v_event.payload->'payment'->>'customer',
      v_event.payload->'subscription'->>'customer'
    );
    IF v_customer IS NOT NULL THEN
      SELECT count(*) INTO v_customer_count
      FROM public.tenant_subscriptions
      WHERE psp_customer_id = v_customer;
      IF v_customer_count = 1 THEN
        SELECT * INTO v_sub
        FROM public.tenant_subscriptions
        WHERE psp_customer_id = v_customer
        FOR UPDATE;
        v_found := true;
      END IF;
    END IF;
  END IF;

  IF NOT v_found THEN
    RAISE EXCEPTION 'subscription-not-found';
  END IF;

  -- §6.1 (4): lastro do pagamento.
  IF v_kind = 'payment_confirmed' AND v_event.psp_payment_id IS NULL THEN
    RAISE EXCEPTION 'psp-event-invalid';
  END IF;

  -- §6.1 (4a): serializacao por chave de PSP (TOCTOU). A fatura concorrente so
  -- e visivel depois do COMMIT do outro evento; sem o lock, a pre-checagem de
  -- 4b roda em snapshot antigo e o `23505` so apareceria no INSERT — tarde,
  -- com a assinatura ja promovida. O lock consultivo de transacao ordena
  -- sempre payment antes de invoice (evita deadlock entre ids cruzados).
  IF v_kind = 'payment_confirmed' THEN
    IF v_event.psp_payment_id IS NOT NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('psp-payment:' || v_event.psp_payment_id, 0)
      );
    END IF;
    IF v_event.psp_invoice_id IS NOT NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('psp-invoice:' || v_event.psp_invoice_id, 0)
      );
    END IF;
  END IF;

  -- §6.1 (4b): chave de PSP e global. Se o id do evento ja pertence a fatura
  -- de OUTRO tenant, nao ha escrita: auditoria + `rejected` + attempts avanca.
  IF v_kind = 'payment_confirmed'
     AND (v_event.psp_payment_id IS NOT NULL OR v_event.psp_invoice_id IS NOT NULL) THEN
    SELECT i.tenant_id INTO v_psp_owner
    FROM public.tenant_invoices AS i
    WHERE (v_event.psp_payment_id IS NOT NULL AND i.psp_payment_id = v_event.psp_payment_id)
       OR (v_event.psp_invoice_id IS NOT NULL AND i.psp_invoice_id = v_event.psp_invoice_id)
    ORDER BY i.id ASC
    LIMIT 1;

    IF FOUND AND v_psp_owner IS DISTINCT FROM v_sub.tenant_id THEN
      PERFORM private.billing_audit(
        v_sub.tenant_id, 'psp-key-conflict', NULL, NULL
      );
      UPDATE public.psp_events
      SET event_kind = v_kind,
          attempts = LEAST(attempts + 1, 10),
          processed_at = pg_catalog.now(),
          process_outcome = 'rejected'
      WHERE id = v_event.id;
      RETURN pg_catalog.jsonb_build_object(
        'outcome', 'rejected', 'transition', NULL, 'invoice_id', NULL,
        'reason', 'psp-key-conflict'
      );
    END IF;
  END IF;

  -- §6.1 (5): plano free nunca abre ciclo nem aceita payment_*.
  IF v_sub.plan_slug = 'free'
     AND v_kind IN ('payment_confirmed', 'payment_overdue', 'payment_refunded') THEN
    PERFORM private.billing_audit(
      v_sub.tenant_id, 'subscription-transition-invalid', v_sub.status, NULL
    );
    UPDATE public.psp_events
    SET event_kind = v_kind,
        processed_at = pg_catalog.now(),
        process_outcome = 'rejected'
    WHERE id = v_event.id;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'rejected', 'transition', NULL, 'invoice_id', NULL
    );
  END IF;

  -- Estado de trabalho (nenhuma escrita antes de decidir a matriz).
  v_old_status := v_sub.status;
  v_new_status := v_sub.status;
  v_new_trial := v_sub.trial_ends_at;
  v_new_past := v_sub.past_due_since;
  v_new_start := v_sub.period_start;
  v_new_end := v_sub.period_end;
  v_new_psp := v_sub.psp_subscription_id;
  v_new_cancel := v_sub.cancel_at_period_end;
  v_billing := COALESCE(
    v_sub.billing_day,
    EXTRACT(DAY FROM (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date)::smallint
  );
  v_new_plan := v_sub.plan_slug;
  v_new_billing := v_sub.billing_day;
  v_new_pending := v_sub.pending_plan_slug;
  v_new_pending_at := v_sub.pending_plan_at;

  -- §4.4: matriz fechada. Par nao listado => invalido (§6.2).
  IF v_kind = 'subscription_canceled' THEN
    -- Linha 10: qualquer estado -> apenas a marca de intencao.
    IF v_sub.cancel_at_period_end THEN
      v_outcome := 'noop';
    ELSE
      v_new_cancel := true;
      v_do_update := true;
      v_outcome := 'applied';
    END IF;

  ELSIF v_kind = 'payment_overdue' THEN
    IF v_sub.status = 'active' THEN
      -- Linha 5.
      v_new_status := 'past_due';
      v_new_past := pg_catalog.now();
      v_do_update := true;

      SELECT i.id INTO v_tmp_invoice
      FROM public.tenant_invoices AS i
      WHERE i.subscription_id = v_sub.id
        AND i.status = 'open'
      ORDER BY i.competencia DESC, i.id ASC
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN
        UPDATE public.tenant_invoices SET status = 'overdue' WHERE id = v_tmp_invoice;
        v_invoice_id := v_tmp_invoice;
      END IF;
      v_outcome := 'applied';
    ELSIF v_sub.status = 'past_due' THEN
      -- Linha 6: nao reinicia past_due_since; so registra o evento.
      v_outcome := 'noop';
    ELSIF v_sub.status = 'trial' THEN
      -- Linha 11.
      v_outcome := 'noop';
    ELSE
      v_audit_invalid := true;
    END IF;

  ELSIF v_kind = 'payment_refunded' THEN
    IF v_sub.status = 'active' THEN
      -- Linha 9: status nao muda; so a fatura DO EVENTO vira `refunded`.
      -- Resolucao por `psp_payment_id` e, sem match, por `psp_invoice_id` —
      -- `competencia` NUNCA desempata (SPEC §4.4). Os dois ids apontando para
      -- faturas DIFERENTES => noop auditado: estorno por adivinhacao e proibido.
      v_tmp_invoice := NULL;
      v_tmp_status := NULL;
      v_pay_invoice := NULL;
      v_pay_status := NULL;
      v_inv_invoice := NULL;
      v_inv_status := NULL;

      IF v_event.psp_payment_id IS NOT NULL THEN
        SELECT i.id, i.status INTO v_pay_invoice, v_pay_status
        FROM public.tenant_invoices AS i
        WHERE i.tenant_id = v_sub.tenant_id
          AND i.psp_payment_id = v_event.psp_payment_id
        FOR UPDATE;
      END IF;

      IF v_event.psp_invoice_id IS NOT NULL THEN
        SELECT i.id, i.status INTO v_inv_invoice, v_inv_status
        FROM public.tenant_invoices AS i
        WHERE i.tenant_id = v_sub.tenant_id
          AND i.psp_invoice_id = v_event.psp_invoice_id
        FOR UPDATE;
      END IF;

      IF v_pay_invoice IS NOT NULL
         AND v_inv_invoice IS NOT NULL
         AND v_pay_invoice IS DISTINCT FROM v_inv_invoice THEN
        PERFORM private.billing_audit(
          v_sub.tenant_id, 'psp:refund_invoice_not_found', NULL, NULL
        );
        v_invoice_id := NULL;
        v_outcome := 'noop';
      ELSE
        IF v_pay_invoice IS NOT NULL THEN
          v_tmp_invoice := v_pay_invoice;
          v_tmp_status := v_pay_status;
        ELSIF v_inv_invoice IS NOT NULL THEN
          v_tmp_invoice := v_inv_invoice;
          v_tmp_status := v_inv_status;
        END IF;

        IF v_tmp_invoice IS NULL THEN
          PERFORM private.billing_audit(
            v_sub.tenant_id, 'psp:refund_invoice_not_found', NULL, NULL
          );
          v_outcome := 'noop';
        ELSIF v_tmp_status = 'paid' THEN
          UPDATE public.tenant_invoices SET status = 'refunded' WHERE id = v_tmp_invoice;
          v_invoice_id := v_tmp_invoice;
          v_outcome := 'applied';
        ELSIF v_tmp_status IN ('open', 'overdue') THEN
          PERFORM private.billing_audit(
            v_sub.tenant_id, 'tenant-invoice-transition-invalid', v_tmp_status, NULL
          );
          v_invoice_id := v_tmp_invoice;
          v_outcome := 'noop';
        ELSE
          v_invoice_id := v_tmp_invoice;
          v_outcome := 'noop';
        END IF;
      END IF;
    ELSIF v_sub.status = 'trial' THEN
      -- Linha 11.
      v_outcome := 'noop';
    ELSE
      v_audit_invalid := true;
    END IF;

  ELSIF v_kind = 'payment_confirmed' THEN
    IF v_sub.status = 'trial' THEN
      -- Linha 1: ativa, limpa trial e abre o primeiro ciclo em hoje.
      v_new_status := 'active';
      v_new_trial := NULL;
      v_new_start := v_hoje;
      v_new_end := private.billing_next_cycle_start(v_hoje, v_billing) - 1;
      v_do_update := true;
      v_need_invoice := true;
      v_outcome := 'applied';

    ELSIF v_sub.status = 'active' THEN
      -- Linha 2: renovacao ao ciclo que contem hoje (sem avanco duplo).
      -- Pendente vencido no ciclo antigo e aplicado ANTES de emitir a fatura
      -- (D6): o ciclo novo cobra o plano novo, nunca o antigo.
      IF v_sub.pending_plan_slug IS NOT NULL
         AND v_sub.pending_plan_at IS NOT NULL
         AND v_sub.period_end IS NOT NULL
         AND v_sub.period_end < v_hoje
         AND v_sub.pending_plan_at <= v_sub.period_end THEN
        v_new_plan := v_sub.pending_plan_slug;
        v_new_pending := NULL;
        v_new_pending_at := NULL;
      END IF;

      IF v_new_plan = 'free' THEN
        -- `free` nao tem aniversario nem ciclo; regulariza sem fatura.
        v_new_start := NULL;
        v_new_end := NULL;
        v_new_billing := NULL;
        v_do_update := true;
        v_outcome := 'applied';
      ELSE
        IF v_sub.period_start IS NULL THEN
          v_new_start := v_hoje;
          v_new_end := private.billing_next_cycle_start(v_hoje, v_billing) - 1;
        ELSE
          v_new_start := v_sub.period_start;
          v_new_end := v_sub.period_end;
          v_cycles := 0;
          WHILE v_new_end < v_hoje LOOP
            v_cycles := v_cycles + 1;
            IF v_cycles > 120 THEN
              v_audit_invalid := true;
              EXIT;
            END IF;
            v_new_start := private.billing_next_cycle_start(v_new_start, v_billing);
            v_new_end := private.billing_next_cycle_start(v_new_start, v_billing) - 1;
          END LOOP;
        END IF;

        IF NOT v_audit_invalid THEN
          v_do_update := (
            v_new_start IS DISTINCT FROM v_sub.period_start
            OR v_new_end IS DISTINCT FROM v_sub.period_end
            OR v_new_plan IS DISTINCT FROM v_sub.plan_slug
          );
          v_need_invoice := true;
          v_outcome := 'applied';
        END IF;
      END IF;

    ELSIF v_sub.status = 'past_due' THEN
      -- Linha 3: reactivacao limpa a carencia e paga a fatura em aberto.
      v_new_status := 'active';
      v_new_past := NULL;
      IF v_sub.period_start IS NULL THEN
        v_new_start := v_hoje;
        v_new_end := private.billing_next_cycle_start(v_hoje, v_billing) - 1;
      END IF;
      v_do_update := true;
      v_need_invoice := true;
      v_outcome := 'applied';

    ELSIF v_sub.status = 'canceled' THEN
      -- Linha 7 (id novo via customer) x linha 8 (mesmo id => invalida).
      IF v_event.psp_subscription_id IS NULL
         OR v_event.psp_subscription_id IS NOT DISTINCT FROM v_sub.psp_subscription_id THEN
        v_audit_invalid := true;
      ELSE
        v_new_status := 'active';
        v_new_trial := NULL;
        v_new_past := NULL;
        v_new_cancel := false;
        v_new_psp := v_event.psp_subscription_id;
        v_new_start := v_hoje;
        v_new_end := private.billing_next_cycle_start(v_hoje, v_billing) - 1;
        v_do_update := true;
        v_need_invoice := true;
        v_outcome := 'applied';
      END IF;
    ELSE
      v_audit_invalid := true;
    END IF;

  ELSE
    -- `internal_*` nunca chega pelo inbox; qualquer outro par e invalido.
    v_audit_invalid := true;
  END IF;

  -- §6.2: transicao invalida = 0 UPDATE de estado + 1 auditoria + terminal.
  IF v_audit_invalid THEN
    PERFORM private.billing_audit(
      v_sub.tenant_id, 'subscription-transition-invalid', v_sub.status, NULL
    );
    UPDATE public.psp_events
    SET event_kind = v_kind,
        processed_at = pg_catalog.now(),
        process_outcome = 'rejected'
    WHERE id = v_event.id;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'rejected', 'transition', NULL, 'invoice_id', NULL
    );
  END IF;

  -- §6.1 (7a): fatura do ciclo ANTES da escrita de estado. Se a chave de PSP
  -- colidir, o evento sai `rejected` sem nenhuma promocao de assinatura — a
  -- escrita de estado nunca sobrevive a um conflito (TOCTOU de §6.1 4a/4b).
  IF v_need_invoice THEN
    v_inv := private.billing_ensure_invoice(
      v_sub.id, v_sub.tenant_id, v_new_plan,
      v_new_start, v_new_end, true,
      v_event.psp_invoice_id, v_event.psp_payment_id
    );

    IF v_inv->>'outcome' = 'conflict' THEN
      PERFORM private.billing_audit(
        v_sub.tenant_id, 'psp-key-conflict', NULL, NULL
      );
      UPDATE public.psp_events
      SET event_kind = v_kind,
          attempts = LEAST(attempts + 1, 10),
          processed_at = pg_catalog.now(),
          process_outcome = 'rejected'
      WHERE id = v_event.id;
      RETURN pg_catalog.jsonb_build_object(
        'outcome', 'rejected', 'transition', NULL, 'invoice_id', NULL,
        'reason', 'psp-key-conflict'
      );
    END IF;

    v_invoice_id := (v_inv->>'invoice_id')::uuid;
    v_invoice_amount := (v_inv->>'amount_cents')::bigint;

    IF v_inv->>'outcome' = 'duplicate' THEN
      v_outcome := CASE WHEN v_do_update THEN 'applied' ELSE 'duplicate' END;
    ELSIF v_inv->>'outcome' = 'invalid' THEN
      PERFORM private.billing_audit(
        v_sub.tenant_id, 'tenant-invoice-transition-invalid', v_sub.status, NULL
      );
      v_outcome := CASE WHEN v_do_update THEN 'applied' ELSE 'noop' END;
    ELSIF v_inv->>'outcome' = 'noop' THEN
      IF NOT v_do_update THEN
        v_outcome := 'noop';
      END IF;
    ELSE
      v_outcome := 'applied';
    END IF;

    -- §6.1 (8): divergencia de valor (ADR-003 D7). O payload so e comparado:
    -- `value` em BRL (Asaas) ou cents sao aceitos na comparacao; nada e escrito.
    -- Sem tipo `numeric`/float em RPC de dinheiro: conversao por texto + bigint.
    -- Normaliza `,`->`.`, aceita sinal e NUNCA descarta formato em silencio:
    -- expoente/3+ casas viram trilha `psp-amount-uncomparable`.
    v_raw_value := COALESCE(
      v_event.payload->'payment'->>'value',
      v_event.payload->>'value'
    );
    IF v_invoice_amount IS NOT NULL AND v_raw_value IS NOT NULL THEN
      v_norm := replace(pg_catalog.btrim(v_raw_value), ',', '.');
      v_sign := 1;
      IF left(v_norm, 1) = '-' THEN
        v_sign := -1;
        v_norm := substr(v_norm, 2);
      ELSIF left(v_norm, 1) = '+' THEN
        v_norm := substr(v_norm, 2);
      END IF;

      IF char_length(v_norm) BETWEEN 1 AND 15
         AND v_norm ~ '^[0-9]+(\.[0-9]+)?$' THEN
        v_dot := position('.' IN v_norm);
        IF v_dot = 0 THEN
          -- Inteiro: pode vir em reais ou em cents; ambas as leituras valem.
          v_raw_int := v_norm::bigint * v_sign;
          IF v_raw_int <> v_invoice_amount
             AND v_raw_int * 100 <> v_invoice_amount THEN
            PERFORM private.billing_audit(
              v_sub.tenant_id, 'psp-amount-divergence',
              v_raw_value, v_invoice_amount::text
            );
          END IF;
        ELSE
          v_frac := split_part(v_norm, '.', 2);
          IF char_length(v_frac) > 2 THEN
            -- `19.999` nao e 19.99: truncar seria adivinhar dinheiro.
            PERFORM private.billing_audit(
              v_sub.tenant_id, 'psp-amount-uncomparable',
              v_raw_value, v_invoice_amount::text
            );
          ELSE
            v_value_cents := v_sign * (
              split_part(v_norm, '.', 1)::bigint * 100
              + left(rpad(v_frac, 2, '0'), 2)::bigint
            );
            IF v_value_cents <> v_invoice_amount THEN
              PERFORM private.billing_audit(
                v_sub.tenant_id, 'psp-amount-divergence',
                v_raw_value, v_invoice_amount::text
              );
            END IF;
          END IF;
        END IF;
      ELSE
        -- Formato nao monetario (expoente, vazio, lixo): auditado, nunca ignorado.
        PERFORM private.billing_audit(
          v_sub.tenant_id, 'psp-amount-uncomparable',
          v_raw_value, v_invoice_amount::text
        );
      END IF;
    END IF;
  END IF;

  -- §6.1 (7b): escrita da verdade (uma instrucao). O espelho (0058) deriva
  -- tenants.* na mesma transacao com reason='psp:<kind>'.
  IF v_do_update THEN
    PERFORM pg_catalog.set_config('app.tenant_reason', 'psp:' || v_kind, true);
    UPDATE public.tenant_subscriptions
    SET plan_slug = v_new_plan,
        billing_day = v_new_billing,
        status = v_new_status,
        trial_ends_at = v_new_trial,
        past_due_since = v_new_past,
        period_start = v_new_start,
        period_end = v_new_end,
        psp_subscription_id = v_new_psp,
        cancel_at_period_end = v_new_cancel,
        pending_plan_slug = v_new_pending,
        pending_plan_at = v_new_pending_at
    WHERE id = v_sub.id;

    IF v_new_status IS DISTINCT FROM v_old_status THEN
      v_transition := v_old_status || '->' || v_new_status;
    END IF;

    -- Troca de plano por pendente aplicado na renovacao: trilha propria.
    IF v_new_plan IS DISTINCT FROM v_sub.plan_slug THEN
      PERFORM private.billing_audit(
        v_sub.tenant_id, 'psp:pending_plan_applied', v_sub.plan_slug, v_new_plan
      );
    END IF;
  END IF;

  -- §6.1 (9): terminal do inbox + envelope.
  UPDATE public.psp_events
  SET event_kind = v_kind,
      processed_at = pg_catalog.now(),
      process_outcome = v_outcome
  WHERE id = v_event.id;

  RETURN pg_catalog.jsonb_build_object(
    'outcome', v_outcome,
    'transition', v_transition,
    'invoice_id', v_invoice_id
  );
END;
$$;

COMMENT ON FUNCTION public.apply_psp_event(text) IS
  'ADR-001 §6.1: aplica a matriz evento->transicao a partir do inbox. Idempotente por event_id. Transicao invalida => envelope rejected + 1 auditoria, 0 UPDATE. Aceita apenas o id do evento.';

REVOKE ALL ON FUNCTION public.apply_psp_event(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_psp_event(text) TO service_role;

-- ============ 5. expire_subscriptions ============

CREATE OR REPLACE FUNCTION public.expire_subscriptions(p_limit int DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
  v_rec record;
  v_count int := 0;
BEGIN
  PERFORM pg_catalog.set_config('app.tenant_reason', 'psp:internal_trial_expired', true);

  FOR v_rec IN
    SELECT s.id
    FROM public.tenant_subscriptions AS s
    WHERE s.status = 'trial'
      AND s.trial_ends_at < pg_catalog.now()
    ORDER BY s.trial_ends_at, s.id
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  LOOP
    UPDATE public.tenant_subscriptions
    SET status = 'canceled'
    WHERE id = v_rec.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.expire_subscriptions(int) IS
  'ADR-001 §6.4: trial vencido -> canceled em lote (clamp 1..100), idempotente. Nao cria fatura, nao apaga, nao toca free/active/past_due. Somente service_role (contagem global e escrita de sistema).';

REVOKE ALL ON FUNCTION public.expire_subscriptions(int)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expire_subscriptions(int) TO service_role;

-- ============ 6. roll_period ============

CREATE OR REPLACE FUNCTION public.roll_period(p_subscription uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub public.tenant_subscriptions%ROWTYPE;
  v_hoje date := (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_apply_pending boolean := false;
  v_new_plan text;
  v_new_start date;
  v_new_end date;
  v_new_billing smallint;
  v_new_status text;
  v_new_trial timestamptz;
  v_billing smallint;
BEGIN
  SELECT * INTO v_sub
  FROM public.tenant_subscriptions
  WHERE id = p_subscription
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('applied', false, 'reason', 'subscription-not-found');
  END IF;
  IF v_sub.status = 'canceled' THEN
    RETURN pg_catalog.jsonb_build_object('applied', false, 'reason', 'subscription-canceled');
  END IF;
  IF v_sub.period_start IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('applied', false, 'reason', 'period-not-open');
  END IF;
  IF v_sub.period_end >= v_hoje THEN
    RETURN pg_catalog.jsonb_build_object('applied', false, 'reason', 'period-not-ended');
  END IF;
  IF v_sub.status = 'past_due' AND v_sub.pending_plan_slug = 'free' THEN
    RETURN pg_catalog.jsonb_build_object('applied', false, 'reason', 'subscription-past-due');
  END IF;

  -- Lastro do ciclo encerrado: so avanca quando a competencia do ciclo corrente
  -- tem fatura `paid`. Sem pagamento comprovado nao ha renovacao (nem downgrade).
  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_invoices AS i
    WHERE i.subscription_id = v_sub.id
      AND i.status = 'paid'
      AND i.competencia = pg_catalog.date_trunc('month', v_sub.period_start)::date
  ) THEN
    RETURN pg_catalog.jsonb_build_object('applied', false, 'reason', 'period-not-paid');
  END IF;

  v_billing := COALESCE(
    v_sub.billing_day,
    EXTRACT(DAY FROM (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date)::smallint
  );
  v_new_plan := v_sub.plan_slug;
  v_new_status := v_sub.status;
  v_new_trial := v_sub.trial_ends_at;

  IF v_sub.pending_plan_slug IS NOT NULL
     AND v_sub.pending_plan_at IS NOT NULL
     AND v_sub.pending_plan_at <= v_sub.period_end THEN
    v_apply_pending := true;
    v_new_plan := v_sub.pending_plan_slug;
  END IF;

  IF v_new_plan = 'free' THEN
    -- Plano free nao tem aniversario nem ciclo; `free` nunca e `trial`.
    v_new_start := NULL;
    v_new_end := NULL;
    v_new_billing := NULL;
    IF v_new_status = 'trial' THEN
      v_new_status := 'active';
      v_new_trial := NULL;
    END IF;
  ELSE
    v_new_start := private.billing_next_cycle_start(v_sub.period_start, v_billing);
    v_new_end := private.billing_next_cycle_start(v_new_start, v_billing) - 1;
    v_new_billing := v_billing;
  END IF;

  PERFORM pg_catalog.set_config('app.tenant_reason', 'psp:internal_period_ended', true);

  UPDATE public.tenant_subscriptions
  SET plan_slug = v_new_plan,
      billing_day = v_new_billing,
      period_start = v_new_start,
      period_end = v_new_end,
      status = v_new_status,
      trial_ends_at = v_new_trial,
      pending_plan_slug = CASE WHEN v_apply_pending THEN NULL ELSE pending_plan_slug END,
      pending_plan_at = CASE WHEN v_apply_pending THEN NULL ELSE pending_plan_at END
  WHERE id = v_sub.id;

  RETURN pg_catalog.jsonb_build_object('applied', true, 'reason', 'applied');
END;
$$;

COMMENT ON FUNCTION public.roll_period(uuid) IS
  'ADR-001 §6.5: avanca UM ciclo, aplica pending_plan_slug no limite e limpa ciclo no free. Nao cria fatura, nao cancela. Envelope applied/reason nas bordas.';

REVOKE ALL ON FUNCTION public.roll_period(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.roll_period(uuid) TO service_role;
