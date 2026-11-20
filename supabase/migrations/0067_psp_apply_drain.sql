-- 0067_psp_apply_drain.sql — asaas-webhook / F5 / ADR-003 (Ed7; REQ-15..REQ-29).
--
-- Motivo: ate 0059 o apply nao tinha ORDEM. `PAYMENT_CONFIRMED` (D+2) podia
-- chegar depois de `PAYMENT_OVERDUE` (D) e o overdue rebaixava `active` para
-- `past_due` — cortando escrita de quem pagou (ADR-003 §6.2). E o
-- `service_role` chamava `apply_psp_event` direto (0059:887-889), pulando
-- dreno, backoff e `attempts`: a "porta unica" era comportamental, nao
-- estrutural (Adendo A2).
--
-- Entrega:
--   1) `CREATE OR REPLACE public.apply_psp_event(text)` — assinatura e retorno
--      `jsonb` congelados; matriz de 0059 preservada. Guarda de ordem por
--      chave total `(COALESCE(psp_event_at, received_at),
--      COALESCE(psp_kind_rank(event_type),0), event_id)` ANTES da matriz:
--      evento nao maior que a marca d'agua => `noop`/`stale-event`, zero
--      transicao e zero escrita de fatura.
--   2) Marca d'agua em `tenant_subscriptions.last_event_at`/`last_event_id`
--      avancada em toda aplicacao (inclusive `noop` de status), gravada como
--      `LEAST(psp_event_at, now())` (Adendo A3: `psp_events.psp_event_at`
--      preserva o valor original para auditoria).
--   3) `public.drain_psp_events(int,text)` — porta unica do `service_role`:
--      subtransacao por linha, backoff `received_at + attempts^2 * 30s`,
--      `FOR UPDATE SKIP LOCKED`, teto de `attempts` de 0057 e retorno
--      `{applied,noop,rejected,failed,pending}`.
--   4) Adendo A2: `REVOKE EXECUTE ON FUNCTION public.apply_psp_event(text)
--      FROM service_role`; `EXECUTE` de `drain_psp_events` so `service_role`.
--
-- Adendo A1: `private.psp_kind_rank` e STRICT; TODO call site usa
-- `COALESCE(psp_kind_rank(...),0)` — sem o COALESCE a comparacao de linha
-- vira NULL, o `IF` nao dispara e o evento viraria `stale-event` em silencio.
--
-- Nenhum valor monetario e escrito aqui (`amount_cents` continua vindo de
-- `get_plan_price` no apply). Nenhum rotulo interpola id, valor, documento ou
-- e-mail (NFR-04). Migrations 0001–0066 intocadas.
--
-- Idempotente-safe: CREATE OR REPLACE / REVOKE / GRANT / COMMENT repetiveis 2x.

