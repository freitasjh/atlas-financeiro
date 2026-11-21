-- 0082-mfa-recovery-schema.spec.sql — ADR-001 / F1 (TST-01) / DB-01.
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0082-mfa-recovery-schema.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova executável da interface congelada do ADR §3.1/§3.3/§3.4:
--   5 tabelas com colunas/tipos exatos, PK/FK/UNIQUE/CHECK,
--   RLS deny-all (nenhuma policy para anon/authenticated/service_role),
--   única exceção = policy mfa_recovery_hook_service (supabase_auth_admin),
--   GRANTs mínimos, 4 RPCs DEFINER + hook NÃO DEFINER, e R4 (gen_random_bytes).
-- Rerunnable: soma leituras do catálogo; nenhuma fixture gravada.

\set ON_ERROR_STOP on

-- ============ T-82-01 — tabelas, colunas e tipos ============
DO $$
DECLARE
  v_tab text;
  v_n int;
  v_col text;
  v_type text;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY[
    'mfa_recovery_code_sets', 'mfa_recovery_codes',
    'mfa_recovery_aal_grants', 'mfa_recovery_attempts', 'mfa_recovery_audit'
  ] LOOP
    IF to_regclass('public.' || v_tab) IS NULL THEN
      RAISE EXCEPTION 'T-82-01 falhou: tabela public.% ausente', v_tab;
    END IF;
  END LOOP;

  -- (coluna, tipo) exatos por tabela — nenhuma coluna extra permitida.
  FOR v_tab, v_col, v_type IN
    SELECT * FROM (VALUES
      ('mfa_recovery_code_sets', 'id', 'uuid'),
      ('mfa_recovery_code_sets', 'user_id', 'uuid'),
      ('mfa_recovery_code_sets', 'created_at', 'timestamp with time zone'),
      ('mfa_recovery_code_sets', 'revoked_at', 'timestamp with time zone'),
      ('mfa_recovery_codes', 'id', 'uuid'),
      ('mfa_recovery_codes', 'set_id', 'uuid'),
      ('mfa_recovery_codes', 'code_hash', 'text'),
      ('mfa_recovery_codes', 'used_at', 'timestamp with time zone'),
      ('mfa_recovery_codes', 'created_at', 'timestamp with time zone'),
      ('mfa_recovery_aal_grants', 'session_id', 'text'),
      ('mfa_recovery_aal_grants', 'user_id', 'uuid'),
      ('mfa_recovery_aal_grants', 'code_id', 'uuid'),
      ('mfa_recovery_aal_grants', 'issued_at', 'timestamp with time zone'),
      ('mfa_recovery_aal_grants', 'expires_at', 'timestamp with time zone'),
      ('mfa_recovery_aal_grants', 'consumed_at', 'timestamp with time zone'),
      ('mfa_recovery_attempts', 'user_id', 'uuid'),
      ('mfa_recovery_attempts', 'failed_count', 'integer'),
      ('mfa_recovery_attempts', 'locked_until', 'timestamp with time zone'),
      ('mfa_recovery_audit', 'id', 'bigint'),
      ('mfa_recovery_audit', 'user_id', 'uuid'),
      ('mfa_recovery_audit', 'action', 'text'),
      ('mfa_recovery_audit', 'set_id', 'uuid'),
      ('mfa_recovery_audit', 'session_id', 'text'),
      ('mfa_recovery_audit', 'occurred_at', 'timestamp with time zone')
    ) AS t(tab, col, typ)
  LOOP
    SELECT count(*) INTO v_n
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = v_tab
      AND column_name = v_col AND data_type = v_type;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'T-82-01 falhou: %.% com tipo não congelado (esperado %)',
        v_tab, v_col, v_type;
    END IF;
  END LOOP;

  -- contagem exata de colunas por tabela (detecta coluna extra, ex.: code em claro).
  FOR v_tab, v_n IN
    SELECT tab, n FROM (VALUES
      ('mfa_recovery_code_sets', 4), ('mfa_recovery_codes', 5),
      ('mfa_recovery_aal_grants', 6), ('mfa_recovery_attempts', 3),
      ('mfa_recovery_audit', 6)
    ) AS t(tab, n)
  LOOP
    IF (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = v_tab) <> v_n THEN
      RAISE EXCEPTION 'T-82-01 falhou: % não tem % colunas', v_tab, v_n;
    END IF;
  END LOOP;

  -- nenhuma coluna de código em claro em nenhuma das 5 tabelas.
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name LIKE 'mfa_recovery_%'
    AND lower(column_name) IN ('code', 'plaintext', 'raw_code', 'code_plain');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-82-01 falhou: % coluna(s) de código em claro', v_n;
  END IF;

  RAISE NOTICE 'T-82-01 ok: 5 tabelas, 24 colunas com tipos congelados, 0 coluna de código em claro';
