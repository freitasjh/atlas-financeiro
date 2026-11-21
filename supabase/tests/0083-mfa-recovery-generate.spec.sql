-- 0083-mfa-recovery-generate.spec.sql — ADR-001 / F1 (TST-01) / RPC-01.
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0083-mfa-recovery-generate.spec.sql
--
-- RF-01/02/11 · NFR-02/03/09. Cobre:
--   T-83-G1  generate devolve exatamente 10 códigos ^[a-z2-7]{24}$ distintos;
--            10 hashes sha256 64 hex; 10 used_at NULL; 1 audit (generate).
--   T-83-G2  conflito: 2º generate ⇒ mfa-recovery-active-set-conflict, 0 escrita.
--   T-83-G3  EXECUTE negado a authenticated (42501).
--   T-83-G4  helper XOR compara todos os bytes sem early exit.
-- Rerunnable: fixtures e820* apagadas no início e no fim.

\set ON_ERROR_STOP on

BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id IN (
    'e8200000-0000-4000-8000-0000000000a1',
    'e8200000-0000-4000-8000-0000000000a2'));
DELETE FROM public.mfa_recovery_code_sets WHERE user_id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_attempts WHERE user_id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_audit WHERE user_id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
DELETE FROM auth.users WHERE id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
COMMIT;

BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('e8200000-0000-4000-8000-0000000000a1', 'mfa-rec-gen-a1@example.test'),
  ('e8200000-0000-4000-8000-0000000000a2', 'mfa-rec-gen-a2@example.test');
COMMIT;

-- ============ T-83-G1 — 10 códigos, hash, unicidade, auditoria ============
BEGIN;
DO $$
DECLARE
  v_uid uuid := 'e8200000-0000-4000-8000-0000000000a1';
  v_res jsonb;
  v_set uuid;
  v_code text;
  v_hash text;
  v_n int;
  i int;
  v_codes text[] := ARRAY[]::text[];
