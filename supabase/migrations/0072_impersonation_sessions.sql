-- 0072_impersonation_sessions.sql — internal-control-plane / F7 / ADR-005 (BE-70).
--
-- Motivo: o backoffice precisa de uma sessão de impersonation auditada e
-- read-only, com prazo dado pelo servidor (TTL 15 min) e UMA sessão aberta por
-- operador. O token nunca é persistido cru: a linha guarda só o `sha256` do
-- token (extensions.digest), de modo que um dump da tabela não impersona
-- ninguém (o token também exige `auth.uid()` e `operator_id`).
--
-- Entrega (server-side; read-only para os papéis JWT de cliente):
--   1) `public.impersonation_sessions` — 11 colunas (id, token_hash,
--      operator_id, tenant_id, reason, started_at, expires_at, ended_at,
--      revoked_at, reads, last_read_at). ZERO FK de propósito: cascade apagaria
--      a prova junto com o operador/tenant (precedente `admin_audit`, 0019).
--   2) 5 CHECK: teto de prazo (20 min), motivo 10..280, motivo sem ':', reads
--      >= 0, ended_at >= started_at. Espelho defensivo da validação de
--      `start_impersonation` (0073) — nunca substitui o rótulo
--      `impersonation-reason-invalid`.
--   3) 3 índices: token_hash (UNIQUE inline), `operator_open_uq` (UNIQUE
--      parcial — I1: no máximo 1 sessão aberta por operador) e
--      `operator_started_idx (operator_id, started_at DESC)`. SEM índice em
--      `tenant_id`: a listagem congelada não filtra por tenant.
--   4) RLS ENABLED sem policy + REVOKE ALL dos 4 papéis = deny-all
--      (precedente `internal_operators`, 0041). Só o owner (DEFINER das RPCs
--      de 0073) escreve/lê; nenhum cliente alcança a tabela (42501).
--   5) COMMENT por tabela e por coluna.
--   6) `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions`
--      (precedente 0036) — `extensions.digest` é usado nas 5 funções.
--
-- Retenção (piso declarado, O2 aberta): 24 meses, sem purge nesta fatia;
-- `ended_at IS NULL` NÃO autoriza exclusão (é o caso "fim não observado").
--
-- Sem dinheiro nesta migration (só identidade/sessão): nenhum float/double.
-- Idempotente-safe: CREATE TABLE/INDEX IF NOT EXISTS + ENABLE RLS + REVOKE
-- repetíveis + COMMENT idempotente. Migrations 0001–0071 intocadas.

-- ============ 0. Extensão (pgcrypto em extensions; precedente 0036) ============
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ============ 1. Guarda de pré-condição ============
-- A faixa 0072–0074 depende de 0019/0022/0028/0032/0037/0041/0051. Falha de
-- dependência vira rótulo fixo (nunca um erro cru com ids).
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regclass('public.tenants') IS NULL
     OR to_regclass('public.tenant_members') IS NULL
     OR to_regclass('public.admin_audit') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('extensions.digest(bytea, text)') IS NULL
     OR to_regprocedure('extensions.digest(text, text)') IS NULL THEN
    RAISE EXCEPTION 'impersonation-missing-dependency';
  END IF;
END $$;

-- ============ 2. Tabela ============
CREATE TABLE IF NOT EXISTS public.impersonation_sessions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  operator_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  reason text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  revoked_at timestamptz,
  reads bigint NOT NULL DEFAULT 0,
  last_read_at timestamptz,
  CONSTRAINT impersonation_sessions_expiry_check
    CHECK (expires_at > started_at
           AND expires_at <= started_at + interval '20 minutes'),
  CONSTRAINT impersonation_sessions_reason_len_check
    CHECK (char_length(btrim(reason)) BETWEEN 10 AND 280),
  CONSTRAINT impersonation_sessions_reason_colon_check
    CHECK (position(':' in reason) = 0),
  CONSTRAINT impersonation_sessions_reads_check
    CHECK (reads >= 0),
  CONSTRAINT impersonation_sessions_ended_check
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

COMMENT ON TABLE public.impersonation_sessions IS
  'Sessão de impersonation read-only (F7/ADR-005, 0072). Deny-all: RLS ENABLED sem policy + REVOKE ALL de PUBLIC/anon/authenticated/service_role; só as RPCs DEFINER de 0073 leem/escrevem. Token nunca cru: guarda sha256 (extensions.digest). Sem FK de propósito (cascade apagaria a prova).';
COMMENT ON COLUMN public.impersonation_sessions.id IS
  'Identificador interno da sessão (uuid). Não é o token.';
COMMENT ON COLUMN public.impersonation_sessions.token_hash IS
  'sha256 hex (64 chars) do token devolvido por start_impersonation; nunca o token cru.';
COMMENT ON COLUMN public.impersonation_sessions.operator_id IS
  'auth.uid() do operador que abriu a sessão. Sem FK (cascade apagaria a prova).';
COMMENT ON COLUMN public.impersonation_sessions.tenant_id IS
  'Tenant alvo (um tenant por sessão). Sem FK (cascade apagaria a prova).';
COMMENT ON COLUMN public.impersonation_sessions.reason IS
  'Motivo (btrim, 10..280, sem ":"); validado por start_impersonation antes do INSERT.';
COMMENT ON COLUMN public.impersonation_sessions.started_at IS
  'Instante de abertura (now() no servidor).';
COMMENT ON COLUMN public.impersonation_sessions.expires_at IS
  'Prazo dado no INSERT (now() + 15 min); nenhuma função o atualiza; teto de 20 min por CHECK.';
COMMENT ON COLUMN public.impersonation_sessions.ended_at IS
  'Fim observado da sessão (operador, expiração, supersessão ou falha de gate).';
COMMENT ON COLUMN public.impersonation_sessions.revoked_at IS
  'Corte administrativo da sessão.';
COMMENT ON COLUMN public.impersonation_sessions.reads IS
  'Contador de leituras aplicadas (observabilidade por sessão).';
COMMENT ON COLUMN public.impersonation_sessions.last_read_at IS
  'Instante da última leitura aplicada.';

-- ============ 3. Índices ============
-- I1: no máximo UMA sessão aberta por operador (provado pelo índice, não por código).
CREATE UNIQUE INDEX IF NOT EXISTS impersonation_sessions_operator_open_uq
  ON public.impersonation_sessions (operator_id)
  WHERE ended_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS impersonation_sessions_operator_started_idx
  ON public.impersonation_sessions (operator_id, started_at DESC);

-- ============ 4. RLS deny-all + privilégios ============
ALTER TABLE public.impersonation_sessions ENABLE ROW LEVEL SECURITY;

-- Nenhum CREATE POLICY: carência deliberada (deny-all mesmo se um GRANT futuro
-- vazar). Só o owner (DEFINER) alcança a tabela.
REVOKE ALL ON TABLE public.impersonation_sessions
  FROM PUBLIC, anon, authenticated, service_role;
