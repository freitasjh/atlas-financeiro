-- 0071_internal_read_rpcs.sql — internal-control-plane / F4 / ADR-004 (BE-45).
--
-- Motivo: o painel interno (`/internal`) precisa de duas leituras que ainda não
-- existem: série de telemetria (`usage_events`) e resumo de MRR/inadimplência.
-- Sem RPC, a UI teria que agregar no cliente — proibido (REQ-33/REQ-49: nada de
-- número inventado; `plan_catalog` fora da allowlist).
--
-- Entrega (somente leitura; nenhuma tabela nova, nenhuma policy nova):
--   1) `public.admin_usage_series(p_from date, p_to date, p_tenant uuid)`
--      RETURNS TABLE(competencia date, tenant_id uuid, events bigint).
--      • gate `is_super_admin()` (0051) ⇒ `not-admin`.
--      • default = 12 competências terminando no mês corrente em
--        America/Sao_Paulo (`p_from` = `p_to` - 11 meses).
--      • `competencia` normalizada ao dia 1; `events = count(*)` de
--        `usage_events` agrupado por (competencia, tenant_id).
--      • rótulos: `not-admin`, `usage-range-invalid` (`p_to < p_from` ou
--        janela > 24 competências; 24 exatas passam).
--      • sem auditoria própria (agregado sem PII — O-F4-10).
--   2) `public.admin_mrr_summary(p_competencia date)` RETURNS jsonb com a
--      forma CONGELADA (SPEC §5.2 / REQ-49):
--      {"competencia":date,"mrr_cents":bigint,"active_count":int,
--       "past_due_count":int,"overdue_cents":bigint,"overdue_count":int}.
--      • gate `is_super_admin()` ⇒ `not-admin`.
--      • `p_competencia` default = mês corrente SP; normalizada ao dia 1.
--
-- FÓRMULA DO MRR — DECISÃO DE PRODUTO DE 2026-11-19 (O-F4-5):
--   `mrr_cents` = Σ `plan_catalog.price_cents` das assinaturas
--   `tenant_subscriptions.status = 'active'`. `past_due` NÃO entra no MRR
--   (aparece em `past_due_count` e nas faturas `overdue`); `trial` e `free`
--   não adicionam receita (o `free` ativo soma 0 e conta em `active_count`).
--   `overdue_cents` = Σ `tenant_invoices.amount_cents` com `status='overdue'`.
--   Esta é a fórmula AUTORITATIVA do painel — o `COMMENT` abaixo a marca como
--   decisão de produto (não mais provisória) e trocá-la é 1 `CREATE OR REPLACE`
--   sem mudança de contrato.
--
-- Dinheiro: `mrr_cents`/`overdue_cents` em BIGINT cents (REQ-53/NFR-03).
-- `sum(bigint)` é convertido com `::bigint`; nenhum float/double/`numeric`
-- como tipo declarado. `count(*)` convertido com `::int`.
--
-- Segurança (REQ-38): `SECURITY DEFINER`, `SET search_path = ''`, chamadas
-- qualificadas (`pg_catalog.`/`public.`). `REVOKE ALL` de PUBLIC/anon/
-- authenticated/service_role ANTES do `GRANT EXECUTE TO authenticated`.
-- Rótulos fixos, sem id/PII.
--
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0070 e 0077–0081 intocadas.

-- ============ 0. Pré-condição dura (fail-closed) ============
DO $$
BEGIN
  IF to_regprocedure('public.is_super_admin()') IS NULL
    OR to_regclass('public.usage_events') IS NULL
    OR to_regclass('public.tenant_subscriptions') IS NULL
    OR to_regclass('public.tenant_invoices') IS NULL
    OR to_regclass('public.plan_catalog') IS NULL THEN
    RAISE EXCEPTION 'internal-read-precondition-missing';
  END IF;
END $$;

-- ============ 0b. Índice de suporte à série (H4/perf) ============
-- A UNIQUE (tenant_id, competencia, dedup_key) de 0023 não atende o filtro por
-- faixa de competência com group by (tenant_id lidera). Índice aditivo,
-- idempotente; nenhuma migration anterior é editada.
CREATE INDEX IF NOT EXISTS idx_usage_events_competencia_tenant
  ON public.usage_events (competencia, tenant_id);

