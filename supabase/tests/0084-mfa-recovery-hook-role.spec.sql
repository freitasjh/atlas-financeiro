-- 0084-mfa-recovery-hook-role.spec.sql — ADR-001 / HOOK-01 (TST-01, rota real).
-- Uso (CONEXÃO DIRETA como a role que o Auth usa para o hook):
--   PGPASSWORD=postgres psql "postgresql://supabase_auth_admin:postgres@127.0.0.1:55322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0084-mfa-recovery-hook-role.spec.sql
--
-- O postgres local não é superuser e não pode SET ROLE supabase_auth_admin
-- (membership reservada). Este spec conecta como a role real e prova:
--   T-84-RA1 USAGE em public + EXECUTE no hook + SELECT/DELETE na tabela de
--            grants (RLS policy mfa_recovery_hook_service efetiva);
--   T-84-RA2 sem grant vigente o hook devolve o evento intacto;
--   T-84-RA3 nenhuma outra tabela de segredo é alcançável.
-- Somente leituras e um DELETE de session_id inexistente (0 linhas): rerunnable.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_ev jsonb;
  v_out jsonb;
  v_n int;
BEGIN
  IF current_user <> 'supabase_auth_admin' THEN
    RAISE EXCEPTION 'T-84-RA1 falhou: current_user=% (esperado supabase_auth_admin)', current_user;
  END IF;
  IF NOT has_schema_privilege(current_user, 'public', 'USAGE') THEN
    RAISE EXCEPTION 'T-84-RA1 falhou: sem USAGE em public';
  END IF;
  IF NOT has_function_privilege(current_user,
       'public.mfa_recovery_aal_hook(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-84-RA1 falhou: sem EXECUTE no hook';
  END IF;
  IF NOT has_table_privilege(current_user, 'public.mfa_recovery_aal_grants', 'SELECT')
     OR NOT has_table_privilege(current_user, 'public.mfa_recovery_aal_grants', 'DELETE') THEN
    RAISE EXCEPTION 'T-84-RA1 falhou: sem SELECT/DELETE na tabela de grants';
  END IF;

  -- RLS efetivo: SELECT e DELETE permitidos pela policy (DELETE de 0 linhas).
  SELECT count(*) INTO v_n FROM public.mfa_recovery_aal_grants;
  DELETE FROM public.mfa_recovery_aal_grants WHERE session_id = 'role-spec-inexistente';

  -- Payload congelado (F20), aal1 sem grant ⇒ evento intacto.
  v_ev := jsonb_build_object(
    'user_id', 'e8240000-0000-4000-8000-0000000000a1',
    'claims', jsonb_build_object(
      'aud', 'authenticated', 'exp', 1893456000, 'iat', 1760000000,
      'sub', 'e8240000-0000-4000-8000-0000000000a1',
      'email', '', 'phone', '', 'app_metadata', '{}'::jsonb,
      'user_metadata', '{}'::jsonb, 'role', 'authenticated',
      'aal', 'aal1', 'amr', '[]'::jsonb,
      'session_id', 'role-spec-inexistente', 'is_anonymous', false
    ),
    'authentication_method', 'password'
  );
  v_out := public.mfa_recovery_aal_hook(v_ev);
  IF v_out <> v_ev OR v_out -> 'claims' ->> 'aal' <> 'aal1' THEN
    RAISE EXCEPTION 'T-84-RA2 falhou: elevou sem grant: %', v_out;
  END IF;

  -- Nenhuma tabela de segredo é alcançável por esta role.
  IF has_table_privilege(current_user, 'public.mfa_recovery_codes', 'SELECT')
     OR has_table_privilege(current_user, 'public.mfa_recovery_code_sets', 'SELECT')
     OR has_table_privilege(current_user, 'public.mfa_recovery_audit', 'SELECT') THEN
    RAISE EXCEPTION 'T-84-RA3 falhou: role do hook alcança tabela de segredo';
  END IF;

  RAISE NOTICE 'T-84-RA ok: role real supabase_auth_admin executa hook e usa policy RLS';
END $$;
