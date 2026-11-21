-- 0082_mfa_recovery_schema.sql — mfa-recovery-codes / ADR-001 / DB-01.
--
-- Schema do control plane para códigos de recuperação MFA (R1-C). 5 tabelas
-- exatamente como a interface congelada do ADR §3.1:
--   code_sets (1 ativo/usuário), codes (só sha256 hex), aal_grants (one-shot),
--   attempts (lockout 5/15 min), audit (append-only, sem código/hash).
--
-- Deny-all (ADR §3.4): RLS ENABLE sem policy em 4 tabelas + REVOKE ALL de
-- PUBLIC/anon/authenticated/service_role nas 5. Única exceção: policy
-- `mfa_recovery_hook_service` + SELECT/DELETE em aal_grants para
-- `supabase_auth_admin` (role que executa o hook). `service_role` tem
-- BYPASSRLS, mas NÃO recebe GRANT de tabela: opera só via RPCs DEFINER.
--
-- Sem dinheiro: nenhum float/double/numeric. Idempotente-safe: CREATE TABLE
-- IF NOT EXISTS + índices IF NOT EXISTS + ENABLE/REVOKE/GRANT repetíveis.
-- Migrations 0001–0081 intocadas.

-- ============ Guarda de dependência ============
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'mfa-recovery-missing-dependency';
  END IF;
  IF to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'mfa-recovery-missing-gen-random-uuid';
  END IF;
END $$;

-- ============ 1. mfa_recovery_code_sets ============
CREATE TABLE IF NOT EXISTS public.mfa_recovery_code_sets (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL
);

COMMENT ON TABLE public.mfa_recovery_code_sets IS
  'ADR-001 (0082): conjunto de 10 códigos de recuperação. No máximo 1 ativo por usuário (revoked_at IS NULL); conjuntos revogados ficam para auditoria e nunca são reexibidos.';
COMMENT ON COLUMN public.mfa_recovery_code_sets.id IS 'Identificador do conjunto (uuid).';
COMMENT ON COLUMN public.mfa_recovery_code_sets.user_id IS 'Operador dono (auth.users.id); cascade no delete.';
COMMENT ON COLUMN public.mfa_recovery_code_sets.created_at IS 'Criação do conjunto (now()).';
COMMENT ON COLUMN public.mfa_recovery_code_sets.revoked_at IS 'Revogação pela regeneração; NULL = ativo.';

CREATE UNIQUE INDEX IF NOT EXISTS mfa_recovery_code_sets_active_user_uq
  ON public.mfa_recovery_code_sets (user_id) WHERE revoked_at IS NULL;