-- ============ 1. Série de telemetria ============
CREATE OR REPLACE FUNCTION public.admin_usage_series(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_tenant uuid DEFAULT NULL
)
RETURNS TABLE (
  competencia date,
  tenant_id uuid,
  events bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_to date;
  v_from date;
  v_months int;
BEGIN
  -- InitPlan: gate avaliado 1x por statement (precedente 0042/0060).
  IF NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  v_to := COALESCE(
    pg_catalog.date_trunc('month', p_to::timestamp)::date,
    pg_catalog.date_trunc(
      'month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date
  );
  v_from := COALESCE(
    pg_catalog.date_trunc('month', p_from::timestamp)::date,
    (v_to - interval '11 months')::date
  );

  IF v_to < v_from THEN
    RAISE EXCEPTION 'usage-range-invalid';
  END IF;

  v_months := (
    (pg_catalog.date_part('year', v_to) - pg_catalog.date_part('year', v_from)) * 12
    + (pg_catalog.date_part('month', v_to) - pg_catalog.date_part('month', v_from))
    + 1
  )::int;

  IF v_months > 24 THEN
    RAISE EXCEPTION 'usage-range-invalid';
  END IF;

  RETURN QUERY
  SELECT ue.competencia,
         ue.tenant_id,
         pg_catalog.count(*)::bigint AS events
  FROM public.usage_events AS ue
  WHERE ue.competencia BETWEEN v_from AND v_to
    AND (p_tenant IS NULL OR ue.tenant_id = p_tenant)
  GROUP BY ue.competencia, ue.tenant_id
  ORDER BY ue.competencia ASC, ue.tenant_id ASC;
END;
$$;

COMMENT ON FUNCTION public.admin_usage_series(date, date, uuid) IS
  'Internal-control-plane F4 (BE-45/REQ-48): serie de usage_events por competencia/tenant. Gate is_super_admin(); default 12 competencias SP; rotulos not-admin/usage-range-invalid; agregado sem PII (sem auditoria propria).';

REVOKE ALL ON FUNCTION public.admin_usage_series(date, date, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_usage_series(date, date, uuid)
  TO authenticated;

-- ============ 2. Resumo de MRR / inadimplência ============
CREATE OR REPLACE FUNCTION public.admin_mrr_summary(p_competencia date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comp date;
  v_mrr_cents bigint;
  v_active_count int;
  v_past_due_count int;
  v_overdue_cents bigint;
  v_overdue_count int;
BEGIN
  -- InitPlan: gate avaliado 1x por statement (precedente 0042/0060).
  IF NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  v_comp := COALESCE(
    pg_catalog.date_trunc('month', p_competencia::timestamp)::date,
    pg_catalog.date_trunc(
      'month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date
  );

  -- MRR (O-F4-5, 2026-11-19): SOMENTE assinaturas `active`.
  SELECT COALESCE(pg_catalog.sum(pc.price_cents), 0)::bigint,
         pg_catalog.count(*)::int
    INTO v_mrr_cents, v_active_count
  FROM public.tenant_subscriptions AS s
  JOIN public.plan_catalog AS pc ON pc.slug = s.plan_slug
  WHERE s.status = 'active';

  -- `past_due` fica FORA do MRR e é contado aqui.
  SELECT pg_catalog.count(*)::int
    INTO v_past_due_count
  FROM public.tenant_subscriptions AS s
  WHERE s.status = 'past_due';

  -- Inadimplência: faturas de tenant com status `overdue` (BIGINT cents).
  SELECT COALESCE(pg_catalog.sum(i.amount_cents), 0)::bigint,
         pg_catalog.count(*)::int
    INTO v_overdue_cents, v_overdue_count
  FROM public.tenant_invoices AS i
  WHERE i.status = 'overdue';

  RETURN pg_catalog.jsonb_build_object(
    'competencia', v_comp,
    'mrr_cents', v_mrr_cents,
    'active_count', v_active_count,
    'past_due_count', v_past_due_count,
    'overdue_cents', v_overdue_cents,
    'overdue_count', v_overdue_count
  );
END;
$$;

COMMENT ON FUNCTION public.admin_mrr_summary(date) IS
  'Internal-control-plane F4 (BE-45/REQ-49): resumo jsonb de MRR/inadimplencia. Forma congelada: competencia, mrr_cents, active_count, past_due_count, overdue_cents, overdue_count. Gate is_super_admin(); cents em BIGINT; sem PII.';

COMMENT ON COLUMN public.tenant_subscriptions.status IS
  'Ciclo de vida da assinatura. DECISAO DE PRODUTO 2026-11-19 (O-F4-5): MRR (admin_mrr_summary) soma price_cents APENAS de status=active; past_due nao entra no MRR (conta em past_due_count e nas faturas overdue); trial/free nao adicionam receita.';

REVOKE ALL ON FUNCTION public.admin_mrr_summary(date)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_mrr_summary(date)
  TO authenticated;
