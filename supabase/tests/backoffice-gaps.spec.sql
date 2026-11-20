-- backoffice-gaps.spec.sql — backoffice P0 / BE-01..BE-03 (SPEC backoffice-p0 §§1-8).
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/backoffice-gaps.spec.sql
-- Rerunnable: fixtures (auth.users + tenants + audit) apagadas no início e no fim.
--
-- Prova em banco real (não mock — mock não avalia trigger, policy nem grant):
--   T-G4 (BE-01/0030): plan_catalog BIGINT cents + seed 4 valores + get_plan_price;
--       slug inválido → tenant-plan-invalid; CHECK barra centavo negativo
--   T-G2 (BE-02/0028): admin_set_tenant_status + tenants_write_guard +
--       tenants_admin_audit; direto → 42501; não-admin → not-admin
--   T-G1 (BE-03/0027): profiles.subscription_status freeze; role admin preservada
--
-- Padrão 0022/0024: SET ROLE authenticated + claims JWT; ROLLBACK por cenário
-- mutante; asserts por rótulo fixo, sem ids/PII nas mensagens (SEC-G3).

\set ON_ERROR_STOP on

-- ============ Fixtures (como postgres: RLS bypass, DBA permitido) ============
-- Ordem: audit órfã de runs anteriores → tenants por documento → users →
-- audit dos fixture ids. DELETE em admin_audit como postgres passa pelo
-- tenants_audit_reject (escape DBA documentado em 0028).

DELETE FROM public.admin_audit
WHERE target_id IN (
  SELECT id FROM public.tenants
  WHERE cpf IN ('52998224725')
     OR cnpj IN ('11222333000181')
);

-- Purge de fixture passa pelo escape declarado (mesmo de tenants-adr004):
-- owner desabilita o trigger de imutabilidade, apaga em cascata, reabilita.
-- Só runbook/fixture, nunca no app.
-- Semântica transacional (2026-11-19): DISABLE→DELETE→ENABLE é UMA transação. Se
-- algum DELETE falhar, o rollback devolve o trigger habilitado — nada fica na
-- janela aberta (o `DELETE tenant_subscriptions` de 0077 não cai mais dentro dela).
BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

-- 0077: tenant criado pela RPC de convite nasce com `tenant_subscriptions`
-- (FK ON DELETE RESTRICT) — a assinatura sai antes do tenant.
DELETE FROM public.tenant_subscriptions AS s
USING public.tenants AS t
WHERE s.tenant_id = t.id
  AND (t.cpf IN ('52998224725') OR t.cnpj IN ('11222333000181'));

DELETE FROM public.tenants
WHERE cpf IN ('52998224725')
   OR cnpj IN ('11222333000181');

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

DELETE FROM public.admin_audit
WHERE target_id IN (
  '8b000000-0000-4000-8000-0000000000a1',
  '8b000000-0000-4000-8000-0000000000b1',
  '8b000000-0000-4000-8000-0000000000c1'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  '8b000000-0000-4000-8000-0000000000a1',
  '8b000000-0000-4000-8000-0000000000b1',
  '8b000000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  '8b000000-0000-4000-8000-0000000000a1',
  '8b000000-0000-4000-8000-0000000000b1',
  '8b000000-0000-4000-8000-0000000000c1'
);

INSERT INTO auth.users (id, email) VALUES
  ('8b000000-0000-4000-8000-0000000000a1', 'gaps-member-a@example.com'),
  ('8b000000-0000-4000-8000-0000000000b1', 'gaps-member-b@example.com'),
  ('8b000000-0000-4000-8000-0000000000c1', 'gaps-admin@example.com');

-- Promoção via DBA (current_user = postgres). A trilha do setup é zerada
-- para as contagens de T-G2. (0035: 'super_admin' — o 'admin' legado não existe;
-- is_admin() = alias super_only, a gate das RPCs admin_*.)
UPDATE public.profiles SET role = 'super_admin'
WHERE id = '8b000000-0000-4000-8000-0000000000c1';

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
  '8b000000-0000-4000-8000-0000000000a1',
  '8b000000-0000-4000-8000-0000000000b1',
  '8b000000-0000-4000-8000-0000000000c1'
);

-- ============ T-G4 — plan_catalog + get_plan_price (BE-01/0030) ============

DO $$
DECLARE
  v_type text;
