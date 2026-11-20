-- tenants-adr002.spec.sql — tenants-cobranca / ADR-002 (migration 0023_usage_events.sql).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenants-adr002.spec.sql
-- Rerunnable: as fixtures (auth.users + tenants + memberships + usage_events) são
-- apagadas no início (delete de auth.users cascateia tenants → usage_events).
--
-- ADR-004 (0024): os tenants do setup são aceitos com
-- `accept_contract(v_id, 'test-v1')` no MESMO bloco da criação (a constraint
-- trigger diferida `tenant_acceptance_required` recusa o COMMIT sem aceite).
-- SEC-04/D1 (0053): criação/aceite só executam como `service_role` (backoffice/
-- Edge); `authenticated`/`anon` → 42501 (T00a).
--
-- Prova em banco real (não mock — mock não avalia policy nem grant):
--   T00 estrutura: tabela com RLS, 1 policy SELECT, 0 de escrita, RPC
--       (uuid,date,text,timestamptz → boolean, SECURITY DEFINER, search_path=''),
--       unique (tenant_id, competencia, dedup_key), CHECKs, FK CASCADE, grants
--   T00a cliente não provisiona tenant nem grava aceite ⇒ 42501 (0053)
--   T01 RPC registra `true` e conta 1
--   T02 reexecução da mesma tupla 3× ⇒ `false`, total estável em 1
--   T03 dedup_key distinto incrementa; mesma chave em competência distinta
--       incrementa separado
--   T04d futuro além de now()+5min (2030 e now()+1h) ⇒
--       usage-competencia-mismatch sem linha; passado 2020 permitido (backfill);
--       borda now()+5min tolerada
--   T05 dedup_key inválido (vazio, só-espaço, longo, charset, nulo) ⇒
--       usage-dedup-invalid, nada persistido
--   T06 INSERT/UPDATE/DELETE direto por authenticated ⇒ 42501
--   T07 B vê 0 eventos de A; membro vê os próprios; admin vê todos;
--       sem-membership não lê nada
--   T08 auth.uid() nulo ⇒ not-authenticated; tenant inexistente ⇒
--       usage-tenant-invalid
--   T09 limpeza de fixtures é efetiva (rerun não duplica)
--
-- Nenhuma mensagem de falha carrega ids, volume ou PII (SEC-G3).

\set ON_ERROR_STOP on

-- ============ Fixtures (como postgres: RLS bypass, DBA permitido) ============
-- Tenants criados pela RPC de ADR-001 (dono = auth.uid()). Apagar os usuários
-- cascateia tenants → memberships → usage_events, o que torna o arquivo
-- rerunnable.
-- ADR-004 (0024): os tenants do setup têm aceite imutável; o purge em cascata
-- passa pelo escape declarado (owner desabilita o trigger, apaga, reabilita).
-- Só fixture, nunca no app.
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

