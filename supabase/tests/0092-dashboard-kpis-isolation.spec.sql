-- 0092-dashboard-kpis-isolation.spec.sql — ADR-001 / DASH-08 (backend/security).
-- TDD: asserções escritas ANTES da migration 0085_dashboard_kpis_rpc.sql.
--
-- Uso:
--   supabase db reset
--   supabase test db supabase/tests/0092-dashboard-kpis-isolation.spec.sql
--
-- Prova em banco real: dois tenants, dois usuários, fatura de B em aberto,
-- A≠B em K1..K5 e em mtd_current/mtd_previous (from/to/k2/k3), anon → 42501,
-- nenhum parâmetro de usuário na RPC e prosrc sem redação de linha sensível.
-- Toda fixture vive dentro de BEGIN/ROLLBACK.

\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_catalog;

select plan(29);

insert into auth.users (id, email) values
  ('a0920000-0000-4000-8000-0000000000a1', 'iso-a@example.com'),
  ('a0920000-0000-4000-8000-0000000000b1', 'iso-b@example.com');

do $$
declare
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := array[
    'a0920000-0000-4000-8000-0000000000a1'::uuid,
    'a0920000-0000-4000-8000-0000000000b1'::uuid
  ];
begin
  foreach v_user in array v_ids loop
    v_i := v_i + 1;
    insert into public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    values ('pf', v_user, pg_catalog.lpad((92000002000 + v_i)::text, 11, '0'),
            'Fixture 0092', 'full')
    returning id into v_tenant;
    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant, v_user, 'owner');
    insert into public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    values (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  end loop;
end $$;

insert into public.accounts (id, user_id, name, type, current_balance_cents) values
  ('e0920000-0000-4000-8000-0000000000a1', 'a0920000-0000-4000-8000-0000000000a1', 'A1', 'checking', 10000),
  ('e0920000-0000-4000-8000-0000000000a2', 'a0920000-0000-4000-8000-0000000000a1', 'A2', 'savings',  2550),
  ('e0920000-0000-4000-8000-0000000000b1', 'a0920000-0000-4000-8000-0000000000b1', 'B1', 'checking', 700000),
  ('e0920000-0000-4000-8000-0000000000b2', 'a0920000-0000-4000-8000-0000000000b1', 'B2', 'savings',   7777);

insert into public.credit_cards (id, user_id, account_id, name, closing_day, due_day) values
  ('c0920000-0000-4000-8000-0000000000a1', 'a0920000-0000-4000-8000-0000000000a1', 'e0920000-0000-4000-8000-0000000000a1', 'Cartão A', 10, 20),
  ('c0920000-0000-4000-8000-0000000000b1', 'a0920000-0000-4000-8000-0000000000b1', 'e0920000-0000-4000-8000-0000000000b1', 'Cartão B', 10, 20);

insert into public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, total_cents)
values
  ('f0920000-0000-4000-8000-000000000001', 'a0920000-0000-4000-8000-0000000000a1', 'c0920000-0000-4000-8000-0000000000a1', date_trunc('month', current_date)::date, date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 50000),
  ('f0920000-0000-4000-8000-000000000002', 'a0920000-0000-4000-8000-0000000000b1', 'c0920000-0000-4000-8000-0000000000b1', date_trunc('month', current_date)::date, date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 80000);

select set_config('app.invoice_rpc', 'on', true);
update public.invoices set status = 'partial', paid_cents = 20000
where id = 'f0920000-0000-4000-8000-000000000001';
select set_config('app.invoice_rpc', 'off', true);