-- ============ 2. mfa_recovery_codes ============
CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
  id uuid PRIMARY KEY,
  set_id uuid NOT NULL REFERENCES public.mfa_recovery_code_sets (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_recovery_codes_set_hash_uq UNIQUE (set_id, code_hash),
  CONSTRAINT mfa_recovery_codes_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE public.mfa_recovery_codes IS
  'ADR-001 (0082): código de uso único. NUNCA guarda código em claro: code_hash = sha256 hex do código normalizado. used_at é a autoridade de uso único.';
COMMENT ON COLUMN public.mfa_recovery_codes.id IS 'Identificador do código (uuid) — não é o segredo.';
COMMENT ON COLUMN public.mfa_recovery_codes.set_id IS 'Conjunto dono (FK cascade).';
COMMENT ON COLUMN public.mfa_recovery_codes.code_hash IS 'sha256 hex (64 chars) do código normalizado (lower, sem "-" nem whitespace).';
COMMENT ON COLUMN public.mfa_recovery_codes.used_at IS 'Consumo do código; NULL = disponível.';
COMMENT ON COLUMN public.mfa_recovery_codes.created_at IS 'Criação do código (now()).';

-- ============ 3. mfa_recovery_aal_grants ============
-- Sem FK em auth.users de propósito: a sessão expira antes do usuário.
CREATE TABLE IF NOT EXISTS public.mfa_recovery_aal_grants (
  session_id text PRIMARY KEY,
  user_id uuid NOT NULL,
  code_id uuid NOT NULL REFERENCES public.mfa_recovery_codes (id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  CONSTRAINT mfa_recovery_aal_grants_ttl_check
    CHECK (expires_at = issued_at + interval '5 minutes')
);

COMMENT ON TABLE public.mfa_recovery_aal_grants IS
  'ADR-001 (0082): marcador one-shot por session_id. Nasce no consume e morre no hook (DELETE ... RETURNING). TTL 5 min; sem FK em auth.users de propósito.';
COMMENT ON COLUMN public.mfa_recovery_aal_grants.session_id IS 'Claim session_id do JWT (PK da elevação).';
COMMENT ON COLUMN public.mfa_recovery_aal_grants.user_id IS 'Dono da sessão; sem FK (sessão expira antes do usuário).';
COMMENT ON COLUMN public.mfa_recovery_aal_grants.code_id IS 'Código que originou o grant (FK cascade).';
COMMENT ON COLUMN public.mfa_recovery_aal_grants.issued_at IS 'Instante do consumo do código.';
COMMENT ON COLUMN public.mfa_recovery_aal_grants.expires_at IS 'issued_at + 5 min (CHECK).';
COMMENT ON COLUMN public.mfa_recovery_aal_grants.consumed_at IS 'Reservado ao ato de leitura; NULL = vigente na tabela.';

-- ============ 4. mfa_recovery_attempts ============
CREATE TABLE IF NOT EXISTS public.mfa_recovery_attempts (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  failed_count int NOT NULL DEFAULT 0,
  locked_until timestamptz NULL,
  CONSTRAINT mfa_recovery_attempts_count_check
    CHECK (failed_count >= 0 AND failed_count <= 5)
);

COMMENT ON TABLE public.mfa_recovery_attempts IS
  'ADR-001 (0082): lockout por operador — 5 falhas em 15 min. Zerado no consumo válido e na regeneração.';
COMMENT ON COLUMN public.mfa_recovery_attempts.user_id IS 'Operador (PK/FK cascade).';
COMMENT ON COLUMN public.mfa_recovery_attempts.failed_count IS 'Falhas consecutivas (0..5).';
COMMENT ON COLUMN public.mfa_recovery_attempts.locked_until IS 'Fim do bloqueio (now() + 15 min na 5ª falha).';

-- ============ 5. mfa_recovery_audit ============
CREATE TABLE IF NOT EXISTS public.mfa_recovery_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  action text NOT NULL,
  set_id uuid NULL,
  session_id text NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_recovery_audit_action_check CHECK (action IN (
    'generate', 'consume', 'invalid', 'reuse-denied', 'locked', 'regenerate'
  ))
);

COMMENT ON TABLE public.mfa_recovery_audit IS
  'ADR-001 (0082): trilha append-only. NUNCA contém código nem code_hash (RF-11).';
COMMENT ON COLUMN public.mfa_recovery_audit.id IS 'Sequência de auditoria (identity).';
COMMENT ON COLUMN public.mfa_recovery_audit.user_id IS 'Operador da ação; sem FK (trilha preservada).';
COMMENT ON COLUMN public.mfa_recovery_audit.action IS 'generate|consume|invalid|reuse-denied|locked|regenerate.';
COMMENT ON COLUMN public.mfa_recovery_audit.set_id IS 'Conjunto envolvido, quando aplicável.';
COMMENT ON COLUMN public.mfa_recovery_audit.session_id IS 'Sessão envolvida, quando aplicável.';
COMMENT ON COLUMN public.mfa_recovery_audit.occurred_at IS 'Instante da ação (now()).';

-- ============ 6. RLS deny-all + GRANTs ============
ALTER TABLE public.mfa_recovery_code_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery_aal_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery_audit ENABLE ROW LEVEL SECURITY;

-- Nenhuma policy para anon/authenticated/service_role: leitura e escrita
-- passam exclusivamente pelas RPCs SECURITY DEFINER (0083).
REVOKE ALL ON TABLE public.mfa_recovery_code_sets FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.mfa_recovery_codes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.mfa_recovery_aal_grants FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.mfa_recovery_attempts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.mfa_recovery_audit FROM PUBLIC, anon, authenticated, service_role;

-- Exceção única e explícita: o hook roda como supabase_auth_admin e precisa
-- de USAGE no schema + SELECT/DELETE no grant (docs oficiais F20/F24).
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT SELECT, DELETE ON TABLE public.mfa_recovery_aal_grants TO supabase_auth_admin;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.mfa_recovery_aal_grants'::regclass
      AND polname = 'mfa_recovery_hook_service'
  ) THEN
    CREATE POLICY mfa_recovery_hook_service
      ON public.mfa_recovery_aal_grants
      FOR ALL TO supabase_auth_admin
      USING (true);
  END IF;
END $$;