-- ============ 1. apply_psp_event — ordem total + marca d'agua ============

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
  v_order_ts timestamptz;
  v_order_rank int;
  v_last_rank int;
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
        process_outcome = 'noop',
        process_reason = 'unmapped-event-type'
    WHERE id = v_event.id;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'noop', 'transition', NULL, 'invoice_id', NULL,
      'reason', 'unmapped-event-type'
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

  -- §4.4/§4.5 (6) + Ed7: guarda de ordem ANTES da matriz. Chave total:
  --   (COALESCE(psp_event_at, received_at), COALESCE(rank,0), event_id)
  -- Todo call site de psp_kind_rank usa COALESCE (Adendo A1): sem ele a
  -- comparacao de linha vira NULL e `IS NOT TRUE` marcaria stale em silencio.
  -- Evento nao maior que a marca d'agua => terminal stale, ZERO transicao e
  -- ZERO escrita de fatura (nao toca tenant_subscriptions nem tenant_invoices).
  v_order_ts := COALESCE(v_event.psp_event_at, v_event.received_at);
  v_order_rank := COALESCE(private.psp_kind_rank(v_event.event_type), 0);

  IF v_sub.last_event_at IS NOT NULL THEN
    SELECT COALESCE(private.psp_kind_rank(e.event_type), 0)
      INTO v_last_rank
    FROM public.psp_events AS e
    WHERE e.event_id = v_sub.last_event_id;

    -- `IS NOT TRUE` fecha o caso NULL (Adendo A1): sem COALESCE a comparacao
    -- de linha seria NULL e o evento viraria `stale-event` em silencio.
    IF ROW(v_order_ts, v_order_rank, v_event.event_id)
         > ROW(v_sub.last_event_at, COALESCE(v_last_rank, 0), v_sub.last_event_id)
       IS NOT TRUE THEN
      UPDATE public.psp_events
      SET event_kind = v_kind,
          processed_at = pg_catalog.now(),
          process_outcome = 'noop',
          process_reason = 'stale-event'
      WHERE id = v_event.id;
      RETURN pg_catalog.jsonb_build_object(
        'outcome', 'noop', 'transition', NULL, 'invoice_id', NULL,
        'reason', 'stale-event'
      );
    END IF;
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
        process_outcome = 'rejected',
        process_reason = 'transition-invalid'
    WHERE id = v_event.id;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'rejected', 'transition', NULL, 'invoice_id', NULL,
      'reason', 'transition-invalid'
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
        process_outcome = 'rejected',
        process_reason = 'transition-invalid'
    WHERE id = v_event.id;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'rejected', 'transition', NULL, 'invoice_id', NULL,
      'reason', 'transition-invalid'
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

  -- REQ-19/Adendo A3: a marca d'agua avanca em toda aplicacao (inclusive
  -- `noop` de status) e grava LEAST(psp_event_at, now()) — o valor original
  -- fica em `psp_events.psp_event_at`, nunca na marca. Para evento sem data do
  -- PSP a marca usa `received_at` (mesmo componente da chave de ordem), com o
  -- teto do `now()` preservado.
  UPDATE public.tenant_subscriptions
  SET last_event_at = LEAST(
        COALESCE(v_event.psp_event_at, v_event.received_at),
        pg_catalog.now()
      ),
      last_event_id = v_event.event_id
  WHERE id = v_sub.id;

  -- §6.1 (9): terminal do inbox + envelope. `process_reason` so tem rotulo nos
  -- terminais rotulados (stale/unmapped/rejected); `applied` e `noop` de
  -- matriz ficam NULL — inventar rotulo e proibido (REQ-02/§4.8).
  UPDATE public.psp_events
  SET event_kind = v_kind,
      processed_at = pg_catalog.now(),
      process_outcome = v_outcome,
      process_reason = NULL
  WHERE id = v_event.id;

  RETURN pg_catalog.jsonb_build_object(
    'outcome', v_outcome,
    'transition', v_transition,
    'invoice_id', v_invoice_id
  );
END;
$$;

COMMENT ON FUNCTION public.apply_psp_event(text) IS
  'ADR-001 §6.1 + ADR-003 §6.2 (0067/Ed7): aplica a matriz evento->transicao a partir do inbox. Idempotente por event_id. Guarda de ordem total (COALESCE(psp_event_at,received_at), COALESCE(psp_kind_rank(event_type),0), event_id) ANTES da matriz: evento nao maior que (last_event_at, rank do last_event_id, last_event_id) => noop/stale-event, zero transicao e zero escrita de fatura. A marca d''agua avanca em toda aplicacao (inclusive noop de status) e grava LEAST(psp_event_at, now()); psp_events.psp_event_at preserva o valor original. Transicao invalida => envelope rejected + 1 auditoria, 0 UPDATE. Aceita apenas o id do evento. EXECUTE so do owner: service_role usa drain_psp_events (Adendo A2).';

REVOKE ALL ON FUNCTION public.apply_psp_event(text)
  FROM PUBLIC, anon, authenticated, service_role;
-- Adendo A2: o Worker nao chama o apply direto — so o dreno (0067).
REVOKE EXECUTE ON FUNCTION public.apply_psp_event(text) FROM service_role;

-- ============ 2. drain_psp_events — porta unica do service_role ============