insert into public.transactions (id, user_id, account_id, description, amount_cents, date, is_transfer, transfer_destination_account_id, type)
values
  ('d0920000-0000-4000-8000-0000000000a1', 'a0920000-0000-4000-8000-0000000000a1', 'e0920000-0000-4000-8000-0000000000a1', 'gasto A', 3400, date_trunc('month', current_date)::date, false, null, 'expense'),
  ('d0920000-0000-4000-8000-0000000000a2', 'a0920000-0000-4000-8000-0000000000a1', 'e0920000-0000-4000-8000-0000000000a1', 'receita A', 8000, date_trunc('month', current_date)::date, false, null, 'income'),
  ('d0920000-0000-4000-8000-0000000000a3', 'a0920000-0000-4000-8000-0000000000a1', 'e0920000-0000-4000-8000-0000000000a1', 'transfer A', 50000, date_trunc('month', current_date)::date, true, 'e0920000-0000-4000-8000-0000000000a2', 'expense'),
  ('d0920000-0000-4000-8000-0000000000a4', 'a0920000-0000-4000-8000-0000000000a1', 'e0920000-0000-4000-8000-0000000000a1', 'prevista A +1', 2000, current_date + 1, false, null, 'income'),
  ('d0920000-0000-4000-8000-0000000000a5', 'a0920000-0000-4000-8000-0000000000a1', 'e0920000-0000-4000-8000-0000000000a1', 'prevista A +30', 500, current_date + 30, false, null, 'expense'),
  ('d0920000-0000-4000-8000-0000000000b1', 'a0920000-0000-4000-8000-0000000000b1', 'e0920000-0000-4000-8000-0000000000b1', 'gasto B', 99000, date_trunc('month', current_date)::date, false, null, 'expense'),
  ('d0920000-0000-4000-8000-0000000000b2', 'a0920000-0000-4000-8000-0000000000b1', 'e0920000-0000-4000-8000-0000000000b1', 'receita B', 88000, date_trunc('month', current_date)::date, false, null, 'income'),
  ('d0920000-0000-4000-8000-0000000000b3', 'a0920000-0000-4000-8000-0000000000b1', 'e0920000-0000-4000-8000-0000000000b1', 'gasto B mês anterior', 33333, (date_trunc('month', current_date)::date - interval '1 month')::date, false, null, 'expense'),
  ('d0920000-0000-4000-8000-0000000000b4', 'a0920000-0000-4000-8000-0000000000b1', 'e0920000-0000-4000-8000-0000000000b1', 'receita B mês anterior', 22222, (date_trunc('month', current_date)::date - interval '1 month')::date, false, null, 'income'),
  ('d0920000-0000-4000-8000-0000000000b5', 'a0920000-0000-4000-8000-0000000000b1', 'e0920000-0000-4000-8000-0000000000b1', 'prevista B +1', 9000, current_date + 1, false, null, 'income'),
  ('d0920000-0000-4000-8000-0000000000b6', 'a0920000-0000-4000-8000-0000000000b1', 'e0920000-0000-4000-8000-0000000000b1', 'prevista B +30', 1000, current_date + 30, false, null, 'expense');

create temp table esperado_0092 as
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

grant select on esperado_0092 to authenticated;

create temp table stat_antes_0092 as
select relname, n_tup_ins, n_tup_upd, n_tup_del
from pg_stat_xact_user_tables
where relname in ('accounts', 'transactions', 'invoices', 'credit_cards', 'profiles');

-- ===========================================================================
-- Estrutura: nenhuma identidade vem do cliente
-- ===========================================================================

select is(
  (select proargnames from pg_proc
   where oid = 'public.get_dashboard_kpis(date)'::regprocedure),
  array['p_month'],
  'DASH-08: único argumento é p_month (sem p_user_id)'
);
select ok(
  (select prosrc from pg_proc
    where oid = 'public.get_dashboard_kpis(date)'::regprocedure)
    !~* '(raise[[:space:]]+(notice|log|warning)|to_jsonb[[:space:]]*\()',
  'DASH-08: prosrc sem RAISE NOTICE/LOG/WARNING e sem to_jsonb sensível'
);

-- ===========================================================================
-- Isolamento A vs B — chamadas autenticadas
-- ===========================================================================

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0920000-0000-4000-8000-0000000000a1', true);
select set_config('app.kpi_a_0092', public.get_dashboard_kpis(date '2026-11-01')::text, true);

select ok(
  (select tenant_id from public.accounts where id = 'e0920000-0000-4000-8000-0000000000a1')
    is distinct from
  (select tenant_id from public.accounts where id = 'e0920000-0000-4000-8000-0000000000b1'),
  'DASH-08: A e B pertencem a tenants distintos'
);

