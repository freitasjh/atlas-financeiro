-- 0086-dashboard-kpis-k1.spec.sql — ADR-001 / DASH-02 (K1: liquidez em cêntimos).
-- K1 = Σ accounts.current_balance_cents do usuário (RN01 + RLS).
-- BEGIN/ROLLBACK: fixtures não persistem.

\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_catalog;

select plan(2);

insert into auth.users (id, email) values
  ('a0860000-0000-4000-8000-0000000000a1', 'k1-a@example.com'),
  ('a0860000-0000-4000-8000-0000000000b1', 'k1-b@example.com'),
  ('a0860000-0000-4000-8000-0000000000d1', 'k1-d@example.com');

do $$
declare
  v_user uuid;
  v_tenant uuid;
  v_i int := 0;
  v_ids uuid[] := array[
    'a0860000-0000-4000-8000-0000000000a1'::uuid,
    'a0860000-0000-4000-8000-0000000000b1'::uuid
  ];
begin
  foreach v_user in array v_ids loop
    v_i := v_i + 1;
    insert into public.tenants (kind, owner_user_id, cpf, razao_social, plan_id)
    values ('pf', v_user, pg_catalog.lpad((86000002000 + v_i)::text, 11, '0'),
            'Fixture 0086', 'full')
    returning id into v_tenant;
    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant, v_user, 'owner');
    insert into public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
    values (v_tenant, 'termos-2026-11-v1', pg_catalog.now(), v_user);
  end loop;
end $$;

insert into public.accounts (id, user_id, name, type, current_balance_cents) values
  ('e0860000-0000-4000-8000-0000000000a1', 'a0860000-0000-4000-8000-0000000000a1', 'A1', 'checking', 10000),
  ('e0860000-0000-4000-8000-0000000000a2', 'a0860000-0000-4000-8000-0000000000a1', 'A2', 'savings',  2550),
  ('e0860000-0000-4000-8000-0000000000b1', 'a0860000-0000-4000-8000-0000000000b1', 'B1', 'checking', 999999);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0860000-0000-4000-8000-0000000000a1', true);

select is(
  (public.get_dashboard_kpis(date '2026-11-01') ->> 'k1_liquidity_cents')::bigint,
  12550::bigint,
  'DASH-02: K1 = 10000 + 2550 cêntimos'
);

-- D: usuário sem contas → nunca null, sempre 0.
select set_config('request.jwt.claim.sub', 'a0860000-0000-4000-8000-0000000000d1', true);
select is(
  (select count(*) from jsonb_each(public.get_dashboard_kpis(date '2026-11-01'))
   where key like '%\_cents' and value <> '0'::jsonb),
  0::bigint,
  'DASH-01: usuário vazio → todo *_cents = 0'
);

reset role;
select * from finish();
rollback;

\echo '0086-dashboard-kpis-k1.spec.sql: OK'