CREATE OR REPLACE FUNCTION public.drain_psp_events(
  p_limit integer DEFAULT 200,
  p_event_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_rec record;
  v_res jsonb;
  v_outcome text;
  v_rows int := 0;
  v_applied int := 0;
  v_noop int := 0;
  v_rejected int := 0;
  v_failed int := 0;
  v_pending int;
BEGIN
  -- §4.6: `p_event_id` nao nulo = caminho da fila (so aquele evento, sem
  -- filtro de backoff); nulo = varredura do cron com backoff quadratico.
  FOR v_rec IN
    SELECT e.id, e.event_id
    FROM public.psp_events AS e
    WHERE (p_event_id IS NOT NULL AND e.event_id = p_event_id)
       OR (
         p_event_id IS NULL
         AND e.processed_at IS NULL
         AND e.attempts < 10
         AND e.received_at
             + (e.attempts * e.attempts) * interval '30 seconds'
             <= pg_catalog.now()
       )
    ORDER BY e.received_at
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  LOOP
    v_rows := v_rows + 1;

    -- Subtransacao por linha: a excecao de um evento nao derruba o lote.
    BEGIN
      v_res := public.apply_psp_event(v_rec.event_id);
      v_outcome := v_res->>'outcome';
      IF v_outcome = 'applied' THEN
        v_applied := v_applied + 1;
      ELSIF v_outcome = 'rejected' THEN
        v_rejected := v_rejected + 1;
      ELSE
        v_noop := v_noop + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'psp-event-already-processed' THEN
        -- REQ-23: erro congelado nunca escapa do dreno.
        v_noop := v_noop + 1;
      ELSE
        -- REQ-27: attempts so avanca aqui (o UPDATE do apply foi desfeito).
        UPDATE public.psp_events
        SET attempts = LEAST(attempts + 1, 10),
            process_reason = 'apply-error',
            process_outcome = CASE
              WHEN attempts + 1 >= 10 THEN 'rejected' ELSE NULL END,
            processed_at = CASE
              WHEN attempts + 1 >= 10 THEN pg_catalog.now() ELSE NULL END
        WHERE id = v_rec.id;
        v_failed := v_failed + 1;
      END IF;
    END;
  END LOOP;

  -- REQ-25: evento inexistente no caminho da fila conta em failed, sem RAISE.
  IF p_event_id IS NOT NULL AND v_rows = 0 THEN
    v_failed := v_failed + 1;
  END IF;

  SELECT count(*) INTO v_pending
  FROM public.psp_events
  WHERE processed_at IS NULL;

  RETURN pg_catalog.jsonb_build_object(
    'applied', v_applied,
    'noop', v_noop,
    'rejected', v_rejected,
    'failed', v_failed,
    'pending', v_pending
  );
END;
$$;

COMMENT ON FUNCTION public.drain_psp_events(integer, text) IS
  'Porta unica de aplicacao do inbox (ADR-003 §6.3; 0067). Assinatura unica public.drain_psp_events(integer, text) — p_limit DEFAULT 200, p_event_id DEFAULT NULL; NAO existe overload de 1 argumento (to_regprocedure(''public.drain_psp_events(integer)'') e NULL). p_event_id nao nulo aplica apenas aquele evento (caminho da fila; inexistente conta em failed sem RAISE); nulo varre pendentes com backoff received_at + attempts^2 * 30s, ORDER BY received_at, FOR UPDATE SKIP LOCKED e LIMIT clampado 1..500. Cada linha roda em subtransacao propria: excecao => attempts+1, process_reason=apply-error, processed_at e process_outcome seguem NULL e a linha conta em failed; em attempts=10 a linha vira rejected/apply-error com processed_at=now() e e preservada. psp-event-already-processed vira duplicate (nunca escapa). Retorno exato: {applied,noop,rejected,failed,pending}; pending = count(*) WHERE processed_at IS NULL no fim da chamada.';

REVOKE ALL ON FUNCTION public.drain_psp_events(integer, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.drain_psp_events(integer, text)
  TO service_role;
