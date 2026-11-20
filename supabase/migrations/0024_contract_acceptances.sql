-- 0024_contract_acceptances.sql — tenants-cobranca / ADR-004 (aceite contratual imutável).
--
-- Motivo: RF-T11 exige prova de consentimento com versão do texto, timestamp
-- UTC e usuário, e recusa de UPDATE/DELETE. RLS sozinha não cobre esse caminho:
-- `service_role` tem `bypassrls`, então a barreira está no trigger e nos
-- grants, não na policy.
--
-- Entrega (server-side, nenhuma escrita direta de `authenticated`):
--   1) `public.contract_acceptances` — append-only (tenant, versão, accepted_at,
--      user_id). Servidor grava `accepted_at = now()` e `user_id = auth.uid()`.
--   2) `UNIQUE (tenant_id, contract_version)` — re-aceite ⇒ `acceptance-duplicate`.
--   3) `public.reject_mutation()` + trigger `BEFORE UPDATE OR DELETE` — recusa
--      mutação para QUALQUER role (inclusive `service_role`/owner), sem
--      consultar `current_user`.
--   4) `public.accept_contract(...)` — RPC `SECURITY DEFINER`: única escrita.
--      Ordem: not-authenticated → acceptance-tenant-invalid → tenant-not-member
--      → acceptance-version-invalid → INSERT → acceptance-duplicate.
--   5) `tenant_acceptance_required` — CONSTRAINT TRIGGER diferida sobre
--      `tenants`: COMMIT de tenant sem aceite ⇒ `tenant-acceptance-required`.
--      O app cria e aceita na mesma transação (os specs 0022/0023 fazem os dois
--      no mesmo bloco). Backfill `legacy-2026-11-05` cobre tenants pré-0024.
--   6) RLS por membership + `REVOKE ALL` antes de `GRANT SELECT`.
--
-- Erros por rótulo fixo, sem id/documento/PII na mensagem:
--   not-authenticated, acceptance-tenant-invalid, tenant-not-member,
--   acceptance-version-invalid, acceptance-duplicate,
--   tenant-acceptance-required, acceptance-immutable.
--
-- Escape declarado (fora do cliente): owner executa
-- `ALTER TABLE public.contract_acceptances DISABLE TRIGGER ...` — só runbook.
--
-- Idempotente-safe: CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- DROP POLICY/TRIGGER IF EXISTS + blocos DO $$ com guarda em `pg_constraint` /
-- REVOKE/GRANT repetíveis + backfill `NOT EXISTS`/`ON CONFLICT DO NOTHING.
-- Migrations 0001–0023 intocadas. Nenhum valor monetário neste ciclo.

-- ============ 1. Tabela ============

CREATE TABLE IF NOT EXISTS public.contract_acceptances (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  contract_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE
);

COMMENT ON TABLE public.contract_acceptances IS
  'Prova de consentimento (ADR-004). Append-only: escrita exclusiva da RPC accept_contract; UPDATE/DELETE recusados por trigger para qualquer role. Todo tenant tem >= 1 linha (backfill + constraint trigger diferida).';
COMMENT ON COLUMN public.contract_acceptances.contract_version IS
  'Slug da versão do texto (ex. termos-2026-11-v1). Formato 1..64, charset [A-Za-z0-9._-]. O texto editorial vive fora do banco.';

-- ============ 2. Constraints (guarda pg_constraint: re-aplicável) ============

-- A-2: re-aceite da mesma versão é duplicata (árbitro do rótulo).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contract_acceptances_tenant_version_uq'
  ) THEN
    ALTER TABLE public.contract_acceptances
      ADD CONSTRAINT contract_acceptances_tenant_version_uq
      UNIQUE (tenant_id, contract_version);
  END IF;
END;
$$;

-- Formato slug no banco (defesa em profundidade — a RPC pré-valida antes).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contract_acceptances_version_format'
  ) THEN
    ALTER TABLE public.contract_acceptances
      ADD CONSTRAINT contract_acceptances_version_format
      CHECK (
        pg_catalog.char_length(contract_version) BETWEEN 1 AND 64
        AND contract_version ~ '^[A-Za-z0-9._-]+$'
      );
  END IF;
END;
$$;

-- ============ 3. Índice ============

CREATE INDEX IF NOT EXISTS contract_acceptances_tenant_idx
  ON public.contract_acceptances (tenant_id);

-- ============ 4. Imutabilidade: trigger barra qualquer role ============
-- Sem `current_user` (durante cascata de FK o trigger roda como owner, então
-- `current_user` mente). `search_path = ''` + corpo só com RAISE.

CREATE OR REPLACE FUNCTION public.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'acceptance-immutable';
END;
$$;

COMMENT ON FUNCTION public.reject_mutation() IS
  'ADR-004: recusa UPDATE/DELETE em contract_acceptances para qualquer role, inclusive service_role (RLS não barra, trigger barra).';

DROP TRIGGER IF EXISTS contract_acceptances_immutable ON public.contract_acceptances;
CREATE TRIGGER contract_acceptances_immutable
  BEFORE UPDATE OR DELETE ON public.contract_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

-- ============ 5. Cadastro não fecha sem aceite (constraint diferida) ============

CREATE OR REPLACE FUNCTION public.tenant_acceptance_required_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.contract_acceptances AS ca WHERE ca.tenant_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'tenant-acceptance-required';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tenant_acceptance_required_fn() IS
  'ADR-004: COMMIT de tenant sem linha de aceite é recusado. Diferida: o app cria o tenant e aceita na mesma transação.';

DROP TRIGGER IF EXISTS tenant_acceptance_required ON public.tenants;
CREATE CONSTRAINT TRIGGER tenant_acceptance_required
  AFTER INSERT ON public.tenants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.tenant_acceptance_required_fn();

-- ============ 6. RPC: única escrita ============
-- Ordem exigida pela SPEC §5: not-authenticated → acceptance-tenant-invalid →
-- tenant-not-member → acceptance-version-invalid → INSERT (accepted_at = now(),
-- user_id = auth.uid() no servidor) → acceptance-duplicate.
-- `search_path = ''` + tudo qualificado: sem sequestro por schema do chamador.

CREATE OR REPLACE FUNCTION public.accept_contract(
  p_tenant_id uuid,
  p_contract_version text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_version text := pg_catalog.btrim(COALESCE(p_contract_version, ''));
  v_id bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenants AS t WHERE t.id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'acceptance-tenant-invalid';
  END IF;

  IF NOT public.is_admin()
    AND NOT EXISTS (
      SELECT 1 FROM private.user_tenant_ids() AS u WHERE u = p_tenant_id
    ) THEN
    RAISE EXCEPTION 'tenant-not-member';
  END IF;

  IF pg_catalog.char_length(v_version) NOT BETWEEN 1 AND 64
    OR v_version !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'acceptance-version-invalid';
  END IF;

  INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
  VALUES (p_tenant_id, v_version, pg_catalog.now(), v_uid)
  RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'acceptance-duplicate';
END;
$$;

COMMENT ON FUNCTION public.accept_contract(uuid, text) IS
  'ADR-004: registra o aceite do contrato pelo chamador (auth.uid(), now() no servidor). Devolve o id do aceite.';

REVOKE ALL ON FUNCTION public.accept_contract(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.accept_contract(uuid, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.reject_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.tenant_acceptance_required_fn()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 7. RLS ============

ALTER TABLE public.contract_acceptances ENABLE ROW LEVEL SECURITY;

-- Leitura: admin (backoffice) ou membro do tenant. `is_admin()` e o helper são
-- avaliados em subquery/EXISTS: viram `InitPlan`/semi-join e são executados 1×
-- por statement, nunca por linha candidata. Nenhuma policy de
-- INSERT/UPDATE/DELETE: escrita é exclusiva da RPC.
DROP POLICY IF EXISTS contract_acceptances_select_member ON public.contract_acceptances;
CREATE POLICY contract_acceptances_select_member ON public.contract_acceptances
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin())
    OR EXISTS (
      SELECT 1 FROM private.user_tenant_ids() AS u WHERE u = contract_acceptances.tenant_id
    )
  );

-- ============ 8. Privilégios ============
-- Supabase concede ALL a anon/authenticated/service_role em tabelas novas de
-- `public` (default privileges). REVOKE ALL antes do GRANT SELECT: sem grant de
-- escrita, nenhuma policy "salva" o cliente. O trigger barra o restante
-- (service_role/owner), que grant nenhum alcança.

REVOKE ALL ON TABLE public.contract_acceptances FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.contract_acceptances TO authenticated;

-- ============ 9. Backfill: tenants pré-0024 ganham aceite legacy ============
-- `(owner, legacy-2026-11-05)`: o dono responde pelo tenant criado antes da
-- exigência. `NOT EXISTS` + `ON CONFLICT DO NOTHING`: re-aplicável.

INSERT INTO public.contract_acceptances (tenant_id, contract_version, accepted_at, user_id)
SELECT t.id, 'legacy-2026-11-05', pg_catalog.now(), t.owner_user_id
FROM public.tenants AS t
WHERE NOT EXISTS (
  SELECT 1 FROM public.contract_acceptances AS ca WHERE ca.tenant_id = t.id
)
ON CONFLICT (tenant_id, contract_version) DO NOTHING;
