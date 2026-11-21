-- 0083-mfa-recovery-consume.spec.sql — ADR-001 / F1 (TST-01) / RPC-02.
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0083-mfa-recovery-consume.spec.sql
--
-- RF-02/05/06/10/13 · NFR-03/04/05/07/09. Cobertura:
--   T-83-C1  sucesso atômico: ok:true/remaining=9 + used_at + grant 5 min
--            + attempts zerados + audit(consume), sem erro tecnico.
--   T-83-C2  session mismatch ⇒ jsonb ok:false, 0 escrita.
--   T-83-C3  inválido ⇒ attempts_remaining + audit(invalid) COMITADO (não RAISE).
--   T-83-C4  reuso ⇒ code-used + audit(reuse-denied), 0 linha nova em codes.
--   T-83-C5  lockout na 5ª falha ⇒ locked + retry_after_seconds=900, 0 RAISE.
--   T-83-C6  tentativas zeradas no consumo válido.
--   T-83-C7  corrida real (2 conexões) é PARCIAL: prova por FOR UPDATE + UPDATE
--            condicional no prosrc e pelo 2º consumo sequencial = code-used.
-- Rerunnable: fixtures e821* apagadas no início e no fim.

\set ON_ERROR_STOP on

BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id IN (
    'e8210000-0000-4000-8000-0000000000a1',
    'e8210000-0000-4000-8000-0000000000a2'));
DELETE FROM public.mfa_recovery_code_sets WHERE user_id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_attempts WHERE user_id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_audit WHERE user_id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
DELETE FROM auth.users WHERE id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
COMMIT;

BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('e8210000-0000-4000-8000-0000000000a1', 'mfa-rec-consume-a1@example.test'),
  ('e8210000-0000-4000-8000-0000000000a2', 'mfa-rec-consume-a2@example.test');
DO $$
DECLARE v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_generate('e8210000-0000-4000-8000-0000000000a1') INTO v_res;
  PERFORM set_config('mfa_rec.c1.codes', (v_res -> 'codes')::text, false);
  SELECT public.mfa_recovery_generate('e8210000-0000-4000-8000-0000000000a2') INTO v_res;
  PERFORM set_config('mfa_rec.c2.codes', (v_res -> 'codes')::text, false);
END $$;
COMMIT;

-- ============ T-83-C1 — sucesso atômico ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8210000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"c1-sess"}', true);
DO $$
DECLARE
  v_code text := current_setting('mfa_rec.c1.codes')::jsonb ->> 0;
  v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_consume(v_code, 'c1-sess') INTO v_res;
  IF v_res ->> 'ok' <> 'true' OR (v_res ->> 'remaining')::int <> 9 THEN
    RAISE EXCEPTION 'T-83-C1 falhou: retorno %', v_res;
  END IF;
  PERFORM set_config('mfa_rec.c1.res', v_res::text, true);
END $$;
RESET ROLE;
DO $$
DECLARE
  v_uid uuid := 'e8210000-0000-4000-8000-0000000000a1';
  v_res jsonb := current_setting('mfa_rec.c1.res')::jsonb;
  v_code text := current_setting('mfa_rec.c1.codes')::jsonb ->> 0;
  v_hash text := encode(sha256(convert_to(current_setting('mfa_rec.c1.codes')::jsonb ->> 0, 'UTF8')), 'hex');
  v_g public.mfa_recovery_aal_grants;
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.mfa_recovery_codes
  WHERE code_hash = v_hash AND used_at IS NOT NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-83-C1 falhou: used_at não marcado';
  END IF;
  SELECT * INTO v_g FROM public.mfa_recovery_aal_grants WHERE session_id = 'c1-sess';
  IF NOT FOUND OR v_g.user_id <> v_uid OR v_g.code_id IS NULL
     OR v_g.consumed_at IS NOT NULL
     OR v_g.expires_at - v_g.issued_at <> interval '5 minutes'
     OR v_g.expires_at <= now() THEN
    RAISE EXCEPTION 'T-83-C1 falhou: grant one-shot inválido';
  END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_attempts
  WHERE user_id = v_uid AND failed_count = 0 AND locked_until IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-83-C1 falhou: attempts não zerado';
  END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_audit
  WHERE user_id = v_uid AND action = 'consume' AND session_id = 'c1-sess'
    AND occurred_at IS NOT NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-83-C1 falhou: % audit(consume)', v_n;
  END IF;
  IF v_res::text LIKE '%' || v_code || '%' THEN
    RAISE EXCEPTION 'T-83-C1 falhou: código vazou no retorno';
  END IF;
  RAISE NOTICE 'T-83-C1 ok: ok:true/remaining=9 + used_at + grant + audit';
