-- 0051_operator_gate.sql — bugfix security-p1-hardening / SEC-03 (F-13).
--
-- Motivo: o gate de MFA (0037/0039) prova `aal2` no claim do JWT, mas o TOTP
-- self-enroll nasce em `aal1` (declarado na 0040) e o `is_super_admin()`
-- ignorava `internal_operators` (0041) — qualquer `profiles.role='super_admin'`
-- com fator auto-enrollado virava operador sem provisionamento. A borda
-- (`verify-operator` Edge) já checava a tabela; o banco não. Decisão humana
-- D2 (refinada em 2026-11-18): o gate passa a ser GLOBAL em
-- `is_super_admin()` (herdado por `is_admin()`, pelas RPCs `admin_*` e pelas
-- policies RLS), com a ordem:
--   first-access-password-change-required → mfa-required → operator-inactive.
-- Bootstrap de produção = DBA/psql (RPC/Edge de ativação foram REJEITADAS:
-- o caminho circular exigiria `aal2` alcançável por auto-enroll, o mesmo furo).
--
-- Entrega (server-side; nenhuma migration aplicada é editada):
--   1) Guarda de deploy: se existe `profiles.role='super_admin'` e NENHUM
--      operador `active=true` entre os super_admins, levanta
--      `operator-bootstrap-required`. Base limpa (sem super_admin) passa; é o
--      freio que impede subir o gate num ambiente onde ele travaria todos.
--      O DBA ativa um operador ANTES de aplicar (runbook §10).
--   2) Backfill inativo: insere `active=false` para todo super_admin sem
--      linha (idempotente, `WHERE NOT EXISTS`). Nunca ativa ninguém — mesma
--      semântica da 0041, reaplicada porque a 0041 já rodou em bancos vivos.
--   3) `public.is_super_admin()` redefinida com `SET search_path = ''` e
--      chamadas qualificadas (`auth.uid()`, `public.profiles`,
--      `private.is_aal2()`, `private.is_internal_operator()`). Corpo 0039
--      preservado; o gate novo só olha `role='super_admin'` (user comum
--      continua `false` sem raise, preservando RLS de membro em `aal1`).
--   4) Auditoria de provisionamento: trigger `internal_operators_audit`
--      (AFTER INSERT OR UPDATE OF active) grava em `public.admin_audit`
--      (`action='other'`, `reason` ∈ `operator_provisioned` |
--      `operator_activated` | `operator_deactivated`, `from_value`/
--      `to_value` com o estado binário). `action='other'` já existe na
--      constraint `admin_audit_action_check` desde a 0037 — nenhuma ação
--      nova é inventada (o CHECK foi conferido: 0037:112-124).
--   5) `COMMENT ON FUNCTION public.admin_grant_super_admin(uuid)`: conceder
--      `role` NÃO ativa operador (são atos separados; ativação é DBA/psql).
--
-- Erros por rótulo fixo, sem PII: `operator-bootstrap-required`,
-- `operator-inactive` (novo), `mfa-required`/`first-access-…` (0034/0037).
-- Sem dinheiro (só identidade): nenhum float/double.
-- Idempotente-safe: CREATE OR REPLACE + DROP TRIGGER IF EXISTS +
-- INSERT ... WHERE NOT EXISTS + REVOKE/GRANT repetíveis. Uma SEGUNDA aplicação
-- só passa se a guarda do passo 1 continuar satisfeita (há super_admin ⇒
-- precisa de ao menos um operador ativo entre eles) — é o comportamento
-- desejado da guarda, não um efeito colateral.
-- Migrations 0001–0050 intocadas.

-- ============ 1. Guarda de deploy ============
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles AS p WHERE p.role = 'super_admin'
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    JOIN public.internal_operators AS io ON io.user_id = p.id
    WHERE p.role = 'super_admin'
      AND io.active = true
  ) THEN
    RAISE EXCEPTION 'operator-bootstrap-required';
  END IF;
END $$;

-- ============ 2. Backfill inativo (nunca ativa) ============
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
  RAISE NOTICE 'internal_operators backfill (0051): % super_admin(s) inserido(s) como inativo(s)', v_inserted;
END $$;

-- ============ 3. Gate global em is_super_admin() ============
-- Ordem literal: sem sessão → sem profile → first-access → mfa-required →
-- operator-inactive → role. `private.is_internal_operator()` já é
-- STABLE/DEFINER/search_path='' e usa `auth.uid()` (0041) — nunca
-- `current_user`.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_must boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.role, p.must_change_password INTO v_role, v_must
  FROM public.profiles AS p
  WHERE p.id = v_uid;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_must THEN
    RAISE EXCEPTION 'first-access-password-change-required';
  END IF;

  IF v_role = 'super_admin' AND NOT private.is_aal2() THEN
    RAISE EXCEPTION 'mfa-required';
  END IF;

  IF v_role = 'super_admin' AND NOT private.is_internal_operator() THEN
    RAISE EXCEPTION 'operator-inactive';
  END IF;

  RETURN v_role = 'super_admin';
END;
$$;

COMMENT ON FUNCTION public.is_super_admin() IS
  'SEC-03 (0051, sobre 0037/0039): role=super_admin exige aal2 E linha internal_operators active=true (0041). Ordem: first-access → mfa-required → operator-inactive. search_path='' com chamadas qualificadas; user comum retorna false sem raise (RLS de membro em aal1 intacta). Ativação é DBA/psql (sem RPC/Edge de bootstrap); admin_grant_super_admin só concede role, não ativa operador.';

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO anon, authenticated, service_role;

-- ============ 4. Auditoria de ativação/desativação ============
-- `action='other'` já é aceito por admin_audit_action_check (0037:112-124).
-- O rótulo vivo vai em `reason` (texto livre da tabela, 0028).
CREATE OR REPLACE FUNCTION public.internal_operators_audit_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.admin_audit (actor_id, target_id, action, reason, from_value, to_value)
    VALUES (v_actor, NEW.user_id, 'other', 'operator_provisioned', NULL, NEW.active::text);
    RETURN NULL;
  END IF;

  IF OLD.active IS NOT DISTINCT FROM NEW.active THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.admin_audit (actor_id, target_id, action, reason, from_value, to_value)
  VALUES (
    v_actor,
    NEW.user_id,
    'other',
    CASE WHEN NEW.active THEN 'operator_activated' ELSE 'operator_deactivated' END,
    OLD.active::text,
    NEW.active::text
  );
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.internal_operators_audit_fn() IS
  'SEC-03 (0051): trilha de provisionamento/ativação em admin_audit (action=other; reason=operator_provisioned|operator_activated|operator_deactivated). Actor = auth.uid() (NULL em seed/DBA). Escrita só pela própria função do trigger.';

REVOKE ALL ON FUNCTION public.internal_operators_audit_fn()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS internal_operators_audit ON public.internal_operators;
CREATE TRIGGER internal_operators_audit
  AFTER INSERT OR UPDATE OF active ON public.internal_operators
  FOR EACH ROW EXECUTE FUNCTION public.internal_operators_audit_fn();

-- ============ 5. Conceder role ≠ ativar operador ============
COMMENT ON FUNCTION public.admin_grant_super_admin(uuid) IS
  'Backoffice P1 (ADR-002): concede super_admin. Só is_super_admin() (primeiro acesso + aal2 + operador ativo). SEC-03 (0051): conceder role NÃO ativa internal_operators — a ativação é ato do DBA/psql (runbook §10); o alvo promovido continua operator-inactive até ser provisionado. Trilha grant_super_admin via trigger; idempotente.';
