-- 0083_mfa_recovery_rpcs.sql — mfa-recovery-codes / ADR-001 / RPC-01..04.
--
-- Interface congelada do ADR §3.2:
--   generate(uuid), consume(text,text), status(uuid), regenerate(uuid,text)
-- Todas SECURITY DEFINER com SET search_path = '' (F18), com checagem de dono
-- no corpo quando há JWT de usuário. EXECUTE: service_role nas 3 de gestão;
-- authenticated SOMENTE em consume (aal1 permitido).
--
-- Regra de ouro (ADR §3.6.2 / "subtransação liberada ≠ commit", 0072–0074):
-- falha ESPERADA retorna jsonb com ok:false e comita contador/lockout/audit.
-- RAISE só em erro técnico inesperado. Sem dblink/pg_background (REQ-47).
--
-- Código: 15 bytes de extensions.gen_random_bytes → 24 chars base32 RFC 4648
-- minúsculo (a–z2–7, ~120 bits). Normalização (lower, sem '-'/whitespace)
-- antes do hash sha256 hex. Comparação XOR de 32 bytes sem early exit.
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migration 0082 é pré-requisito; 0001–0082 intocadas.

-- ============ 0. Guarda de dependência ============
DO $$
BEGIN
  IF to_regclass('public.mfa_recovery_code_sets') IS NULL
     OR to_regclass('public.mfa_recovery_codes') IS NULL
     OR to_regclass('public.mfa_recovery_aal_grants') IS NULL
     OR to_regclass('public.mfa_recovery_attempts') IS NULL
     OR to_regclass('public.mfa_recovery_audit') IS NULL
     OR to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'mfa-recovery-rpc-missing-dependency';
  END IF;
END $$;

