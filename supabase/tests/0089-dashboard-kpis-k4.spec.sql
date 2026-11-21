-- 0089-dashboard-kpis-k4.spec.sql — ADR-001 / DASH-05 (K4: faturas em aberto).
-- Predicado status<>'paid' OR paid_at IS NULL; valor = greatest(total-paid,0);
-- domínio open|closed|partial|paid; invoices isolado por user_id = auth.uid().

\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_catalog;

select plan(1);

insert into auth.users (id, email) values
  ('a0890000-0000-4000-8000-0000000000a1', 'k4-a@example.com'),
  ('a0890000-0000-4000-8000-0000000000b1', 'k4-b@example.com');

do $$
declare
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := array[
    'a0890000-0000-4000-8000-0000000000a1'::uuid,
    'a0890000-0000-4000-8000-0000000000b1'::uuid
  ];
begin
  foreach v_user in array v_ids loop
    v_i := v_i + 1;
    insert into public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    values ('pf', v_user, pg_catalog.lpad((89000002000 + v_i)::text, 11, '0'),
            'Fixture 0089', 'full')
    returning id into v_tenant;
    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant, v_user, 'owner');
    insert into public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    values (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  end loop;
end $$;

insert into public.accounts (id, user_id, name, type, current_balance_cents) values
  ('e0890000-0000-4000-8000-0000000000a1', 'a0890000-0000-4000-8000-0000000000a1', 'A1', 'checking', 10000),
  ('e0890000-0000-4000-8000-0000000000b1', 'a0890000-0000-4000-8000-0000000000b1', 'B1', 'checking', 999999);

insert into public.credit_cards (id, user_id, account_id, name, closing_day, due_day) values
  ('c0890000-0000-4000-8000-0000000000a1', 'a0890000-0000-4000-8000-0000000000a1', 'e0890000-0000-4000-8000-0000000000a1', 'Cartão A', 10, 20),
  ('c0890000-0000-4000-8000-0000000000b1', 'a0890000-0000-4000-8000-0000000000b1', 'e0890000-0000-4000-8000-0000000000b1', 'Cartão B', 10, 20);

insert into public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, total_cents)
values
  ('f0890000-0000-4000-8000-000000000001', 'a0890000-0000-4000-8000-0000000000a1', 'c0890000-0000-4000-8000-0000000000a1', date_trunc('month', current_date)::date,     date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 50000),
  ('f0890000-0000-4000-8000-000000000002', 'a0890000-0000-4000-8000-0000000000a1', 'c0890000-0000-4000-8000-0000000000a1', date_trunc('month', current_date)::date + 1, date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 10000),
  ('f0890000-0000-4000-8000-000000000003', 'a0890000-0000-4000-8000-0000000000a1', 'c0890000-0000-4000-8000-0000000000a1', date_trunc('month', current_date)::date + 2, date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 7000),
  ('f0890000-0000-4000-8000-000000000004', 'a0890000-0000-4000-8000-0000000000a1', 'c0890000-0000-4000-8000-0000000000a1', date_trunc('month', current_date)::date + 3, date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 60000),
  ('f0890000-0000-4000-8000-000000000005', 'a0890000-0000-4000-8000-0000000000b1', 'c0890000-0000-4000-8000-0000000000b1', date_trunc('month', current_date)::date,     date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 80000);

select set_config('app.invoice_rpc', 'on', true);
update public.invoices set status = 'partial', paid_cents = 20000 where id = 'f0890000-0000-4000-8000-000000000001';
update public.invoices set status = 'partial', paid_cents = 15000 where id = 'f0890000-0000-4000-8000-000000000002'; -- overpay → 0
update public.invoices set status = 'closed'                    where id = 'f0890000-0000-4000-8000-000000000003'; -- paid_at null entra
update public.invoices set status = 'paid', paid_at = now()     where id = 'f0890000-0000-4000-8000-000000000004'; -- fora
select set_config('app.invoice_rpc', 'off', true);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0890000-0000-4000-8000-0000000000a1', true);

select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k4_open_invoices_cents')::bigint,
  37000::bigint,
  'DASH-05: K4 = 30000 parcial + 0 overpay + 7000 closed; paid fora'
);

reset role;
select * from finish();
rollback;

\echo '0089-dashboard-kpis-k4.spec.sql: OK'
