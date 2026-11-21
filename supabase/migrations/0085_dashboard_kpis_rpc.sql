-- 0085_dashboard_kpis_rpc.sql — ADR-001 / DASH-01..08: RPC de KPIs reais.
--
-- Contrato congelado (ADR §4.1/§4.2):
--   get_dashboard_kpis(p_month date) RETURNS jsonb
--   LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp
--   REVOKE EXECUTE de PUBLIC/anon ANTES do GRANT a authenticated.
--
-- Regras vinculantes:
--   RN01  — todo *_cents é BIGINT; nenhum tipo de ponto flutuante;
--   RN04  — pagamento de fatura é is_transfer=true → fora de K2/K3;
--   BG-57 — direção vem de transactions.type, nunca da tabela de categorias;
--   nenhuma junção com categorias (lançamento sem categoria mantém direção).
--
-- Fórmulas:
--   K1 = Σ accounts.current_balance_cents do usuário;
--   K2/K3 = Σ amount_cents com type expense/income, is_transfer=false,
--           date ∈ [v_start, v_end] (compra com invoice_id entra);
--   K4 = Σ greatest(total_cents - paid_cents, 0) onde status <> 'paid'
--        OU paid_at IS NULL (domínio open|closed|partial|paid);
--   K5 = K1 + Σ previstas income - Σ previstas expense em
--        (as_of, as_of+30], SEM K4 (o ADR não pede filtro is_transfer aqui);
--   MTD anterior = mesmo número de dias, com clamp ao último dia válido.
--
-- Isolamento: `(select auth.uid())` em TODA agregação, inclusive janelas MTD.
-- invoices não tem tenant_id → predicado explícito de user_id + RLS herdada
-- (security invoker). Nenhum parâmetro de identidade recebido do cliente.
--
-- Aritmética 100% date (current_date, date_trunc, interval); sem instante com
-- fuso e sem conversão de fuso — transactions.date/due_date são datas civis.
--
-- SEM escrita, SEM elevação de privilégios, SEM logs, SEM serialização de linha.
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migration 0084 é pré-requisito. Nenhuma migration anterior é editada.

CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user        uuid := (select auth.uid());
  v_today       date := current_date;
  v_start       date := date_trunc('month', p_month)::date;
  v_month_end   date := (v_start + interval '1 month - 1 day')::date;
  v_end         date := least(greatest(v_today, v_start), v_month_end);
  v_days        int  := extract(day from v_end)::int;
  v_prev_start  date := (v_start - interval '1 month')::date;
  v_prev_last   date := (v_start - interval '1 day')::date;
  v_prev_end    date := least(v_prev_start + (v_days - 1), v_prev_last);
  v_k1          bigint;
  v_k2          bigint;
  v_k3          bigint;
  v_k4          bigint;
  v_k5          bigint;
  v_forecast_in  bigint;
  v_forecast_out bigint;
  v_prev_k2     bigint;
  v_prev_k3     bigint;
BEGIN
  SELECT coalesce(sum(a.current_balance_cents), 0)::bigint
    INTO v_k1
    FROM public.accounts AS a
   WHERE a.user_id = v_user;

  SELECT coalesce(sum(t.amount_cents), 0)::bigint
    INTO v_k2
    FROM public.transactions AS t
   WHERE t.user_id = v_user
     AND t.type = 'expense'
     AND t.is_transfer = false
     AND t.date >= v_start
     AND t.date <= v_end;

  SELECT coalesce(sum(t.amount_cents), 0)::bigint
    INTO v_k3
    FROM public.transactions AS t
   WHERE t.user_id = v_user
     AND t.type = 'income'
     AND t.is_transfer = false
     AND t.date >= v_start
     AND t.date <= v_end;

  SELECT coalesce(sum(greatest(i.total_cents - i.paid_cents, 0)), 0)::bigint
    INTO v_k4
    FROM public.invoices AS i
   WHERE i.user_id = (select auth.uid())
     AND (i.status <> 'paid' OR i.paid_at IS NULL);

  -- Janela aberta à esquerda: date = as_of NÃO entra; as_of+30 entra.
  -- Nenhum filtro is_transfer: formula congelada da ADR §4.2.
  SELECT coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'income'), 0)::bigint,
         coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'expense'), 0)::bigint
    INTO v_forecast_in, v_forecast_out
    FROM public.transactions AS t
   WHERE t.user_id = v_user
     AND t.date > v_today
     AND t.date <= (v_today + interval '30 days')::date;

  v_k5 := v_k1 + v_forecast_in - v_forecast_out;

  SELECT coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'expense'), 0)::bigint,
         coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'income'), 0)::bigint
    INTO v_prev_k2, v_prev_k3
    FROM public.transactions AS t
   WHERE t.user_id = v_user
     AND t.is_transfer = false
     AND t.date >= v_prev_start
     AND t.date <= v_prev_end;

  RETURN jsonb_build_object(
    'month', v_start,
    'as_of', v_today,
    'k1_liquidity_cents', v_k1,
    'k2_realized_expense_cents', v_k2,
    'k3_realized_income_cents', v_k3,
    'k4_open_invoices_cents', v_k4,
    'k5_projected_balance_cents', v_k5,
    'mtd_current', jsonb_build_object(
      'from', v_start,
      'to', v_end,
      'k2_realized_expense_cents', v_k2,
      'k3_realized_income_cents', v_k3
    ),
    'mtd_previous', jsonb_build_object(
      'from', v_prev_start,
      'to', v_prev_end,
      'k2_realized_expense_cents', v_prev_k2,
      'k3_realized_income_cents', v_prev_k3
    )
  );
END;
$$;

COMMENT ON FUNCTION public.get_dashboard_kpis(date) IS
  'ADR-001: K1..K5 + comparativo MTD em BIGINT cêntimos. SECURITY INVOKER, STABLE, search_path fixo; identidade exclusiva de auth.uid(); K4 nunca deduzido de K5.';

-- Ordem importa: negar a PUBLIC/anon ANTES de conceder a authenticated.
REVOKE ALL ON FUNCTION public.get_dashboard_kpis(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_kpis(date) TO authenticated;
