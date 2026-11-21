-- 0090-dashboard-kpis-k5.spec.sql — ADR-001 / DASH-06.
-- K5 = K1 + Σ previstas income − Σ previstas expense, janela (as_of, as_of+30];
-- K4 NUNCA é subtraído (dupla contagem com RN04). Cenário A (com fatura
-- aberta) vs C (sem fatura e sem previstas) prova a independência.

\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_catalog;

select plan(4);

insert into auth.users (id, email) values
  ('a0900000-0000-4000-8000-0000000000a1', 'k5-a@example.com'),
  ('a0900000-0000-4000-8000-0000000000c1', 'k5-c@example.com');

do $$
declare
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := array[
    'a0900000-0000-4000-8000-0000000000a1'::uuid,
    'a0900000-0000-4000-8000-0000000000c1'::uuid
  ];
begin
  foreach v_user in array v_ids loop
    v_i := v_i + 1;
    insert into public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    values ('pf', v_user, pg_catalog.lpad((90000002000 + v_i)::text, 11, '0'),
            'Fixture 0090', 'full')
    returning id into v_tenant;
    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant, v_user, 'owner');
    insert into public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    values (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  end loop;
end $$;

insert into public.accounts (id, user_id, name, type, current_balance_cents) values
  ('e0900000-0000-4000-8000-0000000000a1', 'a0900000-0000-4000-8000-0000000000a1', 'A1', 'checking', 12550),
  ('e0900000-0000-4000-8000-0000000000a2', 'a0900000-0000-4000-8000-0000000000a1', 'A2', 'savings',  0),
  ('e0900000-0000-4000-8000-0000000000c1', 'a0900000-0000-4000-8000-0000000000c1', 'C1', 'checking', 1000);

insert into public.credit_cards (id, user_id, account_id, name, closing_day, due_day) values
  ('c0900000-0000-4000-8000-0000000000a1', 'a0900000-0000-4000-8000-0000000000a1', 'e0900000-0000-4000-8000-0000000000a1', 'Cartão A', 10, 20);

insert into public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, total_cents)
values
  ('f0900000-0000-4000-8000-000000000001', 'a0900000-0000-4000-8000-0000000000a1', 'c0900000-0000-4000-8000-0000000000a1', date_trunc('month', current_date)::date, date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 50000);

select set_config('app.invoice_rpc', 'on', true);
update public.invoices set status = 'partial', paid_cents = 20000
where id = 'f0900000-0000-4000-8000-000000000001';
select set_config('app.invoice_rpc', 'off', true);

insert into public.transactions (id, user_id, account_id, description, amount_cents, date, is_transfer, transfer_destination_account_id, type)
values
  ('d0900000-0000-4000-8000-000000000001', 'a0900000-0000-4000-8000-0000000000a1', 'e0900000-0000-4000-8000-0000000000a1', 'prevista income +1',  2000, current_date + 1,  false, null, 'income'),
  ('d0900000-0000-4000-8000-000000000002', 'a0900000-0000-4000-8000-0000000000a1', 'e0900000-0000-4000-8000-0000000000a1', 'prevista expense +30', 500, current_date + 30, false, null, 'expense'),
  ('d0900000-0000-4000-8000-000000000003', 'a0900000-0000-4000-8000-0000000000a1', 'e0900000-0000-4000-8000-0000000000a1', 'prevista +31 fora', 111, current_date + 31, false, null, 'income'),
  ('d0900000-0000-4000-8000-000000000004', 'a0900000-0000-4000-8000-0000000000a1', 'e0900000-0000-4000-8000-0000000000a1', 'as_of não entra K5', 222, current_date, true, 'e0900000-0000-4000-8000-0000000000a2', 'income');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0900000-0000-4000-8000-0000000000a1', true);

select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k5_projected_balance_cents')::bigint,
  14050::bigint,
  'DASH-06: K5 = K1 + 2000 - 500 (janela (as_of, as_of+30])'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k5_projected_balance_cents')::bigint
    - (public.get_dashboard_kpis(date '2026-11-01') ->> 'k1_liquidity_cents')::bigint,
  1500::bigint,
  'DASH-06: K5-K1 = fluxo previsto, sem K4'
);

-- C: conta sem faturas e sem previstas → K4=0 e K5-K1=0.
select set_config('request.jwt.claim.sub', 'a0900000-0000-4000-8000-0000000000c1', true);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k4_open_invoices_cents')::bigint,
  0::bigint,
  'DASH-06: usuário sem faturas tem K4=0'
);
select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k5_projected_balance_cents')::bigint
    - (public.get_dashboard_kpis(date '2026-11-01') ->> 'k1_liquidity_cents')::bigint,
  0::bigint,
  'DASH-06: sem previstas, K5=K1 (cenário sem fatura)'
);

reset role;
select * from finish();
rollback;

\echo '0090-dashboard-kpis-k5.spec.sql: OK'
