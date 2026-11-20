-- 0068_psp_retention.sql — asaas-webhook / F5 / ADR-003 (A3; REQ-30..REQ-35).
--
-- Motivo: o inbox `psp_events` (0057) guarda o payload CRU do PSP — nome,
-- `cpfCnpj`, e-mail, cartao, endereco e descricao livre. A politica A3
-- (ADR-003 §8) exige payload completo por 90 dias e, depois disso, payload
-- reduzido a metadados. Os 24 meses sao PISO de disponibilidade da trilha
-- (nada e apagado nesse marco): a retencao efetiva e indefinida e o purge
-- esta fora da v1. A linha nunca e apagada — ela e a trilha de idempotencia
-- e de ordem.
--
-- Entrega:
--   1) `public.scrub_psp_events(p_limit integer DEFAULT 500) RETURNS jsonb` —
--      SECURITY DEFINER, search_path='', owner postgres, EXECUTE so
--      service_role. Alvo: `processed_at IS NOT NULL AND received_at <
--      now() - interval '90 days' AND payload_scrubbed_at IS NULL`, com
--      `LIMIT LEAST(GREATEST(p_limit,1),500)` e `FOR UPDATE SKIP LOCKED`.
--   2) Reducao por WHITELIST (nao blacklist): o payload e reconstruido do
--      zero. Raiz: `id`, `event`, `dateCreated`; `payment`: `id`, `status`,
--      `value`, `netValue`, `dueDate`, `paymentDate`, `subscription`;
--      `subscription`: `id`, `status`. Chave fora da whitelist NAO sobrevive —
--      inclusive chave nova que o PSP venha a inventar (blacklist vazaria).
--      Alem da chave, o TIPO e checado: so escalar (`string`/`number`/
--      `boolean`) e copiado. Objeto ou array numa chave whitelisted e
--      descartado — o token do webhook nao prova a integridade do corpo
--      (SPEC §9), logo PII aninhada numa chave prevista nao pode sobreviver.
--   3) Marca `payload_scrubbed_at = now()`; nenhuma outra coluna e escrita
--      (event_id, event_type, psp_event_at, ids de PSP, received_at,
--      processed_at e process_outcome permanecem). A linha nunca e apagada.
--   4) Retorno `{"scrubbed": n, "remaining_overdue": n}` — o segundo e quantas
--      linhas elegiveis sobraram por causa do `p_limit` (nunca o total da
--      tabela). Idempotente: 2a passada devolve `scrubbed = 0`.
--   5) `COMMENT ON TABLE public.psp_events` com a politica A3 completa
--      (90 dias / 24 meses / tenant_invoices 5 anos sem purge na v1).
--
-- Por que o scrub nao quebra nada: a ordem (0067) le `psp_event_at` e
-- `event_type` de COLUNA, nao do payload; a idempotencia vive em
-- `UNIQUE(event_id)`; e `apply_psp_event` recusa evento ja processado. Reenvio
-- pos-scrub continua `duplicate`.
--
-- Nenhum valor monetario e escrito aqui. Nenhum rotulo interpola id, valor,
-- documento ou e-mail (NFR-04). Migrations 0001–0067 intocadas.
--
-- Idempotente-safe: CREATE OR REPLACE / REVOKE / GRANT / COMMENT repetiveis 2x.

-- ============ 1. Retencao A3 — scrub por whitelist ============

CREATE OR REPLACE FUNCTION public.scrub_psp_events(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- REQ-30: clamp 1..500. `COALESCE` porque `GREATEST(NULL,1)` em Postgres
  -- ignora NULL e cairia no piso 1; p_limit nulo deve valer o DEFAULT.
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 500);
  v_cutoff timestamptz := pg_catalog.now() - interval '90 days';
  v_scrubbed integer := 0;
  v_remaining integer := 0;
