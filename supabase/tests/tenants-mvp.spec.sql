-- tenants-mvp.spec.sql — tenants-cobranca MVP / migration 0025_tenant_wrapper.sql.
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenants-mvp.spec.sql
-- Rerunnable: as fixtures (auth.users + tenants + memberships + acceptances) são
-- apagadas no início (delete de auth.users cascateia tenants → memberships → acceptances).
--
-- Prova em banco real (não mock — mock não avalia trigger, policy nem grant):
--   T00 estrutura: RPC (14 args, uuid, SECURITY DEFINER, search_path=''),
--       EXECUTE só para service_role/DBA (SEC-04), sem current_user no corpo
--   T00b SEC-04: authenticated/anon → 42501, nada persiste
--   T01 sucesso PF devolve uuid + membership owner + aceite (versão vigente)
--   T02 sucesso PJ devolve uuid + membership owner + aceite
--   T03 versão inválida ⇒ `acceptance-version-invalid`, nada persiste (3 tabelas)
--   T04 plano não-`free` por chamador sem claim backoffice ⇒ `tenant-plan-forbidden`, nada persiste (3 tabelas)
--   T05 documento duplicado ⇒ `tenant-document-duplicate`, total estável
--   T05b re-aceite da mesma versão ⇒ `acceptance-duplicate`, nada duplica (3 tabelas)
--   T06 auth.uid() nulo ⇒ `not-authenticated` (3 tabelas)
--   T07 kind inválido ⇒ `tenant-kind-invalid`, nada persiste (3 tabelas)
--   T08 tenant sem aceite via RPC base continua impossível
--       (`tenant-acceptance-required` — guarda da 0024 intacta)
--   T09 limpeza final é efetiva (rerun não duplica)
--
-- Documentos de fixture (válidos no DV): PF 11144477735 / 52998224725,
-- PJ 11222333000181 / 45723174000110.
-- Nenhuma mensagem de falha carrega ids, documento ou PII (SEC-G3).

\set ON_ERROR_STOP on

-- ============ Fixtures (como postgres: RLS bypass, DBA permitido) ============

ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM public.tenants
WHERE cpf IN ('11144477735', '52998224725')
   OR cnpj IN ('11222333000181', '45723174000110');

DELETE FROM public.admin_audit
WHERE target_id IN (
  '7f000000-0000-4000-8000-0000000000a1',
  '7f000000-0000-4000-8000-0000000000b1',
  '7f000000-0000-4000-8000-0000000000c1'
);

