-- 0091-dashboard-kpis-mtd-clamp.spec.sql — ADR-001 / DASH-07.
-- Aritmética 100% em date: current_date, date_trunc, interval; proibido
-- timestamptz / AT TIME ZONE. MTD corrente = [1º do mês, as_of] com clamp;
-- MTD anterior = mesmo nº de dias limitado ao último dia válido do mês anterior.

\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_catalog;

select plan(13);

select ok(
  pg_get_functiondef('public.get_dashboard_kpis(date)'::regprocedure)
    !~* '(at[[:space:]]+time[[:space:]]+zone|timestamp[[:space:]]+with[[:space:]]+time[[:space:]]+zone|timestamptz)',
  'DASH-07: def da RPC sem timestamptz / AT TIME ZONE'
);

insert into auth.users (id, email) values
  ('a0910000-0000-4000-8000-0000000000a1', 'mtd-a@example.com');

do $$
declare
  v_tenant uuid;
begin
  insert into public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
  values ('pf', 'a0910000-0000-4000-8000-0000000000a1',
          pg_catalog.lpad(91000002000::text, 11, '0'), 'Fixture 0091', 'full')
  returning id into v_tenant;
  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_tenant, 'a0910000-0000-4000-8000-0000000000a1', 'owner');
  insert into public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
  values (v_tenant, 'termos-2026-11-v1', pg_catalog.now(),
          'a0910000-0000-4000-8000-0000000000a1');
end $$;

insert into public.accounts (id, user_id, name, type, current_balance_cents) values
  ('e0910000-0000-4000-8000-0000000000a1', 'a0910000-0000-4000-8000-0000000000a1', 'A1', 'checking', 12550);

insert into public.transactions (id, user_id, account_id, description, amount_cents, date, is_transfer, type)
values
  ('d0910000-0000-4000-8000-000000000001', 'a0910000-0000-4000-8000-0000000000a1', 'e0910000-0000-4000-8000-0000000000a1', 'gasto A',   3400, date_trunc('month', current_date)::date, false, 'expense'),
  ('d0910000-0000-4000-8000-000000000002', 'a0910000-0000-4000-8000-0000000000a1', 'e0910000-0000-4000-8000-0000000000a1', 'receita A', 8000, date_trunc('month', current_date)::date, false, 'income');

-- Janelas esperadas, calculadas de forma independente (date-only, sem timezone).
create temp table esperado_0091 as
select
  date_trunc('month', current_date)::date as v_start,
  least(greatest(current_date, date_trunc('month', current_date)::date),
        (date_trunc('month', current_date)::date + interval '1 month - 1 day')::date) as v_end,
  ((date_trunc('month', current_date)::date - interval '1 month')::date) as v_prev_start,
  least((date_trunc('month', current_date)::date - interval '1 month')::date
          + (extract(day from least(greatest(current_date,
                date_trunc('month', current_date)::date),
                (date_trunc('month', current_date)::date + interval '1 month - 1 day')::date))::int - 1),
        (date_trunc('month', current_date)::date - interval '1 day')::date) as v_prev_end;

grant select on esperado_0091 to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0910000-0000-4000-8000-0000000000a1', true);

select is(
  public.get_dashboard_kpis(date '2026-11-01') ->> 'month',
  (select v_start from esperado_0091)::text,
  'DASH-07: month normalizado para o 1º dia'
);
select is(
  public.get_dashboard_kpis(date '2026-11-01') ->> 'as_of',
  current_date::text,
  'DASH-07: as_of = current_date'
);
select is(
  public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_current' ->> 'from',
  (select v_start from esperado_0091)::text,
  'DASH-07: mtd_current.from'
);
select is(
  public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_current' ->> 'to',
  (select v_end from esperado_0091)::text,
  'DASH-07: mtd_current.to (clamp ao fim do mês)'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_current' ->> 'k2_realized_expense_cents')::bigint,
  3400::bigint,
  'DASH-07: mtd_current.k2'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_current' ->> 'k3_realized_income_cents')::bigint,
  8000::bigint,
  'DASH-07: mtd_current.k3'
);
select is(
  public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_previous' ->> 'from',
  (select v_prev_start from esperado_0091)::text,
  'DASH-07: mtd_previous.from'
);
select is(
  public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_previous' ->> 'to',
  (select v_prev_end from esperado_0091)::text,
  'DASH-07: mtd_previous.to'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_previous' ->> 'k2_realized_expense_cents')::bigint,
  0::bigint,
  'DASH-07: mtd_previous.k2 (A não tem gastos na janela anterior)'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_previous' ->> 'k3_realized_income_cents')::bigint,
  0::bigint,
  'DASH-07: mtd_previous.k3'
);

reset role;

-- Clamp em meses curtos: prova aritmética date-only da regra congelada.
select is(
  least((date '2026-03-01' - interval '1 month')::date + (31 - 1),
        (date '2026-03-01' - interval '1 day')::date)::text,
  '2026-02-28',
  'DASH-07: as_of=2026-03-31 → mtd_previous.to=2026-02-28'
);
select is(
  least((date '2026-11-01' - interval '1 month')::date + (21 - 1),
        (date '2026-11-01' - interval '1 day')::date)::text,
  '2026-10-21',
  'DASH-07: as_of=2026-11-21 → mtd_previous.to=2026-10-21'
);

select * from finish();
rollback;

\echo '0091-dashboard-kpis-mtd-clamp.spec.sql: OK'