INSERT INTO auth.users (id, email) VALUES
  ('7e000000-0000-4000-8000-0000000000a1', 'usage-a@example.com'),
  ('7e000000-0000-4000-8000-0000000000b1', 'usage-b@example.com'),
  ('7e000000-0000-4000-8000-0000000000c1', 'usage-admin@example.com'),
  ('7e000000-0000-4000-8000-0000000000d1', 'usage-nomember@example.com');

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
  FROM public.usage_events
  WHERE tenant_id IN (
    SELECT id FROM public.tenants
    WHERE cpf IN ('11144477735', '52998224725')
       OR cnpj IN ('11222333000181', '45723174000110')
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T09 falhou: eventos residuais após a limpeza inicial';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE cpf IN ('11144477735', '52998224725')
     OR cnpj IN ('11222333000181', '45723174000110');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T09 falhou: fixtures de tenant sobreviveram à limpeza inicial';
  END IF;

  RAISE NOTICE 'T09a ok: fixtures limpas (rerun não duplica)';
END $$;

-- ============ T00 — estrutura, RLS, RPC, unique, CHECKs, FK, grants ============

DO $$
DECLARE
  v_rls boolean;
  v_policies int;
  v_write_policies int;
  v_proc pg_proc;
  v_qual text;
BEGIN
  IF to_regclass('public.usage_events') IS NULL THEN
    RAISE EXCEPTION 'T00 falhou: tabela usage_events ausente';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.usage_events'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RLS desligada em usage_events';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'usage_events'
    AND cmd = 'SELECT'
    AND roles = '{authenticated}';
  IF v_policies <> 1 THEN
    RAISE EXCEPTION 'T00 falhou: esperava 1 policy SELECT/authenticated em usage_events';
  END IF;

  SELECT count(*) INTO v_write_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'usage_events'
    AND cmd <> 'SELECT';
  IF v_write_policies <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: policy de escrita encontrada em usage_events';
  END IF;

  -- A policy precisa usar EXISTS (semi-join) sobre o helper e is_admin()
  -- em subquery (InitPlan). `IN (SELECT helper)` + `public.is_admin()` cru é a
  -- forma antiga, avaliada por linha candidata.
  SELECT qual INTO v_qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'usage_events'
    AND policyname = 'usage_events_select_member';
  IF v_qual IS NULL
    OR position('EXISTS' IN v_qual) = 0
    OR position('is_admin' IN v_qual) = 0
    OR position('user_tenant_ids' IN v_qual) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: policy de usage_events fora do formato EXISTS/InitPlan (%)', v_qual;
  END IF;

  -- RPC: (uuid, date, text, timestamptz) → boolean, SECURITY DEFINER, search_path=''.
  SELECT * INTO v_proc
  FROM pg_proc
  WHERE oid = to_regprocedure(
    'public.record_usage_event(uuid,date,text,timestamptz)'
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: RPC record_usage_event ausente ou com assinatura errada';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem SECURITY DEFINER';
  END IF;
  IF v_proc.prorettype <> 'boolean'::regtype THEN
    RAISE EXCEPTION 'T00 falhou: RPC não retorna boolean';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem search_path vazio';
  END IF;

  -- U-1: unique é o árbitro do ON CONFLICT.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_events_tenant_comp_dedup_uq'
      AND contype = 'u'
      AND conrelid = 'public.usage_events'::regclass
  ) THEN
    RAISE EXCEPTION 'T00 falhou: unique (tenant_id, competencia, dedup_key) ausente';
  END IF;

  -- U-4: competencia sempre dia 01; formato do dedup_key no banco (defesa em
  -- profundidade — a RPC pré-valida antes).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_events_competencia_day1'
      AND conrelid = 'public.usage_events'::regclass
  ) THEN
    RAISE EXCEPTION 'T00 falhou: CHECK de competencia dia 01 ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_events_dedup_key_format'
      AND conrelid = 'public.usage_events'::regclass
  ) THEN
    RAISE EXCEPTION 'T00 falhou: CHECK de formato do dedup_key ausente';
  END IF;

  -- FK para tenants com CASCADE (purge do tenant leva os eventos).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.usage_events'::regclass
      AND contype = 'f'
      AND confrelid = 'public.tenants'::regclass
      AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: FK usage_events → tenants ON DELETE CASCADE ausente';
  END IF;

  -- Privilégios: authenticated só SELECT; nada de escrita; anon sem leitura.
  IF NOT has_table_privilege('authenticated', 'public.usage_events', 'SELECT') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated sem SELECT em usage_events';
  END IF;
  IF has_table_privilege('authenticated', 'public.usage_events', 'INSERT')
    OR has_table_privilege('authenticated', 'public.usage_events', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.usage_events', 'DELETE')
    OR has_table_privilege('authenticated', 'public.usage_events', 'TRUNCATE') THEN
    RAISE EXCEPTION 'T00 falhou: authenticated mantém escrita em usage_events';
  END IF;
  IF has_table_privilege('anon', 'public.usage_events', 'SELECT') THEN
    RAISE EXCEPTION 'T00 falhou: anon lê usage_events';
  END IF;

  -- RPC executável só por authenticated.
  IF NOT has_function_privilege(
    'authenticated',
    'public.record_usage_event(uuid,date,text,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: authenticated sem EXECUTE na RPC';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.record_usage_event(uuid,date,text,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: anon executa a RPC';
  END IF;
  IF has_function_privilege(
    'service_role',
    'public.record_usage_event(uuid,date,text,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: service_role executa a RPC';
  END IF;

  RAISE NOTICE 'T00 ok: tabela + RLS + 1 policy SELECT + RPC + unique + CHECKs + FK + grants';
END $$;

-- (T00b: sonda do CHECK de competencia vive após o setup de tenants,
-- onde há linha para referenciar — ver abaixo.)


-- ============ T00a — cliente não provisiona nem aceita (SEC-04/D1, 0053) ============
-- `authenticated` e `anon` → 42501 nas duas RPCs de tenant (0022/0024),
-- sem escrita. Provisionamento/aceite é ato de backoffice/Edge.

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
    RAISE EXCEPTION 'T00a falhou: anon provisionou tenant';
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
  v_tenants int;
BEGIN
  SELECT count(*) INTO v_tenants
  FROM public.tenants
  WHERE razao_social = 'Cliente Sem Convite';
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T00a falhou: tenant sem convite persistiu';
  END IF;

  RAISE NOTICE 'T00a ok: authenticated/anon → 42501 sem linha persistida';
END $$;

-- ============ Setup: tenants de A (PF) e B (PJ) via RPC de ADR-001 ============

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
    'pf', '11144477735', 'Ana Silva',
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
    'pj', '11222333000181', 'Beta Comercio Ltda',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;

RESET ROLE;

-- T00b — o CHECK do banco barra escrita incoerente (defesa em profundidade;
-- a RPC pré-valida antes, mas o CHECK segura qualquer outro caminho).
DO $$
BEGIN
  INSERT INTO public.usage_events (tenant_id, competencia, dedup_key)
  SELECT id, DATE '2026-03-15', 'check-probe'
  FROM public.tenants WHERE cpf = '11144477735';
  RAISE EXCEPTION 'T00b falhou: CHECK de competencia dia 01 ausente';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'T00b ok: CHECK recusa competencia fora do dia 01';
END $$;

DO $$
BEGIN
  INSERT INTO public.usage_events (tenant_id, competencia, dedup_key)
  SELECT id, DATE '2026-03-01', 'sonda com espaco'
  FROM public.tenants WHERE cpf = '11144477735';
  RAISE EXCEPTION 'T00c falhou: CHECK de formato do dedup_key ausente';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'T00c ok: CHECK recusa dedup_key fora do charset';
END $$;

-- ============ T01 — RPC registra `true` e conta 1 ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_ok boolean;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  v_ok := public.record_usage_event(
    v_tenant, DATE '2026-03-01', 'tx:abc-123_XY:9',
    TIMESTAMPTZ '2026-03-15 12:00:00+00'
  );
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T01 falhou: 1ª chamada não devolveu true';
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
  v_row public.usage_events;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T01 falhou: esperava 1 evento, achou %', v_count;
  END IF;

  SELECT e.* INTO v_row
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_row.competencia <> DATE '2026-03-01'
    OR v_row.dedup_key <> 'tx:abc-123_XY:9'
    OR v_row.occurred_at <> TIMESTAMPTZ '2026-03-15 12:00:00+00' THEN
    RAISE EXCEPTION 'T01 falhou: linha persistida divergente';
  END IF;

  RAISE NOTICE 'T01 ok: 1ª chamada true e conta 1';
END $$;

-- ============ T02 — reexecução 3× ⇒ `false`, total estável ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_ok boolean;
  i int;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  FOR i IN 1..3 LOOP
    v_ok := public.record_usage_event(
      v_tenant, DATE '2026-03-01', 'tx:abc-123_XY:9',
      TIMESTAMPTZ '2026-03-15 12:00:00+00'
    );
    IF v_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'T02 falhou: reexecução % não devolveu false', i;
    END IF;
  END LOOP;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T02 falhou: total instável após reexecução (esperava 1, achou %)', v_count;
  END IF;

  RAISE NOTICE 'T02 ok: 3 reexecuções false, total estável em 1';
END $$;

-- ============ T03 — chave distinta incrementa; mesma chave em mês distinto separa ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_ok boolean;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  -- dedup_key distinto, mesma competência ⇒ incrementa.
  v_ok := public.record_usage_event(
    v_tenant, DATE '2026-03-01', 'tx:outra-chave_002',
    TIMESTAMPTZ '2026-03-20 12:00:00+00'
  );
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T03 falhou: chave distinta não devolveu true';
  END IF;

  -- mesma chave, competência distinta ⇒ linha separada.
  v_ok := public.record_usage_event(
    v_tenant, DATE '2026-04-01', 'tx:abc-123_XY:9',
    TIMESTAMPTZ '2026-04-10 12:00:00+00'
  );
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T03 falhou: mesma chave em outro mês não devolveu true';
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_mar int;
  v_apr int;
BEGIN
  SELECT count(*) INTO v_mar
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735' AND e.competencia = DATE '2026-03-01';
  IF v_mar <> 2 THEN
    RAISE EXCEPTION 'T03 falhou: março esperava 2, achou %', v_mar;
  END IF;

  SELECT count(*) INTO v_apr
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735' AND e.competencia = DATE '2026-04-01';
  IF v_apr <> 1 THEN
    RAISE EXCEPTION 'T03 falhou: abril esperava 1, achou %', v_apr;
  END IF;

  RAISE NOTICE 'T03 ok: chave distinta incrementa; mesma chave em outro mês separa';
END $$;

-- ============ T04 — competencia divergente ⇒ usage-competencia-mismatch ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  -- Fato em março, competencia de abril.
  BEGIN
    PERFORM public.record_usage_event(
      v_tenant, DATE '2026-04-01', 'tx:mismatch-01',
      TIMESTAMPTZ '2026-03-15 12:00:00+00'
    );
    RAISE EXCEPTION 'T04 falhou: RPC aceitou competencia divergente';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'usage-competencia-mismatch' THEN
        RAISE EXCEPTION 'T04 falhou: rótulo errado para competencia divergente (%)', SQLERRM;
      END IF;
  END;

  -- Borda de fuso: 31/01 23:30 UTC = 31/01 20:30 em SP ⇒ mês de janeiro.
  -- Passar fevereiro é divergência, mesmo que em UTC já seja 01/02.
  BEGIN
    PERFORM public.record_usage_event(
      v_tenant, DATE '2026-02-01', 'tx:mismatch-fuso',
      TIMESTAMPTZ '2026-02-01 02:30:00+00'
    );
    RAISE EXCEPTION 'T04 falhou: RPC aceitou competencia na borda de fuso';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'usage-competencia-mismatch' THEN
        RAISE EXCEPTION 'T04 falhou: rótulo errado na borda de fuso (%)', SQLERRM;
      END IF;
  END;

  -- Dia 01 nominal mas mês errado também é divergência (não só o dia).
  BEGIN
    PERFORM public.record_usage_event(
      v_tenant, DATE '2026-03-01', 'tx:mismatch-dia',
      TIMESTAMPTZ '2026-04-10 12:00:00+00'
    );
    RAISE EXCEPTION 'T04 falhou: RPC aceitou mes errado com dia 01';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'usage-competencia-mismatch' THEN
        RAISE EXCEPTION 'T04 falhou: rótulo errado para mes errado (%)', SQLERRM;
      END IF;
  END;
END $$;

RESET ROLE;

-- Borda válida em transação (desfeita): 31/01 23:30 SP com competencia 01/01 ⇒ true.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_ok boolean;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  v_ok := public.record_usage_event(
    v_tenant, DATE '2026-01-01', 'tx:borda-valida',
    TIMESTAMPTZ '2026-02-01 02:30:00+00'
  );
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T04 falhou: borda de fuso válida não devolveu true';
  END IF;

  RAISE NOTICE 'T04b ok: borda de fuso válida (SP manda, não UTC)';
END $$;
ROLLBACK;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735'
    AND e.dedup_key IN ('tx:mismatch-01', 'tx:mismatch-fuso', 'tx:mismatch-dia', 'tx:borda-valida');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T04 falhou: competencia divergente persistiu linha';
  END IF;

  RAISE NOTICE 'T04 ok: usage-competencia-mismatch sem linha persistida';
END $$;

-- ============ T04d — futuro além de now()+5min ⇒ mismatch; passado segue permitido ============
-- Must-fix do review ADR-002 (U-4 forjável): p_occurred_at/p_competencia eram
-- inputs livres — 100 lançamentos em 2020/2030 zeravam a fatura do mês.
-- Sem este teste o fix não conta: 2030 passava antes (true), agora recusa.

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_future timestamptz := pg_catalog.now() + INTERVAL '1 hour';
  v_future_comp date := (
    pg_catalog.date_trunc(
      'month',
      (pg_catalog.now() + INTERVAL '1 hour') AT TIME ZONE 'America/Sao_Paulo'
    )
  )::date;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  -- Futuro distante com competencia coerente (passava antes do fix).
  BEGIN
    PERFORM public.record_usage_event(
      v_tenant, DATE '2030-06-01', 'tx:futuro-2030',
      TIMESTAMPTZ '2030-06-15 12:00:00+00'
    );
    RAISE EXCEPTION 'T04d falhou: RPC aceitou occurred_at em 2030';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'usage-competencia-mismatch' THEN
        RAISE EXCEPTION 'T04d falhou: rótulo errado para futuro 2030 (%)', SQLERRM;
      END IF;
  END;

  -- Futuro próximo (now()+1h) com competencia do próprio fato.
  BEGIN
    PERFORM public.record_usage_event(
      v_tenant, v_future_comp, 'tx:futuro-1h',
      v_future
    );
    RAISE EXCEPTION 'T04d falhou: RPC aceitou occurred_at now()+1h';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04d falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'usage-competencia-mismatch' THEN
        RAISE EXCEPTION 'T04d falhou: rótulo errado para futuro now()+1h (%)', SQLERRM;
      END IF;
  END;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735'
    AND e.dedup_key IN ('tx:futuro-2030', 'tx:futuro-1h');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T04d falhou: futuro recusado persistiu linha';
  END IF;

  RAISE NOTICE 'T04d-a ok: futuro (2030 e now()+1h) recusado sem linha persistida';
END $$;

-- Backfill passado + borda +5min em transação desfeita (não polui T05/T06).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_ok boolean;
  v_edge timestamptz := pg_catalog.now() + INTERVAL '5 minutes';
  v_edge_comp date := (
    pg_catalog.date_trunc(
      'month',
      (pg_catalog.now() + INTERVAL '5 minutes') AT TIME ZONE 'America/Sao_Paulo'
    )
  )::date;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  -- Passado distante (importação legítima) segue permitido.
  v_ok := public.record_usage_event(
    v_tenant, DATE '2020-05-01', 'tx:passado-2020',
    TIMESTAMPTZ '2020-05-15 12:00:00+00'
  );
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T04d falhou: backfill 2020 não devolveu true';
  END IF;

  -- Borda now()+5min tolerada.
  v_ok := public.record_usage_event(
    v_tenant, v_edge_comp, 'tx:borda-5min',
    v_edge
  );
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T04d falhou: borda now()+5min não devolveu true';
  END IF;

  RAISE NOTICE 'T04d-b ok: passado 2020 permitido; borda +5min tolerada';
END $$;
ROLLBACK;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735'
    AND e.dedup_key IN ('tx:passado-2020', 'tx:borda-5min');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T04d falhou: transação desfeita persistiu linha';
  END IF;

  RAISE NOTICE 'T04d ok: futuro recusa, passado permite, borda tolera';
END $$;

-- ============ T05 — dedup_key inválido ⇒ usage-dedup-invalid ============

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_key text;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  FOREACH v_key IN ARRAY ARRAY[
    '', '   ', repeat('k', 129), 'com espaco', 'com+mais', 'barra/invalida',
    'ponto.invalid', 'aspas"inval', NULL
  ] LOOP
    BEGIN
      PERFORM public.record_usage_event(
        v_tenant, DATE '2026-03-01', v_key,
        TIMESTAMPTZ '2026-03-15 12:00:00+00'
      );
      RAISE EXCEPTION 'T05 falhou: RPC aceitou dedup_key inválido';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM LIKE 'T05 falhou%' THEN
          RAISE;
        END IF;
        IF SQLERRM <> 'usage-dedup-invalid' THEN
          RAISE EXCEPTION 'T05 falhou: rótulo errado para dedup inválido (%)', SQLERRM;
        END IF;
    END;
  END LOOP;
END $$;

RESET ROLE;

-- Charset cheio válido em transação (desfeita): 128 chars de [A-Za-z0-9:_-].
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_ok boolean;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';

  v_ok := public.record_usage_event(
    v_tenant, DATE '2026-03-01',
    'AZaz09:_-' || repeat('k', 119),
    TIMESTAMPTZ '2026-03-15 12:00:00+00'
  );
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T05 falhou: dedup_key limite (128, charset cheio) não devolveu true';
  END IF;

  RAISE NOTICE 'T05b ok: 128 chars com charset cheio é válido';
END $$;
ROLLBACK;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T05 falhou: dedup inválido alterou o total (esperava 3, achou %)', v_count;
  END IF;

  RAISE NOTICE 'T05 ok: usage-dedup-invalid sem linha persistida';
END $$;

-- ============ T06 — escrita direta por authenticated ⇒ 42501 ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  INSERT INTO public.usage_events (tenant_id, competencia, dedup_key)
  SELECT id, DATE '2026-03-01', 'tx:insert-direto'
  FROM public.tenants
  WHERE cpf = '11144477735';
  RAISE EXCEPTION 'T06a falhou: authenticated inseriu em usage_events';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06a ok: INSERT em usage_events negado (42501)';
END $$;

DO $$
BEGIN
  UPDATE public.usage_events SET dedup_key = 'tx:alterado'
  WHERE dedup_key = 'tx:abc-123_XY:9';
  RAISE EXCEPTION 'T06b falhou: authenticated atualizou usage_events';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06b ok: UPDATE em usage_events negado (42501)';
END $$;

DO $$
BEGIN
  DELETE FROM public.usage_events WHERE dedup_key = 'tx:abc-123_XY:9';
  RAISE EXCEPTION 'T06c falhou: authenticated apagou usage_events';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T06c ok: DELETE em usage_events negado (42501)';
END $$;

ROLLBACK;

-- Prova que nada foi alterado pelas tentativas acima.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T06 falhou: tentativa de escrita direta alterou eventos (esperava 3, achou %)', v_count;
  END IF;

  RAISE NOTICE 'T06 ok: escrita direta negada; estado intacto';
END $$;

-- ============ T07 — matriz de leitura (membro, não-membro, admin) ============
-- B registra 1 evento no próprio tenant PJ antes da matriz.

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_ok boolean;
BEGIN
  SELECT id INTO v_tenant FROM public.tenants WHERE cnpj = '11222333000181';

  v_ok := public.record_usage_event(
    v_tenant, DATE '2026-03-01', 'tx:beta-001',
    TIMESTAMPTZ '2026-03-10 12:00:00+00'
  );
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T07 falhou: B não registrou no próprio tenant';
  END IF;
END $$;

-- B (membro do PJ) não lê os 3 eventos de A.
DO $$
DECLARE
  v_total int;
  v_alheio int;
BEGIN
  SELECT count(*) INTO v_total FROM public.usage_events;
  IF v_total <> 1 THEN
    RAISE EXCEPTION 'T07a falhou: B enxergou % eventos (esperava 1 próprio)', v_total;
  END IF;

  SELECT count(*) INTO v_alheio
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_alheio <> 0 THEN
    RAISE EXCEPTION 'T07a falhou: B leu eventos de A';
  END IF;

  RAISE NOTICE 'T07a ok: B vê só o próprio evento, 0 de A';
END $$;

RESET ROLE;

-- A (membro do PF) lê os 3 próprios e não o de B.
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
  SELECT count(*) INTO v_total FROM public.usage_events;
  IF v_total <> 3 THEN
    RAISE EXCEPTION 'T07b falhou: A enxergou % eventos (esperava 3 próprios)', v_total;
  END IF;

  SELECT count(*) INTO v_alheio
  FROM public.usage_events AS e
  JOIN public.tenants AS t ON t.id = e.tenant_id
  WHERE t.cnpj = '11222333000181';
  IF v_alheio <> 0 THEN
    RAISE EXCEPTION 'T07b falhou: A leu eventos de B';
  END IF;

  RAISE NOTICE 'T07b ok: A lê os 3 próprios e não o de B';
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
  SELECT count(*) INTO v_total FROM public.usage_events;
  IF v_total <> 0 THEN
    RAISE EXCEPTION 'T07c falhou: usuário sem membership leu eventos';
  END IF;

  RAISE NOTICE 'T07c ok: usuário sem membership não lê nada';
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
  SELECT count(*) INTO v_total FROM public.usage_events;
  IF v_total <> 4 THEN
    RAISE EXCEPTION 'T07d falhou: admin enxergou % eventos (esperava 4)', v_total;
  END IF;

  RAISE NOTICE 'T07d ok: admin lê todos os eventos';
END $$;

RESET ROLE;

-- ============ T08 — sem sessão ⇒ not-authenticated; tenant inexistente ⇒ usage-tenant-invalid ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE
  v_total int;
BEGIN
  BEGIN
    PERFORM public.record_usage_event(
      '00000000-0000-4000-8000-000000000000', DATE '2026-03-01', 'tx:sem-sessao',
      TIMESTAMPTZ '2026-03-15 12:00:00+00'
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

  SELECT count(*) INTO v_total FROM public.usage_events;
  IF v_total <> 0 THEN
    RAISE EXCEPTION 'T08 falhou: sem sessão a policy liberou usage_events';
  END IF;
END $$;

ROLLBACK;

-- Tenant inexistente com sessão válida (ordem: existe antes de membership).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.record_usage_event(
      '00000000-0000-4000-8000-000000000000', DATE '2026-03-01', 'tx:fantasma',
      TIMESTAMPTZ '2026-03-15 12:00:00+00'
    );
    RAISE EXCEPTION 'T08 falhou: RPC aceitou tenant inexistente';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T08 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'usage-tenant-invalid' THEN
        RAISE EXCEPTION 'T08 falhou: rótulo errado para tenant inexistente (%)', SQLERRM;
      END IF;
  END;
END $$;

RESET ROLE;

-- Não-membro com sessão válida ⇒ tenant-not-member (antes de validar dedup).
-- O id do tenant é resolvido como DBA: a RLS esconderia a linha de D, e
-- passar NULL testaria o caminho errado (usage-tenant-invalid).
DROP TABLE IF EXISTS t08_tenant;
CREATE TEMP TABLE t08_tenant (id uuid);
INSERT INTO t08_tenant SELECT id FROM public.tenants WHERE cpf = '11144477735';
GRANT SELECT ON t08_tenant TO authenticated;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7e000000-0000-4000-8000-0000000000d1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7e000000-0000-4000-8000-0000000000d1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM pg_temp.t08_tenant;

  BEGIN
    PERFORM public.record_usage_event(
      v_tenant, DATE '2026-03-01', 'tx:intruso',
      TIMESTAMPTZ '2026-03-15 12:00:00+00'
    );
    RAISE EXCEPTION 'T08 falhou: RPC aceitou escrita de não-membro';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T08 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-not-member' THEN
        RAISE EXCEPTION 'T08 falhou: rótulo errado para não-membro (%)', SQLERRM;
      END IF;
  END;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.usage_events AS e
  WHERE e.dedup_key IN ('tx:sem-sessao', 'tx:fantasma', 'tx:intruso');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T08 falhou: chamada recusada persistiu evento';
  END IF;

  RAISE NOTICE 'T08 ok: not-authenticated / usage-tenant-invalid / tenant-not-member sem linha persistida';
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
  v_events int;
BEGIN
  SELECT count(*) INTO v_tenants
  FROM public.tenants
  WHERE cpf IN ('11144477735', '52998224725')
     OR cnpj IN ('11222333000181', '45723174000110')
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

  SELECT count(*) INTO v_events FROM public.usage_events;
  IF v_events <> 0 THEN
    RAISE EXCEPTION 'T09b falhou: usage_events sobreviveu à limpeza final';
  END IF;

  RAISE NOTICE 'T09b ok: limpeza final deixa o banco pronto para o próximo run';
END $$;