END $$;

-- ============ T-82-02 — PK/FK/UNIQUE/CHECK/identity ============
DO $$
DECLARE
  v_n int;
  v_def text;
BEGIN
  -- 5 PKs
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE contype = 'p' AND conrelid IN (
    'public.mfa_recovery_code_sets'::regclass, 'public.mfa_recovery_codes'::regclass,
    'public.mfa_recovery_aal_grants'::regclass, 'public.mfa_recovery_attempts'::regclass,
    'public.mfa_recovery_audit'::regclass
  );
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'T-82-02 falhou: % PKs (esperado 5)', v_n;
  END IF;

  -- audit.id é GENERATED ALWAYS AS IDENTITY (bigint).
  SELECT is_identity INTO v_def
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'mfa_recovery_audit'
    AND column_name = 'id';
  IF v_def <> 'YES' THEN
    RAISE EXCEPTION 'T-82-02 falhou: audit.id não é identity (%)', v_def;
  END IF;

  -- FKs congeladas: 3 cascatas + attempts → auth.users (grant sem FK de propósito).
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE contype = 'f' AND conrelid = 'public.mfa_recovery_code_sets'::regclass
    AND confrelid = 'auth.users'::regclass
    AND pg_get_constraintdef(oid) LIKE '%ON DELETE CASCADE%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-82-02 falhou: code_sets → auth.users CASCADE ausente';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE contype = 'f' AND conrelid = 'public.mfa_recovery_codes'::regclass
    AND confrelid = 'public.mfa_recovery_code_sets'::regclass
    AND pg_get_constraintdef(oid) LIKE '%ON DELETE CASCADE%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-82-02 falhou: codes → code_sets CASCADE ausente';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE contype = 'f' AND conrelid = 'public.mfa_recovery_aal_grants'::regclass
    AND confrelid = 'public.mfa_recovery_codes'::regclass
    AND pg_get_constraintdef(oid) LIKE '%ON DELETE CASCADE%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-82-02 falhou: grants → codes CASCADE ausente';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE contype = 'f' AND conrelid = 'public.mfa_recovery_attempts'::regclass
    AND confrelid = 'auth.users'::regclass
    AND pg_get_constraintdef(oid) LIKE '%ON DELETE CASCADE%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-82-02 falhou: attempts → auth.users CASCADE ausente';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE contype = 'f' AND conrelid IN (
    'public.mfa_recovery_aal_grants'::regclass, 'public.mfa_recovery_audit'::regclass
  ) AND confrelid = 'auth.users'::regclass;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-82-02 falhou: FK indevida para auth.users em grants/audit (grant expira antes do usuário)';
  END IF;

  -- 1 set ativo por usuário (índice parcial).
  SELECT indexdef INTO v_def
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'mfa_recovery_code_sets'
    AND indexname = 'mfa_recovery_code_sets_active_user_uq';
  IF v_def IS NULL OR v_def NOT LIKE '%UNIQUE%'
     OR v_def NOT LIKE '%user_id%' OR v_def NOT LIKE '%revoked_at IS NULL%' THEN
    RAISE EXCEPTION 'T-82-02 falhou: índice parcial de set ativo incorreto (%)', v_def;
  END IF;

  -- UNIQUE (set_id, code_hash).
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE conrelid = 'public.mfa_recovery_codes'::regclass AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE '%set_id%' AND pg_get_constraintdef(oid) LIKE '%code_hash%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-82-02 falhou: UNIQUE(set_id, code_hash) ausente';
  END IF;

  -- CHECK das 6 ações congeladas na auditoria.
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.mfa_recovery_audit'::regclass
    AND contype = 'c' AND conname = 'mfa_recovery_audit_action_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'T-82-02 falhou: CHECK de action ausente';
  END IF;
  FOREACH v_def IN ARRAY ARRAY[
    'generate', 'consume', 'invalid', 'reuse-denied', 'locked', 'regenerate'
  ] LOOP
    IF pg_get_constraintdef((
      SELECT oid FROM pg_constraint
      WHERE conrelid = 'public.mfa_recovery_audit'::regclass
        AND conname = 'mfa_recovery_audit_action_check'
    )) NOT LIKE '%' || v_def || '%' THEN
      RAISE EXCEPTION 'T-82-02 falhou: action % ausente no CHECK', v_def;
    END IF;
  END LOOP;

  -- TTL de 5 min do grant e teto de tentativas (invariantes congelados).
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = 'public.mfa_recovery_aal_grants'::regclass AND contype = 'c'
    AND (pg_get_constraintdef(oid) LIKE '%5 minutes%'
         OR pg_get_constraintdef(oid) LIKE '%00:05:00%');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-82-02 falhou: CHECK de TTL 5 min ausente no grant';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = 'public.mfa_recovery_attempts'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%5%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-82-02 falhou: CHECK de failed_count 0..5 ausente';
  END IF;

  RAISE NOTICE 'T-82-02 ok: PK/FK/UNIQUE/CHECK/identity conforme ADR §3.1';
