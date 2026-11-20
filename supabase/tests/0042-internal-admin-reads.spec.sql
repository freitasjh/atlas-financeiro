-- 0042-internal-admin-reads.spec.sql — internal-admin L3 / T07 (ADR-03, 0042).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0042-internal-admin-reads.spec.sql
-- Rerunnable: fixtures (users 4a42*, tenant CPF 11144477735, audit) apagadas no
-- início e no fim. Escrito ANTES da correção do STABLE (TDD): T00 e T03 falham
-- enquanto `admin_get_tenant` for STABLE (INSERT dentro de STABLE →
-- "STABLE functions cannot modify the database"); passam com a 0043.
--
-- Prova em banco real (não mock — mock não avalia grant, trigger nem
-- provolatile):
--   T00 estrutura: admin_get_tenant VOLATILE (grava trilha — STABLE seria
--       incorreto), admin_list_members STABLE; ambos SECURITY DEFINER,
--       search_path=''; EXECUTE só para authenticated (anon → 42501).
--   T01 anon (SET ROLE completo + ROLLBACK): 42501 nas duas RPCs.
--   T02 authenticated não-admin: rótulo fixo 'not-admin' nas duas RPCs; nenhuma
--       trilha gerada (o gate levanta antes do INSERT).
--   T03 admin (super_admin): get retorna 1 linha com documento do tenant;
--       exatamente 1 linha admin_audit action='other'
--       reason='internal_admin_read', actor=auth.uid(), sem PII
--       (from/to NULL, reason sem documento); 2ª chamada gera 2ª linha.
--   T04 admin: admin_list_members retorna os membros ordenados por
--       created_at ASC (membro antigo primeiro).
--   T05 admin: tenant inexistente → rótulo fixo 'tenant-not-found', sem
--       trilha nova.
--
-- Erros por rótulo fixo, sem ids ou PII nas mensagens (SEC-G3).

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS, DBA permitido) ============
-- ADR-004: purge passa pelo escape declarado (owner desabilita o trigger de
-- imutabilidade, apaga em cascata, reabilita). Só runbook/fixture, nunca app.
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.tenants
WHERE cpf IN ('11144477735');

DELETE FROM public.admin_audit
WHERE target_id IN (
  '4a420000-0000-4000-8000-0000000000a1',
  '4a420000-0000-4000-8000-0000000000b1',
  '4a420000-0000-4000-8000-0000000000c1'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  '4a420000-0000-4000-8000-0000000000a1',
  '4a420000-0000-4000-8000-0000000000b1',
  '4a420000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  '4a420000-0000-4000-8000-0000000000a1',
  '4a420000-0000-4000-8000-0000000000b1',
  '4a420000-0000-4000-8000-0000000000c1'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

INSERT INTO auth.users (id, email) VALUES
  ('4a420000-0000-4000-8000-0000000000a1', 'read-admin-0042@example.com'),
  ('4a420000-0000-4000-8000-0000000000b1', 'read-owner-0042@example.com'),
  ('4a420000-0000-4000-8000-0000000000c1', 'read-member-0042@example.com');

-- Promoção via DBA (current_user = postgres). (0035: só 'super_admin' existe;
-- is_admin() = alias super_only.) A trilha do setup é zerada para as
-- contagens. must_change_password=false explícito (sem travamento de
-- primeiro acesso no gate).
UPDATE public.profiles SET role = 'super_admin', must_change_password = false
WHERE id = '4a420000-0000-4000-8000-0000000000a1';

UPDATE public.profiles SET must_change_password = false
WHERE id IN (
  '4a420000-0000-4000-8000-0000000000b1',
  '4a420000-0000-4000-8000-0000000000c1'
);

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
  '4a420000-0000-4000-8000-0000000000a1',
  '4a420000-0000-4000-8000-0000000000b1',
  '4a420000-0000-4000-8000-0000000000c1'
);

