-- 0083-mfa-recovery-regenerate.spec.sql — ADR-001 / F1 (TST-01) / RPC-04.
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0083-mfa-recovery-regenerate.spec.sql
--
-- RF-09/11 · NFR-05/09. Cobertura:
--   T-83-R1  confirmação divergente ⇒ mfa-recovery-confirmation-required e
--            Δ pg_stat_xact_user_tables = 0 (prova runtime, não count(*)).
--   T-83-R2  confirmação exata ⇒ set antigo revogado + grants pendentes apagados
--            + attempts zerados + 10 novos + audit(regenerate).
--   T-83-R3  segunda regeneração revoga a primeira; 1 set ativo (índice).
--   T-83-R4  authenticated não executa regenerate (42501).

\set ON_ERROR_STOP on

BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1');
DELETE FROM public.mfa_recovery_code_sets WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_attempts WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_audit WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DELETE FROM auth.users WHERE id = 'e8230000-0000-4000-8000-0000000000a1';
COMMIT;

BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('e8230000-0000-4000-8000-0000000000a1', 'mfa-rec-regen-a1@example.test');
DO $$
DECLARE v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_generate('e8230000-0000-4000-8000-0000000000a1') INTO v_res;
  PERFORM set_config('mfa_rec.r.codes', (v_res -> 'codes')::text, false);
END $$;
COMMIT;

-- ============ T-83-R1 — confirmação divergente: 0 escrita ============
BEGIN;
DO $$
DECLARE
  v_uid uuid := 'e8230000-0000-4000-8000-0000000000a1';
  v_res jsonb;
  v_w0 bigint;
  v_w1 bigint;
  v_sets int;
  v_codes int;
  v_audit int;
BEGIN
  -- baseline DEPOIS do fixture (contadores de xact sobrevivem ao rollback).
  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_w0
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('mfa_recovery_code_sets', 'mfa_recovery_codes',
                    'mfa_recovery_aal_grants', 'mfa_recovery_attempts', 'mfa_recovery_audit');

  SELECT public.mfa_recovery_regenerate(v_uid, 'ERRADO') INTO v_res;
  IF v_res ->> 'error' <> 'mfa-recovery-confirmation-required' THEN
    RAISE EXCEPTION 'T-83-R1 falhou: rótulo %', v_res ->> 'error';
  END IF;

  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_w1
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('mfa_recovery_code_sets', 'mfa_recovery_codes',
                    'mfa_recovery_aal_grants', 'mfa_recovery_attempts', 'mfa_recovery_audit');
  IF v_w1 - v_w0 <> 0 THEN
    RAISE EXCEPTION 'T-83-R1 falhou: Δ escritas = % (esperado 0)', v_w1 - v_w0;
  END IF;

  SELECT count(*) INTO v_sets FROM public.mfa_recovery_code_sets
  WHERE user_id = v_uid AND revoked_at IS NULL;
  SELECT count(*) INTO v_codes FROM public.mfa_recovery_codes c
  JOIN public.mfa_recovery_code_sets s ON s.id = c.set_id WHERE s.user_id = v_uid;
  SELECT count(*) INTO v_audit FROM public.mfa_recovery_audit
  WHERE user_id = v_uid AND action = 'regenerate';
  IF v_sets <> 1 OR v_codes <> 10 OR v_audit <> 0 THEN
    RAISE EXCEPTION 'T-83-R1 falhou: % sets/% códigos/% audit', v_sets, v_codes, v_audit;
  END IF;
  RAISE NOTICE 'T-83-R1 ok: confirmação divergente + Δ escritas=0';
END $$;
ROLLBACK;

-- ============ T-83-R2 — regenerate atômico ============
BEGIN;
-- grant pendente + tentativas para provar o purge/reset.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8230000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"r2-sess"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_consume(
    current_setting('mfa_rec.r.codes')::jsonb ->> 0, 'r2-sess') INTO v_res;
  IF v_res ->> 'ok' <> 'true' THEN RAISE EXCEPTION 'T-83-R2 falhou: fixture consume %', v_res; END IF;
END $$;
RESET ROLE;
UPDATE public.mfa_recovery_attempts
SET failed_count = 3, locked_until = NULL
WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DO $$
DECLARE
  v_uid uuid := 'e8230000-0000-4000-8000-0000000000a1';
  v_old uuid;
  v_res jsonb;
  v_new uuid;
  v_n int;
  i int;