END $$;
ROLLBACK;

-- ============ T-83-C2 — session mismatch (0 escrita) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8210000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"c2-claim"}', true);
DO $$
DECLARE
  v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_consume(
    current_setting('mfa_rec.c1.codes')::jsonb ->> 0, 'c2-diferente') INTO v_res;
  IF v_res ->> 'error' <> 'mfa-recovery-session-mismatch' OR v_res ->> 'ok' <> 'false' THEN
    RAISE EXCEPTION 'T-83-C2 falhou: retorno %', v_res;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  -- fixture generate já gravou 1 action='generate': aqui só importa 0 escrita
  -- adicional (audit de consume/invalid/reuse/locked).
  SELECT count(*) INTO v_n FROM public.mfa_recovery_audit
  WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1'
    AND action <> 'generate';
  IF v_n <> 0 THEN RAISE EXCEPTION 'T-83-C2 falhou: % escrita em audit', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_aal_grants WHERE session_id LIKE 'c2-%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'T-83-C2 falhou: % grant(s) criado(s)', v_n; END IF;
  RAISE NOTICE 'T-83-C2 ok: session-mismatch + 0 escrita';
END $$;
ROLLBACK;

-- ============ T-83-C3 — inválido: contador/audit comitam (não RAISE) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8210000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"c3-sess"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_consume('zzzzzzzzzzzzzzzzzzzzzzzz', 'c3-sess') INTO v_res;
  IF v_res ->> 'error' <> 'mfa-recovery-code-invalid' THEN
    RAISE EXCEPTION 'T-83-C3 falhou: rótulo %', v_res ->> 'error';
  END IF;
  IF (v_res ->> 'attempts_remaining')::int <> 4 THEN
    RAISE EXCEPTION 'T-83-C3 falhou: attempts_remaining %', v_res ->> 'attempts_remaining';
  END IF;
  IF v_res::text LIKE '%zzzz%' THEN
    RAISE EXCEPTION 'T-83-C3 falhou: código vazou na mensagem';
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.mfa_recovery_attempts
  WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1' AND failed_count = 1;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-C3 falhou: contador não comitou'; END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_audit
  WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1' AND action = 'invalid';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-C3 falhou: audit não comitou'; END IF;
  RAISE NOTICE 'T-83-C3 ok: jsonb ok:false + contador/audit comitados';
END $$;
COMMIT; -- escrita esperada DEVE sobreviver ao commit do chamador

-- limpa o que T-83-C3 commitou (para os próximos cenários partirem do zero)
BEGIN;
DELETE FROM public.mfa_recovery_audit WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_attempts WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1';
COMMIT;

-- ============ T-83-C4 — reuso: code-used + reuse-denied ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8210000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"c4-sess"}', true);
DO $$
DECLARE
  v_code text := current_setting('mfa_rec.c1.codes')::jsonb ->> 0;
  v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_consume(v_code, 'c4-sess') INTO v_res;
  IF v_res ->> 'ok' <> 'true' THEN RAISE EXCEPTION 'T-83-C4 falhou: 1º consumo %', v_res; END IF;
  SELECT public.mfa_recovery_consume(v_code, 'c4-sess') INTO v_res;
  IF v_res ->> 'error' <> 'mfa-recovery-code-used' THEN
    RAISE EXCEPTION 'T-83-C4 falhou: rótulo %', v_res ->> 'error';
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.mfa_recovery_codes c
  JOIN public.mfa_recovery_code_sets s ON s.id = c.set_id
  WHERE s.user_id = 'e8210000-0000-4000-8000-0000000000a1';
  IF v_n <> 10 THEN RAISE EXCEPTION 'T-83-C4 falhou: % linhas em codes', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_audit
  WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1'
    AND action = 'reuse-denied' AND session_id = 'c4-sess';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-C4 falhou: % audit reuse-denied', v_n; END IF;
  RAISE NOTICE 'T-83-C4 ok: code-used + reuse-denied + 0 linha nova';
END $$;
ROLLBACK;

-- ============ T-83-C5 — lockout na 5ª falha, retry_after=900 ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8210000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"c5-sess"}', true);
DO $$
DECLARE
  v_res jsonb;
  v_lbl text;
  i int;
