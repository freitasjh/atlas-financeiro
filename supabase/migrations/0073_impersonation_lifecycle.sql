-- 0073_impersonation_lifecycle.sql — internal-control-plane / F7 / ADR-005 (BE-71, BE-72).
--
-- Motivo: a sessão de 0072 precisa de ciclo de vida server-side — abrir com
-- prazo dado (15 min), encerrar de forma idempotente, reconhecer a sessão
-- (token + operador) e listar para o operador. O token NÃO autoriza sozinho:
-- exige `auth.uid()`, `is_super_admin()` e `operator_id = auth.uid()`.
--
-- Entrega (server-side; nenhuma escrita direta de `authenticated`):
--   1) `public.start_impersonation(p_tenant, p_reason)` — ordem literal:
--      not-authenticated → is_super_admin() (herda first-access/mfa/operator-
--      inactive) → not-admin → tenant-not-found → impersonation-self-target →
--      impersonation-reason-invalid (4 regras) → supersessão da sessão aberta
--      do MESMO operador (com trilha `impersonation_end:superseded` do tenant
--      ANTERIOR) → INSERT da sessão → trilha `impersonation_start:<motivo>`.
--      Corrida de dois starts ⇒ `impersonation-session-conflict` (unique_violation
--      na `operator_open_uq`/`token_hash` mapeado por CONSTRAINT_NAME).
--      TTL é dado no servidor (`now() + 15 min`); a assinatura NÃO tem p_ttl.
--   2) `public.end_impersonation(p_token)` — lookup por `token_hash + operator_id`;
--      sem sessão ⇒ `impersonation-session-not-found`; já encerrada ⇒ `false`
--      SEM segunda trilha; senão sela (`ended_at = revoked_at = now()`) +
--      `impersonation_end:stopped_by_operator` ⇒ `true`. NÃO chama
--      is_super_admin() (encerrar a própria sessão é sempre permitido).
--   3) `private.impersonation_gate(p_token, p_tenant)` — uma porta READ-ONLY
--      para os passos 3–6 do dispatcher (0074): lookup → ended → expiração
--      (só levanta `impersonation-expired`) → mismatch (só levanta
--      `impersonation-tenant-mismatch`). NÃO grava nada (nem UPDATE nem
--      INSERT): a subtransação do §6.2 não sobrevive ao RAISE capturado pelo
--      chamador (medido: count=0), então selo/trilha são assíncronos (§5).
--      SEM EXECUTE para nenhum dos 4 papéis.
--   4) `public.admin_list_impersonation_sessions(p_operator, p_limit, p_offset)` —
--      gate is_super_admin() ⇒ `not-admin`; clamp 1..100 / offset >= 0; ordem
--      `started_at DESC, id DESC`; 10 colunas, sem PII; sem trilha própria.
--   5) `public.admin_sweep_impersonation_sessions(p_limit)` (REQ-48, Opção C) —
--      selo/trilha ASSÍNCRONOS: sela (`ended_at`/`revoked_at`) sessões com
--      `expires_at <= now()` e ainda abertas, gravando 1
--      `impersonation_end:expired` por sessão; `LIMIT 1..500`; devolve o total
--      selado. Só is_super_admin() (⇒ `not-admin`); EXECUTE só `authenticated`.
--
-- Nenhum GUC de impersonation: a sessão é reconhecida SÓ por token_hash +
-- operator_id; `reads`/`last_read_at` são a anotação durável (0074 incrementa).
-- Toda DML desta superfície ⊆ {public.admin_audit (INSERT),
-- public.impersonation_sessions (INSERT/UPDATE)}.
--
-- Erros por rótulo fixo, sem token/id/PII: not-authenticated, not-admin,
-- tenant-not-found, impersonation-self-target, impersonation-reason-invalid,
-- impersonation-session-conflict, impersonation-session-not-found,
-- impersonation-session-ended, impersonation-expired,
-- impersonation-tenant-mismatch.
-- Sem dinheiro (só identidade/sessão): nenhum float/double.
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0071 intocadas; 0072 já cria a tabela e a extensão.