-- A -----------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0920000-0000-4000-8000-0000000000a1', true);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k1_liquidity_cents')::bigint,
  12550::bigint, 'DASH-08: K1 de A'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k2_realized_expense_cents')::bigint,
  3400::bigint, 'DASH-08: K2 de A'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k3_realized_income_cents')::bigint,
  8000::bigint, 'DASH-08: K3 de A'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k4_open_invoices_cents')::bigint,
  30000::bigint, 'DASH-08: K4 de A ignora a fatura aberta de B'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k5_projected_balance_cents')::bigint,
  14050::bigint, 'DASH-08: K5 de A'
);
select is(
  public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_current',
  jsonb_build_object(
    'from', (select v_start from esperado_0092),
    'to', (select v_end from esperado_0092),
    'k2_realized_expense_cents', 3400::bigint,
    'k3_realized_income_cents', 8000::bigint
  ),
  'DASH-08: mtd_current de A (from/to/k2/k3)'
);
select is(
  public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_previous',
  jsonb_build_object(
    'from', (select v_prev_start from esperado_0092),
    'to', (select v_prev_end from esperado_0092),
    'k2_realized_expense_cents', 0::bigint,
    'k3_realized_income_cents', 0::bigint
  ),
  'DASH-08: mtd_previous de A (from/to/k2/k3)'
);
select is(
  (select count(*) from jsonb_object_keys(public.get_dashboard_kpis(date '2026-11-01'))),
  9::bigint, 'DASH-08: A recebe as 9 chaves'
);
select ok(
  not exists (select 1 from jsonb_each(public.get_dashboard_kpis(date '2026-11-01'))
              where value = 'null'::jsonb),
  'DASH-08: A não recebe null'
);

-- B -----------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0920000-0000-4000-8000-0000000000b1', true);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k1_liquidity_cents')::bigint,
  707777::bigint, 'DASH-08: K1 de B'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k2_realized_expense_cents')::bigint,
  99000::bigint, 'DASH-08: K2 de B'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k3_realized_income_cents')::bigint,
  88000::bigint, 'DASH-08: K3 de B'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k4_open_invoices_cents')::bigint,
  80000::bigint, 'DASH-08: K4 de B (fatura em aberto de B)'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k5_projected_balance_cents')::bigint,
  715777::bigint, 'DASH-08: K5 de B'
);
select is(
  public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_previous',
  jsonb_build_object(
    'from', (select v_prev_start from esperado_0092),
    'to', (select v_prev_end from esperado_0092),
    'k2_realized_expense_cents', 33333::bigint,
    'k3_realized_income_cents', 22222::bigint
  ),
  'DASH-08: mtd_previous de B (from/to/k2/k3)'
);
select is(
  (select count(*) from jsonb_object_keys(public.get_dashboard_kpis(date '2026-11-01'))),
  9::bigint, 'DASH-08: B recebe as 9 chaves'
);
select ok(
  not exists (select 1 from jsonb_each(public.get_dashboard_kpis(date '2026-11-01'))
              where value = 'null'::jsonb),
  'DASH-08: B não recebe null'
);

-- A≠B provado em cada KPI e nas janelas MTD.
-- GUC local guarda o JSONB de A; B é chamado ao vivo sob o claim de B.
select ok(
  current_setting('app.kpi_a_0092')::jsonb ->> 'k1_liquidity_cents'
    is distinct from
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k1_liquidity_cents'),
  'DASH-08: A≠B em K1'
);
select ok(
  current_setting('app.kpi_a_0092')::jsonb ->> 'k2_realized_expense_cents'
    is distinct from
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k2_realized_expense_cents'),
  'DASH-08: A≠B em K2'
);
select ok(
  current_setting('app.kpi_a_0092')::jsonb ->> 'k3_realized_income_cents'
    is distinct from
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k3_realized_income_cents'),
  'DASH-08: A≠B em K3'
);
select ok(
  current_setting('app.kpi_a_0092')::jsonb ->> 'k4_open_invoices_cents'
    is distinct from
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k4_open_invoices_cents'),
  'DASH-08: A≠B em K4 (com fatura de B)'
);
select ok(
  current_setting('app.kpi_a_0092')::jsonb ->> 'k5_projected_balance_cents'
    is distinct from
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k5_projected_balance_cents'),
  'DASH-08: A≠B em K5'
);
select ok(
  current_setting('app.kpi_a_0092')::jsonb -> 'mtd_current'
    is distinct from
  (public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_current'),
  'DASH-08: A≠B em mtd_current'
);
select ok(
  current_setting('app.kpi_a_0092')::jsonb -> 'mtd_previous'
    is distinct from
  (public.get_dashboard_kpis(date '2026-11-01') -> 'mtd_previous'),
  'DASH-08: A≠B em mtd_previous'
);

reset role;

select is(
  ((select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)
    from pg_stat_xact_user_tables
    where relname in ('accounts', 'transactions', 'invoices', 'credit_cards', 'profiles'))
   - (select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from stat_antes_0092))::bigint,
  0::bigint,
  'DASH-08: delta pg_stat_xact_user_tables = 0'
);

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $q$ select public.get_dashboard_kpis(date '2026-11-01') $q$,
  '42501', null,
  'DASH-08: anon → 42501 permission denied'
);
reset role;

select * from finish();
rollback;

\echo '0092-dashboard-kpis-isolation.spec.sql: OK'