DELETE FROM auth.users
WHERE id IN (
  '7f000000-0000-4000-8000-0000000000a1',
  '7f000000-0000-4000-8000-0000000000b1',
  '7f000000-0000-4000-8000-0000000000c1'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

INSERT INTO auth.users (id, email) VALUES
  ('7f000000-0000-4000-8000-0000000000a1', 'mvp-a@example.com'),
  ('7f000000-0000-4000-8000-0000000000b1', 'mvp-b@example.com'),
  ('7f000000-0000-4000-8000-0000000000c1', 'mvp-c@example.com');

-- T09a — ponto de partida limpo (prova de que a limpeza acima funciona em rerun).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.tenants
  WHERE cpf IN ('11144477735', '52998224725')
     OR cnpj IN ('11222333000181', '45723174000110');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'T09 falhou: fixtures de tenant sobreviveram à limpeza inicial';
  END IF;

  RAISE NOTICE 'T09a ok: fixtures limpas (rerun não duplica)';
END $$;

-- ============ T00 — estrutura, RPC, grants ============

DO $$
DECLARE
  v_proc pg_proc;
  v_prosrc text;
BEGIN
  SELECT * INTO v_proc
  FROM pg_proc
  WHERE oid = to_regprocedure(
    'public.create_tenant_with_owner_and_acceptance(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T00 falhou: RPC wrapper ausente ou com assinatura errada (14 args text)';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem SECURITY DEFINER';
  END IF;
  IF v_proc.prorettype <> 'uuid'::regtype THEN
    RAISE EXCEPTION 'T00 falhou: RPC não retorna uuid';
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
  WHERE oid = to_regprocedure(
    'public.create_tenant_with_owner_and_acceptance(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'
  );
  IF position('current_user' IN v_prosrc) <> 0 THEN
    RAISE EXCEPTION 'T00 falhou: RPC consulta current_user';
  END IF;
  IF position('tenant-plan-forbidden' IN v_prosrc) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem a trava de plano não-free';
  END IF;
  IF position('acceptance-version-invalid' IN v_prosrc) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: RPC sem validação de versão do aceite';
  END IF;

  -- SEC-04 (D1 invite-only): cliente não provisiona tenant.
  IF has_function_privilege(
    'authenticated',
    'public.create_tenant_with_owner_and_acceptance(text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: authenticated executa o wrapper (SEC-04)';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.create_tenant_with_owner_and_acceptance(text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: anon executa o wrapper';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.create_tenant_with_owner_and_acceptance(text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: service_role sem EXECUTE no wrapper (backoffice/Edge)';
  END IF;
  IF NOT has_function_privilege(
    'postgres',
    'public.create_tenant_with_owner_and_acceptance(text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'T00 falhou: DBA sem EXECUTE no wrapper';
  END IF;

  -- SEC-04: o comentário precisa declarar o modelo (backoffice/Edge, nunca o usuário).
  IF position('SEC-04' IN COALESCE(obj_description(v_proc.oid, 'pg_proc'), '')) = 0 THEN
    RAISE EXCEPTION 'T00 falhou: COMMENT do wrapper não declara o modelo invite-only (SEC-04)';
  END IF;

  RAISE NOTICE 'T00 ok: wrapper 14 args → uuid, SECURITY DEFINER, search_path vazio, EXECUTE só service_role/DBA (SEC-04)';
END $$;

-- ============ T00b — cliente não executa o wrapper (SEC-04 / 42501) ============

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner_and_acceptance(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free', 'termos-2026-11-v1'
    );
    RAISE EXCEPTION 'T00b falhou: authenticated provisionou tenant (SEC-04)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- 42501: EXECUTE revogado na 0052.
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00b falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00b falhou: erro diferente de 42501 (%)', SQLERRM;
  END;
END $$;

-- 0053: as RPCs de baixo nível (0022/0024) também ficaram fora do cliente.
DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'T00b falhou: authenticated provisionou via RPC base';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00b falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00b falhou: erro diferente de 42501 na RPC base (%)', SQLERRM;
  END;

  BEGIN
    PERFORM public.accept_contract(
      '00000000-0000-4000-8000-000000000000', 'termos-2026-11-v1'
    );
    RAISE EXCEPTION 'T00b falhou: authenticated gravou aceite';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00b falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00b falhou: erro diferente de 42501 no aceite (%)', SQLERRM;
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
    PERFORM public.create_tenant_with_owner_and_acceptance(
      'pf', '22233344405', 'Cliente Sem Convite',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free', 'termos-2026-11-v1'
    );
    RAISE EXCEPTION 'T00b falhou: anon provisionou tenant';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T00b falhou%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'T00b falhou: erro diferente de 42501 para anon (%)', SQLERRM;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  v_tenants int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE cpf = '22233344405';
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T00b falhou: tenant sem convite persistiu';
  END IF;

  RAISE NOTICE 'T00b ok: authenticated/anon → 42501 sem linha persistida';
END $$;

-- ============ T01 — sucesso PF: uuid + membership owner + aceite ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000a1","role":"service_role"}', false);

DO $$
DECLARE
  v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner_and_acceptance(
    'pf', '11144477735', 'Ana Silva',
    NULL, '11987654321', '01310100', 'Rua Exemplo', '100', NULL, 'Centro',
    'Sao Paulo', 'SP', 'free', 'termos-2026-11-v1'
  );
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T01 falhou: wrapper PF não devolveu tenant_id';
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenant public.tenants;
  v_members int;
  v_accepts int;
BEGIN
  SELECT * INTO v_tenant FROM public.tenants WHERE cpf = '11144477735';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T01 falhou: tenant PF não persistido';
  END IF;
  IF v_tenant.owner_user_id IS DISTINCT FROM '7f000000-0000-4000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION 'T01 falhou: dono do tenant não é auth.uid()';
  END IF;
  IF v_tenant.plan_id <> 'free' THEN
    RAISE EXCEPTION 'T01 falhou: plano do MVP não é free';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE tenant_id = v_tenant.id
    AND user_id = '7f000000-0000-4000-8000-0000000000a1'
    AND role = 'owner';
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'T01 falhou: membership owner ausente';
  END IF;

  SELECT count(*) INTO v_accepts
  FROM public.contract_acceptances
  WHERE tenant_id = v_tenant.id
    AND contract_version = 'termos-2026-11-v1'
    AND user_id = '7f000000-0000-4000-8000-0000000000a1';
  IF v_accepts <> 1 THEN
    RAISE EXCEPTION 'T01 falhou: aceite da versão vigente ausente';
  END IF;

  RAISE NOTICE 'T01 ok: PF com tenant + owner + aceite atômicos';
END $$;

-- ============ T02 — sucesso PJ: uuid + membership owner + aceite ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000b1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000b1","role":"service_role"}', false);

DO $$
DECLARE
  v_id uuid;
BEGIN
  v_id := public.create_tenant_with_owner_and_acceptance(
    'pj', '11222333000181', 'Beta Comercio Ltda',
    'Beta', '1133334444', '01310100', 'Rua Exemplo', '200', NULL, 'Centro',
    'Sao Paulo', 'SP', 'free', 'termos-2026-11-v1'
  );
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T02 falhou: wrapper PJ não devolveu tenant_id';
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenant public.tenants;
  v_members int;
  v_accepts int;
BEGIN
  SELECT * INTO v_tenant FROM public.tenants WHERE cnpj = '11222333000181';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T02 falhou: tenant PJ não persistido';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE tenant_id = v_tenant.id
    AND user_id = '7f000000-0000-4000-8000-0000000000b1'
    AND role = 'owner';
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'T02 falhou: membership owner do PJ ausente';
  END IF;

  SELECT count(*) INTO v_accepts
  FROM public.contract_acceptances
  WHERE tenant_id = v_tenant.id
    AND contract_version = 'termos-2026-11-v1';
  IF v_accepts <> 1 THEN
    RAISE EXCEPTION 'T02 falhou: aceite do PJ ausente';
  END IF;

  RAISE NOTICE 'T02 ok: PJ com tenant + owner + aceite atômicos';
END $$;

-- ============ T03 — versão inválida desfaz tudo ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000c1","role":"service_role"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner_and_acceptance(
      'pf', '52998224725', 'Sem Versao',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free', 'versao com espaco'
    );
    RAISE EXCEPTION 'T03 falhou: wrapper aceitou versão inválida';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T03 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'acceptance-version-invalid' THEN
        RAISE EXCEPTION 'T03 falhou: rótulo errado para versão inválida (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T03 ok: acceptance-version-invalid sem nada persistido';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenants int;
  v_members int;
  v_accepts int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE cpf = '52998224725';
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T03 falhou: tenant com versão inválida persistiu';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE user_id = '7f000000-0000-4000-8000-0000000000c1';
  IF v_members <> 0 THEN
    RAISE EXCEPTION 'T03 falhou: membership órfã persistiu';
  END IF;

  SELECT count(*) INTO v_accepts
  FROM public.contract_acceptances
  WHERE user_id = '7f000000-0000-4000-8000-0000000000c1';
  IF v_accepts <> 0 THEN
    RAISE EXCEPTION 'T03 falhou: aceite órfão persistiu';
  END IF;
END $$;

-- ============ T04 — plano não-free por authenticated ⇒ tenant-plan-forbidden ============

-- SEC-04: `authenticated` não executa mais o wrapper (T00b). A trava de
-- plano pago continua provada na RPC: a decisão lê o claim `role` do JWT,
-- então o chamador aqui mantém EXECUTE (service_role) mas claims de usuário
-- comum — exatamente o que a guarda precisa recusar.
SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000c1","role":"authenticated"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner_and_acceptance(
      'pj', '45723174000110', 'Plano Pago Ltda',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'pro', 'termos-2026-11-v1'
    );
    RAISE EXCEPTION 'T04 falhou: wrapper aceitou plano pago';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T04 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-plan-forbidden' THEN
        RAISE EXCEPTION 'T04 falhou: rótulo errado para plano pago (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T04 ok: tenant-plan-forbidden sem nada persistido';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenants int;
  v_members int;
  v_accepts int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE cnpj = '45723174000110';
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T04 falhou: tenant com plano pago persistiu';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE user_id = '7f000000-0000-4000-8000-0000000000c1';
  IF v_members <> 0 THEN
    RAISE EXCEPTION 'T04 falhou: membership órfã persistiu';
  END IF;

  SELECT count(*) INTO v_accepts
  FROM public.contract_acceptances
  WHERE user_id = '7f000000-0000-4000-8000-0000000000c1';
  IF v_accepts <> 0 THEN
    RAISE EXCEPTION 'T04 falhou: aceite órfão persistiu';
  END IF;
END $$;

-- ============ T05 — documento duplicado ⇒ tenant-document-duplicate, total estável ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000c1","role":"service_role"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner_and_acceptance(
      'pf', '11144477735', 'Outra Ana',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free', 'termos-2026-11-v1'
    );
    RAISE EXCEPTION 'T05 falhou: wrapper aceitou documento duplicado';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T05 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-document-duplicate' THEN
        RAISE EXCEPTION 'T05 falhou: rótulo errado para duplicata (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T05 ok: tenant-document-duplicate sem linha persistida';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenants int;
  v_accepts int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE cpf = '11144477735';
  IF v_tenants <> 1 THEN
    RAISE EXCEPTION 'T05 falhou: duplicata alterou tenants (esperava 1, achou %)', v_tenants;
  END IF;

  SELECT count(*) INTO v_accepts
  FROM public.contract_acceptances AS ca
  JOIN public.tenants AS t ON t.id = ca.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_accepts <> 1 THEN
    RAISE EXCEPTION 'T05 falhou: duplicata alterou aceites (esperava 1, achou %)', v_accepts;
  END IF;
END $$;

-- ============ T05b — re-aceite da mesma versão ⇒ acceptance-duplicate, nada duplica ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000a1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000a1","role":"service_role"}', false);

DO $$
DECLARE
  v_tenant_id uuid;
BEGIN
  SELECT id INTO v_tenant_id FROM public.tenants WHERE cpf = '11144477735';
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'T05b falhou: tenant base do re-aceite ausente';
  END IF;

  BEGIN
    PERFORM public.accept_contract(v_tenant_id, 'termos-2026-11-v1');
    RAISE EXCEPTION 'T05b falhou: re-aceite da mesma versão foi aceito';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T05b falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'acceptance-duplicate' THEN
        RAISE EXCEPTION 'T05b falhou: rótulo errado para re-aceite (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T05b ok: acceptance-duplicate sem linha duplicada';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenants int;
  v_members int;
  v_accepts int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE cpf = '11144477735';
  IF v_tenants <> 1 THEN
    RAISE EXCEPTION 'T05b falhou: re-aceite alterou tenants (esperava 1, achou %)', v_tenants;
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'T05b falhou: re-aceite alterou memberships (esperava 1, achou %)', v_members;
  END IF;

  SELECT count(*) INTO v_accepts
  FROM public.contract_acceptances AS ca
  JOIN public.tenants AS t ON t.id = ca.tenant_id
  WHERE t.cpf = '11144477735';
  IF v_accepts <> 1 THEN
    RAISE EXCEPTION 'T05b falhou: re-aceite duplicou aceites (esperava 1, achou %)', v_accepts;
  END IF;
END $$;

-- ============ T06 — auth.uid() nulo ⇒ not-authenticated ============

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims', '', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner_and_acceptance(
      'pf', '52998224725', 'Sem Sessao',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free', 'termos-2026-11-v1'
    );
    RAISE EXCEPTION 'T06 falhou: wrapper aceitou chamada sem auth.uid()';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T06 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'not-authenticated' THEN
        RAISE EXCEPTION 'T06 falhou: rótulo errado sem sessão (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T06 ok: not-authenticated sem nada persistido';
END $$;

ROLLBACK;

DO $$
DECLARE
  v_tenants int;
  v_members int;
  v_accepts int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE cpf = '52998224725';
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T06 falhou: tenant sem sessão persistiu';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE user_id = '7f000000-0000-4000-8000-0000000000c1';
  IF v_members <> 0 THEN
    RAISE EXCEPTION 'T06 falhou: membership sem sessão persistiu';
  END IF;

  SELECT count(*) INTO v_accepts
  FROM public.contract_acceptances
  WHERE user_id = '7f000000-0000-4000-8000-0000000000c1';
  IF v_accepts <> 0 THEN
    RAISE EXCEPTION 'T06 falhou: aceite sem sessão persistiu';
  END IF;
END $$;

-- ============ T07 — kind inválido ⇒ tenant-kind-invalid ============

SET ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000c1","role":"service_role"}', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_tenant_with_owner_and_acceptance(
      'xx', '52998224725', 'Kind Ruim',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'free', 'termos-2026-11-v1'
    );
    RAISE EXCEPTION 'T07 falhou: wrapper aceitou kind inválido';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'T07 falhou%' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'tenant-kind-invalid' THEN
        RAISE EXCEPTION 'T07 falhou: rótulo errado para kind (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE 'T07 ok: tenant-kind-invalid sem nada persistido';
