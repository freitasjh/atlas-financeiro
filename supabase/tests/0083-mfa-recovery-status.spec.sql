-- 0083-mfa-recovery-status.spec.sql — ADR-001 / F1 (TST-01) / RPC-03.
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0083-mfa-recovery-status.spec.sql
--
-- RF-07/08 · NFR-09. Cobertura:
--   T-83-S1  payload exato: total=10, remaining, low, codes[10] with id/used_at;
--            sem code_hash e sem código em claro.
--   T-83-S2  fronteira low: remaining=3 ⇒ false; remaining=2 ⇒ true.
--   T-83-S3  somente set ativo (após regenerate, códigos antigos ausentes).
--   T-83-S4  authenticated não executa status (42501).

\set ON_ERROR_STOP on

BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1');
DELETE FROM public.mfa_recovery_code_sets WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_attempts WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_audit WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1';
DELETE FROM auth.users WHERE id = 'e8220000-0000-4000-8000-0000000000a1';
COMMIT;

BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('e8220000-0000-4000-8000-0000000000a1', 'mfa-rec-status-a1@example.test');
DO $$
DECLARE v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_generate('e8220000-0000-4000-8000-0000000000a1') INTO v_res;
  PERFORM set_config('mfa_rec.s.codes', (v_res -> 'codes')::text, false);
END $$;
COMMIT;

-- ============ T-83-S1 — payload exato e sem segredo ============
BEGIN;
DO $$
DECLARE
  v_uid uuid := 'e8220000-0000-4000-8000-0000000000a1';
  v_res jsonb;
  v_codes jsonb := current_setting('mfa_rec.s.codes')::jsonb;
  v_n int;
  i int;
BEGIN
  SELECT public.mfa_recovery_status(v_uid) INTO v_res;

  IF (v_res ->> 'total')::int <> 10 OR (v_res ->> 'remaining')::int <> 10
     OR (v_res ->> 'low')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'T-83-S1 falhou: cabeçalho %', v_res - 'codes';
  END IF;
  IF jsonb_array_length(v_res -> 'codes') <> 10 THEN
    RAISE EXCEPTION 'T-83-S1 falhou: codes[] com % entradas',
      jsonb_array_length(v_res -> 'codes');
  END IF;

  FOR i IN 0..9 LOOP
    IF NOT (v_res -> 'codes' -> i ? 'id') OR NOT (v_res -> 'codes' -> i ? 'used_at') THEN
      RAISE EXCEPTION 'T-83-S1 falhou: entrada % sem id/used_at', i;
    END IF;
    IF (v_res -> 'codes' -> i ->> 'used_at') IS NOT NULL THEN
      RAISE EXCEPTION 'T-83-S1 falhou: used_at não nulo na entrada %', i;
    END IF;
  END LOOP;

  -- nenhum segredo no payload: nem hash, nem código em claro, nem coluna code_hash.
  IF v_res::text ~* 'code_hash|sha256' THEN
    RAISE EXCEPTION 'T-83-S1 falhou: hash vazou no status';
  END IF;
  FOR i IN 0..9 LOOP
    IF v_res::text LIKE '%' || (v_codes ->> i) || '%' THEN
      RAISE EXCEPTION 'T-83-S1 falhou: código em claro vazou no status';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.mfa_recovery_audit
  WHERE user_id = v_uid AND action = 'status';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-83-S1 falhou: status gravou auditoria (deve ser read-only)';
  END IF;
  RAISE NOTICE 'T-83-S1 ok: payload congelado, 10 entradas, 0 segredo';
END $$;
ROLLBACK;

-- ============ T-83-S2 — fronteira low (3 → false; 2 → true) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8220000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"s2"}', true);
DO $$
DECLARE v_res jsonb; i int;
BEGIN
  FOR i IN 1..8 LOOP
    SELECT public.mfa_recovery_consume(
      current_setting('mfa_rec.s.codes')::jsonb ->> i, 's2') INTO v_res;
    IF v_res ->> 'ok' <> 'true' THEN
      RAISE EXCEPTION 'T-83-S2 falhou: consumo % → %', i, v_res;
    END IF;
  END LOOP;
END $$;
RESET ROLE;
DO $$
DECLARE v_res jsonb; v_n int;
BEGIN
  SELECT public.mfa_recovery_status('e8220000-0000-4000-8000-0000000000a1') INTO v_res;
  IF (v_res ->> 'remaining')::int <> 2 OR (v_res ->> 'low') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'T-83-S2 falhou: remaining/low %', v_res - 'codes';
  END IF;
  SELECT count(*) INTO v_n FROM jsonb_array_elements(v_res -> 'codes') AS e
  WHERE (e.value ->> 'used_at') IS NOT NULL;
  IF v_n <> 8 THEN RAISE EXCEPTION 'T-83-S2 falhou: % usados (esperado 8)', v_n; END IF;
  RAISE NOTICE 'T-83-S2 ok: remaining=2, low=true, 8 usados';
END $$;
ROLLBACK;

-- ============ T-83-S3 — só o set ativo ============
BEGIN;
DO $$
DECLARE
  v_uid uuid := 'e8220000-0000-4000-8000-0000000000a1';
  v_old uuid;
  v_new uuid;
  v_res jsonb;
BEGIN
  SELECT id INTO v_old FROM public.mfa_recovery_code_sets
  WHERE user_id = v_uid AND revoked_at IS NULL;

  SELECT public.mfa_recovery_regenerate(v_uid, 'REVOGAR_CODIGOS_ATUAIS') INTO v_res;
  v_new := (v_res ->> 'set_id')::uuid;
  IF v_new IS NULL OR v_new = v_old THEN
    RAISE EXCEPTION 'T-83-S3 falhou: regenerate não criou set novo';
  END IF;

  SELECT public.mfa_recovery_status(v_uid) INTO v_res;
  IF jsonb_array_length(v_res -> 'codes') <> 10
     OR (v_res ->> 'remaining')::int <> 10 THEN
    RAISE EXCEPTION 'T-83-S3 falhou: status não mostrou 10 novos';
  END IF;
  IF (v_res -> 'codes')::text LIKE '%' || v_old::text || '%' THEN
    RAISE EXCEPTION 'T-83-S3 falhou: set antigo vazou no status';
  END IF;
  RAISE NOTICE 'T-83-S3 ok: status mostra só o set novo';
END $$;
ROLLBACK;

-- ============ T-83-S4 — authenticated não executa status ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8220000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.mfa_recovery_status('e8220000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'T-83-S4 falhou: authenticated executou status';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'T-83-S4 ok: 42501 para authenticated'; END $$;
ROLLBACK;

-- ============ Limpeza final ============
BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1');
DELETE FROM public.mfa_recovery_code_sets WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_attempts WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_audit WHERE user_id = 'e8220000-0000-4000-8000-0000000000a1';
DELETE FROM auth.users WHERE id = 'e8220000-0000-4000-8000-0000000000a1';
COMMIT;
