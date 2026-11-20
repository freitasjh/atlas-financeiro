-- 0023_usage_events.sql — tenants-cobranca / ADR-002 (medição de uso idempotente).
--
-- Motivo: RF-T10 exige idempotência provada como constraint do banco, não
-- estimada: reprocessar o mesmo lançamento ou a mesma competência não pode
-- incrementar o contador. Contador por trigger em `transactions` conta linhas,
-- não lançamentos lógicos; agregado recalculado muda retroativamente.
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `public.usage_events` — append-only (tenant, competencia dia 01, dedup_key).
--   2) `UNIQUE (tenant_id, competencia, dedup_key)` — árbitro do `ON CONFLICT`.
--   3) `public.record_usage_event(...)` — RPC `SECURITY DEFINER`: valida e faz
--      `INSERT ... ON CONFLICT DO NOTHING` → `true` (registrado) / `false` (dup).
--   4) RLS por membership + `REVOKE ALL` antes de `GRANT SELECT`.
--
-- Invariantes provadas em `supabase/tests/tenants-adr002.spec.sql` (banco real,
-- `SET ROLE authenticated` + `ROLLBACK`):
--   U-1 (tenant_id, competencia, dedup_key) nunca duplica.
--   U-2 reexecutar a mesma tupla N vezes devolve `false` após a 1ª; `count(*)` estável.
--   U-3 `authenticated` só lê eventos de tenants em que é membro, exceto `is_admin()`.
--   U-4 competencia sempre dia 01 e sempre mês do `occurred_at` em `America/Sao_Paulo`;
--       `occurred_at` futuro além de `pg_catalog.now()` + 5 min é recusado com o
--       mesmo rótulo (backfill passado segue permitido).
--   U-5 nenhum caminho de escrita direta (`42501` em INSERT/UPDATE/DELETE).
--
-- Erros por rótulo fixo, sem PII/volume/id na mensagem:
--   not-authenticated, usage-tenant-invalid, tenant-not-member,
--   usage-dedup-invalid, usage-competencia-mismatch.
--
-- Idempotente-safe: CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- DROP POLICY IF EXISTS + blocos DO $$ com guarda em `pg_constraint` /
-- REVOKE/GRANT repetíveis. Migrations 0001–0022 intocadas. Nenhum valor
-- monetário neste ciclo. Nenhum trigger em `transactions`.

-- ============ 1. Tabela ============

CREATE TABLE IF NOT EXISTS public.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  competencia date NOT NULL,
  dedup_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.usage_events IS
  'Medição de uso (ADR-002). Append-only: escrita exclusiva da RPC record_usage_event; leitura por membership. Total = count(*) sobre (tenant_id, competencia).';
COMMENT ON COLUMN public.usage_events.competencia IS
  'Primeiro dia do mês de occurred_at em America/Sao_Paulo. Servidor é autoritativo.';
COMMENT ON COLUMN public.usage_events.dedup_key IS
  'Id externo estável do lançamento (ex. fitid, id de importação, tx:<uuid>). Derivação total vira follow-up com vínculo transação→tenant.';

-- ============ 2. Constraints (guarda pg_constraint: re-aplicável) ============

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_competencia_day1'
  ) THEN
    ALTER TABLE public.usage_events
      ADD CONSTRAINT usage_events_competencia_day1
      CHECK (pg_catalog.date_part('day', competencia) = 1);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_dedup_key_format'
  ) THEN
    ALTER TABLE public.usage_events
      ADD CONSTRAINT usage_events_dedup_key_format
      CHECK (
        pg_catalog.char_length(dedup_key) BETWEEN 1 AND 128
        AND dedup_key ~ '^[A-Za-z0-9:_-]+$'
      );
  END IF;
END;
$$;

-- U-1: árbitro do ON CONFLICT (sustenta index-only scan do count por tenant+mês).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_tenant_comp_dedup_uq'
  ) THEN
    ALTER TABLE public.usage_events
      ADD CONSTRAINT usage_events_tenant_comp_dedup_uq
      UNIQUE (tenant_id, competencia, dedup_key);
  END IF;
END;
$$;

-- ============ 3. RPC idempotente ============
-- Ordem exigida pela SPEC §5: not-authenticated → usage-tenant-invalid →
-- tenant-not-member → usage-dedup-invalid → usage-competencia-mismatch →
-- INSERT ... ON CONFLICT DO NOTHING.
-- `search_path = ''` + tudo qualificado: sem sequestro por schema do chamador.

CREATE OR REPLACE FUNCTION public.record_usage_event(
  p_tenant_id uuid,
  p_competencia date,
  p_dedup_key text,
  p_occurred_at timestamptz DEFAULT pg_catalog.now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := pg_catalog.btrim(COALESCE(p_dedup_key, ''));
  v_occurred timestamptz := COALESCE(p_occurred_at, pg_catalog.now());
  v_expected date := (
    pg_catalog.date_trunc(
      'month',
      v_occurred AT TIME ZONE 'America/Sao_Paulo'
    )
  )::date;
  v_inserted int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenants AS t WHERE t.id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'usage-tenant-invalid';
  END IF;

  IF NOT public.is_admin()
    AND NOT EXISTS (
      SELECT 1 FROM private.user_tenant_ids() AS u WHERE u = p_tenant_id
    ) THEN
    RAISE EXCEPTION 'tenant-not-member';
  END IF;

  IF pg_catalog.char_length(v_key) NOT BETWEEN 1 AND 128
    OR v_key !~ '^[A-Za-z0-9:_-]+$' THEN
    RAISE EXCEPTION 'usage-dedup-invalid';
  END IF;

  IF v_occurred > pg_catalog.now() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'usage-competencia-mismatch';
  END IF;

  IF p_competencia IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'usage-competencia-mismatch';
  END IF;

  INSERT INTO public.usage_events (tenant_id, competencia, dedup_key, occurred_at)
  VALUES (p_tenant_id, p_competencia, v_key, v_occurred)
  ON CONFLICT (tenant_id, competencia, dedup_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

COMMENT ON FUNCTION public.record_usage_event(uuid, date, text, timestamptz) IS
  'ADR-002: registra um lançamento processado na competencia do fato. true = registrado agora, false = tupla já existia (no-op).';

REVOKE ALL ON FUNCTION public.record_usage_event(uuid, date, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.record_usage_event(uuid, date, text, timestamptz)
  TO authenticated;

-- ============ 4. RLS ============

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

-- Leitura: admin (backoffice) ou membro do tenant. `is_admin()` e o helper são
-- avaliados em subquery/EXISTS: viram `InitPlan`/semi-join e são executados 1×
-- por statement, nunca por linha candidata. Nenhuma policy de
-- INSERT/UPDATE/DELETE: escrita é exclusiva da RPC.
DROP POLICY IF EXISTS usage_events_select_member ON public.usage_events;
CREATE POLICY usage_events_select_member ON public.usage_events
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin())
    OR EXISTS (
      SELECT 1 FROM private.user_tenant_ids() AS u WHERE u = usage_events.tenant_id
    )
  );

-- ============ 5. Privilégios ============
-- Supabase concede ALL a anon/authenticated/service_role em tabelas novas de
-- `public` (default privileges). REVOKE ALL antes do GRANT SELECT: sem grant de
-- escrita, nenhuma policy "salva" o cliente (T06 prova `42501`).

REVOKE ALL ON TABLE public.usage_events FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.usage_events TO authenticated;
