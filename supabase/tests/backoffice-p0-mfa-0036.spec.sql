-- backoffice-p0-mfa-0036.spec.sql — P0M-BE-02 (migration 0036_tenants_trgm.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backoffice-p0-mfa-0036.spec.sql
-- Rerunnable: fixtures (users e600*) e tenants "Acme/Beta/Gamma" apagados no início e no fim.
-- O usuário seed admin@atlas.test (00000000-0000-4000-8000-0000000000a1) NUNCA é apagado aqui.
-- Escrito ANTES da migration (TDD): falha sem 0036 (sem pg_trgm em extensions, sem GIN,
-- admin_list_tenants/admin_count_tenants sem match de auth.users.email) e passa com 0036.
--
-- Prova em banco real (`SET ROLE authenticated` + claims com aal2 p/ pós-0037 + ROLLBACK
-- por cenário mutante — ROLLBACK restaura, nada persiste salvo fixtures):
--   T00 estrutura: pg_trgm existe em schema `extensions` (zero objeto em `public`);
--       índices GIN gin_trgm_ops em tenants.razao_social e tenants.nome_fantasia;
--       admin_list_tenants + admin_count_tenants citam auth.users (match do owner).
--   T-EXPLAIN: com enable_seqscan=off, o predicado ILIKE '%Acme%' na razao_social usa
--       o índice tenants_razao_social_trgm (Bitmap Index Scan) — terme >=3 casa por GIN.
--   T-SEARCH por super_admin (aal2): razao_social ('Acme'->T1), nome_fantasia ('Filial'->T2),
--       cpf ('111444'->T1), cnpj ('112223'->T2), email do owner ('dono-beta'->T2).
--   T-SHORT: termo <3 chars ('Ac') casa via ILIKE (T1).
--   T-BOGUS: termo inexistente ('zzzz-nada') -> lista vazia, count 0 (nunca silencia p/ free).
--   T-COUNT: count == len(lista) em '', NULL, 'Acme', 'dono-beta', 'a' e com filtro status.
--   T-FIX-0053: cliente (authenticated) não provisiona tenant nem grava aceite -> 42501.
-- Erros por rótulo fixo, sem PII (id/e-mail/hash/valor de busca não aparecem nas mensagens).

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
-- contract_acceptances é append-only (trigger): só o postgres desabilita o
-- trigger para a limpeza de fixtures (padrão tenants-adr001.spec.sql).
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM public.contract_acceptances
WHERE tenant_id IN (SELECT id FROM public.tenants WHERE
  razao_social IN ('Acme Comercio SA', 'Beta Servicos LTDA', 'Gamma Distribuidora')
  OR cpf IN ('11144477735', '52998224725')
  OR cnpj IN ('11222333000181'));

DELETE FROM public.tenant_members
WHERE tenant_id IN (SELECT id FROM public.tenants WHERE
  razao_social IN ('Acme Comercio SA', 'Beta Servicos LTDA', 'Gamma Distribuidora')
  OR cpf IN ('11144477735', '52998224725')
  OR cnpj IN ('11222333000181'));

DELETE FROM public.tenants
WHERE razao_social IN ('Acme Comercio SA', 'Beta Servicos LTDA', 'Gamma Distribuidora')
  OR cpf IN ('11144477735', '52998224725')
  OR cnpj IN ('11222333000181');

DELETE FROM public.admin_audit
WHERE target_id IN (
  'e6000000-0000-4000-8000-000000000001',
  'e6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000003'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e6000000-0000-4000-8000-000000000001',
  'e6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000003'
);

DELETE FROM auth.users
WHERE id IN (
  'e6000000-0000-4000-8000-000000000001',
  'e6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000003'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

INSERT INTO auth.users (id, email) VALUES
  ('e6000000-0000-4000-8000-000000000001', 'p0m-reader-0036@example.com'),
  ('e6000000-0000-4000-8000-000000000002', 'dono-beta@example.com'),
  ('e6000000-0000-4000-8000-000000000003', 'p0m-plain-0036@example.com');

UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'e6000000-0000-4000-8000-000000000001';
-- 002/003 permanecem 'user' (handle_new_user).

-- SEC-03 (0051): o super_admin de fixture precisa de operador ATIVO para o
-- caminho feliz das RPCs admin_* (o gate global em is_super_admin() herdou
-- operator-inactive). Bootstrap de fixture, como o seed de dev.
INSERT INTO public.internal_operators (user_id, active)
SELECT p.id, true FROM public.profiles AS p
WHERE p.role = 'super_admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.internal_operators AS io WHERE io.user_id = p.id
  );

DELETE FROM public.admin_audit
WHERE target_id IN (
  'e6000000-0000-4000-8000-000000000001',
  'e6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000003'
);

-- ============ T00 — estrutura pós-0036 ============
DO $$
DECLARE
  v_schema text;
  v_public_obj int;
  v_idx_razao text;
  v_idx_fantasia text;
  v_list_def text;
  v_count_def text;
  v_ext_count int;
BEGIN
  -- Extensão pg_trgm em `extensions`, nunca em `public` (ADR-004).
  SELECT count(*) INTO v_ext_count
  FROM pg_catalog.pg_extension AS e
  JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm' AND n.nspname = 'extensions';
  IF v_ext_count <> 1 THEN
    RAISE EXCEPTION 'T00 falhou: pg_trgm não está em schema extensions';
  END IF;
  SELECT count(*) INTO v_public_obj
  FROM pg_catalog.pg_extension AS e
  JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm' AND n.nspname = 'public';
  IF v_public_obj <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: pg_trgm instalado em schema public (hijack)';
  END IF;

  -- Índices GIN trigram nos dois textos livres do tenant.
  SELECT pg_get_indexdef(indexrelid) INTO v_idx_razao
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'tenants_razao_social_trgm';
  IF v_idx_razao IS NULL OR v_idx_razao NOT LIKE '%USING gin%'
     OR v_idx_razao NOT LIKE '%gin_trgm_ops%' THEN
    RAISE EXCEPTION 'T00 falhou: índice GIN razao_social ausente ou sem gin_trgm_ops (%)', v_idx_razao;
  END IF;

  SELECT pg_get_indexdef(indexrelid) INTO v_idx_fantasia
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'tenants_nome_fantasia_trgm';
  IF v_idx_fantasia IS NULL OR v_idx_fantasia NOT LIKE '%USING gin%'
     OR v_idx_fantasia NOT LIKE '%gin_trgm_ops%' THEN
    RAISE EXCEPTION 'T00 falhou: índice GIN nome_fantasia ausente ou sem gin_trgm_ops (%)', v_idx_fantasia;
  END IF;

  -- As duas RPCs citam auth.users: match do email do owner (mesmo p_search).
  v_list_def := pg_catalog.pg_get_functiondef('public.admin_list_tenants(text, text, text, text, int, int)'::regprocedure);
  v_count_def := pg_catalog.pg_get_functiondef('public.admin_count_tenants(text, text)'::regprocedure);
  IF v_list_def NOT LIKE '%auth.users%' THEN
    RAISE EXCEPTION 'T00 falhou: admin_list_tenants sem match em auth.users (email do owner)';
  END IF;
  IF v_count_def NOT LIKE '%auth.users%' THEN
    RAISE EXCEPTION 'T00 falhou: admin_count_tenants sem match em auth.users (email do owner)';
  END IF;

  RAISE NOTICE 'T00 ok: pg_trgm em extensions + GIN razao/fantasia + list/count com email do owner';
END $$;

-- ============ Fixtures: 3 tenants via RPC atômica (porta; dono = auth.uid) ============
-- Criados como cada dono (RLS de escrita só via RPC). Inserção fora de transação
-- explícita (cleanup no início/fim cobre o rerun).
-- Constraint trigger diferida `tenant_acceptance_required` (0024): o aceite
-- precisa nascer na MESMA transação do tenant (padrão tenants-adr001.spec.sql).
-- SEC-04/D1 (0053): fixtures sob `service_role` (backoffice/Edge) com claims do
-- dono; o cliente recebe 42501 (T-FIX-0053).

-- T-FIX-0053 — cliente não provisiona tenant nem grava aceite.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e6000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e6000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T-FIX-0053 falhou: authenticated provisionou tenant';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-FIX-0053 falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T-FIX-0053 falhou: erro diferente de 42501 no tenant (%)', SQLERRM;
  END;

  BEGIN
    PERFORM public.accept_contract(
      '00000000-0000-4000-8000-000000000000', 'test-v1'
    );
    RAISE EXCEPTION 'T-FIX-0053 falhou: authenticated gravou aceite';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-FIX-0053 falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T-FIX-0053 falhou: erro diferente de 42501 no aceite (%)', SQLERRM;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'e6000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e6000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', false);
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner('pf', '11144477735', 'Acme Comercio SA', 'Acme Loja',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'e6000000-0000-4000-8000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e6000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2"}', false);
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner('pj', '11222333000181', 'Beta Servicos LTDA', 'Beta Filial',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', 'e6000000-0000-4000-8000-000000000003', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e6000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal2"}', false);
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner('pf', '52998224725', 'Gamma Distribuidora', NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'free');
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;
COMMIT;

-- ============ T-EXPLAIN — GIN serve o termo >=3 ============
-- enable_seqscan=off força o planner a provar que o predicado ILIKE '%Acme%'
-- (padrão da busca, com '%' nas pontas) é servível pelo GIN trigram.
BEGIN;
SET LOCAL enable_seqscan = off;
DO $$
DECLARE
  v_plan text;
BEGIN
  EXECUTE 'EXPLAIN (FORMAT JSON) SELECT id FROM public.tenants '
        || 'WHERE razao_social ILIKE ''%Acme%'' AND nome_fantasia ILIKE ''%Acme%'''
       INTO STRICT v_plan;
  IF v_plan NOT LIKE '%tenants_razao_social_trgm%'
     AND v_plan NOT LIKE '%tenants_nome_fantasia_trgm%' THEN
    RAISE EXCEPTION 'T-EXPLAIN falhou: plano sem índice GIN trigram (%)', v_plan;
  END IF;
  RAISE NOTICE 'T-EXPLAIN ok: termo >=3 usa índice GIN trigram';
END $$;
ROLLBACK;

-- ============ T-SEARCH/T-SHORT/T-BOGUS/T-COUNT (leitor = super_admin aal2) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e6000000-0000-4000-8000-000000000001', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"e6000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_list int;
  v_count bigint;
  v_hits int;
BEGIN
  -- razao_social: 'Acme' → só T1.
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('Acme', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('Acme', NULL) INTO v_count;
  IF v_list <> 1 OR v_count <> 1 THEN
    RAISE EXCEPTION 'T-SEARCH falhou: razao Acme list=% count=%', v_list, v_count;
  END IF;

  -- nome_fantasia: 'Filial' → só T2.
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('Filial', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('Filial', NULL) INTO v_count;
  IF v_list <> 1 OR v_count <> 1 THEN
    RAISE EXCEPTION 'T-SEARCH falhou: fantasia Filial list=% count=%', v_list, v_count;
  END IF;

  -- documento: '111444' (cpf T1) e '112223' (cnpj T2).
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('111444', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('111444', NULL) INTO v_count;
  IF v_list <> 1 OR v_count <> 1 THEN
    RAISE EXCEPTION 'T-SEARCH falhou: cpf list=% count=%', v_list, v_count;
  END IF;
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('112223', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('112223', NULL) INTO v_count;
  IF v_list <> 1 OR v_count <> 1 THEN
    RAISE EXCEPTION 'T-SEARCH falhou: cnpj list=% count=%', v_list, v_count;
  END IF;

  -- email do owner (via EXISTS em auth.users): 'dono-beta' → só T2.
  SELECT count(ten.id) INTO v_hits
  FROM public.admin_list_tenants('dono-beta', NULL, 'created_at', 'desc', 100, 0) AS ten;
  SELECT public.admin_count_tenants('dono-beta', NULL) INTO v_count;
  IF v_hits <> 1 OR v_count <> 1 THEN
    RAISE EXCEPTION 'T-SEARCH falhou: email dono-beta list=% count=%', v_hits, v_count;
  END IF;
  SELECT count(ten.id) INTO v_hits
  FROM public.admin_list_tenants('dono-beta', NULL, 'created_at', 'desc', 100, 0) AS ten
  WHERE ten.razao_social = 'Beta Servicos LTDA';
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'T-SEARCH falhou: email dono-beta não retornou o tenant Beta';
  END IF;

  -- curto (<3): 'Ac' via ILIKE → T1.
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('Ac', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('Ac', NULL) INTO v_count;
  IF v_list <> 1 OR v_count <> 1 THEN
    RAISE EXCEPTION 'T-SHORT falhou: termo curto Ac list=% count=%', v_list, v_count;
  END IF;

  -- bogus: lista vazia + count 0 (nunca silencia para `free`/total).
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('zzzz-nada', NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('zzzz-nada', NULL) INTO v_count;
  IF v_list <> 0 OR v_count <> 0 THEN
    RAISE EXCEPTION 'T-BOGUS falhou: termo bogus list=% count=% (esperado 0/0)', v_list, v_count;
  END IF;

  RAISE NOTICE 'T-SEARCH ok: razao/fantasia/cpf/cnpj/email casam; curto <3 via ILIKE; bogus vazio';
END $$;

DO $$
DECLARE
  v_list int;
  v_count bigint;
  v_term text;
  v_terms text[] := ARRAY['', 'Acme', 'dono-beta', 'a', 'Beta'];
BEGIN
  FOREACH v_term IN ARRAY v_terms LOOP
    SELECT count(id) INTO v_list FROM public.admin_list_tenants(v_term, NULL, 'created_at', 'desc', 100, 0);
    SELECT public.admin_count_tenants(v_term, NULL) INTO v_count;
    IF v_list::bigint <> v_count THEN
      RAISE EXCEPTION 'T-COUNT falhou: term=% list=% count=%', v_term, v_list, v_count;
    END IF;
  END LOOP;
  -- NULL == '' (sem busca): os 3 fixtures + seed? Não: só tenants; invariante é count==len.
  SELECT count(id) INTO v_list FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants(NULL, NULL) INTO v_count;
  IF v_list::bigint <> v_count THEN
    RAISE EXCEPTION 'T-COUNT falhou: NULL list=% count=%', v_list, v_count;
  END IF;
  -- Com filtro de status: mesmo predicado nas duas.
  SELECT count(id) INTO v_list FROM public.admin_list_tenants('Acme', 'active', 'created_at', 'desc', 100, 0);
  SELECT public.admin_count_tenants('Acme', 'active') INTO v_count;
  IF v_list::bigint <> v_count THEN
    RAISE EXCEPTION 'T-COUNT falhou: status active list=% count=%', v_list, v_count;
  END IF;
  RAISE NOTICE 'T-COUNT ok: count == len(lista) em termo vazio/NULL/curto/email/status';
END $$;

ROLLBACK;

-- ============ Limpeza final (rerun não duplica; seed preservado) ============
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;
DELETE FROM public.contract_acceptances
WHERE tenant_id IN (SELECT id FROM public.tenants WHERE
  razao_social IN ('Acme Comercio SA', 'Beta Servicos LTDA', 'Gamma Distribuidora')
  OR cpf IN ('11144477735', '52998224725')
  OR cnpj IN ('11222333000181'));

DELETE FROM public.tenant_members
WHERE tenant_id IN (SELECT id FROM public.tenants WHERE
  razao_social IN ('Acme Comercio SA', 'Beta Servicos LTDA', 'Gamma Distribuidora')
  OR cpf IN ('11144477735', '52998224725')
  OR cnpj IN ('11222333000181'));

DELETE FROM public.tenants
WHERE razao_social IN ('Acme Comercio SA', 'Beta Servicos LTDA', 'Gamma Distribuidora')
  OR cpf IN ('11144477735', '52998224725')
  OR cnpj IN ('11222333000181');

DELETE FROM public.admin_audit
WHERE target_id IN (
  'e6000000-0000-4000-8000-000000000001',
  'e6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000003'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'e6000000-0000-4000-8000-000000000001',
  'e6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000003'
);

DELETE FROM auth.users
WHERE id IN (
  'e6000000-0000-4000-8000-000000000001',
  'e6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000003'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

DO $$
DECLARE v_users int; v_seed int;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users WHERE id IN (
    'e6000000-0000-4000-8000-000000000001',
    'e6000000-0000-4000-8000-000000000002',
    'e6000000-0000-4000-8000-000000000003'
  );
  SELECT count(*) INTO v_seed FROM auth.users WHERE email = 'admin@atlas.test';
  IF v_users <> 0 THEN
    RAISE EXCEPTION 'T-FIM falhou: fixtures sobreviveram à limpeza (%)', v_users;
  END IF;
  IF v_seed <> 1 THEN
    RAISE EXCEPTION 'T-FIM falhou: seed admin@atlas.test sumiu na limpeza (%)', v_seed;
  END IF;
  RAISE NOTICE 'T-FIM ok: cleanup efetiva, seed preservado, próximo run limpo';
END $$;
