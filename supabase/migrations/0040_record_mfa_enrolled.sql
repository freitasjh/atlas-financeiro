-- 0040_record_mfa_enrolled.sql — backoffice-p0-mfa / P0M-BE-03-followup (ADR-001).
--
-- Motivo: a 0037 criou a ação `mfa_enrolled` em `admin_audit_action_check` e
-- expandiu a whitelist de `list_admin_audit_page`, mas nenhum produtor a
-- gravava: a trilha do enroll (SPEC §6) era CHECK permissivo + consumidor sem
-- produtor. Escrita direta em `admin_audit` pelo cliente é proibida (0019/0020:
-- authenticated não tem INSERT; só o trigger/função DEFINER grava) — sem esta
-- RPC, gravar a trilha exigiria violar a regra (defeito desta entrega).
--
-- Entrega (server-side, única via de escrita da trilha):
--   `public.record_mfa_enrolled()` — SECURITY DEFINER, search_path=''
--   travado, chamadas qualificadas (`auth.uid()`, `public.profiles`,
--   `auth.mfa_factors`, `public.admin_audit`). Gate próprio, NÃO via
--   `is_super_admin()` (que levanta `mfa-required` em aal1): o enroll acontece
--   em aal1 antes do verify (`/mfa/setup` vive fora do gate — sem isso,
--   lockout total, SPEC §3); um produtor gateado por aal2 nunca rodaria.
--   Em vez disso:
--     1) sem sessão (`auth.uid()` NULL) → `not-admin` (fail-closed);
--     2) sem profile ou `role <> 'super_admin'` → `not-admin` (mesmo rótulo
--        das RPCs admin; usuário comum nunca inscreve trilha);
--     3) `must_change_password=true` → first-access-password-change-required
--        (ordem SPEC §3: must_change antes do mfa, igual às demais gates);
--     4) sem fator TOTP `verified` em `auth.mfa_factors` → `mfa-not-enrolled`
--        (não basta alegar: o fator existe no Auth e a trilha só atesta
--        enrollment real — `unverified` também nega);
--     5) caso contrário insere `actor_id = target_id = auth.uid()`,
--        `action='mfa_enrolled'`, `from_value='aal1'`, `to_value='aal2'`.
--   Leitura: `list_admin_audit_page` já existente (0037) — ver T-READ do spec.
--
-- Sem dinheiro (só identidade). Erros por rótulo fixo, sem PII.
-- Idempotente: CREATE OR REPLACE + REVOKE/GRANT repetíveis (sem objeto novo
-- além da função). Migrations 0001–0039 intocadas.

-- ============ record_mfa_enrolled() — produtor server-only ============
CREATE OR REPLACE FUNCTION public.record_mfa_enrolled()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_must boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  SELECT p.role, p.must_change_password INTO v_role, v_must
  FROM public.profiles AS p
  WHERE p.id = v_uid;

  IF NOT FOUND OR v_role <> 'super_admin' THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF v_must THEN
    RAISE EXCEPTION 'first-access-password-change-required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM auth.mfa_factors AS f
    WHERE f.user_id = v_uid AND f.status = 'verified'
  ) THEN
    RAISE EXCEPTION 'mfa-not-enrolled';
  END IF;

  INSERT INTO public.admin_audit (actor_id, target_id, action, from_value, to_value)
  VALUES (v_uid, v_uid, 'mfa_enrolled', 'aal1', 'aal2');
END;
$$;

COMMENT ON FUNCTION public.record_mfa_enrolled() IS
  'Backoffice P0 MFA (ADR-001, 0040): produtor server-only da trilha mfa_enrolled (SPEC §6). Gate próprio (papel super_admin + must_change=false + fator verified em auth.mfa_factors), fora do gate aal2 — o enroll acontece em aal1. actor_id = target_id = auth.uid(); leitura via list_admin_audit_page.';

REVOKE ALL ON FUNCTION public.record_mfa_enrolled()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_mfa_enrolled() TO authenticated;
