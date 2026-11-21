-- 0088-dashboard-kpis-k3.spec.sql — ADR-001 / DASH-04 (K3: receita realizada MTD).
-- BG-57: direção por transactions.type; categoria nula permanece income.
-- RN04: transferência recebida (is_transfer=true) NÃO entra em K3.

\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_catalog;

select plan(1);

insert into auth.users (id, email) values
  ('a0880000-0000-4000-8000-0000000000a1', 'k3-a@example.com'),
  ('a0880000-0000-4000-8000-0000000000b1', 'k3-b@example.com');

do $$
declare
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := array[
    'a0880000-0000-4000-8000-0000000000a1'::uuid,
    'a0880000-0000-4000-8000-0000000000b1'::uuid
  ];
begin
  foreach v_user in array v_ids loop
    v_i := v_i + 1;
    insert into public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    values ('pf', v_user, pg_catalog.lpad((88000002000 + v_i)::text, 11, '0'),
            'Fixture 0088', 'full')
    returning id into v_tenant;
    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant, v_user, 'owner');
    insert into public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    values (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  end loop;
end $$;

insert into public.accounts (id, user_id, name, type, current_balance_cents) values
  ('e0880000-0000-4000-8000-0000000000a1', 'a0880000-0000-4000-8000-0000000000a1', 'A1', 'checking', 10000),
  ('e0880000-0000-4000-8000-0000000000a2', 'a0880000-0000-4000-8000-0000000000a1', 'A2', 'savings',  2550),
  ('e0880000-0000-4000-8000-0000000000b1', 'a0880000-0000-4000-8000-0000000000b1', 'B1', 'checking', 999999);

insert into public.transactions (id, user_id, account_id, category_id, description, amount_cents, date, is_transfer, transfer_destination_account_id, type)
values
  ('d0880000-0000-4000-8000-000000000001', 'a0880000-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-0000000000a1', null, 'salário sem categoria', 8000, date_trunc('month', current_date)::date, false, null, 'income'),
  ('d0880000-0000-4000-8000-000000000002', 'a0880000-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-0000000000a1', null, 'transferência recebida', 90000, date_trunc('month', current_date)::date, true, 'e0880000-0000-4000-8000-0000000000a2', 'income'),
  ('d0880000-0000-4000-8000-0000000000b1', 'a0880000-0000-4000-8000-0000000000b1', 'e0880000-0000-4000-8000-0000000000b1', null, 'receita B', 88000, date_trunc('month', current_date)::date, false, null, 'income');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0880000-0000-4000-8000-0000000000a1', true);

select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k3_realized_income_cents')::bigint,
  8000::bigint,
  'DASH-04: K3 = income sem categoria; transferência fora (BG-57)'
);

reset role;
select * from finish();
rollback;

\echo '0088-dashboard-kpis-k3.spec.sql: OK'
