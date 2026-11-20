-- 0041_internal_operators.sql — internal-admin L0 / T01 (ADR-01/ADR-04/ADR-05).
--
-- Motivo (SPEC §1 ADR-01): a ordem `profiles.role=super_admin` presta para o
-- backoffice tenant, não para a identidade interna (`/internal-admin`): se a flag virar
-- coluna de `profiles`, os dois donos derivam (dupla) e qualquer rota tenant
-- alcança a rota interna. A fronteira é entidade separada, deny-all, só
-- `service_role` lê/escreve — o único caminho do operador é a Edge
-- `verify-operator` (L1), que checa a linha com `service_role` após
-- `auth.getUser(jwt)`. `profiles` não ganha coluna nem muda role/status
-- aqui (só provisionamento do seed em §4); `is_admin()`/`is_aal2()`
-- seguem preservados (ADR-03, sem reescrita de RPCs).
--
-- Entrega (server-side; read-only para os papéis JWT de cliente):
--   1) `public.internal_operators(user_id PK → auth.users ON DELETE RESTRICT,
--      active, created_at, created_by → auth.users, disabled_at)` — mínima
--      (ADR-05: operador binário, sem permissão granular). A tabela vive em
--      `public` (config.toml expõe só public/graphql_public) mas `REVOKE ALL`
--      de `PUBLIC, anon, authenticated, service_role` + `RLS ENABLED` sem
--      nenhuma policy permissiva = deny-all: SELECT/INSERT/UPDATE/DELETE pelo
--      cliente negam com 42501 e 0 linhas enumeradas (T-DENY-AUTH/ANON no
--      spec 44). `service_role` (Edge/seed) é o único papel com privilege de
--      tabela, por GRANT explícito mínimo (SELECT/INSERT/UPDATE/DELETE): sem
--      TRUNCATE/REFERENCES/TRIGGER/MAINTAIN do default ALL do Supabase
--      (precedente 0020).
--      `ON DELETE RESTRICT` em `user_id`: apagar o auth.users de um operador
--      com linha nega com 23503 em vez de cascatear o histórico (precedente
--      dos delete-guards de cartão; o histórico some só por ato explícito).
--   2) `private.is_internal_operator()` — STABLE SECURITY DEFINER
--      search_path='' (precedente `private.is_aal2()` 0037), schema `private`
--      fora do PostgREST. `true` só com sessão E linha active=true;
--      sem sessão/sem linha/inativo → false, nunca raise (fail-closed: a
--      prova real continua sendo a Edge; o helper serve às RPCs de L3).
--      Sem `current_user`: a identidade vem de `auth.uid()` (o Auth).
--   3) Backfill (SPEC §3): `profiles.id → internal_operators.user_id WHERE
--      NOT EXISTS` SÓ para `role='super_admin'` atuais, sempre `active=false`
--      — enroll MFA forçado antes de `active=true` (L2/L3 ativam quem já
--      enrollou; este lote nunca auto-ativa). Contagem auditada via
--      `RAISE NOTICE` (log da migration no `supabase db reset`).
--   4) Provisionamento do seed (seed.sql após a migration no `db reset`):
--      o dono seed nasce `super_admin` DEPOIS do DO acima (0 linhas no
--      reset limpo), então o seed insere a sua linha inativa junto (ato
--      explícito, mesmo predicado do backfill). Trigger global foi medido
--      e rejeitado: todo `role='super_admin'` de fixture via trigger quebra
--      o cleanup dos specs legados (RESTRICT 23503) — o backfill continua
--      sendo ato da migration (prod: super_admins já existem) + seed.
--
-- Sem dinheiro (só identidade): nenhum float/double. Erros por rótulo fixo.
-- Idempotente-safe: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE +
-- DO/INSERT ... WHERE NOT EXISTS + REVOKE/GRANT repetíveis.
-- Migrations 0001–0040 intocadas.

-- ============ 1. Tabela deny-all ============
CREATE TABLE IF NOT EXISTS public.internal_operators (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  disabled_at timestamptz
);

COMMENT ON TABLE public.internal_operators IS
  'Internal-admin L0 (ADR-01/ADR-05, 0041): identidade interna separada de profiles. Deny-all: RLS ENABLED sem policy permissiva + REVOKE ALL de PUBLIC/anon/authenticated/service_role; só service_role (Edge verify-operator) lê/escreve, por GRANT explícito mínimo (SELECT/INSERT/UPDATE/DELETE).';

ALTER TABLE public.internal_operators ENABLE ROW LEVEL SECURITY;

-- Sem nenhuma policy permissiva de propósito: mesmo se um GRANT futuro vazar
-- para authenticated, a ausência de policy continua negando (0 linhas).
-- (Nenhum CREATE POLICY aqui — carência deliberada, não esquecimento.)

REVOKE ALL ON TABLE public.internal_operators FROM PUBLIC, anon, authenticated, service_role;

-- service_role retém apenas o DML mínimo (Edge verify-operator lê; escrita
-- só via Edge/seed/owner). REVOKE acima remove o ALL default do Supabase
-- (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) — precedente 0020.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.internal_operators TO service_role;

-- ============ 2. Helper private.is_internal_operator() ============
CREATE OR REPLACE FUNCTION private.is_internal_operator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.internal_operators AS io
    WHERE io.user_id = auth.uid()
      AND io.active = true
  );
$$;

COMMENT ON FUNCTION private.is_internal_operator() IS
  'Internal-admin L0 (ADR-01, 0041): true só com sessão e linha internal_operators active=true; sem sessão/sem linha/inativo → false (fail-closed, nunca raise). Schema private fora do PostgREST. Chamado pelas RPCs auditadas (L3); a rota interna prova identidade via Edge verify-operator (L1).';

REVOKE ALL ON FUNCTION private.is_internal_operator() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_internal_operator() TO authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

-- ============ 3. Backfill auditado (só super_admins, inativo, idempotente) ============
DO $$
DECLARE
  v_inserted int;
BEGIN
  INSERT INTO public.internal_operators (user_id, active)
  SELECT p.id, false
  FROM public.profiles AS p
  WHERE p.role = 'super_admin'
    AND NOT EXISTS (
      SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
    );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'internal_operators backfill (0041): % super_admin(s) inserido(s) como inativo(s)', v_inserted;
END $$;