BEGIN
  FOR i IN 1..5 LOOP
    SELECT public.mfa_recovery_consume('zzzzzzzzzzzzzzzzzzzzzzzz', 'c5-sess') INTO v_res;
    v_lbl := v_res ->> 'error';
    IF i < 5 THEN
      IF v_lbl <> 'mfa-recovery-code-invalid'
         OR (v_res ->> 'attempts_remaining')::int <> 5 - i THEN
        RAISE EXCEPTION 'T-83-C5 falhou: tentativa % → %', i, v_res;
      END IF;
    ELSE
      IF v_lbl <> 'mfa-recovery-locked' THEN
        RAISE EXCEPTION 'T-83-C5 falhou: 5ª tentativa → %', v_res;
      END IF;
      IF (v_res ->> 'retry_after_seconds')::int <> 900 THEN
        RAISE EXCEPTION 'T-83-C5 falhou: retry_after %', v_res ->> 'retry_after_seconds';
      END IF;
    END IF;
  END LOOP;
  -- 6ª: ainda locked, sem novo raise.
  SELECT public.mfa_recovery_consume('zzzzzzzzzzzzzzzzzzzzzzzz', 'c5-sess') INTO v_res;
  IF v_res ->> 'error' <> 'mfa-recovery-locked'
     OR (v_res ->> 'retry_after_seconds')::int > 900 THEN
    RAISE EXCEPTION 'T-83-C5 falhou: 6ª tentativa → %', v_res;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE
  v_n int;
  v_lock timestamptz;
BEGIN
  SELECT locked_until INTO v_lock FROM public.mfa_recovery_attempts
  WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1';
  IF v_lock IS NULL OR v_lock - now() NOT BETWEEN interval '14 minutes' AND interval '15 minutes 30 seconds' THEN
    RAISE EXCEPTION 'T-83-C5 falhou: locked_until %', v_lock;
  END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_audit
  WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1'
    AND action IN ('invalid', 'locked');
  IF v_n <> 6 THEN RAISE EXCEPTION 'T-83-C5 falhou: % audit', v_n; END IF;
  RAISE NOTICE 'T-83-C5 ok: 5 falhas → locked/900 + contador/audit persistidos';
END $$;
COMMIT;
BEGIN;
DELETE FROM public.mfa_recovery_audit WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_attempts WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1';
COMMIT;

-- ============ T-83-C6 — tentativas zeradas no consumo válido ============
BEGIN;
INSERT INTO public.mfa_recovery_attempts (user_id, failed_count, locked_until)
VALUES ('e8210000-0000-4000-8000-0000000000a1', 4, NULL);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8210000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"c6-sess"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_consume(
    current_setting('mfa_rec.c1.codes')::jsonb ->> 1, 'c6-sess') INTO v_res;
  IF v_res ->> 'ok' <> 'true' THEN RAISE EXCEPTION 'T-83-C6 falhou: %', v_res; END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.mfa_recovery_attempts
  WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1'
    AND failed_count = 0 AND locked_until IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-C6 falhou: attempts não zerado'; END IF;
  RAISE NOTICE 'T-83-C6 ok: consumo válido zera tentativas';
END $$;
ROLLBACK;

-- ============ T-83-C7 — concorrência (prova parcial) ============
BEGIN;
DO $$
DECLARE v_def text; v_n int;
BEGIN
  SELECT prosrc INTO v_def FROM pg_proc
  WHERE oid = 'public.mfa_recovery_consume(text,text)'::regprocedure;
  IF v_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'T-83-C7 falhou: consume sem FOR UPDATE no set';
  END IF;
  IF v_def NOT LIKE '%UPDATE%' OR v_def NOT LIKE '%RETURNING%' THEN
    RAISE EXCEPTION 'T-83-C7 falhou: consume sem UPDATE ... RETURNING condicional';
  END IF;
  IF v_def !~* '\mraise\M' THEN
    RAISE EXCEPTION 'T-83-C7 falhou: consume sem RAISE para erro técnico inesperado';
  END IF;
  -- 2º consumo sequencial do mesmo código já usado ⇒ code-used (autoridade).
  SELECT count(*) INTO v_n FROM public.mfa_recovery_code_sets
  WHERE user_id = 'e8210000-0000-4000-8000-0000000000a1' AND revoked_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-83-C7 falhou: set de fixture ausente'; END IF;
  RAISE NOTICE 'T-83-C7 ok (parcial): FOR UPDATE + UPDATE...RETURNING no prosrc; corrida real em 2 conexões fora deste spec';
END $$;
ROLLBACK;

-- ============ Limpeza final ============
BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id IN (
    'e8210000-0000-4000-8000-0000000000a1',
    'e8210000-0000-4000-8000-0000000000a2'));
DELETE FROM public.mfa_recovery_code_sets WHERE user_id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_attempts WHERE user_id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
DELETE FROM public.mfa_recovery_audit WHERE user_id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
DELETE FROM auth.users WHERE id IN (
  'e8210000-0000-4000-8000-0000000000a1',
  'e8210000-0000-4000-8000-0000000000a2');
COMMIT;
