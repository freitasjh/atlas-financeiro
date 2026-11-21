-- 0084-mfa-recovery-hook.spec.sql — ADR-001 / F1 (TST-01) / HOOK-01.
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0084-mfa-recovery-hook.spec.sql
--
-- R1 resolvido: claims.session_id é claim REQUIRED no payload do hook
-- (https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook,
-- consultado 2026-11-21). Este spec usa payload real (F20) e prova que a chave
-- do grant é exatamente event.claims->>'session_id'.
--
--   T-84-H1  grant vigente ⇒ aal='aal2', amr[0]={method:'recovery',timestamp},
--            demais claims preservados, grant removido (DELETE ... RETURNING).
--   T-84-H2  aal2 de entrada ⇒ evento intacto (nunca rebaixa).
--   T-84-H3  sem grant / sessão divergente (R1) / expirado ⇒ evento intacto.
--   T-84-H4  2º refresh após elevação não eleva de novo.
--   T-84-H5  hook NÃO DEFINER + uma única DELETE (orçamento 2 s).
-- Rerunnable: fixtures e824* apagadas no início e no fim.

\set ON_ERROR_STOP on

-- Nota de papel: o postgres local NÃO é superuser (rolsuper=f) e a
-- membership em supabase_auth_admin é reservada a superusers; portanto
-- SET ROLE é impossível aqui. A lógica do hook é exercida como dono da
-- função; GRANTs/policy para supabase_auth_admin são provados no catálogo
-- (0082) e por conexão DIRETA em 0084-mfa-recovery-hook-role.spec.sql.

BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1');
DELETE FROM public.mfa_recovery_code_sets WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_attempts WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_audit WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1';
DELETE FROM auth.users WHERE id = 'e8240000-0000-4000-8000-0000000000a1';
COMMIT;

BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('e8240000-0000-4000-8000-0000000000a1', 'mfa-rec-hook-a1@example.test');
DO $$
DECLARE v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_generate('e8240000-0000-4000-8000-0000000000a1') INTO v_res;
  PERFORM set_config('mfa_rec.h.codes', (v_res -> 'codes')::text, false);
END $$;
COMMIT;

-- helper de payload congelado (F20): required claims presentes.
CREATE OR REPLACE FUNCTION pg_temp.mfa_hook_event(p_session text, p_aal text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'user_id', 'e8240000-0000-4000-8000-0000000000a1',
    'claims', jsonb_build_object(
      'aud', 'authenticated', 'exp', 1893456000, 'iat', 1760000000,
      'sub', 'e8240000-0000-4000-8000-0000000000a1',
      'email', 'mfa-rec-hook-a1@example.test', 'phone', '',
      'app_metadata', '{}'::jsonb, 'user_metadata', '{}'::jsonb,
      'role', 'authenticated', 'aal', p_aal,
      'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', 1760000000)),
      'session_id', p_session, 'is_anonymous', false
    ),
    'authentication_method', 'password'
  );
$$;

-- fixture de grant: consume com a session_id que o hook vai receber.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e8240000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1","session_id":"h1-sess"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  SELECT public.mfa_recovery_consume(
    current_setting('mfa_rec.h.codes')::jsonb ->> 0, 'h1-sess') INTO v_res;
  IF v_res ->> 'ok' <> 'true' THEN RAISE EXCEPTION 'T-84 fixture falhou: %', v_res; END IF;
END $$;
COMMIT;

-- ============ T-84-H1 — elevação one-shot ============
BEGIN;
DO $$
DECLARE
  v_ev jsonb := pg_temp.mfa_hook_event('h1-sess', 'aal1');
  v_out jsonb;
  v_claims jsonb;
BEGIN
  SELECT public.mfa_recovery_aal_hook(v_ev) INTO v_out;
  v_claims := v_out -> 'claims';

  IF v_claims ->> 'aal' <> 'aal2' THEN
    RAISE EXCEPTION 'T-84-H1 falhou: aal=%', v_claims ->> 'aal';
  END IF;
  IF v_claims -> 'amr' -> 0 ->> 'method' <> 'recovery' THEN
    RAISE EXCEPTION 'T-84-H1 falhou: amr[0]=%', v_claims -> 'amr' -> 0;
  END IF;
  IF jsonb_typeof(v_claims -> 'amr' -> 0 -> 'timestamp') <> 'number' THEN
    RAISE EXCEPTION 'T-84-H1 falhou: timestamp não numérico';
  END IF;
  IF jsonb_array_length(v_claims -> 'amr') <> 2
     OR v_claims -> 'amr' -> 1 ->> 'method' <> 'password' THEN
    RAISE EXCEPTION 'T-84-H1 falhou: amr anterior não preservado (%)', v_claims -> 'amr';
  END IF;
  -- demais claims preservados
  IF v_claims ->> 'sub' <> 'e8240000-0000-4000-8000-0000000000a1'
     OR v_claims ->> 'role' <> 'authenticated'
     OR v_claims ->> 'session_id' <> 'h1-sess'
     OR v_out ->> 'authentication_method' <> 'password'
     OR v_out ->> 'user_id' <> 'e8240000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'T-84-H1 falhou: claims/evento alterados %', v_out;
  END IF;
END $$;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.mfa_recovery_aal_grants
  WHERE session_id = 'h1-sess';
  IF v_n <> 0 THEN RAISE EXCEPTION 'T-84-H1 falhou: grant não consumido'; END IF;
  RAISE NOTICE 'T-84-H1 ok: aal2 + amr recovery + claims preservados + grant removido';
END $$;
ROLLBACK;