-- ============ 1. start_impersonation ============
CREATE OR REPLACE FUNCTION public.start_impersonation(
  p_tenant uuid,
  p_reason text
)
RETURNS TABLE (token text, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := pg_catalog.btrim(COALESCE(p_reason, ''));
  v_token uuid := pg_catalog.gen_random_uuid();
  v_hash text;
  v_expires timestamptz := pg_catalog.now() + interval '15 minutes';
  v_prev_tenant uuid;
  v_constraint text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  -- Herda first-access-password-change-required / mfa-required /
  -- operator-inactive; user comum devolve false sem raise.
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenants AS t WHERE t.id = p_tenant
  ) THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tenant_members AS tm
    WHERE tm.tenant_id = p_tenant
      AND tm.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'impersonation-self-target';
  END IF;

  -- 4 regras sobre o motivo (mesmo rótulo; ordem 1..4 da SPEC §8.2).
  IF pg_catalog.char_length(v_reason) < 10
     OR pg_catalog.char_length(v_reason) > 280
     OR pg_catalog.strpos(v_reason, ':') <> 0
     OR v_reason ~ '[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+'
     OR v_reason ~ '[0-9]{11,14}' THEN
    RAISE EXCEPTION 'impersonation-reason-invalid';
  END IF;

  -- Supersessão: encerra a sessão aberta do MESMO operador e audita o tenant
  -- ANTERIOR (não o novo) na MESMA transação (I1).
  UPDATE public.impersonation_sessions AS s
     SET ended_at = pg_catalog.now(),
         revoked_at = pg_catalog.now()
   WHERE s.operator_id = v_uid
     AND s.ended_at IS NULL
     AND s.revoked_at IS NULL
  RETURNING s.tenant_id INTO v_prev_tenant;

  IF v_prev_tenant IS NOT NULL THEN
    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
    VALUES (v_uid, v_prev_tenant, v_prev_tenant, 'other',
            'impersonation_end:superseded');
  END IF;

  v_hash := pg_catalog.encode(extensions.digest(v_token::text, 'sha256'), 'hex');

  BEGIN
    INSERT INTO public.impersonation_sessions
      (token_hash, operator_id, tenant_id, reason, expires_at)
    VALUES (v_hash, v_uid, p_tenant, v_reason, v_expires);
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IN (
        'impersonation_sessions_operator_open_uq',
        'impersonation_sessions_token_hash_key'
      ) THEN
        RAISE EXCEPTION 'impersonation-session-conflict';
      END IF;
      RAISE;
  END;

  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (v_uid, p_tenant, p_tenant, 'other', 'impersonation_start:' || v_reason);

  RETURN QUERY SELECT v_token::text, v_expires;
END;
$$;

COMMENT ON FUNCTION public.start_impersonation(uuid, text) IS
  'F7/ADR-005 (0073): abre sessão de impersonation read-only com TTL de 15 min dado no servidor. Ordem: not-authenticated → is_super_admin (herda first-access/mfa/operator-inactive) → not-admin → tenant-not-found → self-target → motivo inválido → supersessão auditada → INSERT → trilha. Token devolvido UMA vez; banco guarda sha256.';