BEGIN
  -- REQ-30: so evento PROCESSADO e mais velho que 90 dias. Evento pendente
  -- fica intocado: o apply ainda precisa do payload para resolver assinatura.
  WITH target AS MATERIALIZED (
    SELECT e.id
    FROM public.psp_events AS e
    WHERE e.processed_at IS NOT NULL
      AND e.received_at < v_cutoff
      AND e.payload_scrubbed_at IS NULL
    ORDER BY e.received_at, e.id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.psp_events AS e
     SET payload = pg_catalog.jsonb_strip_nulls(
           pg_catalog.jsonb_build_object(
             'id', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'id')
                          IN ('string', 'number', 'boolean')
                        THEN e.payload -> 'id' END,
             'event', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'event')
                             IN ('string', 'number', 'boolean')
                           THEN e.payload -> 'event' END,
             'dateCreated', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'dateCreated')
                                   IN ('string', 'number', 'boolean')
                                 THEN e.payload -> 'dateCreated' END,
             'payment', NULLIF(
               pg_catalog.jsonb_strip_nulls(
                 pg_catalog.jsonb_build_object(
                   'id', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'payment' -> 'id')
                                IN ('string', 'number', 'boolean')
                              THEN e.payload -> 'payment' -> 'id' END,
                   'status', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'payment' -> 'status')
                                    IN ('string', 'number', 'boolean')
                                  THEN e.payload -> 'payment' -> 'status' END,
                   'value', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'payment' -> 'value')
                                   IN ('string', 'number', 'boolean')
                                 THEN e.payload -> 'payment' -> 'value' END,
                   'netValue', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'payment' -> 'netValue')
                                      IN ('string', 'number', 'boolean')
                                    THEN e.payload -> 'payment' -> 'netValue' END,
                   'dueDate', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'payment' -> 'dueDate')
                                     IN ('string', 'number', 'boolean')
                                   THEN e.payload -> 'payment' -> 'dueDate' END,
                   'paymentDate', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'payment' -> 'paymentDate')
                                         IN ('string', 'number', 'boolean')
                                       THEN e.payload -> 'payment' -> 'paymentDate' END,
                   'subscription', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'payment' -> 'subscription')
                                          IN ('string', 'number', 'boolean')
                                        THEN e.payload -> 'payment' -> 'subscription' END
                 )
               ),
               '{}'::jsonb
             ),
             'subscription', NULLIF(
               pg_catalog.jsonb_strip_nulls(
                 pg_catalog.jsonb_build_object(
                   'id', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'subscription' -> 'id')
                                IN ('string', 'number', 'boolean')
                              THEN e.payload -> 'subscription' -> 'id' END,
                   'status', CASE WHEN pg_catalog.jsonb_typeof(e.payload -> 'subscription' -> 'status')
                                    IN ('string', 'number', 'boolean')
                                  THEN e.payload -> 'subscription' -> 'status' END
                 )
               ),
               '{}'::jsonb
             )
           )
         ),
         payload_scrubbed_at = pg_catalog.now()
    FROM target
   WHERE e.id = target.id;

  GET DIAGNOSTICS v_scrubbed = ROW_COUNT;

  -- REQ-33: quantas linhas elegiveis sobraram por causa do `p_limit` — nao e
  -- o total da tabela, e sim o backlog de retencao.
  SELECT count(*)
    INTO v_remaining
  FROM public.psp_events AS e
  WHERE e.processed_at IS NOT NULL
    AND e.received_at < v_cutoff
    AND e.payload_scrubbed_at IS NULL;

  RETURN pg_catalog.jsonb_build_object(
    'scrubbed', v_scrubbed,
    'remaining_overdue', v_remaining
  );
END;
$$;

COMMENT ON FUNCTION public.scrub_psp_events(integer) IS
  'Retencao A3 (ADR-003 §8/REQ-30..REQ-35): reduz o payload de evento PROCESSADO com received_at < now()-90d a uma WHITELIST de chaves ESCALARES (raiz id/event/dateCreated; payment id/status/value/netValue/dueDate/paymentDate/subscription; subscription id/status). Chave fora da whitelist nao sobrevive, e chave prevista com objeto/array tambem e descartada (so string/number/boolean e copiado). Marca payload_scrubbed_at=now(); nenhuma outra coluna e escrita e a linha nunca e apagada. LIMIT LEAST(GREATEST(COALESCE(p_limit,500),1),500) com FOR UPDATE SKIP LOCKED. Retorna {"scrubbed":n,"remaining_overdue":n} (backlog de retencao); idempotente — 2a passada devolve scrubbed=0.';

REVOKE ALL ON FUNCTION public.scrub_psp_events(integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.scrub_psp_events(integer)
  TO service_role;

-- ============ 2. Politica A3 declarada na tabela ============

COMMENT ON TABLE public.psp_events IS
  'Inbox append-only de eventos do PSP (ADR-001 §3.3; ADR-003). Idempotencia por UNIQUE(event_id). INSERT exclusivamente por public.ingest_psp_event (0066/Ed6); UPDATE terminal de classificacao apenas por funcoes SECURITY DEFINER (apply_psp_event, drain_psp_events, scrub_psp_events). service_role NAO tem INSERT/UPDATE/SELECT/DELETE de tabela; so EXECUTE das 3 RPCs de nome fixo. Ordem por psp_event_at + psp_kind_rank + event_id (0065/0067). Politica de retencao A3 (0068): payload COMPLETO por 90 dias apos received_at; passado esse prazo scrub_psp_events reduz o payload a uma whitelist de chaves ESCALARES (raiz id/event/dateCreated; payment id/status/value/netValue/dueDate/paymentDate/subscription; subscription id/status) — chave fora da whitelist nao sobrevive e chave prevista com objeto/array e descartada. Os 24 meses sao PISO de disponibilidade da trilha de idempotencia e ordem: nada e apagado nesse marco, a retencao efetiva dos metadados e indeterminada e o purge esta fora da v1. tenant_invoices: 5 anos (fiscal) — nenhum purge na v1.';