END $$;

-- ============ T-82-03 — RLS deny-all e única policy do hook ============
DO $$
DECLARE
  v_tab text;
  v_n int;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY[
    'mfa_recovery_code_sets', 'mfa_recovery_codes',
    'mfa_recovery_aal_grants', 'mfa_recovery_attempts', 'mfa_recovery_audit'
  ] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class
            WHERE oid = ('public.' || v_tab)::regclass) THEN
      RAISE EXCEPTION 'T-82-03 falhou: RLS desligada em %', v_tab;
    END IF;

    -- anon/authenticated/service_role/PUBLIC: nenhum privilégio de tabela.
    IF has_table_privilege('anon', 'public.' || v_tab, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || v_tab, 'SELECT')
       OR has_table_privilege('service_role', 'public.' || v_tab, 'SELECT') THEN
      RAISE EXCEPTION 'T-82-03 falhou: SELECT concedido em %', v_tab;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_tab, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || v_tab, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || v_tab, 'DELETE') THEN
      RAISE EXCEPTION 'T-82-03 falhou: DML concedido em %', v_tab;
    END IF;
    SELECT count(*) INTO v_n
    FROM pg_class AS c, pg_catalog.aclexplode(c.relacl) AS a
    WHERE c.oid = ('public.' || v_tab)::regclass AND a.grantee = 0;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'T-82-03 falhou: PUBLIC com privilégio em %', v_tab;
    END IF;
  END LOOP;

  -- 4 tabelas sem policy; grants com exatamente 1 policy para supabase_auth_admin.
  FOREACH v_tab IN ARRAY ARRAY[
    'mfa_recovery_code_sets', 'mfa_recovery_codes',
    'mfa_recovery_attempts', 'mfa_recovery_audit'
  ] LOOP
    SELECT count(*) INTO v_n FROM pg_policy
    WHERE polrelid = ('public.' || v_tab)::regclass;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'T-82-03 falhou: % policy não congelada em %', v_n, v_tab;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM pg_policy
  WHERE polrelid = 'public.mfa_recovery_aal_grants'::regclass
    AND polname = 'mfa_recovery_hook_service'
    AND polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'supabase_auth_admin')]::oid[]
    AND pg_get_expr(polqual, polrelid) = 'true';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-82-03 falhou: policy mfa_recovery_hook_service ausente/divergente';
  END IF;

  -- hook: SELECT/DELETE na tabela de grants; nenhuma outra tabela concedida.
  IF NOT has_table_privilege('supabase_auth_admin', 'public.mfa_recovery_aal_grants', 'SELECT')
     OR NOT has_table_privilege('supabase_auth_admin', 'public.mfa_recovery_aal_grants', 'DELETE') THEN
    RAISE EXCEPTION 'T-82-03 falhou: supabase_auth_admin sem SELECT/DELETE no grant';
  END IF;
  IF has_table_privilege('supabase_auth_admin', 'public.mfa_recovery_codes', 'SELECT')
     OR has_table_privilege('supabase_auth_admin', 'public.mfa_recovery_code_sets', 'SELECT') THEN
    RAISE EXCEPTION 'T-82-03 falhou: supabase_auth_admin alcança tabela de segredo';
  END IF;
  IF NOT has_schema_privilege('supabase_auth_admin', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'T-82-03 falhou: supabase_auth_admin sem USAGE em public';
  END IF;

  RAISE NOTICE 'T-82-03 ok: RLS deny-all nas 5 + 1 policy hook; GRANTs mínimos';
END $$;

-- ============ T-82-04 — assinaturas, DEFINER, grants de EXECUTE, R4 ============
DO $$
DECLARE
  v_pk regprocedure;
  v_def text;
  v_n int;
  v_fn text;
BEGIN
  -- 4 RPCs + helper privado + hook: assinaturas congeladas.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.mfa_recovery_generate(uuid)',
    'public.mfa_recovery_consume(text,text)',
    'public.mfa_recovery_status(uuid)',
    'public.mfa_recovery_regenerate(uuid,text)',
    'public.mfa_recovery_aal_hook(jsonb)',
    'private.mfa_recovery_hash_equal(text,text)'
  ] LOOP
    BEGIN
      v_pk := v_fn::regprocedure;
    EXCEPTION WHEN undefined_function THEN
      RAISE EXCEPTION 'T-82-04 falhou: função % ausente', v_fn;
    END;
  END LOOP;

  -- 4 RPCs SECURITY DEFINER com search_path vazio.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.mfa_recovery_generate(uuid)',
    'public.mfa_recovery_consume(text,text)',
    'public.mfa_recovery_status(uuid)',
    'public.mfa_recovery_regenerate(uuid,text)'
  ] LOOP
    v_pk := v_fn::regprocedure;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_pk) THEN
      RAISE EXCEPTION 'T-82-04 falhou: % não é SECURITY DEFINER', v_fn;
    END IF;
    SELECT array_to_string(proconfig, ',') INTO v_def FROM pg_proc WHERE oid = v_pk;
    IF v_def IS NULL OR v_def NOT LIKE '%search_path=%' THEN
      RAISE EXCEPTION 'T-82-04 falhou: % sem search_path no proconfig', v_fn;
    END IF;
  END LOOP;

  -- hook NÃO é DEFINER (docs oficiais F20/F24: grants explícitos).
  v_pk := 'public.mfa_recovery_aal_hook(jsonb)'::regprocedure;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_pk) THEN
    RAISE EXCEPTION 'T-82-04 falhou: hook é SECURITY DEFINER (deve ser invoker)';
  END IF;
  SELECT prosrc INTO v_def FROM pg_proc WHERE oid = v_pk;
  IF v_def NOT LIKE '%mfa_recovery_aal_grants%' OR v_def NOT LIKE '%session_id%' THEN
    RAISE EXCEPTION 'T-82-04 falhou: hook sem DELETE indexado por session_id';
  END IF;

  -- EXECUTE congelado: service_role nas 3 de gestão; authenticated só consume;
  -- supabase_auth_admin só no hook; helper privado fora do alcance de cliente.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.mfa_recovery_generate(uuid)',
    'public.mfa_recovery_status(uuid)',
    'public.mfa_recovery_regenerate(uuid,text)'
  ] LOOP
    v_pk := v_fn::regprocedure;
    IF NOT has_function_privilege('service_role', v_pk, 'EXECUTE') THEN
      RAISE EXCEPTION 'T-82-04 falhou: service_role sem EXECUTE em %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_pk, 'EXECUTE')
       OR has_function_privilege('anon', v_pk, 'EXECUTE') THEN
      RAISE EXCEPTION 'T-82-04 falhou: cliente com EXECUTE em %', v_fn;
    END IF;
  END LOOP;

  v_pk := 'public.mfa_recovery_consume(text,text)'::regprocedure;
  IF NOT has_function_privilege('authenticated', v_pk, 'EXECUTE') THEN
    RAISE EXCEPTION 'T-82-04 falhou: authenticated sem EXECUTE em consume';
  END IF;
  IF has_function_privilege('anon', v_pk, 'EXECUTE')
     OR has_function_privilege('service_role', v_pk, 'EXECUTE') THEN
    RAISE EXCEPTION 'T-82-04 falhou: consume com EXECUTE indevido';
  END IF;

  v_pk := 'public.mfa_recovery_aal_hook(jsonb)'::regprocedure;
  IF NOT has_function_privilege('supabase_auth_admin', v_pk, 'EXECUTE') THEN
    RAISE EXCEPTION 'T-82-04 falhou: hook sem EXECUTE para supabase_auth_admin';
  END IF;
  IF has_function_privilege('authenticated', v_pk, 'EXECUTE')
     OR has_function_privilege('anon', v_pk, 'EXECUTE')
     OR has_function_privilege('service_role', v_pk, 'EXECUTE') THEN
    RAISE EXCEPTION 'T-82-04 falhou: hook alcançável por papel de cliente';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.mfa_recovery_generate(uuid)', 'public.mfa_recovery_consume(text,text)',
    'public.mfa_recovery_status(uuid)', 'public.mfa_recovery_regenerate(uuid,text)',
    'public.mfa_recovery_aal_hook(jsonb)', 'private.mfa_recovery_hash_equal(text,text)'
  ] LOOP
    v_pk := v_fn::regprocedure;
    SELECT count(*) INTO v_n
    FROM pg_proc AS p, pg_catalog.aclexplode(p.proacl) AS a
    WHERE p.oid = v_pk AND a.grantee = 0;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'T-82-04 falhou: PUBLIC com EXECUTE em %', v_fn;
    END IF;
  END LOOP;

  -- R4: CSPRNG disponível sem extensão nova (pgcrypto em extensions).
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'T-82-04 falhou: extensions.gen_random_bytes(integer) ausente (R4)';
  END IF;
  IF length(encode(extensions.gen_random_bytes(15), 'hex')) <> 30 THEN
    RAISE EXCEPTION 'T-82-04 falhou: gen_random_bytes(15) não devolve 15 bytes';
  END IF;

  RAISE NOTICE 'T-82-04 ok: assinaturas/DEFINER/grants/R4';
END $$;
