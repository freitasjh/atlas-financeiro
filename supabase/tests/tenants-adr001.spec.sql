-- tenants-adr001.spec.sql — tenants-cobranca / ADR-001 (migration 0022_tenants.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenants-adr001.spec.sql
-- Rerunnable: as fixtures (auth.users + tenants + memberships) são apagadas no início.
--
-- Prova em banco real (não mock — mock não avalia policy nem grant):
--   T00 estrutura: 2 tabelas com RLS, 1 policy SELECT cada, helper privado
--       (SECURITY DEFINER/STABLE/search_path=''), RPC 13 args, índices, grants,
--       policy por EXISTS/InitPlan, default privileges de função em private
--   T00c cliente não executa a RPC base (SEC-04/D1, 0053) ⇒ 42501
--   T01 RPC cria tenant + membership `owner` (dono = auth.uid(), plano default)
--   T02 documento duplicado (CPF e CNPJ) ⇒ tenant-document-duplicate e NADA persistido
--   T02b tenant cancelado libera o documento e permite novo cadastro
--   T02c falha no segundo INSERT (membership) ⇒ nenhum tenant persistido (I-5)
--   T02d payload inválido ⇒ tenant-data-invalid sem PII em message/details/hint
--   T03 DV inválido/sequência repetida ⇒ tenant-document-invalid
--   T04 kind ≠ documento ⇒ tenant-document-invalid (e CHECK no banco)
--   T05 plano fora do catálogo ⇒ tenant-plan-invalid; plano pago por
--       authenticated ⇒ tenant-plan-forbidden; admin cria plano pago
--   T06 INSERT/UPDATE/DELETE direto por authenticated ⇒ 42501 (nas duas tabelas)
--   T07 B não lê tenant de A; membro lê o próprio; admin lê todos; não-membro não lê nada
--   T08 auth.uid() nulo ⇒ not-authenticated
--   T09 limpeza de fixtures é efetiva (rerun não duplica)
--
-- ADR-004 (0024): todo `create_tenant_with_owner` bem-sucedido deste spec é
-- seguido de `accept_contract(v_id, 'test-v1')` no MESMO bloco (a constraint
-- trigger diferida `tenant_acceptance_required` recusa o COMMIT sem aceite).
--
-- SEC-04/D1 (0053): a RPC base só executa como `service_role` (backoffice/
-- Edge). Todo caminho feliz deste spec roda com `SET ROLE service_role` +
-- claims do dono (`sub`); `authenticated`/`anon` recebem 42501 (T00c).
-- O gate de plano pago (T05b) lê `auth.jwt()->>'role'` e roda como owner,
-- com claim `authenticated`, sem trocar de papel.
--
-- Nenhuma mensagem de falha carrega ids, documento ou PII (SEC-G3).

\set ON_ERROR_STOP on

-- ============ Fixtures (como postgres: RLS bypass, DBA permitido) ============
-- Ids/documentos determinísticos. Apagar os usuários cascateia tenants e
-- memberships (owner_user_id ON DELETE CASCADE), o que torna o arquivo
-- rerunnable. A deleção por documento cobre resíduo de execução interrompida.

-- ADR-004 (0024): os tenants deste spec têm aceite imutável; o purge em
-- cascata passa pelo escape declarado (owner desabilita o trigger,
-- apaga, reabilita). Só fixture, nunca no app.
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.tenants
WHERE cpf IN ('11144477735', '52998224725', '12345678909')
   OR cnpj IN ('11222333000181', '45723174000110', '34028316000103');

DELETE FROM public.admin_audit
WHERE target_id IN (
  '7e000000-0000-4000-8000-0000000000a1',
  '7e000000-0000-4000-8000-0000000000b1',
  '7e000000-0000-4000-8000-0000000000c1',
  '7e000000-0000-4000-8000-0000000000d1'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  '7e000000-0000-4000-8000-0000000000a1',
  '7e000000-0000-4000-8000-0000000000b1',
  '7e000000-0000-4000-8000-0000000000c1',
  '7e000000-0000-4000-8000-0000000000d1'
);

DELETE FROM auth.users
WHERE id IN (
  '7e000000-0000-4000-8000-0000000000a1',
  '7e000000-0000-4000-8000-0000000000b1',
  '7e000000-0000-4000-8000-0000000000c1',
  '7e000000-0000-4000-8000-0000000000d1'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

INSERT INTO auth.users (id, email) VALUES
  ('7e000000-0000-4000-8000-0000000000a1', 'tenants-a@example.com'),
  ('7e000000-0000-4000-8000-0000000000b1', 'tenants-b@example.com'),
  ('7e000000-0000-4000-8000-0000000000c1', 'tenants-admin@example.com'),
  ('7e000000-0000-4000-8000-0000000000d1', 'tenants-nomember@example.com');

-- Backoffice: promoção via DBA (current_user = postgres). A trilha gerada é
-- apagada para não interferir nas contagens. (0035: 'super_admin', o 'admin'
-- legado não existe mais; a policy is_admin() = alias super_only.)
UPDATE public.profiles SET role = 'super_admin'
WHERE id = '7e000000-0000-4000-8000-0000000000c1';

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
WHERE target_id = '7e000000-0000-4000-8000-0000000000c1';

-- T09a — ponto de partida limpo (prova de que a limpeza acima funciona em rerun).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE cpf IN ('11144477735', '52998224725', '12345678909')
     OR cnpj IN ('11222333000181', '45723174000110', '34028316000103');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T09 falhou: fixtures de tenant sobreviveram à limpeza inicial';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tenant_members
  WHERE user_id IN (
    '7e000000-0000-4000-8000-0000000000a1',
    '7e000000-0000-4000-8000-0000000000b1',
    '7e000000-0000-4000-8000-0000000000c1',
    '7e000000-0000-4000-8000-0000000000d1'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T09 falhou: memberships residuais após a limpeza inicial';
  END IF;

  RAISE NOTICE 'T09a ok: fixtures limpas (rerun não duplica)';
END $$;

-- ============ T00 — estrutura, RLS, helper, RPC, índices, grants ============

DO $$
DECLARE
  v_rls boolean;
  v_policies int;
  v_write_policies int;
  v_idx int;
  v_constraints int;
  v_proc pg_proc;
  v_priv text;
  v_qual text;
BEGIN
  IF to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: tabela tenants ausente';
  END IF;
  IF to_regclass('public.tenant_members') IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: tabela tenant_members ausente';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.tenants'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RLS desligada em tenants';
  END IF;
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.tenant_members'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RLS desligada em tenant_members';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('tenants', 'tenant_members')
    AND cmd = 'SELECT'
    AND roles = '{authenticated}';
  IF v_policies <> 2 THEN
    RAISE EXCEPTION 'T00 falhou: esperava 1 policy SELECT/authenticated por tabela';
  END IF;

  SELECT count(*) INTO v_write_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('tenants', 'tenant_members')
    AND cmd <> 'SELECT';
  IF v_write_policies <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: policy de escrita encontrada em tabela de tenant';
  END IF;

  -- F4: a policy precisa usar EXISTS (semi-join) sobre o helper e is_admin()
  -- em subquery (InitPlan). `IN (SELECT helper)` + `public.is_admin()` cru é a
  -- forma antiga, avaliada por linha candidata.
  SELECT qual INTO v_qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'tenants'
    AND policyname = 'tenants_select_member';
  IF v_qual IS NULL
    OR position('EXISTS' IN v_qual) = 0
    OR position('is_admin' IN v_qual) = 0
    OR position('user_tenant_ids' IN v_qual) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: policy de tenants fora do formato EXISTS/InitPlan (%)', v_qual;
  END IF;

  SELECT qual INTO v_qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'tenant_members'
    AND policyname = 'tenant_members_select_member';
  IF v_qual IS NULL
    OR position('EXISTS' IN v_qual) = 0
    OR position('is_admin' IN v_qual) = 0
    OR position('user_tenant_ids' IN v_qual) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: policy de tenant_members fora do formato EXISTS/InitPlan (%)', v_qual;
  END IF;

  -- Helper: private, SECURITY DEFINER, STABLE, search_path='', retorna setof uuid.
  SELECT * INTO v_proc
  FROM pg_proc
  WHERE pronamespace = 'private'::regnamespace
    AND proname = 'user_tenant_ids';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: helper private.user_tenant_ids ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: helper sem SECURITY DEFINER';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION 'T00 falhou: helper sem STABLE';
  END IF;
  IF v_proc.proretset IS DISTINCT FROM true OR v_proc.prorettype <> 'uuid'::regtype THEN
    RAISE EXCEPTION 'T00 falhou: helper não retorna setof uuid';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: helper sem search_path vazio';
  END IF;

  -- RPC: 13 parâmetros text, SECURITY DEFINER, search_path=''.
  SELECT * INTO v_proc
  FROM pg_proc
  WHERE oid = to_regprocedure(
    'public.create_tenant_with_owner(text,text,text,text,text,text,text,text,text,text,text,text,text)'
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: RPC create_tenant_with_owner ausente ou com assinatura errada';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem search_path vazio';
  END IF;

  -- Helper de DV não pode ser chamável por client (uso interno da RPC).
  IF to_regprocedure('private.cpf_dv_ok(text)') IS NULL
    OR to_regprocedure('private.cnpj_dv_ok(text)') IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: funções de DV ausentes';
  END IF;

  SELECT count(*) INTO v_idx
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'tenants_owner_idx',
      'tenants_cpf_active_uq',
      'tenants_cnpj_active_uq',
      'tenant_members_user_idx',
      'tenant_members_one_owner_uq'
    );
  IF v_idx <> 5 THEN
    RAISE EXCEPTION 'T00 falhou: índices de tenants/tenant_members ausentes';
  END IF;

  SELECT count(*) INTO v_constraints
  FROM pg_constraint
  WHERE conname IN (
    'tenants_kind_check',
    'tenants_plan_id_check',
    'tenants_subscription_status_check',
    'tenants_kind_document',
    'tenant_members_role_check'
  );
  IF v_constraints <> 5 THEN
    RAISE EXCEPTION 'T00 falhou: CHECKs obrigatórios ausentes';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tenants'::regclass
      AND tgname = 'set_tenants_updated_at'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T00 falhou: trigger set_tenants_updated_at ausente';
  END IF;

  -- Privilégios: authenticated só SELECT; nada de escrita; anon sem leitura.
  FOREACH v_priv IN ARRAY ARRAY['public.tenants', 'public.tenant_members'] LOOP
    IF NOT has_table_privilege('authenticated', v_priv, 'SELECT') THEN
      RAISE EXCEPTION 'T00 falhou: authenticated sem SELECT em %', v_priv;
    END IF;
    IF has_table_privilege('authenticated', v_priv, 'INSERT')
      OR has_table_privilege('authenticated', v_priv, 'UPDATE')
      OR has_table_privilege('authenticated', v_priv, 'DELETE')
      OR has_table_privilege('authenticated', v_priv, 'TRUNCATE') THEN
      RAISE EXCEPTION 'T00 falhou: authenticated mantém escrita em %', v_priv;
    END IF;
    IF has_table_privilege('anon', v_priv, 'SELECT') THEN
      RAISE EXCEPTION 'T00 falhou: anon lê %', v_priv;
    END IF;
  END LOOP;

  IF NOT has_function_privilege('authenticated', 'private.user_tenant_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated sem EXECUTE no helper';
  END IF;
  IF has_function_privilege('anon', 'private.user_tenant_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: anon executa o helper';
  END IF;
  IF has_function_privilege('authenticated', 'private.cpf_dv_ok(text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private.cnpj_dv_ok(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated executa funções de DV';
  END IF;
  IF NOT has_schema_privilege('authenticated', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated sem USAGE no schema private';
  END IF;
  IF has_schema_privilege('anon', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'T00 falhou: anon tem USAGE no schema private';
  END IF;
  -- SEC-04/D1 (0053): a RPC base é ato de backoffice/Edge. Cliente não executa.
  IF has_function_privilege(
    'authenticated',
    'public.create_tenant_with_owner(text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: authenticated executa a RPC (0053 revogou)';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.create_tenant_with_owner(text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: anon executa a RPC';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.create_tenant_with_owner(text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: service_role sem EXECUTE na RPC (backoffice/Edge)';
  END IF;

  RAISE NOTICE 'T00 ok: tabelas + RLS + 1 policy SELECT/tabela + helper + RPC (EXECUTE só service_role) + índices + grants';
END $$;

-- T00b — F1: default privileges de função. Função nova em `private` não pode
-- nascer executável por client. Em transação para não deixar artefato mesmo
-- quando o assert falha.
BEGIN;
CREATE OR REPLACE FUNCTION private.__f1_default_acl_probe()
RETURNS int
LANGUAGE sql
SET search_path = ''
AS $$ SELECT 1 $$;

DO $$
BEGIN
  IF has_function_privilege('anon', 'private.__f1_default_acl_probe()', 'EXECUTE')
    OR has_function_privilege(
      'authenticated', 'private.__f1_default_acl_probe()', 'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'T00b falhou: função nova em private nasceu executável por client';
  END IF;

  IF has_function_privilege('service_role', 'private.__f1_default_acl_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00b falhou: função nova em private nasceu executável por service_role';
  END IF;

  RAISE NOTICE 'T00b ok: default privileges não concedem EXECUTE a client em private';
END $$;
ROLLBACK;

-- ============ T00c — cliente não executa a RPC base (SEC-04/D1, 0053) ============
-- `authenticated` e `anon` → 42501 (insufficient_privilege), antes de qualquer
-- validação de domínio e sem escrita. O provisionamento é ato de backoffice.

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T00c falhou: authenticated provisionou tenant (0053)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00c falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00c falhou: erro diferente de 42501 para authenticated (%)', SQLERRM;
  END;
END $$;

RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T00c falhou: anon provisionou tenant';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00c falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00c falhou: erro diferente de 42501 para anon (%)', SQLERRM;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  v_tenants int;
BEGIN
  SELECT count(*) INTO v_tenants
  FROM public.tenants
  WHERE razao_social = 'Cliente Sem Convite';
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T00c falhou: tenant sem convite persistiu';
  END IF;

  RAISE NOTICE 'T00c ok: authenticated/anon → 42501 sem linha persistida';
END $$;

-- ============ T01 — RPC cria tenant + membership owner ============
-- A cria PF; B cria PJ. Dono = auth.uid(); p_plan_id omitido usa default 'free'.

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner(
    'pf', '11144477735', '  Ana Silva  ',
    NULL, '11987654321', NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T01 falhou: RPC não devolveu tenant_id';
  END IF;
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;

RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner(
    'pj', '11222333000181', 'Beta Comércio Ltda',
    'Beta', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T01 falhou: RPC não devolveu tenant_id (PJ)';
  END IF;
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;

RESET ROLE;

DO $$
DECLARE
  v_row public.tenants;
  v_members int;
BEGIN
  SELECT * INTO v_row FROM public.tenants WHERE cpf = '11144477735';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T01 falhou: tenant PF não persistido';
  END IF;
  IF v_row.kind <> 'pf' OR v_row.cnpj IS NOT NULL THEN
    RAISE EXCEPTION 'T01 falhou: discriminador de documento incorreto no PF';
  END IF;
  IF v_row.owner_user_id IS DISTINCT FROM '7e000000-0000-4000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION 'T01 falhou: dono do tenant PF não é auth.uid()';
  END IF;
  IF v_row.razao_social <> 'Ana Silva' THEN
    RAISE EXCEPTION 'T01 falhou: razão social não foi normalizada';
  END IF;
  IF v_row.plan_id <> 'free' OR v_row.subscription_status <> 'trial' THEN
    RAISE EXCEPTION 'T01 falhou: default de plano/status incorreto';
  END IF;
  IF v_row.phone IS DISTINCT FROM '11987654321' THEN
    RAISE EXCEPTION 'T01 falhou: telefone (só dígitos) não persistido';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE tenant_id = v_row.id
    AND user_id = '7e000000-0000-4000-8000-0000000000a1'
    AND role = 'owner';
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'T01 falhou: membership owner ausente/duplicada no PF';
  END IF;

  SELECT * INTO v_row FROM public.tenants WHERE cnpj = '11222333000181';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T01 falhou: tenant PJ não persistido';
  END IF;
  IF v_row.kind <> 'pj' OR v_row.cpf IS NOT NULL THEN
    RAISE EXCEPTION 'T01 falhou: discriminador de documento incorreto no PJ';
  END IF;
  IF v_row.plan_id <> 'free' THEN
    RAISE EXCEPTION 'T01 falhou: plano default não aplicado ao PJ (authenticated só cria free)';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE tenant_id = v_row.id
    AND user_id = '7e000000-0000-4000-8000-0000000000b1'
    AND role = 'owner';
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'T01 falhou: membership owner ausente/duplicada no PJ';
  END IF;

  RAISE NOTICE 'T01 ok: tenant + membership owner criados pelo dono (PF e PJ)';
END $$;

-- ============ T02 — documento duplicado ⇒ tenant-document-duplicate ============
-- Mesmo usuário e outro usuário: o índice único é global entre não cancelados.

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
BEGIN
  PERFORM public.create_tenant_with_owner(
    'pf', '11144477735', 'Ana Silva 2',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  RAISE EXCEPTION 'T02 falhou: RPC aceitou documento duplicado (mesmo usuário)';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T02 falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'tenant-document-duplicate' THEN
      RAISE EXCEPTION 'T02 falhou: rótulo errado para duplicidade (%)', SQLERRM;
    END IF;
END $$;

RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);

DO $$
BEGIN
  PERFORM public.create_tenant_with_owner(
    'pf', '11144477735', 'Outro Dono',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  RAISE EXCEPTION 'T02 falhou: RPC aceitou documento duplicado entre usuários';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T02 falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'tenant-document-duplicate' THEN
      RAISE EXCEPTION 'T02 falhou: rótulo errado para duplicidade (%)', SQLERRM;
    END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenants int;
  v_members int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE cpf = '11144477735';
  IF v_tenants <> 1 THEN
    RAISE EXCEPTION 'T02 falhou: duplicidade persistiu linha (esperava 1, achou %)', v_tenants;
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE user_id = '7e000000-0000-4000-8000-0000000000a1';
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'T02 falhou: falha da RPC deixou membership órfã';
  END IF;

  RAISE NOTICE 'T02 ok: tenant-document-duplicate sem linha persistida';
END $$;

-- T02a — CNPJ duplicado entre tenants ativos também é documento duplicado.
SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);

DO $$
BEGIN
  PERFORM public.create_tenant_with_owner(
    'pj', '11222333000181', 'Beta Duplicada',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  RAISE EXCEPTION 'T02a falhou: RPC aceitou CNPJ duplicado';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T02a falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'tenant-document-duplicate' THEN
      RAISE EXCEPTION 'T02a falhou: rótulo errado para CNPJ duplicado (%)', SQLERRM;
    END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE cnpj = '11222333000181';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T02a falhou: CNPJ duplicado persistiu linha (esperava 1, achou %)', v_count;
  END IF;

  RAISE NOTICE 'T02a ok: CNPJ duplicado recusado sem linha persistida';
END $$;

-- T02b — tenant cancelado libera o documento (I-4) e permite novo cadastro.
-- Em transação: o cancelamento e o novo tenant são desfeitos no fim.
BEGIN;
UPDATE public.tenants
SET subscription_status = 'canceled'
WHERE cnpj = '11222333000181';

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_id uuid;
  v_total int;
  v_canceled int;
BEGIN
  v_id := public.create_tenant_with_owner(
    'pj', '11222333000181', 'Beta Reativada',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T02b falhou: documento cancelado não liberou novo cadastro';
  END IF;
  PERFORM public.accept_contract(v_id, 'test-v1');

  SELECT count(*) INTO v_total
  FROM public.tenants
  WHERE cnpj = '11222333000181';
  IF v_total <> 2 THEN
    RAISE EXCEPTION 'T02b falhou: esperava 2 tenants com o mesmo CNPJ (1 cancelado), achou %', v_total;
  END IF;

  SELECT count(*) INTO v_canceled
  FROM public.tenants
  WHERE cnpj = '11222333000181'
    AND subscription_status = 'canceled';
  IF v_canceled <> 1 THEN
    RAISE EXCEPTION 'T02b falhou: tenant cancelado não preservado';
  END IF;

  RAISE NOTICE 'T02b ok: status canceled libera o documento e mantém o histórico';
END $$;
ROLLBACK;

-- T02c — falha no segundo INSERT (membership) desfaz o tenant (I-5).
-- Trigger temporário criado/removido dentro da transação.
BEGIN;
CREATE OR REPLACE FUNCTION private.__t02c_member_insert_fail()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 't02c-simulated-member-insert-failure';
END;
$$;
REVOKE ALL ON FUNCTION private.__t02c_member_insert_fail() FROM PUBLIC;

CREATE TRIGGER __t02c_member_insert_fail
  BEFORE INSERT ON public.tenant_members
  FOR EACH ROW EXECUTE FUNCTION private.__t02c_member_insert_fail();

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_before int;
  v_after int;
BEGIN
  SELECT count(*) INTO v_before FROM public.tenants;

  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '52998224725', 'Falha Segundo Insert',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T02c falhou: RPC aceitou falha no segundo INSERT';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02c falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 't02c-simulated-member-insert-failure' THEN
        RAISE EXCEPTION 'T02c falhou: rótulo errado na falha do segundo INSERT (%)', SQLERRM;
      END IF;
  END;

  SELECT count(*) INTO v_after FROM public.tenants;
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'T02c falhou: tenant persistiu sem membership (antes %, depois %)', v_before, v_after;
  END IF;

  RAISE NOTICE 'T02c ok: falha no segundo INSERT desfaz o tenant (nenhum órfão)';
END $$;
ROLLBACK;

-- T02d — payload inválido ⇒ tenant-data-invalid, sem `DETAIL`/`HINT` cru.
-- O `DETAIL` do Postgres (`Failing row contains ...`) carregaria documento,
-- telefone e endereço; a pré-validação da RPC impede que ele chegue ao cliente.
SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_msg text;
  v_detail text;
  v_hint text;
BEGIN
  -- telefone fora do formato
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '52998224725', 'Razao Secreta', 'Fantasia Secreta', 'telefone-invalido',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T02d falhou: RPC aceitou telefone inválido';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02d falhou%' THEN
        RAISE;
      END IF;
      GET STACKED DIAGNOSTICS
        v_msg = MESSAGE_TEXT,
        v_detail = PG_EXCEPTION_DETAIL,
        v_hint = PG_EXCEPTION_HINT;
      IF v_msg <> 'tenant-data-invalid' THEN
        RAISE EXCEPTION 'T02d falhou: rótulo errado para payload inválido (%)', v_msg;
      END IF;
      IF COALESCE(v_detail, '') <> '' OR COALESCE(v_hint, '') <> '' THEN
        RAISE EXCEPTION 'T02d falhou: DETAIL/HINT cru vazou ao cliente';
      END IF;
      IF v_msg LIKE '%52998224725%'
        OR v_msg LIKE '%telefone-invalido%'
        OR v_msg LIKE '%Razao Secreta%'
        OR v_msg LIKE '%Fantasia Secreta%' THEN
        RAISE EXCEPTION 'T02d falhou: PII na mensagem de erro';
      END IF;
  END;

  -- CEP fora do formato
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '52998224725', 'Cep Invalido', NULL, NULL,
      '123', NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T02d falhou: RPC aceitou CEP inválido';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-data-invalid' THEN
        RAISE EXCEPTION 'T02d falhou: rótulo errado para CEP inválido (%)', SQLERRM;
      END IF;
  END;

  -- UF fora do formato
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '52998224725', 'Uf Invalida', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, 'S1'
    );
    RAISE EXCEPTION 'T02d falhou: RPC aceitou UF inválida';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-data-invalid' THEN
        RAISE EXCEPTION 'T02d falhou: rótulo errado para UF inválida (%)', SQLERRM;
      END IF;
  END;

  -- razão social vazia / ausente
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '52998224725', '   ', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T02d falhou: RPC aceitou razão social vazia';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-data-invalid' THEN
        RAISE EXCEPTION 'T02d falhou: rótulo errado para razão social vazia (%)', SQLERRM;
      END IF;
  END;

  -- razão social acima do limite
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '52998224725', repeat('a', 201), NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T02d falhou: RPC aceitou razão social com 201 caracteres';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-data-invalid' THEN
        RAISE EXCEPTION 'T02d falhou: rótulo errado para razão social longa (%)', SQLERRM;
      END IF;
  END;

  -- nome fantasia acima do limite
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '52998224725', 'Nome Longo', repeat('b', 201), NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T02d falhou: RPC aceitou nome fantasia com 201 caracteres';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-data-invalid' THEN
        RAISE EXCEPTION 'T02d falhou: rótulo errado para nome fantasia longo (%)', SQLERRM;
      END IF;
  END;

  -- logradouro acima do limite
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '52998224725', 'Endereco Longo', NULL, NULL,
      NULL, repeat('c', 121), NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T02d falhou: RPC aceitou logradouro com 121 caracteres';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-data-invalid' THEN
        RAISE EXCEPTION 'T02d falhou: rótulo errado para logradouro longo (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T02d ok: tenant-data-invalid sem PII e sem DETAIL/HINT';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE razao_social IN (
    'Razao Secreta', 'Cep Invalido', 'Uf Invalida', 'Nome Longo', 'Endereco Longo'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T02d falhou: payload inválido persistiu tenant';
  END IF;
END $$;

-- ============ T03 — DV inválido ⇒ tenant-document-invalid ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_doc text;
BEGIN
  FOREACH v_doc IN ARRAY ARRAY['11111111111', '11144477736', '1234567890', ''] LOOP
    BEGIN
      PERFORM public.create_tenant_with_owner(
        'pf', v_doc, 'Documento Inválido',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      );
      RAISE EXCEPTION 'T03 falhou: RPC aceitou CPF inválido';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM LIKE 'T03 falhou%' THEN
          RAISE;
        END IF;
        IF SQLERRM <> 'tenant-document-invalid' THEN
          RAISE EXCEPTION 'T03 falhou: rótulo errado para DV inválido (%)', SQLERRM;
        END IF;
    END;
  END LOOP;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE razao_social = 'Documento Inválido';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T03 falhou: CPF inválido persistiu tenant';
  END IF;

  RAISE NOTICE 'T03 ok: DV inválido recusado (repetição e comprimento)';
END $$;

-- ============ T04 — kind ≠ documento ⇒ recusa (RPC e CHECK do banco) ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
BEGIN
  -- PF com CNPJ válido
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '45723174000110', 'PF com CNPJ',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T04 falhou: PF aceitou CNPJ';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-document-invalid' THEN
        RAISE EXCEPTION 'T04 falhou: rótulo errado no cruzamento kind×documento (%)', SQLERRM;
      END IF;
  END;

  -- PJ com CPF válido
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pj', '52998224725', 'PJ com CPF',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T04 falhou: PJ aceitou CPF';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-document-invalid' THEN
        RAISE EXCEPTION 'T04 falhou: rótulo errado no cruzamento kind×documento (%)', SQLERRM;
      END IF;
  END;
END $$;

RESET ROLE;

-- O CHECK do banco também barra escrita direta incoerente (defesa em profundidade).
DO $$
BEGIN
  INSERT INTO public.tenants (kind, owner_user_id, cpf, cnpj, razao_social)
  VALUES (
    'pf',
    '7e000000-0000-4000-8000-0000000000a1',
    '12345678909',
    '34028316000103',
    'Kind Documento Incoerente'
  );
  RAISE EXCEPTION 'T04b falhou: CHECK tenants_kind_document ausente';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'T04b ok: CHECK tenants_kind_document recusa kind×documento incoerente';
END $$;

-- ============ T05 — plano fora do catálogo ⇒ tenant-plan-invalid ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_plan text;
BEGIN
  FOREACH v_plan IN ARRAY ARRAY['enterprise', 'PRO', ''] LOOP
    BEGIN
      PERFORM public.create_tenant_with_owner(
        'pf', '52998224725', 'Plano Inválido',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, v_plan
      );
      RAISE EXCEPTION 'T05 falhou: RPC aceitou plano fora do catálogo';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM LIKE 'T05 falhou%' THEN
          RAISE;
        END IF;
        IF SQLERRM <> 'tenant-plan-invalid' THEN
          RAISE EXCEPTION 'T05 falhou: rótulo errado para plano inválido (%)', SQLERRM;
        END IF;
    END;
  END LOOP;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE razao_social = 'Plano Inválido';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T05 falhou: plano inválido persistiu tenant';
  END IF;

  RAISE NOTICE 'T05 ok: tenant-plan-invalid sem linha persistida';
END $$;

-- T05b — plano do catálogo, pago: `authenticated` comum só cria `free`.
-- T05b roda como owner (postgres), sem SET ROLE: o gate de plano lê
-- `auth.jwt()->>'role'`, então a claim permanece `authenticated`.
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_plan text;
BEGIN
  FOREACH v_plan IN ARRAY ARRAY['standard', 'pro', 'full'] LOOP
    BEGIN
      PERFORM public.create_tenant_with_owner(
        'pf', '52998224725', 'Plano Proibido',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, v_plan
      );
      RAISE EXCEPTION 'T05b falhou: authenticated criou plano pago';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM LIKE 'T05b falhou%' THEN
          RAISE;
        END IF;
        IF SQLERRM <> 'tenant-plan-forbidden' THEN
          RAISE EXCEPTION 'T05b falhou: rótulo errado para plano pago por authenticated (%)', SQLERRM;
        END IF;
    END;
  END LOOP;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE razao_social = 'Plano Proibido';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T05b falhou: plano pago por authenticated persistiu tenant';
  END IF;

  RAISE NOTICE 'T05b ok: tenant-plan-forbidden sem linha persistida';
END $$;

-- T05c — admin (backoffice) mantém qualquer slug do catálogo. Em transação.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_id uuid;
  v_plan text;
BEGIN
  v_id := public.create_tenant_with_owner(
    'pf', '52998224725', 'Plano Admin',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pro'
  );
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T05c falhou: admin não criou plano pago';
  END IF;
  PERFORM public.accept_contract(v_id, 'test-v1');

  SELECT plan_id INTO v_plan FROM public.tenants WHERE id = v_id;
  IF v_plan <> 'pro' THEN
    RAISE EXCEPTION 'T05c falhou: admin não aplicou o plano pago (%)', v_plan;
  END IF;

  RAISE NOTICE 'T05c ok: admin cria plano pago do catálogo';
END $$;
ROLLBACK;

-- ============ T06 — escrita direta por authenticated ⇒ 42501 ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social)
  VALUES (
    'pf', '7e000000-0000-4000-8000-0000000000a1', '98765432100', 'Insert Direto'
  );
  RAISE EXCEPTION 'T06a falhou: authenticated inseriu em tenants';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06a ok: INSERT em tenants negado (42501)';
END $$;

DO $$
BEGIN
  UPDATE public.tenants SET razao_social = 'Alterado'
  WHERE cpf = '11144477735';
  RAISE EXCEPTION 'T06b falhou: authenticated atualizou tenants';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06b ok: UPDATE em tenants negado (42501)';
END $$;

DO $$
BEGIN
  DELETE FROM public.tenants WHERE cpf = '11144477735';
  RAISE EXCEPTION 'T06c falhou: authenticated apagou tenants';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06c ok: DELETE em tenants negado (42501)';
END $$;

DO $$
BEGIN
  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  SELECT id, '7e000000-0000-4000-8000-0000000000d1', 'admin'
  FROM public.tenants
  WHERE cpf = '11144477735';
  RAISE EXCEPTION 'T06d falhou: authenticated inseriu membership';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06d ok: INSERT em tenant_members negado (42501)';
END $$;

DO $$
BEGIN
  UPDATE public.tenant_members SET role = 'owner'
  WHERE user_id = '7e000000-0000-4000-8000-0000000000a1';
  RAISE EXCEPTION 'T06e falhou: authenticated atualizou membership';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06e ok: UPDATE em tenant_members negado (42501)';
END $$;

DO $$
BEGIN
  DELETE FROM public.tenant_members
  WHERE user_id = '7e000000-0000-4000-8000-0000000000a1';
  RAISE EXCEPTION 'T06f falhou: authenticated apagou membership';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06f ok: DELETE em tenant_members negado (42501)';
END $$;

ROLLBACK;

-- Prova que nada foi alterado pelas tentativas acima.
DO $$
DECLARE
  v_members int;
BEGIN
  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE user_id = '7e000000-0000-4000-8000-0000000000a1'
    AND role = 'owner';
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'T06 falhou: tentativa de escrita direta alterou membership';
  END IF;

  RAISE NOTICE 'T06 ok: escrita direta negada nas duas tabelas; estado intacto';
END $$;

-- ============ T07 — matriz de leitura (membro, não-membro, admin) ============

-- B (membro do próprio tenant PJ) não lê o tenant PF de A.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_total int;
  v_alheio int;
  v_members int;
BEGIN
  SELECT count(*) INTO v_total FROM public.tenants;
  IF v_total <> 1 THEN
    RAISE EXCEPTION 'T07a falhou: membro de 1 tenant enxergou % linhas', v_total;
  END IF;

  SELECT count(*) INTO v_alheio FROM public.tenants WHERE cpf = '11144477735';
  IF v_alheio <> 0 THEN
    RAISE EXCEPTION 'T07a falhou: B leu o tenant de A';
  END IF;

  SELECT count(*) INTO v_members FROM public.tenant_members;
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'T07a falhou: membro enxergou % memberships', v_members;
  END IF;

  RAISE NOTICE 'T07a ok: B não lê o tenant de A e vê só a própria membership';
END $$;

RESET ROLE;

-- A (membro do próprio tenant PF) não lê o tenant PJ de B, lê o próprio.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_total int;
  v_prop int;
BEGIN
  SELECT count(*) INTO v_total FROM public.tenants;
  IF v_total <> 1 THEN
    RAISE EXCEPTION 'T07b falhou: A enxergou % linhas (esperava 1 própria)', v_total;
  END IF;

  SELECT count(*) INTO v_prop FROM public.tenants WHERE cpf = '11144477735';
  IF v_prop <> 1 THEN
    RAISE EXCEPTION 'T07b falhou: A não lê o próprio tenant';
  END IF;

  RAISE NOTICE 'T07b ok: A lê o próprio tenant e não o de B';
END $$;

RESET ROLE;

-- D sem membership não lê nada.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000d1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000d1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenants int;
  v_members int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants;
  SELECT count(*) INTO v_members FROM public.tenant_members;
  IF v_tenants <> 0 OR v_members <> 0 THEN
    RAISE EXCEPTION 'T07c falhou: usuário sem membership leu tenants/memberships';
  END IF;

  RAISE NOTICE 'T07c ok: usuário sem membership não lê nada';
END $$;

RESET ROLE;

-- Admin (backoffice) lê todos, sem ser membro.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenants int;
  v_members int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants;
  IF v_tenants <> 2 THEN
    RAISE EXCEPTION 'T07d falhou: admin enxergou % tenants (esperava 2)', v_tenants;
  END IF;

  SELECT count(*) INTO v_members FROM public.tenant_members;
  IF v_members <> 2 THEN
    RAISE EXCEPTION 'T07d falhou: admin enxergou % memberships (esperava 2)', v_members;
  END IF;

  RAISE NOTICE 'T07d ok: admin lê todos os tenants e memberships';
END $$;

RESET ROLE;

-- ============ T08 — auth.uid() nulo ⇒ not-authenticated ============

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE
  v_helper int;
  v_tenants int;
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '98765432100', 'Sem Sessão',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T08 falhou: RPC aceitou chamada sem auth.uid()';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T08 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'not-authenticated' THEN
        RAISE EXCEPTION 'T08 falhou: rótulo errado sem sessão (%)', SQLERRM;
      END IF;
  END;

  -- A RPC roda como service_role (0053). Helper e RLS são provados no papel
  -- do cliente, logo abaixo, na mesma transação.
  RAISE NOTICE 'T08a ok: not-authenticated sem sessão na RPC';
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_helper int;
  v_tenants int;
BEGIN
  SELECT count(*) INTO v_helper FROM private.user_tenant_ids();
  IF v_helper <> 0 THEN
    RAISE EXCEPTION 'T08 falhou: helper devolveu tenant sem sessão';
  END IF;

  SELECT count(*) INTO v_tenants FROM public.tenants;
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T08 falhou: sem sessão a policy liberou tenants';
  END IF;
END $$;

ROLLBACK;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE razao_social = 'Sem Sessão';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T08 falhou: chamada sem sessão persistiu tenant';
  END IF;

  RAISE NOTICE 'T08 ok: not-authenticated sem linha persistida';
END $$;

-- ============ T09 — limpeza final é efetiva (rerun não duplica) ============
-- Mesmo escape da limpeza inicial (ADR-004): purge em cascata com o trigger
-- reabilitado logo após.

DELETE FROM public.admin_audit
WHERE target_id IN (
  '7e000000-0000-4000-8000-0000000000a1',
  '7e000000-0000-4000-8000-0000000000b1',
  '7e000000-0000-4000-8000-0000000000c1',
  '7e000000-0000-4000-8000-0000000000d1'
);

ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.internal_operators
WHERE user_id IN (
  '7e000000-0000-4000-8000-0000000000a1',
  '7e000000-0000-4000-8000-0000000000b1',
  '7e000000-0000-4000-8000-0000000000c1',
  '7e000000-0000-4000-8000-0000000000d1'
);

DELETE FROM auth.users
WHERE id IN (
  '7e000000-0000-4000-8000-0000000000a1',
  '7e000000-0000-4000-8000-0000000000b1',
  '7e000000-0000-4000-8000-0000000000c1',
  '7e000000-0000-4000-8000-0000000000d1'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

DO $$
DECLARE
  v_tenants int;
  v_members int;
BEGIN
  SELECT count(*) INTO v_tenants
  FROM public.tenants
  WHERE cpf IN ('11144477735', '52998224725', '98765432100')
     OR cnpj IN ('11222333000181', '45723174000110', '34028316000103')
     OR owner_user_id IN (
       '7e000000-0000-4000-8000-0000000000a1',
       '7e000000-0000-4000-8000-0000000000b1',
       '7e000000-0000-4000-8000-0000000000c1',
       '7e000000-0000-4000-8000-0000000000d1'
     );
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T09b falhou: fixtures de tenant sobreviveram à limpeza final';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE user_id IN (
    '7e000000-0000-4000-8000-0000000000a1',
    '7e000000-0000-4000-8000-0000000000b1',
    '7e000000-0000-4000-8000-0000000000c1',
    '7e000000-0000-4000-8000-0000000000d1'
  );
  IF v_members <> 0 THEN
    RAISE EXCEPTION 'T09b falhou: memberships sobreviveram à limpeza final';
  END IF;

  RAISE NOTICE 'T09b ok: limpeza final deixa o banco pronto para o próximo run';
END $$;
