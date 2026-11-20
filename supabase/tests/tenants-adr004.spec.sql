-- tenants-adr004.spec.sql — tenants-cobranca / ADR-004 (migration 0024_contract_acceptances.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenants-adr004.spec.sql
-- Rerunnable: as fixtures (auth.users + tenants + memberships + acceptances) são
-- apagadas no início (delete de auth.users cascateia tenants → memberships → acceptances).
--
-- Prova em banco real (não mock — mock não avalia trigger, policy nem grant):
--   T00 estrutura: tabela com RLS, 1 policy SELECT, 0 de escrita, trigger
--       `contract_acceptances_immutable` (sem current_user, search_path=''),
--       constraint trigger diferida `tenant_acceptance_required`, RPC
--       (uuid,text → bigint, SECURITY DEFINER, search_path=''), unique
--       (tenant_id, contract_version), CHECK de versão, índice, grants
--   T00a cliente não grava aceite nem provisiona tenant ⇒ 42501 (SEC-04/D1, 0053)
--   T01 RPC aceita e devolve id; `accepted_at`≈now, `user_id`=auth.uid()
--   T02 re-aceite da mesma versão ⇒ `acceptance-duplicate`, total estável
--   T03 UPDATE/DELETE por authenticated ⇒ 42501; por service_role e pelo
--       owner (postgres) ⇒ `acceptance-immutable`; linha intacta
--   T04 versão inválida ⇒ `acceptance-version-invalid`; tenant inexistente ⇒
--       `acceptance-tenant-invalid`; tenant alheio ⇒ `tenant-not-member`
--   T05 INSERT/UPDATE/DELETE direto por authenticated ⇒ 42501
--   T06 B vê 0 aceites de A; membro vê os próprios; admin vê todos;
--       sem-membership não lê nada
--   T07 tenant sem aceite ⇒ `tenant-acceptance-required` (nada persiste)
--   T08 auth.uid() nulo ⇒ `not-authenticated`
--   T09 limpeza de fixtures é efetiva (rerun não duplica)
--
-- SEC-04/D1 (0053): todo caminho feliz de criação/aceite roda como
-- `SET ROLE service_role` com claims do dono (`sub`); `authenticated`/`anon`
-- recebem 42501 (T00a).
--
-- Nenhuma mensagem de falha carrega ids, versão fora do rótulo ou PII (SEC-G3).

\set ON_ERROR_STOP on

-- ============ Fixtures (como postgres: RLS bypass, DBA permitido) ============
-- Ids/documentos determinísticos. Apagar os usuários cascateia tenants,
-- memberships e acceptances (owner_user_id ON DELETE CASCADE), o que torna o
-- arquivo rerunnable.

-- ADR-004: purge de fixture passa pelo escape declarado (owner desabilita o
-- trigger de imutabilidade, apaga em cascata, reabilita). Só runbook/fixture,
-- nunca no app.
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.tenants
WHERE cpf IN ('12345678909')
   OR cnpj IN ('34028316000103');

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
  ('7e000000-0000-4000-8000-0000000000a1', 'accept-a@example.com'),
  ('7e000000-0000-4000-8000-0000000000b1', 'accept-b@example.com'),
  ('7e000000-0000-4000-8000-0000000000c1', 'accept-admin@example.com'),
  ('7e000000-0000-4000-8000-0000000000d1', 'accept-nomember@example.com');

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
  WHERE cpf IN ('12345678909')
     OR cnpj IN ('34028316000103');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T09 falhou: fixtures de tenant sobreviveram à limpeza inicial';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.contract_acceptances AS ca
  JOIN public.tenants AS t ON t.id = ca.tenant_id
  WHERE t.cpf IN ('12345678909')
     OR t.cnpj IN ('34028316000103');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T09 falhou: aceites residuais após a limpeza inicial';
  END IF;

  RAISE NOTICE 'T09a ok: fixtures limpas (rerun não duplica)';
END $$;

-- ============ T00 — estrutura, RLS, triggers, RPC, unique, CHECKs, grants ============

DO $$
DECLARE
  v_rls boolean;
  v_policies int;
  v_write_policies int;
  v_proc pg_proc;
  v_prosrc text;
  v_qual text;
BEGIN
  IF to_regclass('public.contract_acceptances') IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: tabela contract_acceptances ausente';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.contract_acceptances'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RLS desligada em contract_acceptances';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'contract_acceptances'
    AND cmd = 'SELECT'
    AND roles = '{authenticated}';
  IF v_policies <> 1 THEN
    RAISE EXCEPTION 'T00 falhou: esperava 1 policy SELECT/authenticated em contract_acceptances';
  END IF;

  SELECT count(*) INTO v_write_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'contract_acceptances'
    AND cmd <> 'SELECT';
  IF v_write_policies <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: policy de escrita encontrada em contract_acceptances';
  END IF;

  SELECT qual INTO v_qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'contract_acceptances'
    AND policyname = 'contract_acceptances_select_member';
  IF v_qual IS NULL
    OR position('EXISTS' IN v_qual) = 0
    OR position('is_admin' IN v_qual) = 0
    OR position('user_tenant_ids' IN v_qual) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: policy de contract_acceptances fora do formato EXISTS/InitPlan (%)', v_qual;
  END IF;

  -- Trigger de imutabilidade: BEFORE UPDATE OR DELETE, por linha, sem current_user.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.contract_acceptances'::regclass
      AND tgname = 'contract_acceptances_immutable'
      AND tgenabled <> 'D'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T00 falhou: trigger contract_acceptances_immutable ausente ou desabilitado';
  END IF;

  SELECT prosrc INTO v_prosrc
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'reject_mutation';
  IF v_prosrc IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: função reject_mutation ausente';
  END IF;
  IF position('current_user' IN v_prosrc) <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: reject_mutation consulta current_user';
  END IF;
  IF position('acceptance-immutable' IN v_prosrc) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: reject_mutation sem o rótulo acceptance-immutable';
  END IF;

  SELECT * INTO v_proc
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'reject_mutation';
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: reject_mutation sem search_path vazio';
  END IF;

  -- Constraint trigger diferida sobre tenants.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tenants'::regclass
      AND tgname = 'tenant_acceptance_required'
      AND tgconstraint <> 0
      AND tgdeferrable
      AND tginitdeferred
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T00 falhou: constraint trigger tenant_acceptance_required ausente ou sem DEFERRABLE INITIALLY DEFERRED';
  END IF;

  SELECT prosrc INTO v_prosrc
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'tenant_acceptance_required_fn';
  IF v_prosrc IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: função tenant_acceptance_required_fn ausente';
  END IF;
  IF position('current_user' IN v_prosrc) <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: tenant_acceptance_required_fn consulta current_user';
  END IF;
  IF position('tenant-acceptance-required' IN v_prosrc) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: tenant_acceptance_required_fn sem o rótulo tenant-acceptance-required';
  END IF;

  -- RPC: (uuid, text) → bigint, SECURITY DEFINER, search_path=''.
  SELECT * INTO v_proc
  FROM pg_proc
  WHERE oid = to_regprocedure('public.accept_contract(uuid,text)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: RPC accept_contract ausente ou com assinatura errada';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem SECURITY DEFINER';
  END IF;
  IF v_proc.prorettype <> 'bigint'::regtype THEN
    RAISE EXCEPTION 'T00 falhou: RPC não retorna bigint';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem search_path vazio';
  END IF;

  SELECT prosrc INTO v_prosrc
  FROM pg_proc
  WHERE oid = to_regprocedure('public.accept_contract(uuid,text)');
  IF position('current_user' IN v_prosrc) <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: accept_contract consulta current_user';
  END IF;

  -- A-2: unique é o árbitro da duplicata.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contract_acceptances_tenant_version_uq'
      AND contype = 'u'
      AND conrelid = 'public.contract_acceptances'::regclass
  ) THEN
    RAISE EXCEPTION 'T00 falhou: unique (tenant_id, contract_version) ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contract_acceptances_version_format'
      AND conrelid = 'public.contract_acceptances'::regclass
  ) THEN
    RAISE EXCEPTION 'T00 falhou: CHECK de formato da versão ausente';
  END IF;

  -- FK para tenants com CASCADE (purge do tenant leva os aceites).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.contract_acceptances'::regclass
      AND contype = 'f'
      AND confrelid = 'public.tenants'::regclass
      AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: FK contract_acceptances → tenants ON DELETE CASCADE ausente';
  END IF;

  -- Índice de leitura por tenant.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'contract_acceptances_tenant_idx'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: índice contract_acceptances_tenant_idx ausente';
  END IF;

  -- Privilégios: authenticated só SELECT; nada de escrita; anon sem leitura.
  IF NOT has_table_privilege('authenticated', 'public.contract_acceptances', 'SELECT') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated sem SELECT em contract_acceptances';
  END IF;
  IF has_table_privilege('authenticated', 'public.contract_acceptances', 'INSERT')
    OR has_table_privilege('authenticated', 'public.contract_acceptances', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.contract_acceptances', 'DELETE')
    OR has_table_privilege('authenticated', 'public.contract_acceptances', 'TRUNCATE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated mantém escrita em contract_acceptances';
  END IF;
  IF has_table_privilege('anon', 'public.contract_acceptances', 'SELECT') THEN
    RAISE EXCEPTION 'T00 falhou: anon lê contract_acceptances';
  END IF;

  -- RPC executável só por service_role (SEC-04/D1, 0053).
  IF has_function_privilege(
    'authenticated',
    'public.accept_contract(uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: authenticated executa a RPC (0053 revogou)';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.accept_contract(uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: anon executa a RPC';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.accept_contract(uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: service_role sem EXECUTE na RPC (backoffice/Edge)';
  END IF;

  -- Funções de trigger não são endpoint: client não as executa.
  IF has_function_privilege('authenticated', 'public.reject_mutation()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.tenant_acceptance_required_fn()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated executa função de trigger';
  END IF;

  RAISE NOTICE 'T00 ok: tabela + RLS + 1 policy SELECT + triggers + constraint diferida + RPC + unique + CHECKs + FK + grants';
END $$;

-- ============ T00a — cliente não provisiona nem aceita (SEC-04/D1, 0053) ============
-- `authenticated` e `anon` → 42501 nas RPCs de tenant (0022/0024). O aceite é
-- ato de backoffice/Edge (service_role) com claims do dono.

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.accept_contract(
      '00000000-0000-4000-8000-000000000000', 'test-v1'
    );
    RAISE EXCEPTION 'T00a falhou: authenticated gravou aceite';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00a falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00a falhou: erro diferente de 42501 no aceite (%)', SQLERRM;
  END;

  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T00a falhou: authenticated provisionou tenant';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00a falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00a falhou: erro diferente de 42501 no tenant (%)', SQLERRM;
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
    PERFORM public.accept_contract(
      '00000000-0000-4000-8000-000000000000', 'test-v1'
    );
    RAISE EXCEPTION 'T00a falhou: anon gravou aceite';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00a falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00a falhou: erro diferente de 42501 para anon (%)', SQLERRM;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.contract_acceptances;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T00a falhou: chamada sem permissão persistiu aceite';
  END IF;

  RAISE NOTICE 'T00a ok: authenticated/anon → 42501 sem linha persistida';
END $$;

-- ============ Setup: tenants de A (PF) e B (PJ) via RPC de ADR-001 + aceite ============
-- Criação e aceite no MESMO bloco: a constraint diferida valida no COMMIT.

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
    'pf', '12345678909', 'Ana Silva',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
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
    'pj', '34028316000103', 'Beta Comercio Ltda',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;

RESET ROLE;

-- Ids em temp tables para os blocos que rodam sem visibilidade RLS (D, sem-sessão).
DROP TABLE IF EXISTS t04_tenant_a;
CREATE TEMP TABLE t04_tenant_a (id uuid);
INSERT INTO t04_tenant_a SELECT id FROM public.tenants WHERE cpf = '12345678909';
GRANT SELECT ON t04_tenant_a TO authenticated, service_role;

-- T00b — o CHECK do banco barra versão fora do formato (defesa em profundidade;
-- a RPC pré-valida antes, mas o CHECK segura qualquer outro caminho).
DO $$
BEGIN
  INSERT INTO public.contract_acceptances (tenant_id, contract_version, user_id)
  SELECT id, 'versao com espaco', '7e000000-0000-4000-8000-0000000000a1'
  FROM public.tenants WHERE cpf = '12345678909';
  RAISE EXCEPTION 'T00b falhou: CHECK de formato da versão ausente';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'T00b ok: CHECK recusa versão fora do charset';
END $$;

-- ============ T01 — RPC aceita e devolve id (accepted_at≈now, user_id=auth.uid) ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_id bigint;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '12345678909';

  v_id := public.accept_contract(v_tenant, 'test-v2');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T01 falhou: RPC não devolveu o id do aceite';
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_row public.contract_acceptances;
BEGIN
  SELECT ca.* INTO v_row
  FROM public.contract_acceptances AS ca
  JOIN public.tenants AS t ON t.id = ca.tenant_id
  WHERE t.cpf = '12345678909'
    AND ca.contract_version = 'test-v2';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T01 falhou: aceite test-v2 não persistido';
  END IF;
  IF v_row.user_id IS DISTINCT FROM '7e000000-0000-4000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION 'T01 falhou: user_id do aceite não é auth.uid()';
  END IF;
  IF v_row.accepted_at IS NULL
    OR v_row.accepted_at < pg_catalog.now() - INTERVAL '5 minutes'
    OR v_row.accepted_at > pg_catalog.now() + INTERVAL '1 minute' THEN
    RAISE EXCEPTION 'T01 falhou: accepted_at fora da janela do servidor';
  END IF;

  RAISE NOTICE 'T01 ok: aceite devolve id, accepted_at≈now, user_id=auth.uid()';
END $$;

-- ============ T02 — re-aceite da mesma versão ⇒ acceptance-duplicate ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '12345678909';

  BEGIN
    PERFORM public.accept_contract(v_tenant, 'test-v1');
    RAISE EXCEPTION 'T02 falhou: RPC aceitou re-aceite da mesma versão';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T02 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'acceptance-duplicate' THEN
        RAISE EXCEPTION 'T02 falhou: rótulo errado para duplicata (%)', SQLERRM;
      END IF;
  END;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.contract_acceptances AS ca
  JOIN public.tenants AS t ON t.id = ca.tenant_id
  WHERE t.cpf = '12345678909';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'T02 falhou: duplicata alterou o total (esperava 2, achou %)', v_count;
  END IF;

  RAISE NOTICE 'T02 ok: acceptance-duplicate sem linha persistida';
END $$;

-- ============ T03 — UPDATE/DELETE recusados para qualquer role ============
-- authenticated ⇒ 42501 (sem grant); service_role e owner (postgres) ⇒
-- acceptance-immutable (trigger, que grant nenhum alcança).

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  UPDATE public.contract_acceptances SET contract_version = 'adulterada'
  WHERE contract_version = 'test-v1';
  RAISE EXCEPTION 'T03a falhou: authenticated atualizou aceite';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T03a ok: UPDATE por authenticated negado (42501)';
END $$;

DO $$
BEGIN
  DELETE FROM public.contract_acceptances WHERE contract_version = 'test-v1';
  RAISE EXCEPTION 'T03b falhou: authenticated apagou aceite';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T03b ok: DELETE por authenticated negado (42501)';
END $$;

ROLLBACK;

-- service_role tem bypassrls: só o trigger barra.
SET ROLE service_role;

DO $$
BEGIN
  UPDATE public.contract_acceptances SET contract_version = 'adulterada'
  WHERE contract_version = 'test-v1';
  RAISE EXCEPTION 'T03c falhou: service_role atualizou aceite';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T03c falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'acceptance-immutable' THEN
      RAISE EXCEPTION 'T03c falhou: rótulo errado para service_role (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T03c ok: UPDATE por service_role recusado (acceptance-immutable)';
END $$;

DO $$
BEGIN
  DELETE FROM public.contract_acceptances WHERE contract_version = 'test-v1';
  RAISE EXCEPTION 'T03d falhou: service_role apagou aceite';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T03d falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'acceptance-immutable' THEN
      RAISE EXCEPTION 'T03d falhou: rótulo errado para service_role (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T03d ok: DELETE por service_role recusado (acceptance-immutable)';
END $$;

RESET ROLE;

-- Owner (postgres) também é barrado pelo trigger.
DO $$
BEGIN
  UPDATE public.contract_acceptances SET contract_version = 'adulterada'
  WHERE contract_version = 'test-v1';
  RAISE EXCEPTION 'T03e falhou: owner atualizou aceite';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T03e falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'acceptance-immutable' THEN
      RAISE EXCEPTION 'T03e falhou: rótulo errado para owner (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T03e ok: UPDATE pelo owner recusado (acceptance-immutable)';
END $$;

DO $$
BEGIN
  DELETE FROM public.contract_acceptances WHERE contract_version = 'test-v1';
  RAISE EXCEPTION 'T03f falhou: owner apagou aceite';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T03f falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'acceptance-immutable' THEN
      RAISE EXCEPTION 'T03f falhou: rótulo errado para owner (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T03f ok: DELETE pelo owner recusado (acceptance-immutable)';
END $$;

-- Prova que nada foi alterado pelas tentativas acima.
DO $$
DECLARE
  v_count int;
  v_versions int;
BEGIN
  SELECT count(*) INTO v_count FROM public.contract_acceptances;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T03 falhou: tentativa de mutação alterou aceites (esperava 3, achou %)', v_count;
  END IF;

  SELECT count(*) INTO v_versions
  FROM public.contract_acceptances
  WHERE contract_version = 'adulterada';
  IF v_versions <> 0 THEN
    RAISE EXCEPTION 'T03 falhou: aceite adulterado persistido';
  END IF;

  RAISE NOTICE 'T03 ok: UPDATE/DELETE recusados por authenticated, service_role e owner; estado intacto';
END $$;

-- ============ T04 — versão inválida / tenant inválido / não-membro ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_version text;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '12345678909';

  FOREACH v_version IN ARRAY ARRAY[
    '', '   ', 'com espaco', 'com+mais', 'barra/invalida',
    'aspas"inval', repeat('v', 65), NULL
  ] LOOP
    BEGIN
      PERFORM public.accept_contract(v_tenant, v_version);
      RAISE EXCEPTION 'T04 falhou: RPC aceitou versão inválida';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM LIKE 'T04 falhou%' THEN
          RAISE;
        END IF;
        IF SQLERRM <> 'acceptance-version-invalid' THEN
          RAISE EXCEPTION 'T04 falhou: rótulo errado para versão inválida (%)', SQLERRM;
        END IF;
    END;
  END LOOP;

  -- Charset/limite válidos são provados em transação desfeita (ver abaixo).
  RAISE NOTICE 'T04 ok: acceptance-version-invalid sem linha persistida';
END $$;

RESET ROLE;

-- Versão limite (64 chars, charset cheio) é válida — em transação desfeita
-- para não poluir as contagens de T05/T06.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_id bigint;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '12345678909';

  v_id := public.accept_contract(v_tenant, 'AZaz09._-' || repeat('v', 55));
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T04b falhou: versão limite (64, charset cheio) não devolveu id';
  END IF;

  RAISE NOTICE 'T04b ok: 64 chars com charset cheio é válido';
END $$;
ROLLBACK;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.contract_acceptances AS ca
  JOIN public.tenants AS t ON t.id = ca.tenant_id
  WHERE t.cpf = '12345678909';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'T04 falhou: versão inválida alterou o total (esperava 2, achou %)', v_count;
  END IF;
END $$;

-- Tenant inexistente com sessão válida (ordem: existe antes de membership).
SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.accept_contract(
      '00000000-0000-4000-8000-000000000000', 'test-v1'
    );
    RAISE EXCEPTION 'T04c falhou: RPC aceitou tenant inexistente';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04c falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'acceptance-tenant-invalid' THEN
        RAISE EXCEPTION 'T04c falhou: rótulo errado para tenant inexistente (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T04c ok: acceptance-tenant-invalid sem vazar existência';
END $$;

RESET ROLE;

-- Não-membro (D) aceitando o tenant de A ⇒ tenant-not-member.
-- O id do tenant é resolvido como DBA: a RLS esconderia a linha de D.
SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000d1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000d1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM pg_temp.t04_tenant_a;

  BEGIN
    PERFORM public.accept_contract(v_tenant, 'test-v1');
    RAISE EXCEPTION 'T04d falhou: RPC aceitou aceite de não-membro';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-not-member' THEN
        RAISE EXCEPTION 'T04d falhou: rótulo errado para não-membro (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T04d ok: tenant-not-member sem linha persistida';
END $$;

RESET ROLE;

-- Membro de outro tenant (B) aceitando o tenant de A ⇒ tenant-not-member.
SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM pg_temp.t04_tenant_a;

  BEGIN
    PERFORM public.accept_contract(v_tenant, 'test-v9');
    RAISE EXCEPTION 'T04e falhou: RPC aceitou aceite entre tenants';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04e falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-not-member' THEN
        RAISE EXCEPTION 'T04e falhou: rótulo errado para aceite entre tenants (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T04e ok: membro de outro tenant não aceita (tenant-not-member)';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.contract_acceptances;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T04 falhou: chamada recusada persistiu aceite (esperava 3, achou %)', v_count;
  END IF;
END $$;

-- ============ T05 — escrita direta por authenticated ⇒ 42501 ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  INSERT INTO public.contract_acceptances (tenant_id, contract_version, user_id)
  SELECT id, 'insercao-direta', '7e000000-0000-4000-8000-0000000000a1'
  FROM public.tenants
  WHERE cpf = '12345678909';
  RAISE EXCEPTION 'T05a falhou: authenticated inseriu em contract_acceptances';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T05a ok: INSERT em contract_acceptances negado (42501)';
END $$;

DO $$
BEGIN
  UPDATE public.contract_acceptances SET contract_version = 'alterado'
  WHERE contract_version = 'test-v1';
  RAISE EXCEPTION 'T05b falhou: authenticated atualizou contract_acceptances';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T05b ok: UPDATE em contract_acceptances negado (42501)';
END $$;

DO $$
BEGIN
  DELETE FROM public.contract_acceptances WHERE contract_version = 'test-v1';
  RAISE EXCEPTION 'T05c falhou: authenticated apagou contract_acceptances';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T05c ok: DELETE em contract_acceptances negado (42501)';
END $$;

ROLLBACK;

-- Prova que nada foi alterado pelas tentativas acima.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.contract_acceptances;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T05 falhou: tentativa de escrita direta alterou aceites (esperava 3, achou %)', v_count;
  END IF;

  RAISE NOTICE 'T05 ok: escrita direta negada; estado intacto';
END $$;

-- ============ T06 — matriz de leitura (membro, não-membro, admin) ============

-- B (membro do PJ) não lê os 2 aceites de A.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_total int;
  v_alheio int;
BEGIN
  SELECT count(*) INTO v_total FROM public.contract_acceptances;
  IF v_total <> 1 THEN
    RAISE EXCEPTION 'T06a falhou: B enxergou % aceites (esperava 1 próprio)', v_total;
  END IF;

  SELECT count(*) INTO v_alheio
  FROM public.contract_acceptances AS ca
  JOIN public.tenants AS t ON t.id = ca.tenant_id
  WHERE t.cpf = '12345678909';
  IF v_alheio <> 0 THEN
    RAISE EXCEPTION 'T06a falhou: B leu aceites de A';
  END IF;

  RAISE NOTICE 'T06a ok: B vê só o próprio aceite, 0 de A';
END $$;

RESET ROLE;

-- A (membro do PF) lê os 2 próprios e não o de B.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_total int;
  v_alheio int;
BEGIN
  SELECT count(*) INTO v_total FROM public.contract_acceptances;
  IF v_total <> 2 THEN
    RAISE EXCEPTION 'T06b falhou: A enxergou % aceites (esperava 2 próprios)', v_total;
  END IF;

  SELECT count(*) INTO v_alheio
  FROM public.contract_acceptances AS ca
  JOIN public.tenants AS t ON t.id = ca.tenant_id
  WHERE t.cnpj = '34028316000103';
  IF v_alheio <> 0 THEN
    RAISE EXCEPTION 'T06b falhou: A leu aceites de B';
  END IF;

  RAISE NOTICE 'T06b ok: A lê os 2 próprios e não o de B';
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
  v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM public.contract_acceptances;
  IF v_total <> 0 THEN
    RAISE EXCEPTION 'T06c falhou: usuário sem membership leu aceites';
  END IF;

  RAISE NOTICE 'T06c ok: usuário sem membership não lê nada';
END $$;

RESET ROLE;

-- Admin (backoffice) lê todos sem ser membro.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM public.contract_acceptances;
  IF v_total <> 3 THEN
    RAISE EXCEPTION 'T06d falhou: admin enxergou % aceites (esperava 3)', v_total;
  END IF;

  RAISE NOTICE 'T06d ok: admin lê todos os aceites';
END $$;

RESET ROLE;

-- ============ T07 — tenant sem aceite ⇒ tenant-acceptance-required ============
-- A constraint é diferida: com o modo forçado a IMMEDIATE nesta transação, o
-- INSERT do tenant dispara a verificação dentro do bloco (capturável) e o
-- ROLLBACK garante que nada persiste.

BEGIN;
SET CONSTRAINTS tenant_acceptance_required IMMEDIATE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
BEGIN
  PERFORM public.create_tenant_with_owner(
    'pf', '52998224725', 'Sem Aceite',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  RAISE EXCEPTION 'T07 falhou: tenant sem aceite foi aceito';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T07 falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'tenant-acceptance-required' THEN
      RAISE EXCEPTION 'T07 falhou: rótulo errado sem aceite (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T07 ok: tenant-acceptance-required sem aceite';
END $$;

ROLLBACK;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE razao_social = 'Sem Aceite';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T07 falhou: tenant sem aceite persistiu';
  END IF;
END $$;

-- ============ T08 — auth.uid() nulo ⇒ not-authenticated ============

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE
  v_tenant uuid;
  v_total int;
BEGIN
  SELECT id INTO v_tenant FROM pg_temp.t04_tenant_a;

  BEGIN
    PERFORM public.accept_contract(v_tenant, 'test-v1');
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

  RAISE NOTICE 'T08a ok: not-authenticated sem sessão na RPC (service_role)';
END $$;

-- A visibilidade RLS é provada no papel do cliente, na mesma transação.
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM public.contract_acceptances;
  IF v_total <> 0 THEN
    RAISE EXCEPTION 'T08 falhou: sem sessão a policy liberou contract_acceptances';
  END IF;
END $$;

ROLLBACK;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.contract_acceptances;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T08 falhou: chamada sem sessão alterou aceites (esperava 3, achou %)', v_count;
  END IF;

  RAISE NOTICE 'T08 ok: not-authenticated sem linha persistida';
END $$;

-- ============ T09 — limpeza final é efetiva (rerun não duplica) ============
-- Mesmo escape da limpeza inicial (trigger reabilitado logo após o purge).

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
  v_accepts int;
BEGIN
  SELECT count(*) INTO v_tenants
  FROM public.tenants
  WHERE cpf IN ('12345678909', '52998224725')
     OR cnpj IN ('34028316000103')
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

  SELECT count(*) INTO v_accepts FROM public.contract_acceptances;
  IF v_accepts <> 0 THEN
    RAISE EXCEPTION 'T09b falhou: contract_acceptances sobreviveu à limpeza final';
  END IF;

  RAISE NOTICE 'T09b ok: limpeza final deixa o banco pronto para o próximo run';
END $$;