END $$;

RESET ROLE;

DO $$
DECLARE
  v_tenants int;
  v_members int;
  v_accepts int;
BEGIN
  SELECT count(*) INTO v_tenants FROM public.tenants WHERE razao_social = 'Kind Ruim';
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T07 falhou: tenant com kind inválido persistiu';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE user_id = '7f000000-0000-4000-8000-0000000000c1';
  IF v_members <> 0 THEN
    RAISE EXCEPTION 'T07 falhou: membership órfã persistiu';
  END IF;

  SELECT count(*) INTO v_accepts
  FROM public.contract_acceptances
  WHERE user_id = '7f000000-0000-4000-8000-0000000000c1';
  IF v_accepts <> 0 THEN
    RAISE EXCEPTION 'T07 falhou: aceite órfão persistiu';
  END IF;
END $$;

-- ============ T08 — RPC base sem aceite continua impossível (guarda 0024 intacta) ============

BEGIN;
SET CONSTRAINTS tenant_acceptance_required IMMEDIATE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '7f000000-0000-4000-8000-0000000000c1', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT set_config('request.jwt.claims',
  '{"sub":"7f000000-0000-4000-8000-0000000000c1","role":"service_role"}', false);

DO $$
BEGIN
  PERFORM public.create_tenant_with_owner(
    'pf', '52998224725', 'Sem Aceite',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  RAISE EXCEPTION 'T08 falhou: tenant sem aceite foi aceito';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'T08 falhou%' THEN
      RAISE;
    END IF;
    IF SQLERRM <> 'tenant-acceptance-required' THEN
      RAISE EXCEPTION 'T08 falhou: rótulo errado sem aceite (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'T08 ok: tenant-acceptance-required sem aceite';
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
    RAISE EXCEPTION 'T08 falhou: tenant sem aceite persistiu';
  END IF;
END $$;

-- ============ T09 — limpeza final é efetiva (rerun não duplica) ============

DELETE FROM public.admin_audit
WHERE target_id IN (
  '7f000000-0000-4000-8000-0000000000a1',
  '7f000000-0000-4000-8000-0000000000b1',
  '7f000000-0000-4000-8000-0000000000c1'
);

ALTER TABLE public.contract_acceptances DISABLE TRIGGER contract_acceptances_immutable;

DELETE FROM auth.users
WHERE id IN (
  '7f000000-0000-4000-8000-0000000000a1',
  '7f000000-0000-4000-8000-0000000000b1',
  '7f000000-0000-4000-8000-0000000000c1'
);

ALTER TABLE public.contract_acceptances ENABLE TRIGGER contract_acceptances_immutable;

DO $$
DECLARE
  v_tenants int;
  v_members int;
BEGIN
  SELECT count(*) INTO v_tenants
  FROM public.tenants
  WHERE cpf IN ('11144477735', '52998224725')
     OR cnpj IN ('11222333000181', '45723174000110')
     OR owner_user_id IN (
       '7f000000-0000-4000-8000-0000000000a1',
       '7f000000-0000-4000-8000-0000000000b1',
       '7f000000-0000-4000-8000-0000000000c1'
     );
  IF v_tenants <> 0 THEN
    RAISE EXCEPTION 'T09b falhou: fixtures de tenant sobreviveram à limpeza final';
  END IF;

  SELECT count(*) INTO v_members
  FROM public.tenant_members
  WHERE user_id IN (
    '7f000000-0000-4000-8000-0000000000a1',
    '7f000000-0000-4000-8000-0000000000b1',
    '7f000000-0000-4000-8000-0000000000c1'
  );
  IF v_members <> 0 THEN
    RAISE EXCEPTION 'T09b falhou: memberships sobreviveram à limpeza final';
  END IF;

  RAISE NOTICE 'T09b ok: limpeza final deixa o banco pronto para o próximo run';
END $$;