-- ============ 1. Helper XOR sem early exit (RPC-01/RPC-02) ============
CREATE OR REPLACE FUNCTION private.mfa_recovery_hash_equal(p_a text, p_b text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_a bytea := pg_catalog.decode(p_a, 'hex');
  v_b bytea := pg_catalog.decode(p_b, 'hex');
  v_acc integer := 0;
  i integer;
BEGIN
  -- Percorre os 32 bytes SEM parada antecipada: diferença em qualquer posição
  -- preserva o mesmo custo (F7/F12/F14). get_byte fora da faixa = 0.
  FOR i IN 0..31 LOOP
    v_acc := v_acc
      # CASE WHEN i < pg_catalog.octet_length(v_a) THEN pg_catalog.get_byte(v_a, i) ELSE 0 END
      # CASE WHEN i < pg_catalog.octet_length(v_b) THEN pg_catalog.get_byte(v_b, i) ELSE 0 END;
  END LOOP;
  RETURN v_acc = 0
     AND pg_catalog.octet_length(v_a) = 32
     AND pg_catalog.octet_length(v_b) = 32;
END $$;

COMMENT ON FUNCTION private.mfa_recovery_hash_equal(text, text) IS
  'ADR-001 (0083): XOR dos 32 bytes de dois hashes sha256 hex. Sem early exit (F7/F12/F14). Helper privado, chamado só por SECURITY DEFINER.';

REVOKE ALL ON FUNCTION private.mfa_recovery_hash_equal(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 2. Emissor de conjunto (compartilhado por generate/regenerate) ============
CREATE OR REPLACE FUNCTION private.mfa_recovery_issue_codes(
  p_user_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_set_id uuid := pg_catalog.gen_random_uuid();
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  v_bits bit(120);
  v_code text;
  v_hash text;
  v_codes jsonb := '[]'::jsonb;
  i integer;
  j integer;
  v_pos integer;
BEGIN
  INSERT INTO public.mfa_recovery_code_sets (id, user_id)
  VALUES (v_set_id, p_user_id);

  FOR i IN 1..10 LOOP
    -- 15 bytes CSPRNG = 120 bits = 24 grupos de 5 bits.
    v_bits := ('x' || pg_catalog.encode(extensions.gen_random_bytes(15), 'hex'))::bit(120);
    v_code := '';
    FOR j IN 0..23 LOOP
      v_pos := pg_catalog.substring(v_bits, j * 5 + 1, 5)::integer;
      v_code := v_code || pg_catalog.substr(v_alphabet, v_pos + 1, 1);
    END LOOP;

    -- Plaintext SÓ no retorno: gravamos apenas o sha256 hex do código normalizado.
    v_hash := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')), 'hex');
    INSERT INTO public.mfa_recovery_codes (id, set_id, code_hash)
    VALUES (pg_catalog.gen_random_uuid(), v_set_id, v_hash);
    v_codes := v_codes || pg_catalog.to_jsonb(v_code);
  END LOOP;

  INSERT INTO public.mfa_recovery_audit (user_id, action, set_id)
  VALUES (p_user_id, p_action, v_set_id);

  RETURN jsonb_build_object('set_id', v_set_id, 'codes', v_codes);
END $$;

COMMENT ON FUNCTION private.mfa_recovery_issue_codes(uuid, text) IS
  'ADR-001 (0083): cria set + 10 códigos (base32/24, sha256 hex) + auditoria. Retorno é o único lugar com plaintext.';

REVOKE ALL ON FUNCTION private.mfa_recovery_issue_codes(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ 3. RPC-01: mfa_recovery_generate ============
CREATE OR REPLACE FUNCTION public.mfa_recovery_generate(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
BEGIN
  -- Checagem de dono no corpo (F18): service_role/seed não têm auth.uid().
  IF v_uid IS NOT NULL AND v_uid <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-forbidden');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.mfa_recovery_code_sets
    WHERE user_id = p_user_id AND revoked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-active-set-conflict');
  END IF;

  BEGIN
    v_res := private.mfa_recovery_issue_codes(p_user_id, 'generate');
  EXCEPTION WHEN unique_violation THEN
    -- Concorrência: o índice parcial é a autoridade do "1 set ativo".
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-active-set-conflict');
  END;

  RETURN v_res;
END $$;

COMMENT ON FUNCTION public.mfa_recovery_generate(uuid) IS
  'ADR-001 (0083): devolve {"set_id","codes":[10]} uma única vez; grava só sha256 hex. EXECUTE: service_role.';

REVOKE ALL ON FUNCTION public.mfa_recovery_generate(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mfa_recovery_generate(uuid) TO service_role;

-- ============ 4. RPC-02: mfa_recovery_consume ============
CREATE OR REPLACE FUNCTION public.mfa_recovery_consume(
  p_code text,
  p_session_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_claim_session text := auth.jwt() ->> 'session_id';
  v_normalized text;
  v_hash text;
  v_set_id uuid;
  v_row record;
  v_match_id uuid;
  v_used_id uuid;
  v_failed integer;
  v_locked_until timestamptz;
  v_new_failed integer;
  v_retry integer;
  v_remaining integer;
  v_is_used boolean := false;
  v_action text;
  v_result jsonb;
BEGIN
  -- 1. Sessão: auth.uid() nulo OU session_id divergente ⇒ mismatch (0 escrita).
  IF v_uid IS NULL OR p_session_id IS NULL
     OR p_session_id IS DISTINCT FROM v_claim_session THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-session-mismatch');
  END IF;

  -- 2. Trava o set ativo (F16): serializa tentativas concorrentes.
  SELECT s.id INTO v_set_id
  FROM public.mfa_recovery_code_sets AS s
  WHERE s.user_id = v_uid AND s.revoked_at IS NULL
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1
  FOR UPDATE;
  IF v_set_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-no-active-set');
  END IF;

  -- 3. Lockout ANTES de qualquer comparação de hash.
  SELECT a.failed_count, a.locked_until INTO v_failed, v_locked_until
  FROM public.mfa_recovery_attempts AS a
  WHERE a.user_id = v_uid;
  IF v_locked_until IS NOT NULL AND v_locked_until > now() THEN
    v_retry := pg_catalog.ceil(
      pg_catalog.date_part('epoch', v_locked_until - now()))::integer;
    INSERT INTO public.mfa_recovery_audit (user_id, action, set_id, session_id)
    VALUES (v_uid, 'locked', v_set_id, p_session_id);
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-locked',
                              'retry_after_seconds', v_retry);
  END IF;

  -- 4. Normalização congelada (lower, sem '-' nem whitespace) e hash.
  v_normalized := pg_catalog.lower(
    pg_catalog.regexp_replace(COALESCE(p_code, ''), '[-[:space:]]', '', 'g'));
  v_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_normalized, 'UTF8')), 'hex');
  -- Erro técnico inesperado (não é falha de credencial): RAISE com rollback.
  IF pg_catalog.length(v_hash) <> 64 THEN
    RAISE EXCEPTION 'mfa-recovery-internal-hash-error';
  END IF;

  -- 5. Compara TODOS os hashes do set: sem early exit.
  FOR v_row IN
    SELECT c.id, c.code_hash FROM public.mfa_recovery_codes AS c
    WHERE c.set_id = v_set_id
  LOOP
    IF private.mfa_recovery_hash_equal(v_hash, v_row.code_hash) THEN
      v_match_id := v_row.id;
    END IF;
  END LOOP;

  IF v_match_id IS NOT NULL THEN
    -- Autoridade de uso único: UPDATE condicional (perdedor não marca).
    UPDATE public.mfa_recovery_codes AS c
    SET used_at = now()
    WHERE c.id = v_match_id AND c.used_at IS NULL
    RETURNING c.id INTO v_used_id;

    IF v_used_id IS NULL THEN
      INSERT INTO public.mfa_recovery_audit (user_id, action, set_id, session_id)
      VALUES (v_uid, 'reuse-denied', v_set_id, p_session_id);
      RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-code-used',
        'attempts_remaining', GREATEST(5 - COALESCE(v_failed, 0), 0));
    END IF;

    -- Grant one-shot (mesma transação do uso do código).
    DELETE FROM public.mfa_recovery_aal_grants AS g
    WHERE g.session_id = p_session_id;
    INSERT INTO public.mfa_recovery_aal_grants
      (session_id, user_id, code_id, issued_at, expires_at)
    VALUES (p_session_id, v_uid, v_used_id, now(), now() + interval '5 minutes');

    INSERT INTO public.mfa_recovery_attempts (user_id, failed_count, locked_until)
    VALUES (v_uid, 0, NULL)
    ON CONFLICT (user_id) DO UPDATE
      SET failed_count = 0, locked_until = NULL;

    INSERT INTO public.mfa_recovery_audit (user_id, action, set_id, session_id)
    VALUES (v_uid, 'consume', v_set_id, p_session_id);

    SELECT count(*) INTO v_remaining
    FROM public.mfa_recovery_codes AS c
    WHERE c.set_id = v_set_id AND c.used_at IS NULL;

    RETURN jsonb_build_object('ok', true, 'remaining', v_remaining);
  END IF;

  -- 6. Sem match: 'used' só quando o hash já usado pertence ao mesmo operador;
  --    'invalid' para código inexistente ou de outro set/usuário.
  SELECT EXISTS (
    SELECT 1
    FROM public.mfa_recovery_codes AS c
    JOIN public.mfa_recovery_code_sets AS s ON s.id = c.set_id
    WHERE s.user_id = v_uid AND c.code_hash = v_hash AND c.used_at IS NOT NULL
  ) INTO v_is_used;

  IF v_is_used THEN
    v_action := 'reuse-denied';
    v_result := jsonb_build_object('ok', false, 'error', 'mfa-recovery-code-used');
  ELSE
    v_action := 'invalid';
    v_result := jsonb_build_object('ok', false, 'error', 'mfa-recovery-code-invalid');
  END IF;

  -- 7. Contador/lockout: retorno jsonb (NÃO RAISE) ⇒ comita com a chamada.
  v_new_failed := LEAST(COALESCE(v_failed, 0) + 1, 5);
  INSERT INTO public.mfa_recovery_attempts (user_id, failed_count, locked_until)
  VALUES (v_uid, v_new_failed,
          CASE WHEN v_new_failed >= 5
               THEN now() + interval '15 minutes' ELSE NULL END)
  ON CONFLICT (user_id) DO UPDATE SET
    failed_count = LEAST(public.mfa_recovery_attempts.failed_count + 1, 5),
    locked_until = CASE
      WHEN public.mfa_recovery_attempts.failed_count + 1 >= 5
        THEN now() + interval '15 minutes' ELSE NULL END;

  IF v_new_failed >= 5 THEN
    v_action := 'locked';
    v_result := jsonb_build_object('ok', false, 'error', 'mfa-recovery-locked',
                                   'retry_after_seconds', 900);
  ELSE
    v_result := v_result || jsonb_build_object(
      'attempts_remaining', 5 - v_new_failed);
  END IF;

  INSERT INTO public.mfa_recovery_audit (user_id, action, set_id, session_id)
  VALUES (v_uid, v_action, v_set_id, p_session_id);

  RETURN v_result;
END $$;

COMMENT ON FUNCTION public.mfa_recovery_consume(text, text) IS
  'ADR-001 (0083): transação única — lock set, lockout, XOR sem early exit, UPDATE...RETURNING, grant one-shot 5 min, reset attempts, audit. Falha esperada é jsonb ok:false (comita); EXECUTE: authenticated.';

REVOKE ALL ON FUNCTION public.mfa_recovery_consume(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mfa_recovery_consume(text, text) TO authenticated;

-- ============ 5. RPC-03: mfa_recovery_status ============
CREATE OR REPLACE FUNCTION public.mfa_recovery_status(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_set_id uuid;
  v_remaining integer;
  v_codes jsonb;
BEGIN
  IF v_uid IS NOT NULL AND v_uid <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-forbidden');
  END IF;

  SELECT s.id INTO v_set_id
  FROM public.mfa_recovery_code_sets AS s
  WHERE s.user_id = p_user_id AND s.revoked_at IS NULL
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1;
  IF v_set_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-no-active-set');
  END IF;

  SELECT
    count(*) FILTER (WHERE c.used_at IS NULL),
    COALESCE(jsonb_agg(
      jsonb_build_object('id', c.id, 'used_at', c.used_at)
      ORDER BY c.created_at, c.id
    ), '[]'::jsonb)
  INTO v_remaining, v_codes
  FROM public.mfa_recovery_codes AS c
  WHERE c.set_id = v_set_id;

  -- Sem code_hash e sem código em claro (RF-07/08, NFR-09).
  RETURN jsonb_build_object(
    'total', 10,
    'remaining', v_remaining,
    'low', v_remaining <= 2,
    'codes', v_codes
  );
END $$;

COMMENT ON FUNCTION public.mfa_recovery_status(uuid) IS
  'ADR-001 (0083): {"total":10,"remaining":int,"low":bool,"codes":[{id,used_at}...10]} do set ativo. EXECUTE: service_role.';

REVOKE ALL ON FUNCTION public.mfa_recovery_status(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mfa_recovery_status(uuid) TO service_role;

-- ============ 6. RPC-04: mfa_recovery_regenerate ============
CREATE OR REPLACE FUNCTION public.mfa_recovery_regenerate(
  p_user_id uuid,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_set_id uuid;
  v_res jsonb;
BEGIN
  -- Confirmação textual EXATA: divergência ⇒ 0 escrita (antes de qualquer DML).
  IF p_confirmation IS DISTINCT FROM 'REVOGAR_CODIGOS_ATUAIS' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-confirmation-required');
  END IF;

  IF v_uid IS NOT NULL AND v_uid <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-forbidden');
  END IF;

  SELECT s.id INTO v_set_id
  FROM public.mfa_recovery_code_sets AS s
  WHERE s.user_id = p_user_id AND s.revoked_at IS NULL
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1
  FOR UPDATE;
  IF v_set_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mfa-recovery-no-active-set');
  END IF;

  -- Uma transação: revoga, apaga grants pendentes, zera tentativas e emite.
  UPDATE public.mfa_recovery_code_sets AS s
  SET revoked_at = now()
  WHERE s.id = v_set_id;

  DELETE FROM public.mfa_recovery_aal_grants AS g
  WHERE g.user_id = p_user_id AND g.consumed_at IS NULL;

  INSERT INTO public.mfa_recovery_attempts (user_id, failed_count, locked_until)
  VALUES (p_user_id, 0, NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET failed_count = 0, locked_until = NULL;

  v_res := private.mfa_recovery_issue_codes(p_user_id, 'regenerate');
  RETURN v_res;
END $$;

COMMENT ON FUNCTION public.mfa_recovery_regenerate(uuid, text) IS
  'ADR-001 (0083): confirmação exata REVOGAR_CODIGOS_ATUAIS; revoga set + apaga grants pendentes + zera attempts + 10 novos + audit, numa transação. EXECUTE: service_role.';

REVOKE ALL ON FUNCTION public.mfa_recovery_regenerate(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mfa_recovery_regenerate(uuid, text) TO service_role;
