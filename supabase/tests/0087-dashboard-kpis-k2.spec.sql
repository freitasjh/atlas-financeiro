-- 0087-dashboard-kpis-k2.spec.sql — ADR-001 / DASH-03 (K2: gasto realizado MTD).
-- Regras congeladas: type='expense' AND is_transfer=false AND date ∈ [v_start,
-- as_of]; compra com invoice_id ENTRA; categorias NÃO são consultadas (BG-57);
-- pagamento de fatura (is_transfer=true) NÃO entra (RN04).

\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_catalog;

select plan(1);

insert into auth.users (id, email) values
  ('a0870000-0000-4000-8000-0000000000a1', 'k2-a@example.com'),
  ('a0870000-0000-4000-8000-0000000000b1', 'k2-b@example.com');

do $$
declare
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := array[
    'a0870000-0000-4000-8000-0000000000a1'::uuid,
    'a0870000-0000-4000-8000-0000000000b1'::uuid
  ];
begin
  foreach v_user in array v_ids loop
    v_i := v_i + 1;
    insert into public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    values ('pf', v_user, pg_catalog.lpad((87000002000 + v_i)::text, 11, '0'),
            'Fixture 0087', 'full')
    returning id into v_tenant;
    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant, v_user, 'owner');
    insert into public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    values (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  end loop;
end $$;

insert into public.accounts (id, user_id, name, type, current_balance_cents) values
  ('e0870000-0000-4000-8000-0000000000a1', 'a0870000-0000-4000-8000-0000000000a1', 'A1', 'checking', 10000),
  ('e0870000-0000-4000-8000-0000000000b1', 'a0870000-0000-4000-8000-0000000000b1', 'B1', 'checking', 999999);

insert into public.credit_cards (id, user_id, account_id, name, closing_day, due_day) values
  ('c0870000-0000-4000-8000-0000000000a1', 'a0870000-0000-4000-8000-0000000000a1', 'e0870000-0000-4000-8000-0000000000a1', 'Cartão A', 10, 20);

insert into public.invoices (id, user_id, credit_card_id, period_start, period_end, due_date, total_cents)
values
  ('f0870000-0000-4000-8000-000000000001', 'a0870000-0000-4000-8000-0000000000a1', 'c0870000-0000-4000-8000-0000000000a1', date_trunc('month', current_date)::date, date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 50000),
  ('f0870000-0000-4000-8000-000000000002', 'a0870000-0000-4000-8000-0000000000a1', 'c0870000-0000-4000-8000-0000000000a1', date_trunc('month', current_date)::date + 1, date_trunc('month', current_date)::date + 29, date_trunc('month', current_date)::date + 30, 60000);

select set_config('app.invoice_rpc', 'on', true);
update public.invoices set status = 'partial', paid_cents = 20000
where id = 'f0870000-0000-4000-8000-000000000001';
update public.invoices set status = 'paid', paid_at = now()
where id = 'f0870000-0000-4000-8000-000000000002';
select set_config('app.invoice_rpc', 'off', true);

insert into public.transactions (id, user_id, account_id, invoice_id, category_id, description, amount_cents, date, is_transfer, type)
values
  ('d0870000-0000-4000-8000-000000000001', 'a0870000-0000-4000-8000-0000000000a1', 'e0870000-0000-4000-8000-0000000000a1', 'f0870000-0000-4000-8000-000000000001', null, 'compra cartão', 3400, date_trunc('month', current_date)::date, false, 'expense'),
  ('d0870000-0000-4000-8000-000000000002', 'a0870000-0000-4000-8000-0000000000a1', 'e0870000-0000-4000-8000-0000000000a1', 'f0870000-0000-4000-8000-000000000002', null, 'paga fatura', 50000, date_trunc('month', current_date)::date, true, 'expense'),
  ('d0870000-0000-4000-8000-000000000003', 'a0870000-0000-4000-8000-0000000000a1', 'e0870000-0000-4000-8000-0000000000a1', null, null, 'fora da janela', 7777, (date_trunc('month', current_date)::date - 1), false, 'expense'),
  ('d0870000-0000-4000-8000-0000000000b1', 'a0870000-0000-4000-8000-0000000000b1', 'e0870000-0000-4000-8000-0000000000b1', null, null, 'gasto B', 99000, date_trunc('month', current_date)::date, false, 'expense');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0870000-0000-4000-8000-0000000000a1', true);

select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k2_realized_expense_cents')::bigint,
  3400::bigint,
  'DASH-03: K2 = compra com invoice_id; transfer e fora-da-janela fora'
);

reset role;
select * from finish();
rollback;

\echo '0087-dashboard-kpis-k2.spec.sql: OK'