-- SEC-04/D1 (0053): o cliente (authenticated/anon) não provisiona tenant nem
-- grava aceite. Fixture roda como service_role (backoffice/Edge) com claims do
-- dono; T00a prova o 42501 no papel do cliente.
--
-- Tenant do owner via RPC 0022 + aceite 0024 (mesmo bloco: a constraint
-- diferida valida no COMMIT). CPF 11144477735 (DV válido).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '4a420000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"4a420000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal1"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T00a falhou: authenticated provisionou tenant (0053)';
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
    RAISE EXCEPTION 'T00a falhou: authenticated gravou aceite (0053)';
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
ROLLBACK;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '4a420000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"4a420000-0000-4000-8000-0000000000b1","role":"service_role","aal":"aal1"}', false);

DO $$
DECLARE
  v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner(
    'pf', '11144477735', 'Internal Read Tenant',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;

RESET ROLE;

CREATE TEMP TABLE read_tenant_0042 (id uuid);
INSERT INTO read_tenant_0042 SELECT id FROM public.tenants WHERE cpf = '11144477735';
-- A tabela temporária é da sessão (owner=postgres): sem GRANT, anon e
-- authenticated não leem o id do tenant fixture (precedente backoffice-gaps).
GRANT SELECT ON read_tenant_0042 TO authenticated, anon;

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM read_tenant_0042;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Setup falhou: tenant fixture não criado (%)', v_n;
  END IF;
END $$;

-- 2º membro com created_at antigo (prova a ordem ASC de T04). Como postgres:
-- sem policy/RLS no caminho DBA. O tenant é `full` para a quota de seats
-- (`0063`, max_members NULL) não interferir na fixture de leitura.
UPDATE public.tenants SET plan_id = 'full'
WHERE id = (SELECT id FROM read_tenant_0042);

INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at)
VALUES (
  (SELECT id FROM read_tenant_0042),
  '4a420000-0000-4000-8000-0000000000c1',
  'member',
  '2024-05-01T12:00:00Z'::timestamptz
);

-- ============ T00 — estrutura: volatilidade correta + DEFINER + ACL ============
-- admin_get_tenant grava a trilha (INSERT): STABLE é incorreto — o Postgres
-- recusaria a escrita em tempo de chamada. Precedente 0028 (RPCs de escrita
-- sem STABLE, i.e. VOLATILE). admin_list_members só lê: STABLE permanece.
DO $$
DECLARE
  v_proc pg_proc;
  v_vol char;
  v_src text;
  v_n int;