BEGIN
  IF to_regclass('public.plan_catalog') IS NULL THEN
    RAISE EXCEPTION 'T-G4 falhou: tabela plan_catalog ausente';
  END IF;

  SELECT format_type(atttypid, NULL) INTO v_type
  FROM pg_attribute
  WHERE attrelid = 'public.plan_catalog'::regclass
    AND attname = 'price_cents';
  IF v_type <> 'bigint' THEN
    RAISE EXCEPTION 'T-G4 falhou: price_cents não é BIGINT (%)', v_type;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.plan_catalog'::regclass
      AND pg_get_constraintdef(oid) LIKE '%price_cents >= 0%'
  ) THEN
    RAISE EXCEPTION 'T-G4 falhou: CHECK price_cents >= 0 ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.plan_catalog'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'T-G4 falhou: RLS desligada em plan_catalog';
  END IF;

  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'plan_catalog'
        AND cmd = 'SELECT') < 1 THEN
    RAISE EXCEPTION 'T-G4 falhou: policy SELECT ausente em plan_catalog';
  END IF;

  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'plan_catalog'
        AND cmd <> 'SELECT') <> 0 THEN
    RAISE EXCEPTION 'T-G4 falhou: policy de escrita em plan_catalog';
  END IF;

  IF has_table_privilege('authenticated', 'public.plan_catalog', 'INSERT')
    OR has_table_privilege('authenticated', 'public.plan_catalog', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.plan_catalog', 'DELETE') THEN
    RAISE EXCEPTION 'T-G4 falhou: authenticated escreve em plan_catalog';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.plan_catalog', 'SELECT') THEN
    RAISE EXCEPTION 'T-G4 falhou: authenticated sem SELECT em plan_catalog';
  END IF;

  IF NOT has_function_privilege(
    'authenticated', 'public.get_plan_price(text)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T-G4 falhou: authenticated sem EXECUTE em get_plan_price';
  END IF;

  RAISE NOTICE 'T-G4a ok: estrutura + RLS + grants';
END $$;

-- Seed exato: free 0 / standard 1990 / pro 3990 / full 6990 (BIGINT cents).
DO $$
DECLARE
  v_free bigint;
  v_standard bigint;
  v_pro bigint;
  v_full bigint;
  v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM public.plan_catalog;
  IF v_total <> 4 THEN
    RAISE EXCEPTION 'T-G4 falhou: seed com % linhas (esperava 4)', v_total;
  END IF;

  SELECT price_cents INTO v_free FROM public.plan_catalog WHERE slug = 'free';
  SELECT price_cents INTO v_standard FROM public.plan_catalog WHERE slug = 'standard';
  SELECT price_cents INTO v_pro FROM public.plan_catalog WHERE slug = 'pro';
  SELECT price_cents INTO v_full FROM public.plan_catalog WHERE slug = 'full';

  IF v_free IS DISTINCT FROM 0
    OR v_standard IS DISTINCT FROM 1990
    OR v_pro IS DISTINCT FROM 3990
    OR v_full IS DISTINCT FROM 6990 THEN
    RAISE EXCEPTION 'T-G4 falhou: seed divergente do catálogo';
  END IF;

  IF public.get_plan_price('free') <> 0
    OR public.get_plan_price('standard') <> 1990
    OR public.get_plan_price('pro') <> 3990
    OR public.get_plan_price('full') <> 6990 THEN
    RAISE EXCEPTION 'T-G4 falhou: get_plan_price divergente do seed';
  END IF;

  RAISE NOTICE 'T-G4b ok: seed + RPC com centavo exato';
END $$;

-- Slug inválido → tenant-plan-invalid (nunca silencia para free).
DO $$
BEGIN
  BEGIN
    PERFORM public.get_plan_price('bogus');
    RAISE EXCEPTION 'T-G4c falhou: RPC aceitou slug inválido';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G4c falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-plan-invalid' THEN
        RAISE EXCEPTION 'T-G4 falhou: rótulo errado para slug inválido (%)', SQLERRM;
      END IF;
  END;
  RAISE NOTICE 'T-G4c ok: tenant-plan-invalid sem PII';
END $$;

-- CHECK barra centavo negativo mesmo via DBA (defesa em profundidade).
DO $$
BEGIN
  BEGIN
    INSERT INTO public.plan_catalog (slug, price_cents)
    VALUES ('full', -1)
    ON CONFLICT (slug) DO UPDATE SET price_cents = EXCLUDED.price_cents;
    RAISE EXCEPTION 'T-G4d falhou: CHECK aceitou price_cents negativo';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'T-G4d ok: CHECK recusa centavo negativo';
  END;
END $$;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.plan_catalog
  WHERE price_cents < 0;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T-G4 falhou: centavo negativo persistido';
  END IF;
END $$;

-- ============ Setup tenants de A (PF) via RPC 0022 + aceite 0024 ============
-- Mesmo bloco: a constraint diferida valida no COMMIT.
-- SEC-04/D1 (0053): fixture sob `service_role` (backoffice/Edge) com claims do
-- dono; o cliente recebe 42501 (T-G1a).

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '11144477735', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T-G1a falhou: authenticated provisionou tenant (0053)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G1a falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T-G1a falhou: erro diferente de 42501 no tenant (%)', SQLERRM;
  END;

  BEGIN
    PERFORM public.accept_contract(
      '00000000-0000-4000-8000-000000000000', 'test-v1'
    );
    RAISE EXCEPTION 'T-G1a falhou: authenticated gravou aceite (0053)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G1a falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T-G1a falhou: erro diferente de 42501 no aceite (%)', SQLERRM;
  END;
END $$;
ROLLBACK;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000a1","role":"service_role","aal":"aal2"}', false);

DO $$
DECLARE
  v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner(
    'pf', '52998224725', 'Gaps Tenant A',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM public.accept_contract(v_id, 'test-v1');
END $$;

RESET ROLE;

DROP TABLE IF EXISTS gaps_tenant_a;
CREATE TEMP TABLE gaps_tenant_a (id uuid);
INSERT INTO gaps_tenant_a SELECT id FROM public.tenants WHERE cpf = '52998224725';
GRANT SELECT ON gaps_tenant_a TO authenticated, anon;

-- ============ T-G2 — admin_set_tenant_status + guards + audit (BE-02/0028) ============

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'admin_set_tenant_status'
  ) THEN
    RAISE EXCEPTION 'T-G2 falhou: RPC admin_set_tenant_status ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tenants'::regclass
      AND tgname = 'tenants_write_guard'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T-G2 falhou: trigger tenants_write_guard ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.tenants'::regclass
      AND tgname = 'tenants_admin_audit'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T-G2 falhou: trigger tenants_admin_audit ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.admin_audit'::regclass
      AND pg_get_constraintdef(oid) LIKE '%tenant_status_changed%'
  ) THEN
    RAISE EXCEPTION 'T-G2 falhou: admin_audit sem action tenant_status_changed';
  END IF;

  IF to_regclass('public.admin_audit') IS NULL THEN
    RAISE EXCEPTION 'T-G2 falhou: tabela admin_audit ausente';
  END IF;

  IF has_function_privilege('anon', 'public.admin_set_tenant_status(uuid,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-G2 falhou: anon executa a RPC de escrita admin';
  END IF;

  IF has_function_privilege('authenticated', 'public.admin_set_tenant_status(uuid,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-G2 falhou: authenticated ainda executa a RPC admin (deprecada em 0058)';
  END IF;

  IF has_function_privilege('service_role', 'public.admin_set_tenant_status(uuid,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-G2 falhou: service_role ainda executa a RPC admin (deprecada em 0058)';
  END IF;

  RAISE NOTICE 'T-G2a ok: RPC + guards + audit + grants (RPC admin deprecada em 0058)';
END $$;

-- Sucesso: admin muda trial→past_due com motivo; status muda + 1 linha audit.
-- 0058 deprecou `admin_set_tenant_status` (sem EXECUTE para cliente); a escrita
-- passa pela verdade de billing + espelho. Aqui o caminho equivalente de
-- guarda/trilha (`tenants_write_guard` + `tenants_admin_audit`) é exercido como
-- DBA com as mesmas GUCs que a RPC setava — o gate is_admin() é provado em T-G2c.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);
RESET ROLE;

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM pg_temp.gaps_tenant_a;
  PERFORM set_config('app.tenant_reason', 'inadimplencia bancaria', true);
  UPDATE public.tenants
  SET subscription_status = 'past_due', updated_at = pg_catalog.now()
  WHERE id = v_tenant;
END $$;

DO $$
DECLARE
  v_status text;
  v_count int;
  r public.admin_audit;
BEGIN
  SELECT subscription_status INTO v_status
  FROM public.tenants WHERE cpf = '52998224725';
  IF v_status <> 'past_due' THEN
    RAISE EXCEPTION 'T-G2 falhou: RPC admin não mudou o status';
  END IF;

  SELECT count(*) INTO v_count FROM public.admin_audit AS a
  JOIN pg_temp.gaps_tenant_a AS g ON g.id = a.target_id
  WHERE a.action = 'tenant_status_changed';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T-G2 falhou: esperava 1 linha tenant_status_changed (achou %)', v_count;
  END IF;

  SELECT * INTO r FROM public.admin_audit AS a
  JOIN pg_temp.gaps_tenant_a AS g ON g.id = a.target_id
  WHERE a.action = 'tenant_status_changed';
  IF r.from_value <> 'trial' OR r.to_value <> 'past_due' THEN
    RAISE EXCEPTION 'T-G2 falhou: transição auditada errada';
  END IF;
  IF r.actor_id IS DISTINCT FROM '8b000000-0000-4000-8000-0000000000c1'::uuid THEN
    RAISE EXCEPTION 'T-G2 falhou: actor_id não é o admin executor';
  END IF;
  IF r.reason IS DISTINCT FROM 'inadimplencia bancaria' THEN
    RAISE EXCEPTION 'T-G2 falhou: motivo não registrado na trilha';
  END IF;

  RAISE NOTICE 'T-G2b ok: status muda + trilha com ator e motivo';
END $$;

-- Não-admin via RPC → not-admin, sem escrita e sem trilha nova.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM pg_temp.gaps_tenant_a;
  BEGIN
    PERFORM public.admin_set_tenant_status(v_tenant, 'active', NULL, 'tentativa comum');
    RAISE EXCEPTION 'T-G2c falhou: RPC aceitou não-admin';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL; -- 0058: sem EXECUTE para authenticated (42501 antes do gate)
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G2c falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T-G2 falhou: erro diferente de 42501 (%)', SQLERRM;
  END;
END $$;

ROLLBACK;

DO $$
DECLARE
  v_status text;
  v_count int;
BEGIN
  SELECT subscription_status INTO v_status
  FROM public.tenants WHERE cpf = '52998224725';
  IF v_status <> 'past_due' THEN
    RAISE EXCEPTION 'T-G2 falhou: chamada não-admin alterou o status';
  END IF;

  SELECT count(*) INTO v_count FROM public.admin_audit AS a
  JOIN pg_temp.gaps_tenant_a AS g ON g.id = a.target_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T-G2 falhou: chamada não-admin gerou trilha';
  END IF;

  RAISE NOTICE 'T-G2c ok: not-admin sem escrita e sem trilha';
END $$;

-- Escrita direta por authenticated → 42501 (grant, antes do trigger).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  UPDATE public.tenants SET subscription_status = 'active'
  WHERE cpf = '52998224725';
  RAISE EXCEPTION 'T-G2d falhou: authenticated atualizou tenants direto';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-G2d ok: UPDATE direto negado (42501)';
END $$;

DO $$
BEGIN
  DELETE FROM public.tenants WHERE cpf = '52998224725';
  RAISE EXCEPTION 'T-G2e falhou: authenticated apagou tenant direto';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-G2e ok: DELETE direto negado (42501)';
END $$;

ROLLBACK;

-- RPC deprecada (0058): authenticated nao executa, entao o dominio de status/
-- plano/motivo/tenant nao e alcancavel por cliente. Os rotulos de dominio
-- migraram para admin_override_subscription (0060, P6). Aqui prova-se o 42501.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM pg_temp.gaps_tenant_a;

  BEGIN
    PERFORM public.admin_set_tenant_status(v_tenant, 'suspenso', NULL, 'motivo valido');
    RAISE EXCEPTION 'T-G2f falhou: RPC deprecada executou status inválido';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'T-G2 falhou: erro diferente de 42501 (%)', SQLERRM;
  END;

  BEGIN
    PERFORM public.admin_set_tenant_status(
      '00000000-0000-4000-8000-000000000000', 'active', NULL, 'motivo valido');
    RAISE EXCEPTION 'T-G2f falhou: RPC deprecada executou tenant inexistente';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'T-G2 falhou: erro diferente de 42501 (%)', SQLERRM;
  END;

  RAISE NOTICE 'T-G2f ok: RPC deprecada → 42501 (dominio migrou para 0060)';
END $$;

ROLLBACK;

-- anon via RPC → 42501 (sem EXECUTE para anon).
BEGIN;
SET LOCAL ROLE anon;

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM pg_temp.gaps_tenant_a;
  BEGIN
    PERFORM public.admin_set_tenant_status(v_tenant, 'active', NULL, 'motivo valido');
    RAISE EXCEPTION 'T-G2g falhou: anon executou RPC admin';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G2g ok: anon negado (42501)';
  END;
END $$;

ROLLBACK;

-- Trilha append-only: UPDATE/DELETE em admin_audit falham.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  UPDATE public.admin_audit SET reason = 'adulterado'
  WHERE target_id IN (SELECT id FROM pg_temp.gaps_tenant_a);
  RAISE EXCEPTION 'T-G2h falhou: authenticated atualizou audit';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-G2h ok: UPDATE em audit negado (42501)';
END $$;

ROLLBACK;

SET ROLE service_role;

-- service_role cai no grant (42501, 0020) antes do trigger — fail-closed.
-- O trigger tenants_audit_reject é defesa em profundidade (ex.: grants futuros).
DO $$
BEGIN
  BEGIN
    UPDATE public.admin_audit SET reason = 'adulterado'
    WHERE target_id IN (SELECT id FROM pg_temp.gaps_tenant_a);
    RAISE EXCEPTION 'T-G2i falhou: service_role atualizou audit';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G2i ok: UPDATE por service_role negado (42501)';
  END;

  BEGIN
    DELETE FROM public.admin_audit
    WHERE target_id IN (SELECT id FROM pg_temp.gaps_tenant_a);
    RAISE EXCEPTION 'T-G2i falhou: service_role apagou audit';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G2i ok: DELETE por service_role negado (42501)';
  END;
END $$;

RESET ROLE;

-- Defesa em profundidade: guard existe, carrega o rótulo e não é executável
-- por clients (inalcançável via SQL enquanto os grants 0020 valem — o 42501
-- acima é a barreira ativa; o trigger segura grants futuros).
DO $$
DECLARE
  v_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.admin_audit'::regclass
      AND tgname = 'tenants_audit_reject'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T-G2 falhou: trigger tenants_audit_reject ausente';
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'tenants_audit_reject' ORDER BY oid LIMIT 1;
  IF v_src IS NULL OR position('audit-immutable' IN v_src) = 0 THEN
    RAISE EXCEPTION 'T-G2 falhou: guard sem rótulo audit-immutable';
  END IF;

  IF has_function_privilege('authenticated', 'public.tenants_audit_reject()', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.tenants_audit_reject()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-G2 falhou: guard executável por client';
  END IF;

  RAISE NOTICE 'T-G2j ok: tenants_audit_reject estrutural (trigger + rótulo + sem EXECUTE)';
END $$;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_audit AS a
  JOIN pg_temp.gaps_tenant_a AS g ON g.id = a.target_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T-G2 falhou: tentativa de mutação alterou a trilha';
  END IF;
END $$;

-- ============ T-G1 — profiles.subscription_status freeze (BE-03/0027) ============

DO $$
DECLARE
  v_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.profiles'::regclass
      AND tgname = 'deny_role_change'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T-G1 falhou: trigger deny_role_change ausente';
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'deny_role_change' ORDER BY oid LIMIT 1;
  IF v_src IS NULL
    OR position('subscription_status' IN v_src) = 0
    OR position('profiles-status-readonly-use-tenant-rpc' IN v_src) = 0 THEN
    RAISE EXCEPTION 'T-G1 falhou: trigger sem freeze de subscription_status';
  END IF;
  IF position('is_admin' IN v_src) = 0 THEN
    RAISE EXCEPTION 'T-G1 falhou: trigger sem exceção is_admin (role travada)';
  END IF;

  RAISE NOTICE 'T-G1a ok: trigger com freeze + role preservada';
END $$;

-- Dono atualiza o próprio status → rótulo fixo (fonte única é tenants).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  UPDATE public.profiles SET subscription_status = 'active'
  WHERE id = '8b000000-0000-4000-8000-0000000000a1';
  RAISE EXCEPTION 'T-G1b falhou: status via client permitido';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-G1b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'profiles-status-readonly-use-tenant-rpc' THEN
      RAISE EXCEPTION 'T-G1 falhou: rótulo errado para freeze (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T-G1b ok: freeze com rótulo fixo';
END $$;

ROLLBACK;

-- Super_admin via JWT também congela (sem sync dual por porta lateral).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  UPDATE public.profiles SET subscription_status = 'active'
  WHERE id = '8b000000-0000-4000-8000-0000000000b1';
  RAISE EXCEPTION 'T-G1c falhou: super_admin alterou status via client';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-G1c falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'profiles-status-readonly-use-tenant-rpc' THEN
      RAISE EXCEPTION 'T-G1 falhou: rótulo errado para super_admin (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T-G1c ok: super_admin usa RPC de tenant, não profiles';
END $$;

ROLLBACK;

-- Role segue mutável via super_admin + audit grant/revoke_super_admin (0035;
-- JWT direto user→super_admin é negado — a via viva é a RPC auditada).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

SELECT public.admin_grant_super_admin('8b000000-0000-4000-8000-0000000000b1');
SELECT public.admin_revoke_super_admin('8b000000-0000-4000-8000-0000000000b1');

RESET ROLE;

DO $$
DECLARE
  v_role text;
  v_grant int;
  v_revoke int;
BEGIN
  SELECT role INTO v_role FROM public.profiles
  WHERE id = '8b000000-0000-4000-8000-0000000000b1';
  IF v_role <> 'user' THEN
    RAISE EXCEPTION 'T-G1 falhou: revoke não voltou o alvo a user (%)', v_role;
  END IF;

  SELECT count(*) INTO v_grant FROM public.admin_audit
  WHERE target_id = '8b000000-0000-4000-8000-0000000000b1'
    AND action = 'grant_super_admin';
  IF v_grant <> 1 THEN
    RAISE EXCEPTION 'T-G1 falhou: grant_super_admin sem trilha após o freeze';
  END IF;

  SELECT count(*) INTO v_revoke FROM public.admin_audit
  WHERE target_id = '8b000000-0000-4000-8000-0000000000b1'
    AND action = 'revoke_super_admin';
  IF v_revoke <> 1 THEN
    RAISE EXCEPTION 'T-G1 falhou: revoke_super_admin sem trilha após o freeze';
  END IF;

  RAISE NOTICE 'T-G1d ok: role via super_admin + audit intactos';
END $$;

-- DBA mantém escape (runbook) e a trilha change_plan continua gravando.
UPDATE public.profiles SET subscription_status = 'active'
WHERE id = '8b000000-0000-4000-8000-0000000000a1';

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_audit
  WHERE target_id = '8b000000-0000-4000-8000-0000000000a1'
    AND action = 'change_plan';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T-G1 falhou: escape DBA sem trilha change_plan';
  END IF;

  RAISE NOTICE 'T-G1e ok: escape DBA auditado';
END $$;

-- Signup intacto: handle_new_user cria user/trial (INSERT, não UPDATE).
DELETE FROM public.internal_operators WHERE user_id = '8b000000-0000-4000-8000-0000000000d1';
DELETE FROM auth.users WHERE id = '8b000000-0000-4000-8000-0000000000d1';

INSERT INTO auth.users (id, email) VALUES
  ('8b000000-0000-4000-8000-0000000000d1', 'gaps-signup@example.com');

DO $$
DECLARE
  v_row public.profiles;
BEGIN
  SELECT * INTO v_row FROM public.profiles
  WHERE id = '8b000000-0000-4000-8000-0000000000d1';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T-G1 falhou: signup não criou profile';
  END IF;
  IF v_row.role <> 'user' OR v_row.subscription_status <> 'trial' THEN
    RAISE EXCEPTION 'T-G1 falhou: signup fora de user/trial';
  END IF;

  RAISE NOTICE 'T-G1f ok: signup user/trial intacto';
END $$;

DELETE FROM public.internal_operators WHERE user_id = '8b000000-0000-4000-8000-0000000000d1';
DELETE FROM auth.users WHERE id = '8b000000-0000-4000-8000-0000000000d1';

-- ============ Fixtures T-G3/G5/G6 (rerun-safe: limpa antes de inserir) ============
-- Docs novos (DV válido, fora dos fixtures T-G1/T-G2):
--   Alfa PF 11144477735 · Meio PF 12345678909 · Zebra PJ 11444777000161.

DELETE FROM public.admin_audit
WHERE target_id IN (
  SELECT id FROM public.tenants
  WHERE cpf IN ('11144477735', '12345678909')
     OR cnpj IN ('11444777000161')
);

BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

-- 0077: assinatura da RPC de convite sai antes do tenant (FK RESTRICT).
DELETE FROM public.tenant_subscriptions AS s
USING public.tenants AS t
WHERE s.tenant_id = t.id
  AND (t.cpf IN ('11144477735', '12345678909') OR t.cnpj IN ('11444777000161'));

DELETE FROM public.tenants
WHERE cpf IN ('11144477735', '12345678909')
   OR cnpj IN ('11444777000161');

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

DELETE FROM public.admin_audit
WHERE target_id IN (
  '8b000000-0000-4000-8000-0000000000d2',
  '8b000000-0000-4000-8000-0000000000e2',
  '8b000000-0000-4000-8000-0000000000f2'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  '8b000000-0000-4000-8000-0000000000d2',
  '8b000000-0000-4000-8000-0000000000e2',
  '8b000000-0000-4000-8000-0000000000f2'
);

DELETE FROM auth.users
WHERE id IN (
  '8b000000-0000-4000-8000-0000000000d2',
  '8b000000-0000-4000-8000-0000000000e2',
  '8b000000-0000-4000-8000-0000000000f2'
);

INSERT INTO auth.users (id, email) VALUES
  ('8b000000-0000-4000-8000-0000000000d2', 'gaps-invited-alfa@example.com'),
  ('8b000000-0000-4000-8000-0000000000e2', 'gaps-invited-meio@example.com'),
  ('8b000000-0000-4000-8000-0000000000f2', 'gaps-invited-zebra@example.com');

-- ============ T-G3 — create_tenant_for_invited_user (BE-04/0029) ============
-- Contrato atualizado por 0077 (ADR-006): assinatura no nascimento, reuso por
-- (owner, documento), `invite-pending` para convidado sem identidade.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'create_tenant_for_invited_user'
  ) THEN
    RAISE EXCEPTION 'T-G3 falhou: RPC create_tenant_for_invited_user ausente';
  END IF;

  IF has_function_privilege('anon',
    'public.create_tenant_for_invited_user(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE') THEN
    RAISE EXCEPTION 'T-G3 falhou: anon executa a RPC de convite';
  END IF;

  IF NOT has_function_privilege('authenticated',
    'public.create_tenant_for_invited_user(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE') THEN
    RAISE EXCEPTION 'T-G3 falhou: authenticated sem EXECUTE na RPC de convite';
  END IF;

  RAISE NOTICE 'T-G3a ok: RPC + grants';
END $$;

-- Sucesso: admin c1 cria para o convidado d2 — dono=convidado, mesma tx.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_id uuid;
BEGIN
  v_id := public.create_tenant_for_invited_user(
    '8b000000-0000-4000-8000-0000000000d2',
    'pf', '11144477735', 'Alfa Tenant SA',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM public.create_tenant_for_invited_user(
    '8b000000-0000-4000-8000-0000000000e2',
    'pf', '12345678909', 'Meio Tenant SA',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM public.create_tenant_for_invited_user(
    '8b000000-0000-4000-8000-0000000000f2',
    'pj', '11444777000161', 'Zebra Tenant SA',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
END $$;

RESET ROLE;

DROP TABLE IF EXISTS gaps_tenants_new;
CREATE TEMP TABLE gaps_tenants_new (doc text PRIMARY KEY, id uuid);
INSERT INTO gaps_tenants_new
SELECT cpf, id FROM public.tenants WHERE cpf IN ('11144477735', '12345678909')
UNION ALL
SELECT cnpj, id FROM public.tenants WHERE cnpj IN ('11444777000161');
GRANT SELECT ON gaps_tenants_new TO authenticated, anon;

DO $$
DECLARE
  v_count int;
  r public.tenants;
BEGIN
  SELECT count(*) INTO v_count FROM pg_temp.gaps_tenants_new;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T-G3 falhou: esperava 3 tenants convidados (achou %)', v_count;
  END IF;

  SELECT * INTO r FROM public.tenants WHERE cpf = '11144477735';
  IF r.owner_user_id IS DISTINCT FROM '8b000000-0000-4000-8000-0000000000d2'::uuid THEN
    RAISE EXCEPTION 'T-G3 falhou: dono não é o convidado';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tenant_members AS m
    JOIN pg_temp.gaps_tenants_new AS g ON g.id = m.tenant_id
    WHERE m.user_id = '8b000000-0000-4000-8000-0000000000c1'
  ) THEN
    RAISE EXCEPTION 'T-G3 falhou: operador virou membro do tenant convidado';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tenant_members AS m
  JOIN pg_temp.gaps_tenants_new AS g ON g.id = m.tenant_id
  WHERE m.role = 'owner';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T-G3 falhou: esperava 3 memberships owner (achou %) (convidado sem dono)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.contract_acceptances AS ca
  JOIN pg_temp.gaps_tenants_new AS g ON g.id = ca.tenant_id;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'T-G3 falhou: aceite mesma-tx ausente (achou %)', v_count;
  END IF;

  RAISE NOTICE 'T-G3b ok: dono=convidado + membership + aceite mesma tx';
END $$;

-- Convidado enxerga o próprio tenant (RLS por membership, sem admin).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000d2', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000d2","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.tenants WHERE cpf = '11144477735';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'T-G3 falhou: convidado não enxerga o próprio tenant';
  END IF;

  SELECT count(*) INTO v_count FROM public.tenants WHERE cpf = '52998224725';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T-G3 falhou: convidado enxerga tenant alheio';
  END IF;

  RAISE NOTICE 'T-G3b2 ok: convidado vê o próprio, não o alheio';
END $$;

RESET ROLE;

-- Duplicata: mesmo CPF ativo → tenant-document-duplicate, sem resíduo.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_before int;
  v_after int;
BEGIN
  SELECT count(*) INTO v_before FROM public.tenants WHERE cpf = '11144477735';

  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      '8b000000-0000-4000-8000-0000000000e2',
      'pf', '11144477735', 'Alfa Duplicata SA',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T-G3c falhou: RPC aceitou documento duplicado';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G3c falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-document-duplicate' THEN
        RAISE EXCEPTION 'T-G3 falhou: rótulo errado para duplicata (%)', SQLERRM;
      END IF;
  END;

  SELECT count(*) INTO v_after FROM public.tenants WHERE cpf = '11144477735';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'T-G3 falhou: duplicata deixou resíduo';
  END IF;

  RAISE NOTICE 'T-G3c ok: tenant-document-duplicate sem resíduo';
END $$;

ROLLBACK;

-- Dono sem identidade materializada ⇒ invite-pending; dono = chamador ⇒
-- tenant-owner-invalid (0077/ADR-006 REQ-03).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      '00000000-0000-4000-8000-000000000000',
      'pf', '11144477735', 'Fantasma SA',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T-G3d falhou: RPC aceitou dono inexistente';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G3d falhou%' THEN RAISE; END IF;
      -- 0077 (ADR-006/REQ-03): dono sem identidade materializada não é "dono
      -- inválido", é convite pendente. O rótulo herdado da 0029 mudou de
      -- propósito: `tenant-owner-invalid` ficou reservado ao autoprovisionamento.
      IF SQLERRM <> 'invite-pending' THEN
        RAISE EXCEPTION 'T-G3 falhou: rótulo errado para dono inexistente (%)', SQLERRM;
      END IF;
  END;

  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      '8b000000-0000-4000-8000-0000000000c1',
      'pf', '11144477735', 'Proprio SA',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T-G3d falhou: RPC aceitou dono=chamador';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G3d falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-owner-invalid' THEN
        RAISE EXCEPTION 'T-G3 falhou: rótulo errado para dono=chamador (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T-G3d ok: invite-pending (sem identidade) + tenant-owner-invalid (autoprovisionamento), sem PII';
END $$;

ROLLBACK;

-- Não-admin via RPC → not-admin; anon → 42501.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      '8b000000-0000-4000-8000-0000000000e2',
      'pf', '12345678909', 'Invasor SA',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T-G3e falhou: RPC aceitou não-admin';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G3e falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-admin' THEN
        RAISE EXCEPTION 'T-G3 falhou: rótulo errado para não-admin (%)', SQLERRM;
      END IF;
  END;
  RAISE NOTICE 'T-G3e ok: not-admin sem escrita';
END $$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE anon;

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_for_invited_user(
      '8b000000-0000-4000-8000-0000000000e2',
      'pf', '12345678909', 'Anon SA',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T-G3f falhou: anon executou RPC de convite';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G3f ok: anon negado (42501)';
  END;
END $$;

ROLLBACK;

-- ============ T-G5 — admin_list/count_tenants (BE-05/0031) ============

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('admin_list_tenants', 'admin_count_tenants')
    GROUP BY proname HAVING count(*) >= 1
  ) THEN
    RAISE EXCEPTION 'T-G5 falhou: RPCs admin_list/count_tenants ausentes';
  END IF;

  IF has_function_privilege('anon',
    'public.admin_list_tenants(text,text,text,text,int,int)', 'EXECUTE')
    OR has_function_privilege('anon',
    'public.admin_count_tenants(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-G5 falhou: anon executa RPC de lista admin';
  END IF;

  IF NOT has_function_privilege('authenticated',
    'public.admin_list_tenants(text,text,text,text,int,int)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated',
    'public.admin_count_tenants(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-G5 falhou: authenticated sem EXECUTE na lista admin';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'tenants'
      AND indexname = 'tenants_list_created_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'tenants'
      AND indexname = 'tenants_list_status_name_idx'
  ) THEN
    RAISE EXCEPTION 'T-G5 falhou: índices de lista ausentes';
  END IF;

  RAISE NOTICE 'T-G5a ok: RPCs + grants + índices';
END $$;

-- Páginas sem sobreposição, ordem exata (name asc + id desempate).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  r1_1 text; r1_2 text; r2_1 text;
  v_total bigint;
BEGIN
  SELECT string_agg(t.razao_social, '|' ORDER BY t.razao_social) INTO r1_1
  FROM public.admin_list_tenants('Tenant SA', NULL, 'name', 'asc', 2, 0) AS t;
  IF r1_1 <> 'Alfa Tenant SA|Meio Tenant SA' THEN
    RAISE EXCEPTION 'T-G5 falhou: página 1 fora de ordem (%)', r1_1;
  END IF;

  SELECT t.razao_social INTO r2_1
  FROM public.admin_list_tenants('Tenant SA', NULL, 'name', 'asc', 2, 2) AS t
  ORDER BY t.razao_social LIMIT 1;
  IF r2_1 <> 'Zebra Tenant SA' THEN
    RAISE EXCEPTION 'T-G5 falhou: página 2 fora de ordem (%)', r2_1;
  END IF;

  -- 0077/REQ-17: a RPC de convite cria com plano `free` ⇒ assinatura `active`
  -- (o espelho de 0058 leva `tenants.subscription_status` junto). Filtro
  -- `active`, não mais `trial`.
  SELECT count(*) INTO v_total
  FROM public.admin_list_tenants('Tenant SA', 'active', 'created_at', 'desc', 100, 0) AS t;
  IF v_total <> 3 THEN
    RAISE EXCEPTION 'T-G5 falhou: filtro active devolveu % (esperava 3)', v_total;
  END IF;

  v_total := public.admin_count_tenants('Tenant SA', 'active');
  IF v_total < 3 THEN
    RAISE EXCEPTION 'T-G5 falhou: count active devolveu % (esperava >=3)', v_total;
  END IF;

  RAISE NOTICE 'T-G5b ok: paginação determinística + count';
END $$;

RESET ROLE;

-- Domínio: sort/dir/status inválidos → rótulo fixo; cap sem erro.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  v_n int;
BEGIN
  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'bogus', 'asc', 2, 0) AS t;
    RAISE EXCEPTION 'T-G5c falhou: RPC aceitou sort inválido';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G5c falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-sort-invalid' THEN
        RAISE EXCEPTION 'T-G5 falhou: rótulo errado para sort (%)', SQLERRM;
      END IF;
  END;

  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'name', 'lateral', 2, 0) AS t;
    RAISE EXCEPTION 'T-G5c falhou: RPC aceitou direção inválida';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G5c falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-sort-invalid' THEN
        RAISE EXCEPTION 'T-G5 falhou: rótulo errado para direção (%)', SQLERRM;
      END IF;
  END;

  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, 'suspenso', 'name', 'asc', 2, 0) AS t;
    RAISE EXCEPTION 'T-G5c falhou: RPC aceitou status inválido';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G5c falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-status-invalid' THEN
        RAISE EXCEPTION 'T-G5 falhou: rótulo errado para status (%)', SQLERRM;
      END IF;
  END;

  -- Cap 1..100: limite absurdo não estoura, limite zero não zera.
  SELECT count(*) INTO v_n
  FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 500, 0) AS t;
  IF v_n > 100 THEN
    RAISE EXCEPTION 'T-G5 falhou: cap 100 furado (%)', v_n;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 0, 0) AS t;
  IF v_n < 1 THEN
    RAISE EXCEPTION 'T-G5 falhou: limite zero zerou a lista';
  END IF;

  RAISE NOTICE 'T-G5c ok: domínio + cap 1..100';
END $$;

ROLLBACK;

-- Não-admin via RPC → not-admin; anon → 42501.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'name', 'asc', 2, 0) AS t;
    RAISE EXCEPTION 'T-G5d falhou: lista aceitou não-admin';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G5d falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-admin' THEN
        RAISE EXCEPTION 'T-G5 falhou: rótulo errado para não-admin (%)', SQLERRM;
      END IF;
  END;

  BEGIN
    PERFORM public.admin_count_tenants(NULL, NULL);
    RAISE EXCEPTION 'T-G5d falhou: count aceitou não-admin';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G5d falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-admin' THEN
        RAISE EXCEPTION 'T-G5 falhou: rótulo errado para não-admin no count (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T-G5d ok: not-admin sem leak';