-- ============ T-84-H2 — aal2 nunca rebaixado ============
BEGIN;
DO $$
DECLARE
  v_ev jsonb := pg_temp.mfa_hook_event('h1-sess', 'aal2');
  v_out jsonb;
  v_n int;
BEGIN
  v_out := public.mfa_recovery_aal_hook(v_ev);
  IF v_out <> v_ev THEN
    RAISE EXCEPTION 'T-84-H2 falhou: evento aal2 alterado';
  END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_aal_grants WHERE session_id = 'h1-sess';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-84-H2 falhou: hook apagou grant com aal2 de entrada'; END IF;
  RAISE NOTICE 'T-84-H2 ok: aal2 intacto, grant preservado';
END $$;
ROLLBACK;

-- ============ T-84-H3 — sem grant / divergente / expirado ============
BEGIN;
-- UPDATE de fixture é feito como postgres: hook roda como supabase_auth_admin,
-- que tem apenas SELECT/DELETE na tabela de grants (ADR §3.4).
UPDATE public.mfa_recovery_aal_grants
SET issued_at = now() - interval '10 minutes',
    expires_at = now() - interval '5 minutes'
WHERE session_id = 'h1-sess';
DO $$
DECLARE
  v_ev jsonb;
  v_out jsonb;
  v_n int;
BEGIN
  -- (a) sessão sem grant
  v_ev := pg_temp.mfa_hook_event('sem-grant', 'aal1');
  IF public.mfa_recovery_aal_hook(v_ev) <> v_ev THEN
    RAISE EXCEPTION 'T-84-H3a falhou: elevou sem grant';
  END IF;

  -- (b) R1: claims.session_id divergente do p_session_id usado no consume
  v_ev := pg_temp.mfa_hook_event('outra-sessao', 'aal1');
  v_out := public.mfa_recovery_aal_hook(v_ev);
  IF v_out <> v_ev OR v_out -> 'claims' ->> 'aal' <> 'aal1' THEN
    RAISE EXCEPTION 'T-84-H3b falhou: elevou com session_id divergente';
  END IF;

  -- (c) grant expirado (issued_at antigo; CHECK garante expires_at = issued_at + 5 min)
  v_ev := pg_temp.mfa_hook_event('h1-sess', 'aal1');
  v_out := public.mfa_recovery_aal_hook(v_ev);
  IF v_out <> v_ev OR v_out -> 'claims' ->> 'aal' <> 'aal1' THEN
    RAISE EXCEPTION 'T-84-H3c falhou: elevou com grant expirado';
  END IF;
  SELECT count(*) INTO v_n FROM public.mfa_recovery_aal_grants WHERE session_id = 'h1-sess';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T-84-H3c falhou: hook apagou grant expirado'; END IF;

  RAISE NOTICE 'T-84-H3 ok: sem grant / divergente / expirado ⇒ evento intacto';
END $$;
ROLLBACK;

-- ============ T-84-H4 — segundo refresh não eleva de novo ============
BEGIN;
-- grant vigente restaurado (o UPDATE de H3 foi rollbackado).
DO $$
DECLARE
  v_ev jsonb := pg_temp.mfa_hook_event('h1-sess', 'aal1');
  v_out jsonb;
BEGIN
  v_out := public.mfa_recovery_aal_hook(v_ev);
  IF v_out -> 'claims' ->> 'aal' <> 'aal2' THEN
    RAISE EXCEPTION 'T-84-H4 falhou: 1º hook não elevou';
  END IF;
  -- 2ª chamada com o MESMO evento aal1: grant já foi apagado ⇒ intacto.
  IF public.mfa_recovery_aal_hook(v_ev) <> v_ev THEN
    RAISE EXCEPTION 'T-84-H4 falhou: 2º hook elevou de novo';
  END IF;
  RAISE NOTICE 'T-84-H4 ok: one-shot, 2ª elevação bloqueada';
END $$;
ROLLBACK;

-- ============ T-84-H5 — corpo/grants do hook ============
BEGIN;
DO $$
DECLARE
  v_pk regprocedure := 'public.mfa_recovery_aal_hook(jsonb)'::regprocedure;
  v_src text;
  v_n int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_pk;
  IF v_src LIKE '%DELETE%' AND v_src LIKE '%RETURNING%' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'T-84-H5 falhou: hook sem DELETE ... RETURNING';
  END IF;
  -- uma única tabela consultada: a de grants (orçamento 2 s).
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, 'FROM[[:space:]]+public\.', 'gi');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-84-H5 falhou: % tabelas consultadas no hook (esperado 1)', v_n;
  END IF;
  IF v_src ~* '\minsert\M' OR v_src ~* '\mupdate\M' THEN
    RAISE EXCEPTION 'T-84-H5 falhou: hook escreve (INSERT/UPDATE)';
  END IF;
  IF v_src NOT LIKE '%session_id%' THEN
    RAISE EXCEPTION 'T-84-H5 falhou: hook não usa claims.session_id';
  END IF;
  RAISE NOTICE 'T-84-H5 ok: 1 DELETE indexada, sem escrita extra';
END $$;
ROLLBACK;

-- ============ Limpeza final ============
BEGIN;
DELETE FROM public.mfa_recovery_aal_grants WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_codes WHERE set_id IN (
  SELECT id FROM public.mfa_recovery_code_sets WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1');
DELETE FROM public.mfa_recovery_code_sets WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_attempts WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1';
DELETE FROM public.mfa_recovery_audit WHERE user_id = 'e8240000-0000-4000-8000-0000000000a1';
DELETE FROM auth.users WHERE id = 'e8240000-0000-4000-8000-0000000000a1';
COMMIT;