BEGIN
  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('public.admin_get_tenant(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: public.admin_get_tenant(uuid) ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: admin_get_tenant sem SECURITY DEFINER';
  END IF;
  SELECT provolatile INTO v_vol FROM pg_proc WHERE oid = to_regprocedure('public.admin_get_tenant(uuid)');
  IF v_vol IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'T00 falhou: admin_get_tenant provolatile=% (esperado v=VOLATILE, a função grava trilha)', v_vol;
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'T00 falhou: admin_get_tenant sem search_path='' travado';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.admin_get_tenant(uuid)');
  IF v_src NOT LIKE '%public.admin_audit%' OR v_src NOT LIKE '%internal_admin_read%' THEN
    RAISE EXCEPTION 'T00 falhou: admin_get_tenant sem trilha internal_admin_read';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_get_tenant(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: admin_get_tenant sem EXECUTE para authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.admin_get_tenant(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: admin_get_tenant com EXECUTE para anon (leak)';
  END IF;

  SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure('public.admin_list_members(uuid)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: public.admin_list_members(uuid) ausente';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: admin_list_members sem SECURITY DEFINER';
  END IF;
  SELECT provolatile INTO v_vol FROM pg_proc WHERE oid = to_regprocedure('public.admin_list_members(uuid)');
  IF v_vol IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'T00 falhou: admin_list_members provolatile=% (esperado s=STABLE, só leitura)', v_vol;
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.aclexplode(
    COALESCE(v_proc.proacl, pg_catalog.acldefault('f', v_proc.oid))
  ) WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated');
  IF v_n = 0 THEN
    RAISE EXCEPTION 'T00 falhou: admin_list_members sem EXECUTE para authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_list_members(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: admin_list_members sem EXECUTE para authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.admin_list_members(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T00 falhou: admin_list_members com EXECUTE para anon (leak)';
  END IF;
  RAISE NOTICE 'T00 ok: admin_get_tenant VOLATILE + list_members STABLE, DEFINER, search_path='' travado, EXECUTE só authenticated';
END $$;

-- ============ T01 — anon: 42501 nas duas RPCs (SET ROLE completo + ROLLBACK) ============
BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', NULL, false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT set_config('request.jwt.claims', NULL, false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM read_tenant_0042;

  BEGIN
    PERFORM * FROM public.admin_get_tenant(v_tenant);
    RAISE EXCEPTION 'T01 falhou: anon passou em admin_get_tenant';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T01a ok: anon → 42501 em admin_get_tenant';
  END;

  BEGIN
    PERFORM * FROM public.admin_list_members(v_tenant);
    RAISE EXCEPTION 'T01 falhou: anon passou em admin_list_members';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T01b ok: anon → 42501 em admin_list_members';
  END;
END $$;

RESET ROLE;
ROLLBACK;

-- ============ T02 — authenticated não-admin: not-admin + 0 trilha ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '4a420000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"4a420000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal1"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM read_tenant_0042;

  BEGIN
    PERFORM * FROM public.admin_get_tenant(v_tenant);
    RAISE EXCEPTION 'T02 falhou: não-admin passou em admin_get_tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T02 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' THEN
      RAISE EXCEPTION 'T02 falhou: rótulo errado em admin_get_tenant (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T02a ok: authenticated não-admin → not-admin em admin_get_tenant';
  END;

  BEGIN
    PERFORM * FROM public.admin_list_members(v_tenant);
    RAISE EXCEPTION 'T02 falhou: não-admin passou em admin_list_members';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T02 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' THEN
      RAISE EXCEPTION 'T02 falhou: rótulo errado em admin_list_members (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T02b ok: authenticated não-admin → not-admin em admin_list_members';
  END;
END $$;

RESET ROLE;

-- O gate levanta antes do INSERT: 0 linhas para o tenant fixture.
DO $$
DECLARE
  v_tenant uuid;
  v_n int;
BEGIN
  SELECT id INTO v_tenant FROM read_tenant_0042;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'other' AND reason = 'internal_admin_read';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T02 falhou: not-admin gerou trilha (% linhas)', v_n;
  END IF;
  RAISE NOTICE 'T02 ok: not-admin não audita (gate antes do INSERT)';
END $$;

ROLLBACK;

-- ============ T03 — admin: 1 linha + trilha auditada sem PII ============
-- (STABLE recusaria o INSERT: sem a 0043, esta chamada levanta
-- "STABLE functions cannot modify the database" — o red do TDD.)
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '4a420000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"4a420000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  r record;
BEGIN
  SELECT id INTO v_tenant FROM read_tenant_0042;

  SELECT * INTO r FROM public.admin_get_tenant(v_tenant);
  IF NOT FOUND OR r.id IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'T03 falhou: admin_get_tenant não devolveu o tenant';
  END IF;
  IF r.document IS DISTINCT FROM '11144477735' THEN
    RAISE EXCEPTION 'T03 falhou: documento do tenant incorreto';
  END IF;
  IF r.razao_social IS DISTINCT FROM 'Internal Read Tenant' THEN
    RAISE EXCEPTION 'T03 falhou: razao_social do tenant incorreta';
  END IF;

  -- Segunda visita: +1 linha (audit por leitura, não por sessão).
  PERFORM * FROM public.admin_get_tenant(v_tenant);

  RAISE NOTICE 'T03a ok: admin lê o órgão (documento + razao_social)';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenant uuid;
  v_n int;
  a public.admin_audit;
BEGIN
  SELECT id INTO v_tenant FROM read_tenant_0042;

  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'other' AND reason = 'internal_admin_read';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'T03 falhou: esperava 2 linhas internal_admin_read, veio %', v_n;
  END IF;

  SELECT * INTO a FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'other' AND reason = 'internal_admin_read'
  ORDER BY at DESC LIMIT 1;

  IF a.actor_id IS DISTINCT FROM '4a420000-0000-4000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION 'T03 falhou: actor_id não é o admin (auth.uid())';
  END IF;
  IF a.target_id IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'T03 falhou: target_id não é o tenant';
  END IF;
  -- Sem PII na trilha: from/to NULL e reason é o rótulo fixo, sem documento.
  IF a.from_value IS NOT NULL OR a.to_value IS NOT NULL THEN
    RAISE EXCEPTION 'T03 falhou: trilha de leitura com from/to (possível PII)';
  END IF;
  IF a.reason = 'internal_admin_read' AND a.reason LIKE '%11144477735%' THEN
    RAISE EXCEPTION 'T03 falhou: reason carrega documento (PII)';
  END IF;

  RAISE NOTICE 'T03b ok: 2 leituras → 2 trilhas other/internal_admin_read, actor=admin, sem PII';
END $$;

ROLLBACK;

-- ============ T04 — admin: membros ordenados created_at ASC ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '4a420000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"4a420000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
  v_ids uuid[];
BEGIN
  SELECT id INTO v_tenant FROM read_tenant_0042;

  SELECT array_agg(user_id) INTO v_ids
  FROM public.admin_list_members(v_tenant);

  IF COALESCE(array_length(v_ids, 1), 0) <> 2 THEN
    RAISE EXCEPTION 'T04 falhou: esperava 2 membros, veio %', COALESCE(array_length(v_ids, 1), 0);
  END IF;
  -- O membro com created_at 2024 (c1) precede o owner recém-criado (b1).
  IF v_ids[1] IS DISTINCT FROM '4a420000-0000-4000-8000-0000000000c1'::uuid THEN
    RAISE EXCEPTION 'T04 falhou: primeiro membro não é o mais antigo';
  END IF;
  IF v_ids[2] IS DISTINCT FROM '4a420000-0000-4000-8000-0000000000b1'::uuid THEN
    RAISE EXCEPTION 'T04 falhou: segundo membro não é o owner';
  END IF;

  RAISE NOTICE 'T04 ok: admin_list_members ordenado created_at ASC';
END $$;

RESET ROLE;
ROLLBACK;

-- ============ T05 — tenant inexistente: tenant-not-found, sem trilha ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '4a420000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"4a420000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.admin_get_tenant('4a420000-0000-4000-8000-000000009999');
    RAISE EXCEPTION 'T05 falhou: tenant inexistente passou em admin_get_tenant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T05 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'tenant-not-found' THEN
      RAISE EXCEPTION 'T05 falhou: rótulo errado para tenant inexistente (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T05 ok: tenant inexistente → tenant-not-found';
  END;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE target_id = '4a420000-0000-4000-8000-000000009999';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T05 falhou: tenant-not-found gerou trilha (% linhas)', v_n;
  END IF;
  RAISE NOTICE 'T05b ok: tenant-not-found não audita';
END $$;

ROLLBACK;

-- ============ Limpeza final (rerun não duplica) ============
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.tenants
WHERE cpf IN ('11144477735');

DELETE FROM public.admin_audit
WHERE target_id IN (
  '4a420000-0000-4000-8000-0000000000a1',
  '4a420000-0000-4000-8000-0000000000b1',
  '4a420000-0000-4000-8000-0000000000c1'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  '4a420000-0000-4000-8000-0000000000a1',
  '4a420000-0000-4000-8000-0000000000b1',
  '4a420000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  '4a420000-0000-4000-8000-0000000000a1',
  '4a420000-0000-4000-8000-0000000000b1',
  '4a420000-0000-4000-8000-0000000000c1'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenants WHERE cpf = '11144477735';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-FIM falhou: tenant fixture sobreviveu à limpeza (%)', v_n;
  END IF;
  RAISE NOTICE 'T-FIM ok: cleanup efetiva, próximo run limpo';
END $$;
