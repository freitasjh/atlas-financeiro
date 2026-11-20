-- 0066_psp_ingest.sql — asaas-webhook / F5 / ADR-003 (Ed6; REQ-07..REQ-14).
--
-- Motivo: a borda (Worker) precisa de UMA porta de escrita. Ate 0057 o
-- `service_role` tinha `INSERT` direto em `psp_events` — podia escolher
-- `received_at`, `processed_at`, `process_outcome`, `event_kind` e `attempts`,
-- e marcar evento como processado sem processar. Esta migration troca esse
-- privilegio por uma funcao de nome fixo, com validacao fechada e extracao
-- derivada (ADR-003 D3).
--
-- Entrega:
--   1) `private.psp_kind_rank(text)` — mapa fechado de SPEC §4.4
--      (IMMUTABLE, STRICT, search_path='', sem EXECUTE para ninguem).
--   1b) `private.safe_ts(text)` — cast defensivo de timestamp por candidato
--      (IMMUTABLE, search_path='', captura so `data_exception`; sem EXECUTE).
--   2) `public.ingest_psp_event(jsonb,text,text,timestamptz,text)` — SECURITY
--      DEFINER, search_path='', owner postgres, EXECUTE so service_role.
--      Valida na ordem de REQ-09 e devolve {"stored":bool,"outcome":...}.
--   3) Ed6: `REVOKE INSERT ON public.psp_events FROM service_role`
--      (concedido em 0057:85) — qualquer INSERT direto vira 42501.
--
-- Nenhum valor monetario e escrito; `amount_cents` continua vindo de
-- `get_plan_price` no apply (0059/0067). Nenhum rotulo interpola id, valor,
-- documento ou e-mail (NFR-04). Migrations 0001–0065 intocadas.
--
-- Idempotente-safe: CREATE OR REPLACE / REVOKE / GRANT repetiveis 2x.

-- ============ 1. Rank de ordem (SPEC §4.4) ============

