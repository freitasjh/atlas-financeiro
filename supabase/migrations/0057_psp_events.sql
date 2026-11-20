-- 0057_psp_events.sql — control-plane-billing / F1 / ADR-001 (D3; REQ-18/REQ-37).
--
-- Motivo: o webhook do PSP precisa de inbox idempotente. Sem `UNIQUE(event_id)`
-- uma reentrega do provedor processa duas vezes; sem grants fechados o payload
-- cru (PII) fica legivel por cliente. Esta migration cria o inbox append-only.
--
-- Entrega (REQ-18, I7/I13):
--   1) `public.psp_events` com as 13 colunas congeladas de §4.3.
--   2) `UNIQUE (event_id)` + CHECKs de provider/enums/limites/attempts/payload.
--   3) `payload jsonb NOT NULL`; classificacao (`event_kind`/`process_outcome`)
--      nula ate o processamento pela RPC (0059).
--   4) RLS deny-all (sem policy) + REVOKE ALL de PUBLIC/anon/authenticated/
--      service_role; `GRANT INSERT` apenas para `service_role` (borda ADR-003;
--      sera revogado em 0066/Ed6). Sem SELECT/UPDATE/DELETE para cliente.
--   5) COMMENT declarando append-only e retencao de ADR-003 §8.
--
-- Correcao por texto (ids de PSP), sem FK: o evento pode chegar antes da linha
-- local. Nenhum valor monetario e escrito aqui (o valor vem do catalogo em 0059).
--
-- Idempotente-safe: CREATE ... IF NOT EXISTS / REVOKE/GRANT repetiveis.
-- Migrations 0001–0056 intocadas.

-- ============ 1. Tabela ============

CREATE TABLE IF NOT EXISTS public.psp_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'asaas',
  event_id text NOT NULL,
  event_type text NOT NULL,
  event_kind text,
  psp_subscription_id text,
  psp_invoice_id text,
  psp_payment_id text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  process_outcome text,
  attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT psp_events_event_id_uq UNIQUE (event_id),
  CONSTRAINT psp_events_provider_check
    CHECK (provider = 'asaas'),
  CONSTRAINT psp_events_event_id_len_check
    CHECK (char_length(event_id) BETWEEN 1 AND 255),
  CONSTRAINT psp_events_event_type_len_check
    CHECK (char_length(event_type) BETWEEN 1 AND 128),
  CONSTRAINT psp_events_event_kind_check
    CHECK (event_kind IS NULL OR event_kind IN (
      'payment_confirmed', 'payment_overdue', 'payment_refunded',
      'subscription_canceled', 'internal_trial_expired',
      'internal_period_ended', 'unmapped'
    )),
  CONSTRAINT psp_events_process_outcome_check
    CHECK (process_outcome IS NULL OR process_outcome IN (
      'applied', 'duplicate', 'noop', 'rejected'
    )),
  CONSTRAINT psp_events_attempts_check
    CHECK (attempts BETWEEN 0 AND 10),
  CONSTRAINT psp_events_psp_subscription_len_check
    CHECK (psp_subscription_id IS NULL
      OR char_length(psp_subscription_id) BETWEEN 1 AND 255),
  CONSTRAINT psp_events_psp_invoice_len_check
    CHECK (psp_invoice_id IS NULL
      OR char_length(psp_invoice_id) BETWEEN 1 AND 255),
  CONSTRAINT psp_events_psp_payment_len_check
    CHECK (psp_payment_id IS NULL
      OR char_length(psp_payment_id) BETWEEN 1 AND 255)
);

COMMENT ON TABLE public.psp_events IS
  'Inbox append-only de eventos do PSP (ADR-001 §3.3). Idempotencia por UNIQUE(event_id). Cliente sem SELECT/UPDATE/DELETE; service_role apenas INSERT (borda ADR-003, revogado em 0066). Retencao declarada em ADR-003 §8 (90 dias operacional / 24 meses trilha).';
COMMENT ON COLUMN public.psp_events.payload IS
  'Corpo cru do PSP (jsonb). Pode conter PII: acessivel somente a service_role e funcoes DEFINER.';
COMMENT ON COLUMN public.psp_events.process_outcome IS
  'Resultado terminal do processamento (applied|duplicate|noop|rejected). NULL = pendente.';

-- ============ 2. RLS deny-all (sem policy) ============

ALTER TABLE public.psp_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.psp_events
  FROM PUBLIC, anon, authenticated, service_role;

-- Unica borda de escrita direta nesta fatia: o webhook (service_role) entrega
-- o evento. Nenhuma leitura: a RPC apply_psp_event (0059) le como DEFINER.
GRANT INSERT ON TABLE public.psp_events TO service_role;