END $$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE anon;

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'name', 'asc', 2, 0) AS t;
    RAISE EXCEPTION 'T-G5e falhou: anon listou tenants';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G5e ok: anon negado (42501)';
  END;
END $$;

ROLLBACK;

-- ============ T-G6 — list_admin_audit_page + reject_mutation (BE-06/0032) ============

DO $$
BEGIN
  IF to_regclass('public.admin_audit') IS NULL THEN
    RAISE EXCEPTION 'T-G6 falhou: tabela admin_audit ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_audit'
      AND column_name = 'tenant_id'
  ) THEN
    RAISE EXCEPTION 'T-G6 falhou: coluna admin_audit.tenant_id ausente';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_schema = 'public' AND tc.table_name = 'admin_audit'
      AND kcu.column_name = 'tenant_id'
      AND tc.constraint_type = 'FOREIGN KEY'
  ) THEN
    RAISE EXCEPTION 'T-G6 falhou: tenant_id com FK (prova seria destruída)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'list_admin_audit_page'
  ) THEN
    RAISE EXCEPTION 'T-G6 falhou: RPC list_admin_audit_page ausente';
  END IF;

  -- Sem PII na forma da RPC: nenhum OUT cpf/cnpj/email/documento/telefone.
  IF EXISTS (
    SELECT 1 FROM information_schema.parameters
    WHERE specific_schema = 'public'
      AND specific_name LIKE 'list_admin_audit_page%'
      AND parameter_name IN (
        'cpf', 'cnpj', 'email', 'document', 'documento', 'phone', 'telefone'
      )
  ) THEN
    RAISE EXCEPTION 'T-G6 falhou: RPC de audit expõe PII na forma';
  END IF;

  IF has_function_privilege('anon',
    'public.list_admin_audit_page(uuid,text,int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-G6 falhou: anon executa a RPC de audit';
  END IF;

  IF NOT has_function_privilege('authenticated',
    'public.list_admin_audit_page(uuid,text,int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T-G6 falhou: authenticated sem EXECUTE na RPC de audit';
  END IF;

  IF has_table_privilege('authenticated', 'public.admin_audit', 'SELECT')
    OR has_table_privilege('authenticated', 'public.admin_audit', 'INSERT')
    OR has_table_privilege('authenticated', 'public.admin_audit', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.admin_audit', 'DELETE') THEN
    RAISE EXCEPTION 'T-G6 falhou: authenticated escreve/lê admin_audit direto';
  END IF;

  RAISE NOTICE 'T-G6a ok: estrutura + sem PII + grants';
END $$;

-- Sucesso: admin muda Alfa active→past_due e lê a trilha via RPC.
-- 0058 deprecou `admin_set_tenant_status`; a trilha é produzida pelo trigger
-- `tenants_admin_audit` (mesma GUC de motivo). O gate is_admin() é de 0060.
-- 0077: tenant de convite com plano `free` JÁ nasce `active` (espelho 0058),
-- logo a transição exercitada aqui é `active → past_due` (o UPDATE precisa
-- mudar a coluna para gerar trilha).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);
RESET ROLE;

DO $$
DECLARE
  v_alfa uuid;
BEGIN
  SELECT id INTO v_alfa FROM pg_temp.gaps_tenants_new WHERE doc = '11144477735';
  PERFORM set_config('app.tenant_reason', 'expansao comercial', true);
  UPDATE public.tenants
  SET subscription_status = 'past_due', updated_at = pg_catalog.now()
  WHERE id = v_alfa;
END $$;

DO $$
DECLARE
  v_alfa uuid;
  v_n int;
  r record;
BEGIN
  SELECT id INTO v_alfa FROM pg_temp.gaps_tenants_new WHERE doc = '11144477735';

  SELECT count(*) INTO v_n
  FROM public.list_admin_audit_page(v_alfa, 'tenant_status_changed', 20, 0) AS a;
  IF v_n < 1 THEN
    RAISE EXCEPTION 'T-G6 falhou: trilha da mudança ausente na RPC';
  END IF;

  SELECT * INTO r
  FROM public.list_admin_audit_page(v_alfa, 'tenant_status_changed', 20, 0) AS a
  ORDER BY a.at DESC, a.id ASC LIMIT 1;
  IF r.from_value <> 'active' OR r.to_value <> 'past_due' THEN
    RAISE EXCEPTION 'T-G6 falhou: transição auditada errada';
  END IF;
  IF r.tenant_id IS DISTINCT FROM v_alfa THEN
    RAISE EXCEPTION 'T-G6 falhou: tenant_id da trilha não é o tenant';
  END IF;
  IF r.actor_id IS DISTINCT FROM '8b000000-0000-4000-8000-0000000000c1'::uuid THEN
    RAISE EXCEPTION 'T-G6 falhou: actor_id não é o admin executor';
  END IF;
  IF r.reason IS DISTINCT FROM 'expansao comercial' THEN
    RAISE EXCEPTION 'T-G6 falhou: motivo não registrado na trilha';
  END IF;

  -- Escopo: página do Meio não vaza linha da Alfa.
  SELECT count(*) INTO v_n
  FROM public.list_admin_audit_page(
    (SELECT id FROM pg_temp.gaps_tenants_new WHERE doc = '12345678909'),
    NULL, 20, 0) AS a
  WHERE a.tenant_id = v_alfa OR a.target_id = v_alfa;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-G6 falhou: escopo por tenant vazou linha alheia';
  END IF;

  RAISE NOTICE 'T-G6b ok: trilha legível + escopo sem PII';
END $$;

-- Não-admin via RPC → not-admin; anon → 42501; ação inválida → rótulo fixo.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.list_admin_audit_page(NULL, NULL, 20, 0) AS a;
    RAISE EXCEPTION 'T-G6c falhou: audit aceitou não-admin';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G6c falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-admin' THEN
        RAISE EXCEPTION 'T-G6 falhou: rótulo errado para não-admin (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T-G6c ok: not-admin sem leak';
END $$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.list_admin_audit_page(NULL, 'wiretap', 20, 0) AS a;
    RAISE EXCEPTION 'T-G6d falhou: audit aceitou ação inválida';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-G6d falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-audit-action-invalid' THEN
        RAISE EXCEPTION 'T-G6 falhou: rótulo errado para ação (%)', SQLERRM;
      END IF;
  END;

  -- Direto na tabela por authenticated → 42501 (grant, antes de RLS).
  BEGIN
    PERFORM * FROM public.admin_audit LIMIT 1;
    RAISE EXCEPTION 'T-G6d falhou: authenticated leu admin_audit direto';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G6d2 ok: SELECT direto negado (42501)';
  END;

  BEGIN
    UPDATE public.admin_audit SET reason = 'adulterado'
    WHERE tenant_id IN (SELECT id FROM pg_temp.gaps_tenants_new);
    RAISE EXCEPTION 'T-G6d falhou: authenticated atualizou audit';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G6d3 ok: UPDATE em audit negado (42501)';
  END;

  RAISE NOTICE 'T-G6d ok: ação inválida + tabela fechada';
END $$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE anon;

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.list_admin_audit_page(NULL, NULL, 20, 0) AS a;
    RAISE EXCEPTION 'T-G6e falhou: anon leu audit via RPC';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G6e ok: anon negado (42501)';
  END;
END $$;

ROLLBACK;

-- Defesa em profundidade: reject existe e service_role cai no grant (42501).
SET ROLE service_role;

DO $$
BEGIN
  BEGIN
    DELETE FROM public.admin_audit
    WHERE tenant_id IN (SELECT id FROM pg_temp.gaps_tenants_new);
    RAISE EXCEPTION 'T-G6f falhou: service_role apagou audit';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'T-G6f ok: DELETE por service_role negado (42501)';
  END;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_audit AS a
  JOIN pg_temp.gaps_tenants_new AS g ON g.id = a.target_id
  WHERE a.action = 'tenant_status_changed';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'T-G6 falhou: tentativa de mutação apagou a trilha';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.admin_audit'::regclass
      AND tgname = 'tenants_audit_reject'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'T-G6 falhou: trigger tenants_audit_reject ausente';
  END IF;

  RAISE NOTICE 'T-G6f2 ok: trilha intacta + reject presente';
END $$;

-- ============ T-G7 — ACL matrix (BE-07: escrita direta sempre negada) ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.tenants (kind, owner_user_id, cpf, razao_social)
    VALUES ('pf', '8b000000-0000-4000-8000-0000000000c1', '11144477735', 'ACL SA');
    RAISE EXCEPTION 'T-G7 falhou: INSERT direto em tenants';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-G7a ok: INSERT tenants negado (42501)';
  END;

  BEGIN
    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES ('00000000-0000-4000-8000-000000000000',
      '8b000000-0000-4000-8000-0000000000c1', 'member');
    RAISE EXCEPTION 'T-G7 falhou: INSERT direto em tenant_members';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-G7b ok: INSERT tenant_members negado (42501)';
  END;

  BEGIN
    DELETE FROM public.contract_acceptances
    WHERE tenant_id IN (SELECT id FROM pg_temp.gaps_tenants_new);
    RAISE EXCEPTION 'T-G7 falhou: DELETE direto em contract_acceptances';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-G7c ok: DELETE acceptances negado (42501)';
  END;

  BEGIN
    INSERT INTO public.plan_catalog (slug, price_cents) VALUES ('full', 1)
    ON CONFLICT (slug) DO UPDATE SET price_cents = EXCLUDED.price_cents;
    RAISE EXCEPTION 'T-G7 falhou: escrita direta em plan_catalog';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'T-G7d ok: escrita plan_catalog negada (42501)';
  END;
END $$;

ROLLBACK;

-- ============ T-G8 — flood + CORS probes (BE-07) ============
-- T-G8a (banco, automatizado): 70 leituras admin seguidas passam — a borda
-- de throttle vive no Edge (429+Retry-After), o banco não limita leitura
-- legítima (sem falso-positivo de throttle em RPC).
-- T-G8b/T-G8c (Edge ao vivo, documentadas): exigem
-- `supabase functions serve admin-invite-user` com APP_URL configurado:
--   flood: 11 POSTs /invite em <60s mesma IP → 11º responde 429 + Retry-After
--   cors:  OPTIONS com `Origin: https://evil.example` → 403 sem ACA-Origin:*
--          OPTIONS com Origin=APP_URL → 204 com ACA-Origin=APP_URL

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '8b000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}', false);

DO $$
DECLARE
  i int;
  v_n bigint;
BEGIN
  FOR i IN 1..70 LOOP
    PERFORM * FROM public.admin_list_tenants(NULL, NULL, 'created_at', 'desc', 20, 0) AS t;
    v_n := public.admin_count_tenants(NULL, NULL);
  END LOOP;

  IF v_n IS NULL OR v_n < 3 THEN
    RAISE EXCEPTION 'T-G8 falhou: flood de leitura legítima quebrou o count';
  END IF;

  RAISE NOTICE 'T-G8a ok: 70 leituras admin sem falso-throttle no banco';
END $$;

RESET ROLE;

-- ============ Cleanup T-G3/G5/G6 (rerun não duplica) ============

DELETE FROM public.admin_audit
WHERE target_id IN (
  SELECT id FROM public.tenants
  WHERE cpf IN ('11144477735', '12345678909')
     OR cnpj IN ('11444777000161')
);

BEGIN;
ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

-- 0077: assinatura da RPC de convite sai antes do tenant (FK RESTRICT).
DELETE FROM public.tenant_subscriptions AS s
USING public.tenants AS t
WHERE s.tenant_id = t.id
  AND (t.cpf IN ('11144477735', '12345678909') OR t.cnpj IN ('11444777000161'));

DELETE FROM public.tenants
WHERE cpf IN ('11144477735', '12345678909')
   OR cnpj IN ('11444777000161');

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;
COMMIT;

DELETE FROM public.admin_audit
WHERE target_id IN (
  '8b000000-0000-4000-8000-0000000000d2',
  '8b000000-0000-4000-8000-0000000000e2',
  '8b000000-0000-4000-8000-0000000000f2'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  '8b000000-0000-4000-8000-0000000000d2',
  '8b000000-0000-4000-8000-0000000000e2',
  '8b000000-0000-4000-8000-0000000000f2'
);

DELETE FROM auth.users
WHERE id IN (
  '8b000000-0000-4000-8000-0000000000d2',
  '8b000000-0000-4000-8000-0000000000e2',
  '8b000000-0000-4000-8000-0000000000f2'
);

DO $$
DECLARE
  v_tenants int;
  v_users int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants
  WHERE cpf IN ('11144477735', '12345678909')
     OR cnpj IN ('11444777000161');
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T-G9b falhou: fixtures T-G3/G5/G6 de tenant sobreviveram';
  END IF;

  SELECT count(*) INTO v_users FROM auth.users
  WHERE id IN (
    '8b000000-0000-4000-8000-0000000000d2',
    '8b000000-0000-4000-8000-0000000000e2',
    '8b000000-0000-4000-8000-0000000000f2'
  );
  IF v_users <> 0 THEN
    RAISE EXCEPTION 'T-G9b falhou: fixtures T-G3/G5/G6 de users sobreviveram';
  END IF;

  RAISE NOTICE 'T-G9b ok: limpeza T-G3/G5/G6 deixa o banco pronto para o próximo run';
END $$;

-- ============ Cleanup final (rerun não duplica) ============

DELETE FROM public.admin_audit
WHERE target_id IN (
  '8b000000-0000-4000-8000-0000000000a1',
  '8b000000-0000-4000-8000-0000000000b1',
  '8b000000-0000-4000-8000-0000000000c1'
);

DELETE FROM public.admin_audit
WHERE target_id IN (SELECT id FROM pg_temp.gaps_tenant_a);

ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

-- 0077: assinatura da RPC de convite sai antes do tenant (FK RESTRICT).
DELETE FROM public.tenant_subscriptions AS s
USING public.tenants AS t
WHERE s.tenant_id = t.id
  AND (t.cpf IN ('52998224725') OR t.cnpj IN ('11222333000181'));

DELETE FROM public.tenants
WHERE cpf IN ('52998224725')
   OR cnpj IN ('11222333000181');

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.internal_operators
WHERE user_id IN (
  '8b000000-0000-4000-8000-0000000000a1',
  '8b000000-0000-4000-8000-0000000000b1',
  '8b000000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  '8b000000-0000-4000-8000-0000000000a1',
  '8b000000-0000-4000-8000-0000000000b1',
  '8b000000-0000-4000-8000-0000000000c1'
);

DO $$
DECLARE
  v_tenants int;
  v_users int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants
  WHERE cpf IN ('52998224725') OR cnpj IN ('11222333000181');
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T-G9 falhou: fixtures de tenant sobreviveram';
  END IF;

  SELECT count(*) INTO v_users FROM auth.users
  WHERE id IN (
    '8b000000-0000-4000-8000-0000000000a1',
    '8b000000-0000-4000-8000-0000000000b1',
    '8b000000-0000-4000-8000-0000000000c1'
  );
  IF v_users <> 0 THEN
    RAISE EXCEPTION 'T-G9 falhou: fixtures de users sobreviveram';
  END IF;

  RAISE NOTICE 'T-G9 ok: limpeza final deixa o banco pronto para o próximo run';
END $$;