BEGIN
  SELECT public.mfa_recovery_generate(v_uid) INTO v_res;

  IF v_res ? 'error' THEN
    RAISE EXCEPTION 'T-83-G1 falhou: generate devolveu erro %', v_res->>'error';
  END IF;
  v_set := (v_res ->> 'set_id')::uuid;
  IF v_set IS NULL THEN
    RAISE EXCEPTION 'T-83-G1 falhou: set_id ausente';
  END IF;
  IF jsonb_array_length(v_res -> 'codes') <> 10 THEN
    RAISE EXCEPTION 'T-83-G1 falhou: % códigos (esperado 10)',
      jsonb_array_length(v_res -> 'codes');
  END IF;

  FOR i IN 0..9 LOOP
    v_code := v_res -> 'codes' ->> i;
    IF v_code !~ '^[a-z2-7]{24}$' THEN
      RAISE EXCEPTION 'T-83-G1 falhou: código % fora do formato base32/24', v_code;
    END IF;
    v_codes := v_codes || v_code;

    v_hash := encode(sha256(convert_to(v_code, 'UTF8')), 'hex');
    IF v_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'T-83-G1 falhou: hash % não é 64 hex', v_hash;
    END IF;
    IF v_hash = v_code THEN
      RAISE EXCEPTION 'T-83-G1 falhou: código em claro persistido como hash';
    END IF;
    SELECT count(*) INTO v_n
    FROM public.mfa_recovery_codes
    WHERE set_id = v_set AND code_hash = v_hash AND used_at IS NULL;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'T-83-G1 falhou: hash % não gravado uma vez', v_hash;
    END IF;
  END LOOP;

  -- 10 distintos.
  SELECT count(DISTINCT x) INTO v_n FROM unnest(v_codes) AS x;
  IF v_n <> 10 THEN
    RAISE EXCEPTION 'T-83-G1 falhou: apenas % códigos distintos', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.mfa_recovery_codes
  WHERE set_id = v_set AND used_at IS NULL;
  IF v_n <> 10 THEN
    RAISE EXCEPTION 'T-83-G1 falhou: % linhas disponíveis (esperado 10)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_code_sets
  WHERE user_id = v_uid AND revoked_at IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-83-G1 falhou: % sets ativos (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_audit
  WHERE user_id = v_uid AND action = 'generate' AND set_id = v_set
    AND occurred_at IS NOT NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-83-G1 falhou: % trilha generate', v_n;
  END IF;

  PERFORM set_config('mfa_rec.gen.set', v_set::text, false);
  PERFORM set_config('mfa_rec.gen.code', v_code, false);
  RAISE NOTICE 'T-83-G1 ok: 10 base32/24 + 10 sha256/64 + 1 set + 1 audit';
END $$;
ROLLBACK;

-- ============ T-83-G2 — conflito de set ativo (0 escrita) ============
BEGIN;
-- fixture: set ativo do a2
DO $$
DECLARE v_uid uuid := 'e8200000-0000-4000-8000-0000000000a2';
BEGIN
  PERFORM public.mfa_recovery_generate(v_uid);
END $$;
DO $$
DECLARE
  v_uid uuid := 'e8200000-0000-4000-8000-0000000000a2';
  v_res jsonb;
  v_sets int;
  v_codes int;
  v_audit int;
BEGIN
  SELECT public.mfa_recovery_generate(v_uid) INTO v_res;
  IF v_res ->> 'error' <> 'mfa-recovery-active-set-conflict' THEN
    RAISE EXCEPTION 'T-83-G2 falhou: rótulo %', v_res ->> 'error';
  END IF;

  SELECT count(*) INTO v_sets FROM public.mfa_recovery_code_sets
  WHERE user_id = v_uid AND revoked_at IS NULL;
  SELECT count(*) INTO v_codes FROM public.mfa_recovery_codes c
  JOIN public.mfa_recovery_code_sets s ON s.id = c.set_id
  WHERE s.user_id = v_uid;
  SELECT count(*) INTO v_audit FROM public.mfa_recovery_audit
  WHERE user_id = v_uid AND action = 'generate';
  IF v_sets <> 1 OR v_codes <> 10 OR v_audit <> 1 THEN
    RAISE EXCEPTION 'T-83-G2 falhou: % sets / % códigos / % audit', v_sets, v_codes, v_audit;
  END IF;
  RAISE NOTICE 'T-83-G2 ok: mfa-recovery-active-set-conflict + 0 escrita';
END $$;
ROLLBACK;

-- ============ T-83-G3 — authenticated não executa generate (42501) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"g3"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.mfa_recovery_generate('e8200000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'T-83-G3 falhou: authenticated executou generate';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'T-83-G3 ok: 42501 para authenticated'; END $$;
ROLLBACK;

-- ============ T-83-G4 — helper XOR: compara TODOS os bytes ============
BEGIN;
DO $$
DECLARE
  v_a text := encode(sha256(convert_to('abcdefghijklmnopqrstuvwx', 'UTF8')), 'hex');
  v_b text := encode(sha256(convert_to('ABCDEFGHIJKLMNOPQRSTUVWX', 'UTF8')), 'hex');
  v_z text := encode(sha256(convert_to('zyxwvutsrqponmlkjihgfedcb', 'UTF8')), 'hex');
  v_def text;
BEGIN
  IF NOT private.mfa_recovery_hash_equal(v_a, v_a) THEN
    RAISE EXCEPTION 'T-83-G4 falhou: hash igual não comparou';
  END IF;
  IF private.mfa_recovery_hash_equal(v_a, v_z) THEN
    RAISE EXCEPTION 'T-83-G4 falhou: hashes diferentes compararam';
  END IF;
  IF v_a = v_b THEN
    RAISE EXCEPTION 'T-83-G4 falhou: hash é case-sensitive (normalização é do chamador)';
  END IF;

  SELECT prosrc INTO v_def FROM pg_proc
  WHERE oid = 'private.mfa_recovery_hash_equal(text,text)'::regprocedure;
  IF v_def NOT LIKE '%FOR %' OR v_def NOT LIKE '%#%' THEN
    RAISE EXCEPTION 'T-83-G4 falhou: helper não percorre todos os bytes com XOR';
  END IF;
  IF v_def ~* 'return.*loop' OR v_def ~* 'exit' THEN
    RAISE EXCEPTION 'T-83-G4 falhou: helper tem early exit';
  END IF;
  RAISE NOTICE 'T-83-G4 ok: XOR de 32 bytes sem early exit';
END $$;
ROLLBACK;

-- ============ Limpeza final ============
BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id IN (
    'e8200000-0000-4000-8000-0000000000a1',
    'e8200000-0000-4000-8000-0000000000a2'));
DELETE FROM public.mfa_recovery_code_sets WHERE user_id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_attempts WHERE user_id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_audit WHERE user_id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
DELETE FROM auth.users WHERE id IN (
  'e8200000-0000-4000-8000-0000000000a1',
  'e8200000-0000-4000-8000-0000000000a2');
COMMIT;