BEGIN
  SELECT id INTO v_old FROM public.mfa_recovery_code_sets
  WHERE user_id = v_uid AND revoked_at IS NULL;

  SELECT public.mfa_recovery_regenerate(v_uid, 'REVOGAR_CODIGOS_ATUAIS') INTO v_res;
  v_new := (v_res ->> 'set_id')::uuid;
  IF v_new IS NULL OR v_new = v_old OR jsonb_array_length(v_res -> 'codes') <> 10 THEN
    RAISE EXCEPTION 'T-83-R2 falhou: retorno %', v_res - 'codes';
  END IF;

  SELECT count(*) INTO v_n FROM public.mfa_recovery_code_sets
  WHERE id = v_old AND revoked_at IS NOT NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-R2 falhou: set antigo não revogado'; END IF;

  -- grants NÃO consumidos do usuário apagados (o consumido 'r2-sess' também sai:
  -- foi gravado com consumed_at NULL até o hook, logo é pendente).
  SELECT count(*) INTO v_n FROM public.mfa_recovery_aal_grants WHERE user_id = v_uid;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T-83-R2 falhou: % grants pendentes', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.mfa_recovery_attempts
  WHERE user_id = v_uid AND failed_count = 0 AND locked_until IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-R2 falhou: attempts não zerado'; END IF;

  SELECT count(*) INTO v_n FROM public.mfa_recovery_codes
  WHERE set_id = v_new AND used_at IS NULL;
  IF v_n <> 10 THEN RAISE EXCEPTION 'T-83-R2 falhou: % novos códigos', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.mfa_recovery_audit
  WHERE user_id = v_uid AND action = 'regenerate' AND set_id = v_new;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-R2 falhou: % audit regenerate', v_n; END IF;

  FOR i IN 0..9 LOOP
    IF (v_res -> 'codes' ->> i) !~ '^[a-z2-7]{24}$' THEN
      RAISE EXCEPTION 'T-83-R2 falhou: novo código % inválido', v_res -> 'codes' ->> i;
    END IF;
  END LOOP;
  RAISE NOTICE 'T-83-R2 ok: revoke + purge grants + reset attempts + 10 novos + audit';
END $$;
ROLLBACK;

-- ============ T-83-R3 — dupla regeneração ============
BEGIN;
DO $$
DECLARE
  v_uid uuid := 'e8230000-0000-4000-8000-0000000000a1';
  v_a uuid; v_b uuid; v_res jsonb; v_n int;
BEGIN
  SELECT public.mfa_recovery_regenerate(v_uid, 'REVOGAR_CODIGOS_ATUAIS') INTO v_res;
  v_a := (v_res ->> 'set_id')::uuid;
  SELECT public.mfa_recovery_regenerate(v_uid, 'REVOGAR_CODIGOS_ATUAIS') INTO v_res;
  v_b := (v_res ->> 'set_id')::uuid;
  IF v_a = v_b THEN RAISE EXCEPTION 'T-83-R3 falhou: set_id repetido'; END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_code_sets
  WHERE user_id = v_uid AND revoked_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-R3 falhou: % sets ativos', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_code_sets
  WHERE id = v_a AND revoked_at IS NOT NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-R3 falhou: 1ª lista não revogada'; END IF;
  RAISE NOTICE 'T-83-R3 ok: 2ª regeneração revoga a 1ª; 1 set ativo';
END $$;
ROLLBACK;

-- ============ T-83-R4 — authenticated não executa regenerate ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8230000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.mfa_recovery_regenerate(
      'e8230000-0000-4000-8000-0000000000a1', 'REVOGAR_CODIGOS_ATUAIS');
    RAISE EXCEPTION 'T-83-R4 falhou: authenticated executou regenerate';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'T-83-R4 ok: 42501 para authenticated'; END $$;
ROLLBACK;

-- ============ Limpeza final ============
BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1');
DELETE FROM public.mfa_recovery_code_sets WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_attempts WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_audit WHERE user_id = 'e8230000-0000-4000-8000-0000000000a1';
DELETE FROM auth.users WHERE id = 'e8230000-0000-4000-8000-0000000000a1';
COMMIT;
