-- 0065_psp_event_order_retention.sql — asaas-webhook / F5 / ADR-003 (Ed1–Ed5).
--
-- Motivo: o inbox `psp_events` (0057) guarda o evento cru mas nao guarda a
-- ORDEM nem o MOTIVO terminal. Sem `psp_event_at` a comparacao de §6.1 leria
-- o payload (que o scrub de 0068 reduz); sem `process_reason` o operador nao
-- distingue `stale-event` de `apply-error`; sem `payload_scrubbed_at` a
-- retencao A3 nao e idempotente. `tenant_subscriptions` tambem nao tem marca
-- d'agua para recusar evento velho (ADR-003 §6.2).
--
-- Entrega (REQ-01..REQ-06):
--   1) `psp_events.psp_event_at timestamptz` — nullable, sem default.
--   2) `psp_events.process_reason text` + CHECK com os 8 rotulos de SPEC §4.8.
--   3) `psp_events.payload_scrubbed_at timestamptz` — preenchido so por 0068.
--   4) `idx_psp_events_pending` — parcial em `received_at WHERE processed_at IS NULL`.
--   5) `tenant_subscriptions.last_event_at`/`last_event_id` + CHECK de par e
--      de comprimento 1..255.
--   6) COMMENT em cada coluna nova (a fonte de `psp_event_at` e documentada).
--
-- Nenhum valor monetario e escrito aqui; nenhuma migration 0001–0064 e tocada.
-- Idempotente-safe: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
-- ADD CONSTRAINT guardado por pg_constraint (repetivel 2x).

-- ============ 1. Colunas de ordem e retencao ============

ALTER TABLE public.psp_events
  ADD COLUMN IF NOT EXISTS psp_event_at timestamptz,
  ADD COLUMN IF NOT EXISTS process_reason text,
  ADD COLUMN IF NOT EXISTS payload_scrubbed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.psp_events'::regclass
      AND conname = 'psp_events_process_reason_check'
  ) THEN
    ALTER TABLE public.psp_events
      ADD CONSTRAINT psp_events_process_reason_check
      CHECK (process_reason IS NULL OR process_reason IN (
        'stale-event', 'unmapped-event-type', 'already-processed',
        'transition-invalid', 'subscription-not-found', 'invoice-not-found',
        'amount-divergence', 'apply-error'
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.psp_events.psp_event_at IS
  'Instante do evento segundo o PSP (coluna, nao payload): COALESCE do parametro p_event_at e de payload.payment.dateCreated / payload.subscription.dateCreated / payload.dateCreated, na admissao (0066). NULL = payload sem data legivel; a comparacao de ordem (0067) cai para received_at. Coluna separada para o scrub (0068) poder reduzir o payload sem perder a ordem.';
COMMENT ON COLUMN public.psp_events.process_reason IS
  'Rotulo terminal fixo (SPEC §4.8): stale-event | unmapped-event-type | already-processed | transition-invalid | subscription-not-found | invoice-not-found | amount-divergence | apply-error. Nunca contem id, valor, documento, e-mail ou nome.';
COMMENT ON COLUMN public.psp_events.payload_scrubbed_at IS
  'Momento em que scrub_psp_events (0068) reduziu o payload a whitelist da politica A3. NULL = payload ainda completo. Escrito exclusivamente pela RPC de retencao.';

-- ============ 2. Indice parcial da fila de dreno (Ed4) ============

CREATE INDEX IF NOT EXISTS idx_psp_events_pending
  ON public.psp_events (received_at)
  WHERE processed_at IS NULL;

-- ============ 3. Marca d'agua de ordem na assinatura (Ed5) ============

ALTER TABLE public.tenant_subscriptions
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_event_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.tenant_subscriptions'::regclass
      AND conname = 'tenant_subscriptions_last_event_pair_check'
  ) THEN
    ALTER TABLE public.tenant_subscriptions
      ADD CONSTRAINT tenant_subscriptions_last_event_pair_check
      CHECK ((last_event_at IS NULL) = (last_event_id IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.tenant_subscriptions'::regclass
      AND conname = 'tenant_subscriptions_last_event_id_len_check'
  ) THEN
    ALTER TABLE public.tenant_subscriptions
      ADD CONSTRAINT tenant_subscriptions_last_event_id_len_check
      CHECK (last_event_id IS NULL OR char_length(last_event_id) BETWEEN 1 AND 255);
  END IF;
END $$;

COMMENT ON COLUMN public.tenant_subscriptions.last_event_at IS
  'Marca d''agua de ordem (ADR-003 §6.2): instante do ultimo evento APLICADO (inclusive noop de status). Evento com chave menor que (last_event_at, rank, last_event_id) e stale e nao transiciona.';
COMMENT ON COLUMN public.tenant_subscriptions.last_event_id IS
  'event_id do ultimo evento aplicado; desempate final da chave total (last_event_at, psp_kind_rank, last_event_id). Par obrigatorio com last_event_at (CHECK).';