CREATE OR REPLACE FUNCTION private.psp_kind_rank(p_event_type text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT CASE p_event_type
    -- `event_type` cru do PSP (coluna psp_events.event_type).
    WHEN 'PAYMENT_CONFIRMED' THEN 40
    WHEN 'PAYMENT_RECEIVED' THEN 40
    WHEN 'PAYMENT_REFUNDED' THEN 30
    WHEN 'PAYMENT_PARTIALLY_REFUNDED' THEN 30
    WHEN 'PAYMENT_OVERDUE' THEN 20
    WHEN 'SUBSCRIPTION_DELETED' THEN 10
    WHEN 'SUBSCRIPTION_INACTIVATED' THEN 10
    -- Kind normalizado (§4.9), para chamadores que ja classificaram.
    WHEN 'payment_confirmed' THEN 40
    WHEN 'payment_refunded' THEN 30
    WHEN 'payment_overdue' THEN 20
    WHEN 'subscription_canceled' THEN 10
    ELSE 0
  END;
$$;

COMMENT ON FUNCTION private.psp_kind_rank(text) IS
  'Rank de desempate da chave de ordem (SPEC §4.4): payment_confirmed=40, payment_refunded=30, payment_overdue=20, subscription_canceled=10, qualquer outro=0. Aceita o event_type cru do PSP e o kind normalizado. STRICT: NULL entra como NULL — o chamador usa COALESCE(psp_kind_rank(...),0).';

REVOKE ALL ON FUNCTION private.psp_kind_rank(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 1b. Cast defensivo de timestamp (REQ-10) ============
-- Aplicado por candidato: um `dateCreated` ilegivel devolve NULL e nao anula
-- os demais candidatos do COALESCE. Captura apenas `data_exception` (22007/
-- 22008) — qualquer outro erro continua propagando.

CREATE OR REPLACE FUNCTION private.safe_ts(p_text text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  RETURN p_text::pg_catalog.timestamptz;
EXCEPTION
  WHEN data_exception THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION private.safe_ts(text) IS
  'Cast defensivo text->timestamptz usado por ingest_psp_event (0066/REQ-10): texto ilegivel devolve NULL, sem propagar erro; NULL entra como NULL. Captura so data_exception. IMMUTABLE, search_path='' e sem EXECUTE para ninguem.';

REVOKE ALL ON FUNCTION private.safe_ts(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 2. Admissao (SPEC §4.2) ============

CREATE OR REPLACE FUNCTION public.ingest_psp_event(
  p_payload jsonb,
  p_event_id text,
  p_event_type text,
  p_event_at timestamptz DEFAULT NULL,
  p_provider text DEFAULT 'asaas'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_at timestamptz;
  v_sub text;
  v_inv text;
  v_pay text;
  v_rows integer := 0;
BEGIN
  -- REQ-09: validacao fechada, na ordem declarada, rotulo fixo sem valor.
  IF p_provider IS DISTINCT FROM 'asaas' THEN
    RAISE EXCEPTION 'psp-event-invalid';
  END IF;

  IF p_event_id IS NULL OR p_event_id = '' OR char_length(p_event_id) > 255 THEN
    RAISE EXCEPTION 'psp-event-invalid';
  END IF;

  IF p_event_type IS NULL OR p_event_type = '' OR char_length(p_event_type) > 128 THEN
    RAISE EXCEPTION 'psp-event-invalid';
  END IF;

  IF p_payload IS NULL OR pg_catalog.pg_column_size(p_payload) > 65536 THEN
    RAISE EXCEPTION 'psp-event-invalid';
  END IF;

  -- REQ-10: psp_event_at = parametro ou primeiro dateCreated legivel do
  -- payload (candidato invalido => NULL, sem anular os seguintes).
  IF p_event_at IS NOT NULL THEN
    v_event_at := p_event_at;
  ELSE
    v_event_at := COALESCE(
      private.safe_ts(p_payload #>> '{payment,dateCreated}'),
      private.safe_ts(p_payload #>> '{subscription,dateCreated}'),
      private.safe_ts(p_payload #>> '{dateCreated}')
    );
  END IF;

  -- REQ-10: ids derivados do payload; ausente/invalido => NULL (payload cru
  -- preserva o dado; a admissao nunca recusa por forma de negocio — §4.1).
  v_sub := COALESCE(
    p_payload #>> '{subscription,id}',
    p_payload #>> '{payment,subscription}'
  );
  v_inv := COALESCE(
    p_payload #>> '{payment,invoice}',
    p_payload #>> '{payment,id}'
  );
  v_pay := p_payload #>> '{payment,id}';

  v_sub := NULLIF(v_sub, '');
  v_inv := NULLIF(v_inv, '');
  v_pay := NULLIF(v_pay, '');

  IF v_sub IS NOT NULL AND char_length(v_sub) > 255 THEN
    v_sub := NULL;
  END IF;
  IF v_inv IS NOT NULL AND char_length(v_inv) > 255 THEN
    v_inv := NULL;
  END IF;
  IF v_pay IS NOT NULL AND char_length(v_pay) > 255 THEN
    v_pay := NULL;
  END IF;

  -- REQ-11/REQ-12: idempotente; o duplicado nao altera a linha existente.
  INSERT INTO public.psp_events (
    provider, event_id, event_type,
    psp_subscription_id, psp_invoice_id, psp_payment_id,
    payload, received_at, psp_event_at
  ) VALUES (
    'asaas', p_event_id, p_event_type,
    v_sub, v_inv, v_pay,
    p_payload, pg_catalog.now(), v_event_at
  )
  ON CONFLICT (event_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 1 THEN
    RETURN pg_catalog.jsonb_build_object('stored', true, 'outcome', 'stored');
  END IF;

  RETURN pg_catalog.jsonb_build_object('stored', false, 'outcome', 'duplicate');
END;
$$;

COMMENT ON FUNCTION public.ingest_psp_event(jsonb, text, text, timestamptz, text) IS
  'Porta unica de escrita do inbox (ADR-003 D3/Ed6). received_at = now() do servidor; psp_event_at = COALESCE(p_event_at, payload.payment.dateCreated, payload.subscription.dateCreated, payload.dateCreated) avaliado por candidato via private.safe_ts (candidato ilegivel e ignorado, nao anula os seguintes) e NULL quando nenhum e legivel; ids de PSP derivados do payload (ausente/invalido => NULL). Nunca aceita tenant_id, valor, status, processed_at, process_outcome, process_reason, attempts nem event_kind. Idempotente por UNIQUE(event_id): devolve {"stored":true,"outcome":"stored"} ou {"stored":false,"outcome":"duplicate"}; erro unico: psp-event-invalid.';

REVOKE ALL ON FUNCTION public.ingest_psp_event(
  jsonb, text, text, timestamptz, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.ingest_psp_event(
  jsonb, text, text, timestamptz, text
) TO service_role;

-- ============ 3. Ed6 — revoga o INSERT de tabela de 0057:85 ============

REVOKE INSERT ON TABLE public.psp_events FROM service_role;

-- Repeticao declarativa do deny do cliente (idempotente com 0057).
REVOKE ALL ON TABLE public.psp_events
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.psp_events IS
  'Inbox append-only de eventos do PSP (ADR-001 §3.3; ADR-003). Idempotencia por UNIQUE(event_id). INSERT exclusivamente por public.ingest_psp_event (0066/Ed6); UPDATE terminal de classificacao apenas por funcoes SECURITY DEFINER (apply_psp_event, drain_psp_events). service_role NAO tem INSERT/UPDATE/SELECT/DELETE de tabela. Ordem por psp_event_at + psp_kind_rank + event_id (0065/0067). Retencao: ADR-003 §8.';