REVOKE ALL ON FUNCTION public.start_impersonation(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_impersonation(uuid, text) TO authenticated;

-- ============ 2. end_impersonation ============
CREATE OR REPLACE FUNCTION public.end_impersonation(p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hash text := pg_catalog.encode(extensions.digest(p_token::text, 'sha256'), 'hex');
  v_session public.impersonation_sessions;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  SELECT * INTO v_session
  FROM public.impersonation_sessions AS s
  WHERE s.token_hash = v_hash
    AND s.operator_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'impersonation-session-not-found';
  END IF;

  -- Idempotente: já encerrada ⇒ false, SEM segunda linha de trilha.
  IF v_session.ended_at IS NOT NULL OR v_session.revoked_at IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE public.impersonation_sessions AS s
     SET ended_at = pg_catalog.now(),
         revoked_at = pg_catalog.now()
   WHERE s.id = v_session.id
     AND s.ended_at IS NULL
     AND s.revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (v_uid, v_session.tenant_id, v_session.tenant_id, 'other',
          'impersonation_end:stopped_by_operator');

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.end_impersonation(uuid) IS
  'F7/ADR-005 (0073): encerra a própria sessão (token + operator_id) de forma idempotente. Já encerrada ⇒ false sem segunda trilha; sucesso ⇒ true + impersonation_end:stopped_by_operator. Não chama is_super_admin().';

REVOKE ALL ON FUNCTION public.end_impersonation(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_impersonation(uuid) TO authenticated;

-- ============ 3. private.impersonation_gate (passos 3–6; READ-ONLY) ============
-- Opção C (decisão humana, 2026-11-20; adendo ao ADR-005): o gate NÃO grava.
-- A subtransação do §6.2 não sobrevive ao RAISE capturado pelo chamador
-- (medido: count=0), então selo/trilha são assíncronos
-- (`admin_sweep_impersonation_sessions`, §5). O gate só LÊ e levanta rótulo.
CREATE OR REPLACE FUNCTION private.impersonation_gate(
  p_token uuid,
  p_tenant uuid
)
RETURNS public.impersonation_sessions
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hash text := pg_catalog.encode(extensions.digest(p_token::text, 'sha256'), 'hex');
  v_session public.impersonation_sessions;
BEGIN
  -- Passo 3: lookup por token_hash + operator_id.
  SELECT * INTO v_session
  FROM public.impersonation_sessions AS s
  WHERE s.token_hash = v_hash
    AND s.operator_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'impersonation-session-not-found';
  END IF;

  -- Passo 4: sessão encerrada/revogada.
  IF v_session.ended_at IS NOT NULL OR v_session.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'impersonation-session-ended';
  END IF;

  -- Passo 5: expiração — só levanta (selo/trilha são do sweep assíncrono).
  IF v_session.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'impersonation-expired';
  END IF;

  -- Passo 6: mismatch de tenant — só levanta (sem gravação).
  IF p_tenant IS DISTINCT FROM v_session.tenant_id THEN
    RAISE EXCEPTION 'impersonation-tenant-mismatch';
  END IF;

  RETURN v_session;
END;
$$;

COMMENT ON FUNCTION private.impersonation_gate(uuid, uuid) IS
  'F7/ADR-005 (0073, Opção C): porta única dos passos 3–6 do dispatcher (lookup, ended, expiração, mismatch). READ-ONLY: não grava nada (nem UPDATE nem INSERT); selo/trilha da expiração são assíncronos via admin_sweep_impersonation_sessions. SEM EXECUTE para PUBLIC/anon/authenticated/service_role — só o DEFINER de impersonation_read a chama.';

REVOKE ALL ON FUNCTION private.impersonation_gate(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 4. admin_list_impersonation_sessions ============
CREATE OR REPLACE FUNCTION public.admin_list_impersonation_sessions(
  p_operator uuid DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  operator_id uuid,
  tenant_id uuid,
  reason text,
  started_at timestamptz,
  expires_at timestamptz,
  ended_at timestamptz,
  revoked_at timestamptz,
  reads bigint,
  last_read_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  RETURN QUERY
  SELECT s.id, s.operator_id, s.tenant_id, s.reason,
         s.started_at, s.expires_at, s.ended_at, s.revoked_at,
         s.reads, s.last_read_at
  FROM public.impersonation_sessions AS s
  WHERE p_operator IS NULL OR s.operator_id = p_operator
  ORDER BY s.started_at DESC, s.id DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.admin_list_impersonation_sessions(uuid, int, int) IS
  'F7/ADR-005 (0073): lista sessões de impersonation (10 colunas, sem PII). Só is_super_admin(); clamp 1..100 / offset >= 0; ordem started_at DESC, id DESC; filtro opcional por operador; sem trilha própria.';

REVOKE ALL ON FUNCTION public.admin_list_impersonation_sessions(uuid, int, int)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_impersonation_sessions(uuid, int, int)
  TO authenticated;

-- ============ 5. admin_sweep_impersonation_sessions (REQ-48, Opção C) ============
-- Selo/trilha ASSÍNCRONOS: o gate (READ-ONLY) não grava porque a subtransação
-- não sobrevive ao RAISE capturado pelo chamador. Este sweep é o único caminho
-- que sela sessões expiradas e grava `impersonation_end:expired` (1 por sessão),
-- numa transação que COMMITA (a RPC não levanta no caminho de sucesso).
CREATE OR REPLACE FUNCTION public.admin_sweep_impersonation_sessions(
  p_limit int DEFAULT 100
)
RETURNS int
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_sealed int := 0;
  v_session public.impersonation_sessions;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  FOR v_session IN
    SELECT * FROM public.impersonation_sessions AS s
    WHERE s.expires_at <= pg_catalog.now()
      AND s.ended_at IS NULL
      AND s.revoked_at IS NULL
    ORDER BY s.started_at ASC, s.id ASC
    LIMIT v_limit
  LOOP
    UPDATE public.impersonation_sessions AS s
       SET ended_at = pg_catalog.now(),
           revoked_at = pg_catalog.now()
     WHERE s.id = v_session.id
       AND s.ended_at IS NULL
       AND s.revoked_at IS NULL;

    IF FOUND THEN
      INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
      VALUES (v_uid, v_session.tenant_id, v_session.tenant_id, 'other',
              'impersonation_end:expired');
      v_sealed := v_sealed + 1;
    END IF;
  END LOOP;

  RETURN v_sealed;
END;
$$;

COMMENT ON FUNCTION public.admin_sweep_impersonation_sessions(int) IS
  'F7/ADR-005 (0073, Opção C/REQ-48): selo assíncrono. Sela sessões expiradas ainda abertas e grava 1 impersonation_end:expired por sessão; LIMIT clamp 1..500; devolve o total selado. Só is_super_admin() (not-admin); EXECUTE só authenticated.';

REVOKE ALL ON FUNCTION public.admin_sweep_impersonation_sessions(int)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_sweep_impersonation_sessions(int)
  TO authenticated;
