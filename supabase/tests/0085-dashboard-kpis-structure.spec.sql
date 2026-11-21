-- 0085-dashboard-kpis-structure.spec.sql — ADR-001 / DASH-01 (estrutura da RPC).
-- TDD: asserções escritas ANTES da migration 0085_dashboard_kpis_rpc.sql.
--
-- Uso:
--   supabase db reset
--   supabase test db supabase/tests/0085-dashboard-kpis-structure.spec.sql
--
-- Prova em banco real: pg_proc (STABLE/INVOKER/search_path/1 argumento),
-- grants (PUBLIC e anon negados, authenticated permitido), 2º argumento,
-- 9 chaves exatas sem null em BIGINT, redação segura do prosrc e delta
-- pg_stat_xact_user_tables = 0. BEGIN/ROLLBACK: sem resíduo de fixture.

\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_catalog;

select plan(15);

-- ===========================================================================
-- DASH-01 — contrato congelado (E1/E3/E4/E5)
-- ===========================================================================

select ok(
  to_regprocedure('public.get_dashboard_kpis(date)') is not null,
  'DASH-01: public.get_dashboard_kpis(date) existe'
);
select is(
  (select provolatile from pg_proc where oid = 'public.get_dashboard_kpis(date)'::regprocedure),
  's'::"char",
  'DASH-01: provolatile=s (STABLE)'
);
select is(
  (select prosecdef from pg_proc where oid = 'public.get_dashboard_kpis(date)'::regprocedure),
  false,
  'DASH-01: prosecdef=false (SECURITY INVOKER)'
);
select ok(
  exists (
    select 1
    from unnest((select proconfig from pg_proc
                 where oid = 'public.get_dashboard_kpis(date)'::regprocedure)) as c
    where c = 'search_path=public, pg_temp'
  ),
  'DASH-01: proconfig com search_path=public, pg_temp'
);
select is(
  (select pronargs from pg_proc where oid = 'public.get_dashboard_kpis(date)'::regprocedure),
  1::int2,
  'DASH-01: exatamente um parâmetro (sem p_user_id)'
);
select ok(
  has_function_privilege('authenticated', 'public.get_dashboard_kpis(date)', 'EXECUTE'),
  'DASH-01: EXECUTE concedido a authenticated'
);
select ok(
  not has_function_privilege('anon', 'public.get_dashboard_kpis(date)', 'EXECUTE'),
  'DASH-01: EXECUTE negado a anon'
);
select ok(
  not exists (
    select 1
    from aclexplode((select proacl from pg_proc
                     where oid = 'public.get_dashboard_kpis(date)'::regprocedure))
    where grantee = 0 and privilege_type = 'EXECUTE'
  ),
  'DASH-01: EXECUTE negado a PUBLIC'
);
select ok(
  (select prosrc from pg_proc
    where oid = 'public.get_dashboard_kpis(date)'::regprocedure)
    !~* '(raise[[:space:]]+(notice|log|warning)|to_jsonb[[:space:]]*\()',
  'DASH-01: prosrc sem RAISE NOTICE/LOG/WARNING e sem to_jsonb de linha'
);
select throws_ok(
  $q$ select public.get_dashboard_kpis(date '2026-11-01', 1) $q$,
  '42883',
  null,
  'DASH-01: segundo argumento falha'
);

-- Snapshot ANTES de qualquer chamada — prova de 0 escrita (E5).
create temp table stat_antes_0085 as
select relname, n_tup_ins, n_tup_upd, n_tup_del
from pg_stat_xact_user_tables
where relname in ('accounts', 'transactions', 'invoices', 'credit_cards', 'profiles');

-- Chaves exatas em BIGINT, mesmo sem nenhuma fixture (retorno não nulo).
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '', true);

select is(
  (select count(*) from jsonb_object_keys(public.get_dashboard_kpis(date '2026-11-01'))),
  9::bigint,
  'DASH-01: exatamente 9 chaves'
);
select ok(
  not exists (
    select 1 from jsonb_each(public.get_dashboard_kpis(date '2026-11-01'))
    where value = 'null'::jsonb
  ),
  'DASH-01: nenhuma chave com null'
);
select ok(
  (select bool_and(jsonb_typeof(value) = 'number'
                   and value::text::numeric = trunc(value::text::numeric))
   from jsonb_each(public.get_dashboard_kpis(date '2026-11-01'))
   where key like '%\_cents'),
  'DASH-01: todo *_cents é inteiro (sem ponto flutuante)'
);

reset role;
select is(
  ((select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)
    from pg_stat_xact_user_tables
    where relname in ('accounts', 'transactions', 'invoices', 'credit_cards', 'profiles'))
   - (select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from stat_antes_0085))::bigint,
  0::bigint,
  'DASH-01: delta pg_stat_xact_user_tables = 0 (RPC não escreve)'
);

-- anon: 42501
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $q$ select public.get_dashboard_kpis(date '2026-11-01') $q$,
  '42501',
  null,
  'DASH-01: anon → 42501 permission denied'
);
reset role;

select * from finish();
rollback;

\echo '0085-dashboard-kpis-structure.spec.sql: OK'
