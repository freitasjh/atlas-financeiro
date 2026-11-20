-- 0055-0060-subscription-billing.spec.sql — control-plane-billing / F1 / ADR-001.
-- Uso: supabase db reset && psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0055-0060-subscription-billing.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova em banco real (mock não avalia constraint, RLS, ACL, trigger nem transação):
--   T00 estrutura: `public.tenant_subscriptions` com as 18 colunas (16 de §4.1
--       + `last_event_at`/`last_event_id` de 0065)
--       (tipo, nulabilidade, default), as constraints nomeadas (13 CHECKs,
--       incl. os limites de 1..255 de `psp_subscription_id`/`psp_customer_id`
--       e o par de marca d'água de 0065), o enum fechado
--       de `status`, as FKs (`tenants` RESTRICT; `plan_catalog` ×2), os índices
--       (`UNIQUE(tenant_id)`, parcial de `psp_subscription_id`, parcial
--       `trial_ends_at WHERE status='trial'`), `relrowsecurity=true`, ZERO
--       policy, `REVOKE ALL` de PUBLIC/anon/authenticated/service_role,
--       COMMENT de tabela, trigger `set_updated_at`, as 9 ações fechadas de
--       `admin_audit`, ZERO FK para `invoices` e nenhum tipo float/numeric.
--   T01 uma assinatura por tenant (`UNIQUE (tenant_id)`).
--   T02 CHECKs por plano do adendo §14 (free × pago × trial × período).
--   T03 `ON DELETE RESTRICT` ao apagar tenant com assinatura.
--   T04 `updated_at` muda em UPDATE (`set_updated_at`).
--   T05 faturas: `UNIQUE(tenant_id, competencia)` + uniques parciais de PSP.
--   T06 estrutura de `tenant_invoices` (15 colunas, 6 CHECKs, FKs RESTRICT,
--       RLS sem policy, REVOKE ALL, guards de tenant/imutabilidade), competencia
--       dia 1 e `amount_cents` bigint.
--   T07 `status='paid'` exige `paid_at` (INSERT e UPDATE).
--   T08 `invoice-tenant-mismatch` (assinatura de outro tenant, 0 escrita).
--   T09 imutabilidade de `paid`/`refunded` (valor/competencia/periodo).
--   T10 matriz fechada de status; invalida preserva o estado.
--   T11 inbox: `UNIQUE(event_id)`, enums/limites/payload.
--   T12 inbox: `service_role` sem DML de tabela (INSERT revogado em 0066/Ed6;
--       escrita so por ingest_psp_event); `authenticated`/`anon` nada.
--   T13 espelho INSERT/UPDATE na mesma transacao.
--   T14 free trial->active com exatamente 1 auditoria e reason.
--   T15 plano/status iguais nao atualizam tenants nem auditam.
--   T16 UPDATE no-op nao toca updated_at nem auditoria.
--   T17 reason do chamador viaja intacto para a trilha.
--   T50 `admin_set_tenant_status` deprecado: 42501 para authenticated.
--   T18a estrutura das 3 RPCs de escrita de 0059 (assinatura exata,
--       SECURITY DEFINER, search_path vazio, grants fechados, helper privado).
--   T18b `expire_subscriptions` negado ao cliente (42501: service_role apenas).
--   T18 idempotencia: mesmo event_id 3x => 1 applied + 2 already-processed.
--   T19 mesmo psp_payment_id em 2 eventos => 1 fatura; 2o outcome duplicate.
--   T19x psp_payment_id de outro tenant => rejected/psp-key-conflict, attempts+1.
--   T19y concorrencia (2 sessoes via dblink): mesmo psp_payment_id em 2 tenants
--       => colisao detectada ANTES da escrita de estado; assinatura intacta.
--   T20 trial + payment_confirmed => active, ciclo aberto, fatura paid do catalogo.
--   T20b payment_confirmed sem psp_payment_id => psp-event-invalid, 0 escrita.
--   T21 active com period_end < hoje => avanca ao ciclo de hoje, 1 fatura paga.
--   T21b renovacao aplica pending_plan antes da fatura (pro) e limpa ciclo no free.
--   T22 active com period_end >= hoje => nao avanca, fatura do ciclo paga.
--   T23 active + payment_overdue => past_due + past_due_since + fatura overdue.
--   T24 past_due + payment_overdue => no-op, past_due_since intacto.
--   T25 past_due + payment_confirmed => active, past_due_since NULL, fatura paga.
--   T26 trial + payment_overdue/refunded => no-op.
--   T27 active + payment_refunded => fatura paid vira refunded, status intacto.
--   T27b estorno resolve a fatura pelo psp_payment_id; sem match => noop auditado.
--   T27c ids cruzados (payment de uma fatura, invoice de outra) => noop auditado,
--       nenhuma fatura estornada; sem payment, resolve pelo psp_invoice_id.
--   T28 subscription_canceled => cancel_at_period_end=true, status intacto.
--   T29 canceled + payment_confirmed mesmo id => rejected + 1 auditoria, 0 UPDATE.
--   T30 canceled + payment_confirmed id novo via customer => active.
--   T31 evento nao mapeado => noop, 0 auditoria.
--   T32 combinacao nao prevista (canceled+overdue; free+confirmed) => rejected.
--   T33 payload value divergente => transicao aplicada + psp-amount-divergence.
--   T33b value com virgula/sinal compara; expoente/truncamento => uncomparable.
--   T34 expire_subscriptions cancela trial vencido, idempotente.
--   T35 roll_period: bordas, lastro pago, +1 ciclo, pendente aplicado, free.
--   T49 estrutura das 4 RPCs de 0060 (assinatura, DEFINER, search_path vazio,
--       grants so authenticated, retorno jsonb/TABLE, contagem exata).
--   T36 get_my_subscription: propria assinatura (pago e free sem cobranca);
--       0 linhas sem tenant; sem ids de PSP.
--   T37 list_my_invoices: envelope {items,total}, ordem competencia DESC,
--       clamp de limit 1..100, offset >= 0; sem ids de PSP.
--   T38a isolamento: owner de A nao le faturas/assinatura de B.
--   T38b admin_get_tenant_billing audita a leitura de tenant alheio.
--   T38c authenticated recebe 42501 nas 3 tabelas (sem grant de leitura).
--   T38d service_role nao le tenant_subscriptions/tenant_invoices.
--   T39 admin_get_tenant_billing: gate, lastro de PSP, usage null, 50 faturas.
--   T40 legado sem assinatura => subscription null, faturas vazias, sem erro.
--   T41 override: not-admin, tenant-not-found, subscription-not-found, motivo.
--   T42 override: tenant-plan-invalid, tenant-status-invalid (enum e past_due+free).
--   T43 upgrade imediato preserva ciclo; espelho e trilha na mesma transacao.
--   T44 downgrade com ciclo aberto => pending_plan_slug/pending_plan_at.
--   T45 free->pago preenche billing_day; pago->free imediato limpa ciclo;
--       pago->free com ciclo aberto e diferido (sem 23514 cru).
--   T46 alvo fora da matriz => outcome rejected + 1 auditoria, 0 UPDATE.
--   T47 fatura manual (competencia normalizada, valor do catalogo, auditoria).
--   T47b segunda fatura manual na mesma competencia => tenant-invoice-duplicate.
--   T48 fatura manual clampa vencimento (dia 31 em fevereiro); free => invalido.
--
-- Fixtures em UUIDs c550* (users/tenants) e c5500000-...0101+ (assinaturas),
-- criadas por helper `pg_temp` e removidas no início e no fim; todo cenário
-- mutável roda em transação com ROLLBACK. Nenhuma escrita permanente.
-- Nenhum rótulo/PII em mensagem: os erros abaixo são do próprio teste.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (inicio; rerunnable) ============
-- Ordem: faturas e inbox ANTES das assinaturas; assinaturas ANTES dos tenants
-- (FK ON DELETE RESTRICT impede cascata). A trilha de `admin_audit` nao tem FK
-- e e limpa pelo escape DBA (postgres) — sem isso a auditoria do espelho (0058)
-- sobraria entre execucoes.
-- Guarda `to_regclass`: o cleanup roda ANTES do T00 e nao pode mascarar a
-- falha de estrutura quando a tabela ainda nao existe.
BEGIN;
DO $$
DECLARE
  v_users uuid[] := ARRAY[
    'c5500000-0000-4000-8000-0000000000a1',
    'c5500000-0000-4000-8000-0000000000b1',
    'c5500000-0000-4000-8000-0000000000c1',
    'c5500000-0000-4000-8000-0000000000d1',
    'c5600000-0000-4000-8000-0000000000a1',
    'c5600000-0000-4000-8000-0000000000b1',
    'c5700000-0000-4000-8000-0000000000a1',
    'c5700000-0000-4000-8000-0000000000b1',
    'c5700000-0000-4000-8000-0000000000c1',
    'c5700000-0000-4000-8000-0000000000d1',
    'c5800000-0000-4000-8000-0000000000a1',
    'c5800000-0000-4000-8000-0000000000b1'
  ]::uuid[];
BEGIN
  IF to_regclass('public.tenant_invoices') IS NOT NULL THEN
    DELETE FROM public.tenant_invoices AS i
    USING public.tenants AS t
    WHERE i.tenant_id = t.id
      AND t.owner_user_id = ANY(v_users);
  END IF;
  IF to_regclass('public.psp_events') IS NOT NULL THEN
    DELETE FROM public.psp_events
    WHERE event_id LIKE 'c57-%' OR event_id LIKE 'c58-%';
  END IF;
  IF to_regclass('public.tenant_subscriptions') IS NOT NULL THEN
    DELETE FROM public.tenant_subscriptions AS s
    USING public.tenants AS t
    WHERE s.tenant_id = t.id
      AND t.owner_user_id = ANY(v_users);
  END IF;
  DELETE FROM public.admin_audit AS a
  USING public.tenants AS t
  WHERE t.owner_user_id = ANY(v_users)
    AND (a.tenant_id = t.id OR a.target_id = t.id);
END $$;
DELETE FROM auth.users
WHERE id = ANY (ARRAY[
  'c5500000-0000-4000-8000-0000000000a1',
  'c5500000-0000-4000-8000-0000000000b1',
  'c5500000-0000-4000-8000-0000000000c1',
  'c5500000-0000-4000-8000-0000000000d1',
  'c5600000-0000-4000-8000-0000000000a1',
  'c5600000-0000-4000-8000-0000000000b1',
  'c5700000-0000-4000-8000-0000000000a1',
  'c5700000-0000-4000-8000-0000000000b1',
  'c5700000-0000-4000-8000-0000000000c1',
  'c5700000-0000-4000-8000-0000000000d1',
  'c5800000-0000-4000-8000-0000000000a1',
  'c5800000-0000-4000-8000-0000000000b1'
]::uuid[]);
COMMIT;

-- ============ T00 — estrutura de 0055 ============
DO $$
DECLARE
  v_rel oid;
  v_count int;
  v_data_type text;
  v_nullable text;
  v_default text;
  v_def text;
  v_idx text;
  v_name text;
  v_role text;
  v_priv text;
  v_exp record;
  v_proc record;
BEGIN
  v_rel := to_regclass('public.tenant_subscriptions');
  IF v_rel IS NULL THEN
    RAISE EXCEPTION '0055 T00 falhou: tabela public.tenant_subscriptions ausente';
  END IF;

  -- 18 colunas exatas (16 de §4.1 + last_event_at/last_event_id de 0065).
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_attribute
  WHERE attrelid = v_rel AND attnum > 0 AND NOT attisdropped;
  IF v_count <> 18 THEN
    RAISE EXCEPTION '0055 T00 falhou: tenant_subscriptions tem % colunas (esperado 18)', v_count;
  END IF;

  FOR v_exp IN
    SELECT * FROM (VALUES
      ('id',                  'uuid',                     'NO',  'gen_random_uuid'),
      ('tenant_id',           'uuid',                     'NO',  NULL),
      ('plan_slug',           'text',                     'NO',  NULL),
      ('status',              'text',                     'NO',  'trial'),
      ('psp_subscription_id', 'text',                     'YES', NULL),
      ('psp_customer_id',     'text',                     'YES', NULL),
      ('trial_ends_at',       'timestamp with time zone', 'YES', NULL),
      ('billing_day',         'smallint',                 'YES', NULL),
      ('period_start',        'date',                     'YES', NULL),
      ('period_end',          'date',                     'YES', NULL),
      ('past_due_since',      'timestamp with time zone', 'YES', NULL),
      ('pending_plan_slug',   'text',                     'YES', NULL),
      ('pending_plan_at',     'date',                     'YES', NULL),
      ('cancel_at_period_end','boolean',                  'NO',  'false'),
      ('created_at',          'timestamp with time zone', 'NO',  'now('),
      ('updated_at',          'timestamp with time zone', 'NO',  'now('),
      ('last_event_at',       'timestamp with time zone', 'YES', NULL),
      ('last_event_id',       'text',                     'YES', NULL)
    ) AS e(name, expected_type, expected_nullable, expected_default)
  LOOP
    SELECT c.data_type, c.is_nullable, c.column_default
      INTO v_data_type, v_nullable, v_default
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'tenant_subscriptions'
      AND c.column_name = v_exp.name;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0055 T00 falhou: coluna % ausente', v_exp.name;
    END IF;
    IF v_data_type <> v_exp.expected_type THEN
      RAISE EXCEPTION '0055 T00 falhou: coluna % tipo % (esperado %)',
        v_exp.name, v_data_type, v_exp.expected_type;
    END IF;
    IF v_nullable <> v_exp.expected_nullable THEN
      RAISE EXCEPTION '0055 T00 falhou: coluna % nulabilidade % (esperado %)',
        v_exp.name, v_nullable, v_exp.expected_nullable;
    END IF;
    IF v_exp.expected_default IS NULL THEN
      IF v_default IS NOT NULL THEN
        RAISE EXCEPTION '0055 T00 falhou: coluna % tem default inesperado (%)',
          v_exp.name, v_default;
      END IF;
    ELSIF v_default IS NULL OR position(v_exp.expected_default IN v_default) = 0 THEN
      RAISE EXCEPTION '0055 T00 falhou: coluna % default % (esperado %)',
        v_exp.name, coalesce(v_default, '<null>'), v_exp.expected_default;
    END IF;
  END LOOP;

  -- Constraints nomeadas (§4.1).
  FOREACH v_name IN ARRAY ARRAY[
    'tenant_subscriptions_pkey',
    'tenant_subscriptions_tenant_uq',
    'tenant_subscriptions_trial_ends_check',
    'tenant_subscriptions_billing_day_check',
    'tenant_subscriptions_period_pair_check',
    'tenant_subscriptions_period_order_check',
    'tenant_subscriptions_pending_pair_check',
    'tenant_subscriptions_pending_diff_check',
    'tenant_subscriptions_plan_cycle_check',
    'tenant_subscriptions_free_status_check',
    'tenant_subscriptions_psp_subscription_len_check',
    'tenant_subscriptions_psp_customer_len_check',
    'tenant_subscriptions_last_event_pair_check',
    'tenant_subscriptions_last_event_id_len_check'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = v_rel AND conname = v_name
    ) THEN
      RAISE EXCEPTION '0055 T00 falhou: constraint % ausente', v_name;
    END IF;
  END LOOP;

  -- Nenhum CHECK pode sumir: o total exato impede remocao/afrouxamento
  -- passar verde (nomeado ausente + contagem divergente).
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = v_rel AND contype = 'c';
  IF v_count <> 13 THEN
    RAISE EXCEPTION '0055 T00 falhou: tenant_subscriptions tem % CHECKs (esperado 13: 11 de 0055 + 2 de 0065)', v_count;
  END IF;

  -- UNIQUE (tenant_id) é exatamente uma coluna.
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def
  FROM pg_catalog.pg_constraint
  WHERE conrelid = v_rel AND conname = 'tenant_subscriptions_tenant_uq';
  IF v_def IS DISTINCT FROM 'UNIQUE (tenant_id)' THEN
    RAISE EXCEPTION '0055 T00 falhou: tenant_uq def % (esperado UNIQUE (tenant_id))', v_def;
  END IF;

  -- Enum fechado de status (trial|active|past_due|canceled).
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = v_rel
    AND contype = 'c'
    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%''trial''%'
    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%''active''%'
    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%''past_due''%'
    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%''canceled''%';
  IF v_count < 1 THEN
    RAISE EXCEPTION '0055 T00 falhou: CHECK do enum de status ausente';
  END IF;

  -- FK tenant_id -> tenants(id) ON DELETE RESTRICT.
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = v_rel
    AND contype = 'f'
    AND confrelid = 'public.tenants'::regclass
    AND confdeltype = 'r'
    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%tenant_id%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0055 T00 falhou: FK tenant_id->tenants RESTRICT ausente/duplicada (%)', v_count;
  END IF;

  -- FKs plan_slug/pending_plan_slug -> plan_catalog(slug).
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = v_rel
    AND contype = 'f'
    AND confrelid = 'public.plan_catalog'::regclass;
  IF v_count <> 2 THEN
    RAISE EXCEPTION '0055 T00 falhou: FKs para plan_catalog = % (esperado 2)', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = v_rel AND contype = 'f'
      AND confrelid = 'public.plan_catalog'::regclass
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%plan_slug%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = v_rel AND contype = 'f'
      AND confrelid = 'public.plan_catalog'::regclass
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%pending_plan_slug%'
  ) THEN
    RAISE EXCEPTION '0055 T00 falhou: FK de plan_slug/pending_plan_slug ausente';
  END IF;

  -- Índice UNIQUE (tenant_id).
  SELECT indexdef INTO v_idx
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public' AND tablename = 'tenant_subscriptions'
    AND indexname = 'tenant_subscriptions_tenant_uq';
  IF v_idx IS NULL OR position('UNIQUE' IN v_idx) = 0 OR position('(tenant_id)' IN v_idx) = 0 THEN
    RAISE EXCEPTION '0055 T00 falhou: indice UNIQUE(tenant_id) ausente/errado (%)', coalesce(v_idx, '<null>');
  END IF;

  -- Índice UNIQUE parcial de psp_subscription_id WHERE NOT NULL.
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public' AND tablename = 'tenant_subscriptions'
    AND indexdef LIKE 'CREATE UNIQUE INDEX%'
    AND indexdef LIKE '%psp_subscription_id%'
    AND indexdef LIKE '%WHERE%';
  IF v_count < 1 THEN
    RAISE EXCEPTION '0055 T00 falhou: UNIQUE parcial de psp_subscription_id ausente';
  END IF;

  -- Índice parcial de expire_subscriptions: trial_ends_at WHERE status='trial'.
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public' AND tablename = 'tenant_subscriptions'
    AND indexdef LIKE '%trial_ends_at%'
    AND indexdef LIKE '%status%'
    AND indexdef LIKE '%trial%'
    AND indexdef LIKE '%WHERE%';
  IF v_count < 1 THEN
    RAISE EXCEPTION '0055 T00 falhou: indice parcial trial_ends_at/status ausente';
  END IF;

  -- RLS ligada e ZERO policy (deny por construção).
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = v_rel) THEN
    RAISE EXCEPTION '0055 T00 falhou: ROW LEVEL SECURITY desabilitada';
  END IF;
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'tenant_subscriptions';
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0055 T00 falhou: % policy criada (esperado 0)', v_count;
  END IF;

  -- REVOKE ALL: nenhum privilegio de tabela para client/service_role.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.tenant_subscriptions', v_priv) THEN
        RAISE EXCEPTION '0055 T00 falhou: % tem % em tenant_subscriptions', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c,
         pg_catalog.aclexplode(c.relacl) AS a
    WHERE c.oid = v_rel AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION '0055 T00 falhou: PUBLIC ainda tem privilegio em tenant_subscriptions';
  END IF;

  -- COMMENT ON TABLE declarando o deny intencional.
  SELECT pg_catalog.obj_description(v_rel, 'pg_class') INTO v_def;
  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION '0055 T00 falhou: COMMENT ON TABLE tenant_subscriptions ausente';
  END IF;

  -- set_updated_at: trigger BEFORE UPDATE FOR EACH ROW.
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = v_rel
    AND NOT tgisinternal
    AND tgfoid = 'public.set_updated_at()'::regprocedure
    AND (tgtype & 2) <> 0
    AND (tgtype & 16) <> 0;
  IF v_count < 1 THEN
    RAISE EXCEPTION '0055 T00 falhou: trigger set_updated_at BEFORE UPDATE ausente';
  END IF;

  -- Nenhuma funcao nova (quando houver) sem DEFINER/search_path.
  FOR v_proc IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig
    FROM pg_catalog.pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname LIKE 'tenant_subscriptions%'
  LOOP
    IF v_proc.prosecdef IS DISTINCT FROM true THEN
      RAISE EXCEPTION '0055 T00 falhou: funcao % sem SECURITY DEFINER', v_proc.proname;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION '0055 T00 falhou: funcao % sem search_path vazio', v_proc.proname;
    END IF;
  END LOOP;

  -- admin_audit: as 9 acoes fechadas (pre-condicao B4).
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.admin_audit'::regclass
    AND conname = 'admin_audit_action_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '0055 T00 falhou: admin_audit_action_check ausente';
  END IF;
  FOREACH v_name IN ARRAY ARRAY[
    'grant_admin', 'revoke_admin', 'change_plan', 'tenant_status_changed',
    'quota_override', 'grant_super_admin', 'revoke_super_admin',
    'mfa_enrolled', 'other'
  ] LOOP
    IF position('''' || v_name || '''' IN v_def) = 0 THEN
      RAISE EXCEPTION '0055 T00 falhou: acao % ausente do CHECK de admin_audit', v_name;
    END IF;
  END LOOP;

  -- ZERO FK para invoices nas 3 tabelas de billing.
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint AS f
  JOIN pg_catalog.pg_class AS t ON t.oid = f.conrelid
  WHERE f.contype = 'f'
    AND f.confrelid = 'public.invoices'::regclass
    AND t.relname IN ('tenant_subscriptions', 'tenant_invoices', 'psp_events');
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0055 T00 falhou: % FK para invoices (proibido)', v_count;
  END IF;

  -- Nenhuma coluna de dinheiro em float/numeric na tabela.
  SELECT count(*) INTO v_count
  FROM information_schema.columns AS c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'tenant_subscriptions'
    AND c.data_type IN ('real', 'double precision', 'numeric', 'money');
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0055 T00 falhou: % coluna(s) float/numeric de dinheiro', v_count;
  END IF;

  RAISE NOTICE '0055 T00 ok: 18 colunas (16 de 0055 + 2 de 0065), constraints nomeadas, FKs RESTRICT, indices parciais, RLS sem policy, REVOKE ALL, set_updated_at; 0 FK para invoices';
END $$;

-- ============ Fixtures: users + tenants (postgres) ============
-- Tenants criados direto pelo DBA (tenants_write_guard libera current_user
-- postgres/supabase_admin). O CONSTRAINT TRIGGER diferido
-- `tenant_acceptance_required` (0024) e desligado SO na criacao da fixture e
-- religado antes do COMMIT: este spec prova billing, nao aceite de contrato —
-- por isso nao cria `contract_acceptances` (o purge delas e append-only).
INSERT INTO auth.users (id, email) VALUES
  ('c5500000-0000-4000-8000-0000000000a1', 'free-0055@example.com'),
  ('c5500000-0000-4000-8000-0000000000b1', 'paid-0055@example.com'),
  ('c5500000-0000-4000-8000-0000000000c1', 'restrict-0055@example.com'),
  ('c5500000-0000-4000-8000-0000000000d1', 'updated-0055@example.com'),
  ('c5600000-0000-4000-8000-0000000000a1', 'invoice-a-0056@example.com'),
  ('c5600000-0000-4000-8000-0000000000b1', 'invoice-b-0056@example.com'),
  ('c5700000-0000-4000-8000-0000000000a1', 'mirror-free-0058@example.com'),
  ('c5700000-0000-4000-8000-0000000000b1', 'mirror-trial-0058@example.com'),
  ('c5700000-0000-4000-8000-0000000000c1', 'mirror-active-0058@example.com'),
  ('c5700000-0000-4000-8000-0000000000d1', 'deprecated-rpc-0058@example.com');

BEGIN;
ALTER TABLE public.tenants DISABLE TRIGGER tenant_acceptance_required;
INSERT INTO public.tenants (id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status) VALUES
  ('c5500000-0000-4000-8000-0000000001a1', 'pf', 'c5500000-0000-4000-8000-0000000000a1',
   '55000000187', 'Free 0055', 'free', 'trial'),
  ('c5500000-0000-4000-8000-0000000001b1', 'pf', 'c5500000-0000-4000-8000-0000000000b1',
   '55000000268', 'Pago 0055', 'standard', 'trial'),
  ('c5500000-0000-4000-8000-0000000001c1', 'pf', 'c5500000-0000-4000-8000-0000000000c1',
   '55000000349', 'Restrict 0055', 'standard', 'trial'),
  ('c5500000-0000-4000-8000-0000000001d1', 'pf', 'c5500000-0000-4000-8000-0000000000d1',
   '55000000420', 'Updated 0055', 'free', 'active'),
  ('c5600000-0000-4000-8000-0000000001a1', 'pf', 'c5600000-0000-4000-8000-0000000000a1',
   '56100000187', 'Invoice A 0056', 'standard', 'trial'),
  ('c5600000-0000-4000-8000-0000000001b1', 'pf', 'c5600000-0000-4000-8000-0000000000b1',
   '56200000268', 'Invoice B 0056', 'standard', 'trial'),
  ('c5700000-0000-4000-8000-0000000001a1', 'pf', 'c5700000-0000-4000-8000-0000000000a1',
   '57100000187', 'Mirror Free 0058', 'free', 'trial'),
  ('c5700000-0000-4000-8000-0000000001b1', 'pf', 'c5700000-0000-4000-8000-0000000000b1',
   '57200000268', 'Mirror Trial 0058', 'standard', 'trial'),
  ('c5700000-0000-4000-8000-0000000001c1', 'pf', 'c5700000-0000-4000-8000-0000000000c1',
   '57300000349', 'Mirror Active 0058', 'standard', 'active'),
  ('c5700000-0000-4000-8000-0000000001d1', 'pf', 'c5700000-0000-4000-8000-0000000000d1',
   '57400000420', 'Deprecated RPC 0058', 'free', 'active');
ALTER TABLE public.tenants ENABLE TRIGGER tenant_acceptance_required;
COMMIT;

-- ============ T01 — uma assinatura por tenant ============
BEGIN;
DO $$
DECLARE
  v_n int;
  v_constraint text;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status)
  VALUES ('c5500000-0000-4000-8000-0000000001a1', 'free', 'active');

  BEGIN
    INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status)
    VALUES ('c5500000-0000-4000-8000-0000000001a1', 'free', 'active');
    RAISE EXCEPTION '0055 T01 falhou: segunda assinatura aceita no mesmo tenant';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'tenant_subscriptions_tenant_uq' THEN
      RAISE EXCEPTION '0055 T01 falhou: unique violada em % (esperado tenant_subscriptions_tenant_uq)', v_constraint;
    END IF;
  END;

  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id = 'c5500000-0000-4000-8000-0000000001a1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0055 T01 falhou: linhas do tenant = % (esperado 1)', v_n;
  END IF;
  RAISE NOTICE '0055 T01 ok: segundo INSERT viola UNIQUE(tenant_id), 1 linha';
END $$;
ROLLBACK;

-- ============ T02 — CHECKs por plano (adendo §14) ============
-- Helper pg_temp: INSERT que DEVE violar o CHECK nomeado; 0 escrita.
CREATE OR REPLACE FUNCTION pg_temp.assert_check(
  p_label text,
  p_constraint text,
  p_tenant uuid,
  p_plan text,
  p_status text,
  p_trial_ends timestamptz,
  p_billing_day smallint,
  p_period_start date,
  p_period_end date,
  p_pending_plan text,
  p_pending_at date,
  p_cancel boolean,
  p_psp_subscription text DEFAULT NULL,
  p_psp_customer text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_constraint text;
BEGIN
  BEGIN
    INSERT INTO public.tenant_subscriptions (
      tenant_id, plan_slug, status, trial_ends_at, billing_day,
      period_start, period_end, pending_plan_slug, pending_plan_at,
      cancel_at_period_end, psp_subscription_id, psp_customer_id
    ) VALUES (
      p_tenant, p_plan, p_status, p_trial_ends, p_billing_day,
      p_period_start, p_period_end, p_pending_plan, p_pending_at, p_cancel,
      p_psp_subscription, p_psp_customer
    );
    RAISE EXCEPTION '0055-T02-FALHOU-DEVERIA: %', p_label;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0055-T02-FALHOU-DEVERIA:%' THEN RAISE; END IF;
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION '0055 T02 falhou: % SQLSTATE % (%)', p_label, SQLSTATE, SQLERRM;
    END IF;
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM p_constraint THEN
      RAISE EXCEPTION '0055 T02 falhou: % violou % (esperado %)', p_label, v_constraint, p_constraint;
    END IF;
  END;
END $$;

BEGIN;
DO $$
DECLARE
  v_tenant_free uuid := 'c5500000-0000-4000-8000-0000000001a1';
  v_tenant_paid uuid := 'c5500000-0000-4000-8000-0000000001b1';
  v_n int;
BEGIN
  -- Sucesso: free nasce `active` SEM ciclo nem aniversario.
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status)
  VALUES (v_tenant_free, 'free', 'active');
  -- Sucesso: free `canceled` tambem e permitido.
  DELETE FROM public.tenant_subscriptions WHERE tenant_id = v_tenant_free;
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status)
  VALUES (v_tenant_free, 'free', 'canceled');

  -- free nao pode `trial` (free_status). trial_ends_at preenchido para que a
  -- unica violacao seja free_status (trial_ends_check fica satisfeito).
  PERFORM pg_temp.assert_check('free status trial', 'tenant_subscriptions_free_status_check',
    v_tenant_free, 'free', 'trial', now() + interval '14 days', NULL, NULL, NULL, NULL, NULL, false);
  -- free nao tem aniversario (plan_cycle).
  PERFORM pg_temp.assert_check('free billing_day', 'tenant_subscriptions_plan_cycle_check',
    v_tenant_free, 'free', 'active', NULL, 10::smallint, NULL, NULL, NULL, NULL, false);
  -- free nao tem ciclo (plan_cycle).
  PERFORM pg_temp.assert_check('free period', 'tenant_subscriptions_plan_cycle_check',
    v_tenant_free, 'free', 'active', NULL, NULL, '2026-01-01', '2026-01-31', NULL, NULL, false);

  -- Sucesso: pago `trial` com billing_day e SEM periodo.
  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, trial_ends_at, billing_day
  ) VALUES (v_tenant_paid, 'standard', 'trial', now() + interval '14 days', 10);
  -- Sucesso: pago `active` com billing_day e SEM periodo (ciclo so abre no pagamento).
  DELETE FROM public.tenant_subscriptions WHERE tenant_id = v_tenant_paid;
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant_paid, 'standard', 'active', 10);
  DELETE FROM public.tenant_subscriptions WHERE tenant_id = v_tenant_paid;

  -- pago exige billing_day (plan_cycle).
  PERFORM pg_temp.assert_check('paid sem billing_day', 'tenant_subscriptions_plan_cycle_check',
    v_tenant_paid, 'standard', 'trial', now() + interval '14 days', NULL, NULL, NULL, NULL, NULL, false);
  -- trial exige trial_ends_at.
  PERFORM pg_temp.assert_check('trial sem trial_ends_at', 'tenant_subscriptions_trial_ends_check',
    v_tenant_paid, 'standard', 'trial', NULL, 10::smallint, NULL, NULL, NULL, NULL, false);
  -- billing_day fora de 1..31 (limite inferior).
  PERFORM pg_temp.assert_check('billing_day 0', 'tenant_subscriptions_billing_day_check',
    v_tenant_paid, 'standard', 'active', NULL, 0::smallint, NULL, NULL, NULL, NULL, false);
  -- billing_day fora de 1..31 (limite superior).
  PERFORM pg_temp.assert_check('billing_day 32', 'tenant_subscriptions_billing_day_check',
    v_tenant_paid, 'standard', 'active', NULL, 32::smallint, NULL, NULL, NULL, NULL, false);
  -- par de periodo pela metade.
  PERFORM pg_temp.assert_check('period_start sem period_end', 'tenant_subscriptions_period_pair_check',
    v_tenant_paid, 'standard', 'active', NULL, 10::smallint, '2026-01-01', NULL, NULL, NULL, false);
  -- periodo nao avanca (period_end = period_start).
  PERFORM pg_temp.assert_check('period_end <= period_start', 'tenant_subscriptions_period_order_check',
    v_tenant_paid, 'standard', 'active', NULL, 10::smallint, '2026-01-01', '2026-01-01', NULL, NULL, false);
  -- pendente pela metade.
  PERFORM pg_temp.assert_check('pending sem pending_at', 'tenant_subscriptions_pending_pair_check',
    v_tenant_paid, 'standard', 'active', NULL, 10::smallint, NULL, NULL, 'pro', NULL, false);
  -- pendente igual ao plano vigente.
  PERFORM pg_temp.assert_check('pending igual ao plano', 'tenant_subscriptions_pending_diff_check',
    v_tenant_paid, 'standard', 'active', NULL, 10::smallint, NULL, NULL, 'standard', '2026-02-01', false);
  -- psp_subscription_id acima de 255 chars (limite real do DDL: BETWEEN 1 AND 255).
  PERFORM pg_temp.assert_check('psp_subscription_id 256 chars', 'tenant_subscriptions_psp_subscription_len_check',
    v_tenant_paid, 'standard', 'active', NULL, 10::smallint, NULL, NULL, NULL, NULL, false,
    repeat('x', 256), NULL);
  -- psp_customer_id vazio (limite inferior do DDL: BETWEEN 1 AND 255).
  PERFORM pg_temp.assert_check('psp_customer_id vazio', 'tenant_subscriptions_psp_customer_len_check',
    v_tenant_paid, 'standard', 'active', NULL, 10::smallint, NULL, NULL, NULL, NULL, false,
    NULL, '');

  -- Nenhuma das falhas deixou linha.
  SELECT count(*) INTO v_n FROM public.tenant_subscriptions
  WHERE tenant_id = v_tenant_paid;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0055 T02 falhou: CHECK falho deixou linha (%)', v_n;
  END IF;
  RAISE NOTICE '0055 T02 ok: free/pago/trial/periodo/pendente/billing_day/psp_len recusados pelo CHECK certo';
END $$;
ROLLBACK;

-- ============ T03 — RESTRICT ao apagar tenant com assinatura ============
BEGIN;
DO $$
DECLARE
  v_n int;
  v_deleted int;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES ('c5500000-0000-4000-8000-0000000001c1', 'standard', 'active', 10);

  BEGIN
    DELETE FROM public.tenants WHERE id = 'c5500000-0000-4000-8000-0000000001c1';
    RAISE EXCEPTION '0055 T03 falhou: DELETE de tenant com assinatura passou';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  SELECT count(*) INTO v_n FROM public.tenants
  WHERE id = 'c5500000-0000-4000-8000-0000000001c1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0055 T03 falhou: tenant apagado apesar do RESTRICT (%)', v_n;
  END IF;
  SELECT count(*) INTO v_deleted FROM public.tenant_subscriptions
  WHERE tenant_id = 'c5500000-0000-4000-8000-0000000001c1';
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION '0055 T03 falhou: assinatura nao sobreviveu ao RESTRICT (%)', v_deleted;
  END IF;
  RAISE NOTICE '0055 T03 ok: DELETE do tenant falha (FK RESTRICT), ambos intactos';
END $$;
ROLLBACK;

-- ============ T04 — updated_at muda em UPDATE ============
BEGIN;
DO $$
DECLARE
  v_old timestamptz := '2020-01-01T00:00:00Z';
  v_new timestamptz;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, updated_at)
  VALUES ('c5500000-0000-4000-8000-0000000001d1', 'free', 'active', v_old);

  UPDATE public.tenant_subscriptions
  SET cancel_at_period_end = true
  WHERE tenant_id = 'c5500000-0000-4000-8000-0000000001d1';

  SELECT updated_at INTO v_new FROM public.tenant_subscriptions
  WHERE tenant_id = 'c5500000-0000-4000-8000-0000000001d1';
  IF v_new <= v_old THEN
    RAISE EXCEPTION '0055 T04 falhou: updated_at nao avancou (% -> %)', v_old, v_new;
  END IF;
  RAISE NOTICE '0055 T04 ok: set_updated_at avanca updated_at em UPDATE';
END $$;
ROLLBACK;

-- ============ T05 — tenant_invoices: uniques de competencia e de PSP ============
-- Helper reutilizado por T05/T06/T07: INSERT que DEVE violar a constraint
-- nomeada; 0 escrita. Isola o CHECK/UNIQUE por nome (nao depende de ordem).
CREATE OR REPLACE FUNCTION pg_temp.assert_invoice_constraint(
  p_label text,
  p_constraint text,
  p_tenant uuid,
  p_subscription uuid,
  p_competencia date,
  p_period_start date,
  p_period_end date,
  p_amount bigint,
  p_status text DEFAULT 'open',
  p_paid_at timestamptz DEFAULT NULL,
  p_psp_invoice text DEFAULT NULL,
  p_psp_payment text DEFAULT NULL,
  p_kind text DEFAULT 'cycle'
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_constraint text;
BEGIN
  BEGIN
    INSERT INTO public.tenant_invoices (
      tenant_id, subscription_id, kind, competencia, period_start, period_end,
      due_date, amount_cents, status, paid_at, psp_invoice_id, psp_payment_id
    ) VALUES (
      p_tenant, p_subscription, p_kind, p_competencia, p_period_start, p_period_end,
      p_period_start, p_amount, p_status, p_paid_at, p_psp_invoice, p_psp_payment
    );
    RAISE EXCEPTION '0056-FALHOU-DEVERIA: %', p_label;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0056-FALHOU-DEVERIA:%' THEN RAISE; END IF;
    IF SQLSTATE NOT IN ('23514', '23505') THEN
      RAISE EXCEPTION '0056 falhou: % SQLSTATE % (%)', p_label, SQLSTATE, SQLERRM;
    END IF;
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM p_constraint THEN
      RAISE EXCEPTION '0056 falhou: % violou % (esperado %)',
        p_label, v_constraint, p_constraint;
    END IF;
  END;
END $$;

BEGIN;
DO $$
DECLARE
  v_tenant_a uuid := 'c5600000-0000-4000-8000-0000000001a1';
  v_tenant_b uuid := 'c5600000-0000-4000-8000-0000000001b1';
  v_sub_a uuid;
  v_sub_b uuid;
  v_n int;
  v_constraint text;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant_a, 'standard', 'active', 10)
  RETURNING id INTO v_sub_a;
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant_b, 'standard', 'active', 10)
  RETURNING id INTO v_sub_b;

  -- Sucesso: primeira fatura da competencia (dia 1).
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents
  ) VALUES (
    v_tenant_a, v_sub_a, DATE '2026-01-01', DATE '2026-01-01', DATE '2026-01-31',
    DATE '2026-01-10', 1990
  );

  -- Falha: segunda fatura do mesmo tenant/competencia.
  BEGIN
    INSERT INTO public.tenant_invoices (
      tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents
    ) VALUES (
      v_tenant_a, v_sub_a, DATE '2026-01-01', DATE '2026-01-01', DATE '2026-01-31',
      DATE '2026-01-10', 1990
    );
    RAISE EXCEPTION '0056 T05 falhou: segunda fatura da competencia aceita';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'tenant_invoices_tenant_competencia_uq' THEN
      RAISE EXCEPTION '0056 T05 falhou: unique de competencia em % (esperado tenant_invoices_tenant_competencia_uq)', v_constraint;
    END IF;
  END;

  -- Sucesso: faturas de outros tenants/competencias com ids de PSP.
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, psp_invoice_id
  ) VALUES (
    v_tenant_b, v_sub_b, DATE '2026-02-01', DATE '2026-02-01', DATE '2026-02-28',
    DATE '2026-02-10', 3990, 'c56-inv-1'
  );
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, psp_payment_id
  ) VALUES (
    v_tenant_b, v_sub_b, DATE '2026-04-01', DATE '2026-04-01', DATE '2026-04-30',
    DATE '2026-04-10', 3990, 'c56-pay-1'
  );

  -- Falha: psp_invoice_id duplicado (unique parcial).
  PERFORM pg_temp.assert_invoice_constraint(
    'psp_invoice_id duplicado', 'tenant_invoices_psp_invoice_uq',
    v_tenant_a, v_sub_a, DATE '2026-03-01', DATE '2026-03-01', DATE '2026-03-31',
    1990, 'open', NULL, 'c56-inv-1', NULL
  );
  -- Falha: psp_payment_id duplicado (unique parcial).
  PERFORM pg_temp.assert_invoice_constraint(
    'psp_payment_id duplicado', 'tenant_invoices_psp_payment_uq',
    v_tenant_a, v_sub_a, DATE '2026-05-01', DATE '2026-05-01', DATE '2026-05-31',
    1990, 'open', NULL, NULL, 'c56-pay-1'
  );

  SELECT count(*) INTO v_n FROM public.tenant_invoices
  WHERE tenant_id IN (v_tenant_a, v_tenant_b);
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0056 T05 falhou: faturas = % (esperado 3; falha deixou linha)', v_n;
  END IF;
  RAISE NOTICE '0056 T05 ok: UNIQUE(tenant,competencia) + uniques parciais de PSP recusam duplicata';
END $$;
ROLLBACK;

-- ============ T06 — estrutura de 0056 + competencia dia 1 + bigint ============
BEGIN;
DO $$
DECLARE
  v_rel oid := to_regclass('public.tenant_invoices');
  v_count int;
  v_name text;
  v_def text;
  v_idx text;
  v_role text;
  v_priv text;
  v_sub uuid;
  v_tenant uuid := 'c5600000-0000-4000-8000-0000000001a1';
  v_type text;
BEGIN
  IF v_rel IS NULL THEN
    RAISE EXCEPTION '0056 T06 falhou: tabela public.tenant_invoices ausente';
  END IF;

  -- 15 colunas exatas de §4.2.
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_attribute
  WHERE attrelid = v_rel AND attnum > 0 AND NOT attisdropped;
  IF v_count <> 15 THEN
    RAISE EXCEPTION '0056 T06 falhou: tenant_invoices tem % colunas (esperado 15)', v_count;
  END IF;

  -- Dinheiro em BIGINT (nunca float/numeric).
  SELECT c.data_type INTO v_type
  FROM information_schema.columns AS c
  WHERE c.table_schema = 'public' AND c.table_name = 'tenant_invoices'
    AND c.column_name = 'amount_cents';
  IF v_type IS DISTINCT FROM 'bigint' THEN
    RAISE EXCEPTION '0056 T06 falhou: amount_cents tipo % (esperado bigint)', v_type;
  END IF;

  -- Constraints nomeadas (6 CHECKs + unique de competencia + pkey).
  FOREACH v_name IN ARRAY ARRAY[
    'tenant_invoices_pkey',
    'tenant_invoices_tenant_competencia_uq',
    'tenant_invoices_kind_check',
    'tenant_invoices_status_check',
    'tenant_invoices_competencia_day1_check',
    'tenant_invoices_period_order_check',
    'tenant_invoices_amount_check',
    'tenant_invoices_paid_at_check'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = v_rel AND conname = v_name
    ) THEN
      RAISE EXCEPTION '0056 T06 falhou: constraint % ausente', v_name;
    END IF;
  END LOOP;

  -- Nenhum CHECK pode sumir (contagem exata).
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = v_rel AND contype = 'c';
  IF v_count <> 6 THEN
    RAISE EXCEPTION '0056 T06 falhou: tenant_invoices tem % CHECKs (esperado 6)', v_count;
  END IF;

  -- FKs: tenants + tenant_subscriptions, ambas ON DELETE RESTRICT.
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = v_rel AND contype = 'f' AND confdeltype = 'r';
  IF v_count <> 2 THEN
    RAISE EXCEPTION '0056 T06 falhou: FKs RESTRICT = % (esperado 2)', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = v_rel AND contype = 'f'
      AND confrelid = 'public.tenants'::regclass
  ) THEN
    RAISE EXCEPTION '0056 T06 falhou: FK tenant_id->tenants ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = v_rel AND contype = 'f'
      AND confrelid = 'public.tenant_subscriptions'::regclass
  ) THEN
    RAISE EXCEPTION '0056 T06 falhou: FK subscription_id->tenant_subscriptions ausente';
  END IF;

  -- ZERO FK para invoices (fatura de cartao do usuario).
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = v_rel AND contype = 'f'
    AND confrelid = 'public.invoices'::regclass;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0056 T06 falhou: % FK para invoices (proibido)', v_count;
  END IF;

  -- Uniques parciais de PSP (indices).
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public' AND tablename = 'tenant_invoices'
    AND indexdef LIKE 'CREATE UNIQUE INDEX%'
    AND indexdef LIKE '%(psp_invoice_id)%'
    AND indexdef LIKE '%WHERE%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0056 T06 falhou: unique parcial de psp_invoice_id = % (esperado 1)', v_count;
  END IF;
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public' AND tablename = 'tenant_invoices'
    AND indexdef LIKE 'CREATE UNIQUE INDEX%'
    AND indexdef LIKE '%(psp_payment_id)%'
    AND indexdef LIKE '%WHERE%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0056 T06 falhou: unique parcial de psp_payment_id = % (esperado 1)', v_count;
  END IF;

  -- RLS ligada e ZERO policy; nenhum privilegio de cliente/service_role.
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = v_rel) THEN
    RAISE EXCEPTION '0056 T06 falhou: ROW LEVEL SECURITY desabilitada';
  END IF;
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'tenant_invoices';
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0056 T06 falhou: % policy criada (esperado 0)', v_count;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.tenant_invoices', v_priv) THEN
        RAISE EXCEPTION '0056 T06 falhou: % tem % em tenant_invoices', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c,
         pg_catalog.aclexplode(c.relacl) AS a
    WHERE c.oid = v_rel AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION '0056 T06 falhou: PUBLIC ainda tem privilegio em tenant_invoices';
  END IF;

  -- COMMENT ON TABLE declarando o deny intencional.
  SELECT pg_catalog.obj_description(v_rel, 'pg_class') INTO v_def;
  IF v_def IS NULL OR pg_catalog.btrim(v_def) = '' THEN
    RAISE EXCEPTION '0056 T06 falhou: COMMENT ON TABLE tenant_invoices ausente';
  END IF;

  -- Triggers: set_updated_at + guards de tenant e imutabilidade/transicao.
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = v_rel
    AND NOT tgisinternal
    AND tgfoid = 'public.set_updated_at()'::regprocedure;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0056 T06 falhou: trigger set_updated_at = % (esperado 1)', v_count;
  END IF;
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = v_rel
    AND NOT tgisinternal
    AND tgname IN ('tenant_invoices_tenant_guard', 'tenant_invoices_immutable_guard');
  IF v_count <> 2 THEN
    RAISE EXCEPTION '0056 T06 falhou: guards de tenant/imutabilidade = % (esperado 2)', v_count;
  END IF;

  -- Competencia fora do dia 1 e amount negativo recusados pelo CHECK certo.
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant, 'standard', 'active', 10)
  RETURNING id INTO v_sub;
  PERFORM pg_temp.assert_invoice_constraint(
    'competencia dia 2', 'tenant_invoices_competencia_day1_check',
    v_tenant, v_sub, DATE '2026-01-02', DATE '2026-01-01', DATE '2026-01-31',
    1990
  );
  PERFORM pg_temp.assert_invoice_constraint(
    'amount negativo', 'tenant_invoices_amount_check',
    v_tenant, v_sub, DATE '2026-01-01', DATE '2026-01-01', DATE '2026-01-31',
    -1
  );

  RAISE NOTICE '0056 T06 ok: 15 colunas, 6 CHECKs, FKs RESTRICT, 2 uniques parciais, RLS sem policy, REVOKE ALL, guards';
END $$;
ROLLBACK;

-- ============ T07 — paid_at coerente com status ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5600000-0000-4000-8000-0000000001a1';
  v_sub uuid;
  v_invoice uuid;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant, 'standard', 'active', 10)
  RETURNING id INTO v_sub;

  -- Falha: `paid` sem paid_at.
  PERFORM pg_temp.assert_invoice_constraint(
    'paid sem paid_at', 'tenant_invoices_paid_at_check',
    v_tenant, v_sub, DATE '2026-01-01', DATE '2026-01-01', DATE '2026-01-31',
    1990, 'paid', NULL
  );
  -- Sucesso: `paid` com paid_at; `open` sem paid_at.
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, status, paid_at
  ) VALUES (
    v_tenant, v_sub, DATE '2026-02-01', DATE '2026-02-01', DATE '2026-02-28',
    DATE '2026-02-10', 1990, 'paid', pg_catalog.now()
  ) RETURNING id INTO v_invoice;
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents
  ) VALUES (
    v_tenant, v_sub, DATE '2026-03-01', DATE '2026-03-01', DATE '2026-03-31',
    DATE '2026-03-10', 1990
  );

  -- Falha: open -> paid sem paid_at (CHECK, nao transicao).
  BEGIN
    UPDATE public.tenant_invoices SET status = 'paid'
    WHERE tenant_id = v_tenant AND competencia = DATE '2026-03-01';
    RAISE EXCEPTION '0056 T07 falhou: open->paid sem paid_at aceito';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%tenant_invoices_paid_at_check%' THEN
      RAISE EXCEPTION '0056 T07 falhou: CHECK errado (%)', SQLERRM;
    END IF;
  END;

  RAISE NOTICE '0056 T07 ok: status=paid exige paid_at (INSERT e UPDATE)';
END $$;
ROLLBACK;

-- ============ T08 — invoice-tenant-mismatch (fatura de outro tenant) ============
BEGIN;
DO $$
DECLARE
  v_tenant_a uuid := 'c5600000-0000-4000-8000-0000000001a1';
  v_tenant_b uuid := 'c5600000-0000-4000-8000-0000000001b1';
  v_sub_a uuid;
  v_n int;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant_a, 'standard', 'active', 10)
  RETURNING id INTO v_sub_a;

  BEGIN
    INSERT INTO public.tenant_invoices (
      tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents
    ) VALUES (
      v_tenant_b, v_sub_a, DATE '2026-01-01', DATE '2026-01-01', DATE '2026-01-31',
      DATE '2026-01-10', 1990
    );
    RAISE EXCEPTION '0056 T08 falhou: fatura cruzando tenant aceita';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0056 T08 falhou:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%invoice-tenant-mismatch%' THEN
      RAISE EXCEPTION '0056 T08 falhou: rotulo % (esperado invoice-tenant-mismatch)', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE tenant_id = v_tenant_b;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0056 T08 falhou: guard deixou % fatura(s)', v_n;
  END IF;
  RAISE NOTICE '0056 T08 ok: subscription de outro tenant recusada com invoice-tenant-mismatch, 0 escrita';
END $$;
ROLLBACK;

-- ============ T09 — imutabilidade de fatura paid/refunded ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5600000-0000-4000-8000-0000000001a1';
  v_sub uuid;
  v_paid uuid;
  v_refunded uuid;
  v_amount bigint;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant, 'standard', 'active', 10)
  RETURNING id INTO v_sub;

  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, status, paid_at
  ) VALUES (
    v_tenant, v_sub, DATE '2026-01-01', DATE '2026-01-01', DATE '2026-01-31',
    DATE '2026-01-10', 1990, 'paid', pg_catalog.now()
  ) RETURNING id INTO v_paid;

  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, status, paid_at
  ) VALUES (
    v_tenant, v_sub, DATE '2026-02-01', DATE '2026-02-01', DATE '2026-02-28',
    DATE '2026-02-10', 3990, 'refunded', pg_catalog.now()
  ) RETURNING id INTO v_refunded;

  -- paid: amount_cents imutavel.
  BEGIN
    UPDATE public.tenant_invoices SET amount_cents = 100 WHERE id = v_paid;
    RAISE EXCEPTION '0056 T09 falhou: amount de fatura paid alterado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0056 T09 falhou:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%tenant-invoice-immutable%' THEN
      RAISE EXCEPTION '0056 T09 falhou: rotulo % (esperado tenant-invoice-immutable)', SQLERRM;
    END IF;
  END;

  -- paid: competencia/periodo imutaveis.
  BEGIN
    UPDATE public.tenant_invoices
    SET competencia = DATE '2026-03-01', period_start = DATE '2026-03-01', period_end = DATE '2026-03-31'
    WHERE id = v_paid;
    RAISE EXCEPTION '0056 T09 falhou: competencia/periodo de fatura paid alterados';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0056 T09 falhou:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%tenant-invoice-immutable%' THEN
      RAISE EXCEPTION '0056 T09 falhou: rotulo % (esperado tenant-invoice-immutable)', SQLERRM;
    END IF;
  END;

  -- refunded: periodo imutavel.
  BEGIN
    UPDATE public.tenant_invoices SET period_end = DATE '2026-03-28' WHERE id = v_refunded;
    RAISE EXCEPTION '0056 T09 falhou: periodo de fatura refunded alterado';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0056 T09 falhou:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%tenant-invoice-immutable%' THEN
      RAISE EXCEPTION '0056 T09 falhou: rotulo % (esperado tenant-invoice-immutable)', SQLERRM;
    END IF;
  END;

  SELECT amount_cents INTO v_amount FROM public.tenant_invoices WHERE id = v_paid;
  IF v_amount <> 1990 THEN
    RAISE EXCEPTION '0056 T09 falhou: amount de paid virou % (esperado 1990)', v_amount;
  END IF;
  RAISE NOTICE '0056 T09 ok: paid/refunded imutaveis em valor/competencia/periodo';
END $$;
ROLLBACK;

-- ============ T10 — transicoes de status fechadas ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5600000-0000-4000-8000-0000000001a1';
  v_sub uuid;
  v_id uuid;
  v_status text;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant, 'standard', 'active', 10)
  RETURNING id INTO v_sub;

  -- Helpers inline de insercao por status/competencia.
  -- open -> paid (com paid_at)
  INSERT INTO public.tenant_invoices (tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents)
  VALUES (v_tenant, v_sub, DATE '2026-01-01', DATE '2026-01-01', DATE '2026-01-31', DATE '2026-01-10', 1990)
  RETURNING id INTO v_id;
  UPDATE public.tenant_invoices SET status = 'paid', paid_at = pg_catalog.now() WHERE id = v_id;
  SELECT status INTO v_status FROM public.tenant_invoices WHERE id = v_id;
  IF v_status <> 'paid' THEN RAISE EXCEPTION '0056 T10 falhou: open->paid nao aplicou (%)', v_status; END IF;

  -- open -> overdue
  INSERT INTO public.tenant_invoices (tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents)
  VALUES (v_tenant, v_sub, DATE '2026-02-01', DATE '2026-02-01', DATE '2026-02-28', DATE '2026-02-10', 1990)
  RETURNING id INTO v_id;
  UPDATE public.tenant_invoices SET status = 'overdue' WHERE id = v_id;
  SELECT status INTO v_status FROM public.tenant_invoices WHERE id = v_id;
  IF v_status <> 'overdue' THEN RAISE EXCEPTION '0056 T10 falhou: open->overdue nao aplicou (%)', v_status; END IF;

  -- open -> canceled
  INSERT INTO public.tenant_invoices (tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents)
  VALUES (v_tenant, v_sub, DATE '2026-03-01', DATE '2026-03-01', DATE '2026-03-31', DATE '2026-03-10', 1990)
  RETURNING id INTO v_id;
  UPDATE public.tenant_invoices SET status = 'canceled' WHERE id = v_id;
  SELECT status INTO v_status FROM public.tenant_invoices WHERE id = v_id;
  IF v_status <> 'canceled' THEN RAISE EXCEPTION '0056 T10 falhou: open->canceled nao aplicou (%)', v_status; END IF;

  -- overdue -> paid
  INSERT INTO public.tenant_invoices (tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents, status)
  VALUES (v_tenant, v_sub, DATE '2026-04-01', DATE '2026-04-01', DATE '2026-04-30', DATE '2026-04-10', 1990, 'overdue')
  RETURNING id INTO v_id;
  UPDATE public.tenant_invoices SET status = 'paid', paid_at = pg_catalog.now() WHERE id = v_id;
  SELECT status INTO v_status FROM public.tenant_invoices WHERE id = v_id;
  IF v_status <> 'paid' THEN RAISE EXCEPTION '0056 T10 falhou: overdue->paid nao aplicou (%)', v_status; END IF;

  -- paid -> refunded
  UPDATE public.tenant_invoices SET status = 'refunded' WHERE id = v_id;
  SELECT status INTO v_status FROM public.tenant_invoices WHERE id = v_id;
  IF v_status <> 'refunded' THEN RAISE EXCEPTION '0056 T10 falhou: paid->refunded nao aplicou (%)', v_status; END IF;

  -- open -> refunded (invalida)
  INSERT INTO public.tenant_invoices (tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents)
  VALUES (v_tenant, v_sub, DATE '2026-05-01', DATE '2026-05-01', DATE '2026-05-31', DATE '2026-05-10', 1990)
  RETURNING id INTO v_id;
  BEGIN
    UPDATE public.tenant_invoices SET status = 'refunded' WHERE id = v_id;
    RAISE EXCEPTION '0056 T10 falhou: open->refunded aceita';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0056 T10 falhou:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%tenant-invoice-transition-invalid%' THEN
      RAISE EXCEPTION '0056 T10 falhou: rotulo % (esperado tenant-invoice-transition-invalid)', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.tenant_invoices WHERE id = v_id;
  IF v_status <> 'open' THEN RAISE EXCEPTION '0056 T10 falhou: transicao invalida alterou status (%)', v_status; END IF;

  -- canceled -> paid (invalida)
  INSERT INTO public.tenant_invoices (tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents, status)
  VALUES (v_tenant, v_sub, DATE '2026-06-01', DATE '2026-06-01', DATE '2026-06-30', DATE '2026-06-10', 1990, 'canceled')
  RETURNING id INTO v_id;
  BEGIN
    UPDATE public.tenant_invoices SET status = 'paid', paid_at = pg_catalog.now() WHERE id = v_id;
    RAISE EXCEPTION '0056 T10 falhou: canceled->paid aceita';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0056 T10 falhou:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%tenant-invoice-transition-invalid%' THEN
      RAISE EXCEPTION '0056 T10 falhou: rotulo % (esperado tenant-invoice-transition-invalid)', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.tenant_invoices WHERE id = v_id;
  IF v_status <> 'canceled' THEN RAISE EXCEPTION '0056 T10 falhou: terminal canceled mudou (%)', v_status; END IF;

  -- refunded -> open (invalida)
  INSERT INTO public.tenant_invoices (tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents, status, paid_at)
  VALUES (v_tenant, v_sub, DATE '2026-07-01', DATE '2026-07-01', DATE '2026-07-31', DATE '2026-07-10', 1990, 'refunded', pg_catalog.now())
  RETURNING id INTO v_id;
  BEGIN
    UPDATE public.tenant_invoices SET status = 'open' WHERE id = v_id;
    RAISE EXCEPTION '0056 T10 falhou: refunded->open aceita';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0056 T10 falhou:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%tenant-invoice-transition-invalid%' THEN
      RAISE EXCEPTION '0056 T10 falhou: rotulo % (esperado tenant-invoice-transition-invalid)', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.tenant_invoices WHERE id = v_id;
  IF v_status <> 'refunded' THEN RAISE EXCEPTION '0056 T10 falhou: terminal refunded mudou (%)', v_status; END IF;

  RAISE NOTICE '0056 T10 ok: matriz de status fechada; invalidas preservam o estado';
END $$;
ROLLBACK;

-- ============ T11 — psp_events: uniques/checks do inbox ============
CREATE OR REPLACE FUNCTION pg_temp.assert_psp_constraint(
  p_label text,
  p_constraint text,
  p_event_id text,
  p_event_type text DEFAULT 'PAYMENT_CONFIRMED',
  p_event_kind text DEFAULT NULL,
  p_process_outcome text DEFAULT NULL,
  p_attempts int DEFAULT 0,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_provider text DEFAULT 'asaas'
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_constraint text;
BEGIN
  BEGIN
    INSERT INTO public.psp_events (
      provider, event_id, event_type, event_kind, process_outcome, attempts, payload
    ) VALUES (
      p_provider, p_event_id, p_event_type, p_event_kind, p_process_outcome, p_attempts, p_payload
    );
    RAISE EXCEPTION '0057-FALHOU-DEVERIA: %', p_label;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '0057-FALHOU-DEVERIA:%' THEN RAISE; END IF;
    IF SQLSTATE NOT IN ('23514', '23505', '23502') THEN
      RAISE EXCEPTION '0057 falhou: % SQLSTATE % (%)', p_label, SQLSTATE, SQLERRM;
    END IF;
    IF SQLSTATE = '23502' THEN
      RETURN;
    END IF;
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM p_constraint THEN
      RAISE EXCEPTION '0057 falhou: % violou % (esperado %)',
        p_label, v_constraint, p_constraint;
    END IF;
  END;
END $$;

BEGIN;
DO $$
DECLARE
  v_n int;
BEGIN
  -- Sucesso: payload e campos de classificacao nulos (pendente).
  INSERT INTO public.psp_events (event_id, event_type, payload)
  VALUES ('c57-evt-valid', 'PAYMENT_CONFIRMED', '{"id":"evt_valid"}'::jsonb);

  -- Falha: event_id duplicado.
  PERFORM pg_temp.assert_psp_constraint(
    'event_id duplicado', 'psp_events_event_id_uq', 'c57-evt-valid'
  );
  -- Falha: provider fora da lista fechada.
  PERFORM pg_temp.assert_psp_constraint(
    'provider stripe', 'psp_events_provider_check', 'c57-evt-bad-provider',
    'PAYMENT_CONFIRMED', NULL, NULL, 0, '{}'::jsonb, 'stripe'
  );
  -- Falha: event_kind fora do enum.
  PERFORM pg_temp.assert_psp_constraint(
    'event_kind bogus', 'psp_events_event_kind_check', 'c57-evt-bad-kind',
    'PAYMENT_CONFIRMED', 'bogus'
  );
  -- Falha: process_outcome fora do enum.
  PERFORM pg_temp.assert_psp_constraint(
    'process_outcome bogus', 'psp_events_process_outcome_check', 'c57-evt-bad-outcome',
    'PAYMENT_CONFIRMED', NULL, 'bogus'
  );
  -- Falha: attempts fora de 0..10.
  PERFORM pg_temp.assert_psp_constraint(
    'attempts -1', 'psp_events_attempts_check', 'c57-evt-bad-attempts',
    'PAYMENT_CONFIRMED', NULL, NULL, -1
  );
  PERFORM pg_temp.assert_psp_constraint(
    'attempts 11', 'psp_events_attempts_check', 'c57-evt-bad-attempts-2',
    'PAYMENT_CONFIRMED', NULL, NULL, 11
  );
  -- Falha: event_id vazio / event_type acima de 128.
  PERFORM pg_temp.assert_psp_constraint(
    'event_id vazio', 'psp_events_event_id_len_check', ''
  );
  PERFORM pg_temp.assert_psp_constraint(
    'event_type 129', 'psp_events_event_type_len_check', 'c57-evt-bad-type',
    repeat('x', 129)
  );
  -- Falha: payload nulo.
  PERFORM pg_temp.assert_psp_constraint(
    'payload nulo', NULL, 'c57-evt-bad-payload',
    'PAYMENT_CONFIRMED', NULL, NULL, 0, NULL
  );

  SELECT count(*) INTO v_n FROM public.psp_events;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0057 T11 falhou: inbox tem % linhas (esperado 1; falha deixou linha)', v_n;
  END IF;
  RAISE NOTICE '0057 T11 ok: UNIQUE(event_id), provider/kind/outcome/attempts/len/payload recusados pelo check certo';
END $$;
ROLLBACK;

-- ============ T12 — psp_events: grants (sem DML de tabela; 0066/Ed6) ============
BEGIN;
DO $$
DECLARE
  v_role text;
  v_priv text;
  v_rel oid := to_regclass('public.psp_events');
  v_n int;
BEGIN
  IF v_rel IS NULL THEN
    RAISE EXCEPTION '0057 T12 falhou: tabela public.psp_events ausente';
  END IF;

  IF pg_catalog.has_table_privilege('service_role', 'public.psp_events', 'INSERT') THEN
    RAISE EXCEPTION '0057 T12 falhou: service_role ainda com INSERT no inbox (revogado em 0066/Ed6)';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF pg_catalog.has_table_privilege('service_role', 'public.psp_events', v_priv) THEN
      RAISE EXCEPTION '0057 T12 falhou: service_role tem % no inbox', v_priv;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.psp_events', v_priv) THEN
        RAISE EXCEPTION '0057 T12 falhou: % tem % no inbox', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c,
         pg_catalog.aclexplode(c.relacl) AS a
    WHERE c.oid = v_rel AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION '0057 T12 falhou: PUBLIC ainda tem privilegio no inbox';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = v_rel) THEN
    RAISE EXCEPTION '0057 T12 falhou: ROW LEVEL SECURITY desabilitada';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'psp_events';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0057 T12 falhou: % policy criada (esperado 0)', v_n;
  END IF;

  RAISE NOTICE '0057 T12 ok: service_role sem privilegio de tabela; anon/authenticated sem privilegio; RLS sem policy';
END $$;
ROLLBACK;

-- 0066/Ed6: service_role nao insere nem le (42501 nos dois).
BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.psp_events (event_id, event_type, payload)
    VALUES ('c57-svc-insert', 'PAYMENT_CONFIRMED', '{}'::jsonb);
    RAISE EXCEPTION '0057 T12 falhou: service_role inseriu no inbox apos 0066';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.psp_events LIMIT 1;
    RAISE EXCEPTION '0057 T12 falhou: service_role leu psp_events';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RAISE NOTICE '0057 T12 ok: service_role sem INSERT/SELECT (42501, 0066/Ed6)';
END $$;
ROLLBACK;

-- authenticated e anon nao escrevem nem leem (42501).
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.psp_events (event_id, event_type, payload)
    VALUES ('c57-auth-insert', 'PAYMENT_CONFIRMED', '{}'::jsonb);
    RAISE EXCEPTION '0057 T12 falhou: authenticated inseriu no inbox';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.psp_events LIMIT 1;
    RAISE EXCEPTION '0057 T12 falhou: authenticated leu o inbox';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.psp_events LIMIT 1;
    RAISE EXCEPTION '0057 T12 falhou: anon leu o inbox';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RAISE NOTICE '0057 T12 ok: authenticated/anon recebem 42501 no inbox';
END $$;
ROLLBACK;

-- ============ T13 — espelho: INSERT e UPDATE na mesma transacao ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5700000-0000-4000-8000-0000000001a1';
  v_sub uuid;
  v_plan text;
  v_status text;
  v_audits int;
BEGIN
  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, billing_day, trial_ends_at
  ) VALUES (
    v_tenant, 'standard', 'trial', 10, pg_catalog.now() + interval '14 days'
  ) RETURNING id INTO v_sub;

  SELECT plan_id, subscription_status INTO v_plan, v_status
  FROM public.tenants WHERE id = v_tenant;
  IF v_plan <> 'standard' OR v_status <> 'trial' THEN
    RAISE EXCEPTION '0058 T13 falhou: espelho apos INSERT plan=% status=% (esperado standard/trial)', v_plan, v_status;
  END IF;
  -- Plano free->standard muda: 1 auditoria de plano; status trial->trial nao audita.
  SELECT count(*) INTO v_audits
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_audits <> 1 THEN
    RAISE EXCEPTION '0058 T13 falhou: auditorias apos INSERT = % (esperado 1)', v_audits;
  END IF;

  UPDATE public.tenant_subscriptions SET status = 'active' WHERE id = v_sub;

  SELECT subscription_status INTO v_status
  FROM public.tenants WHERE id = v_tenant;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION '0058 T13 falhou: espelho apos UPDATE = % (esperado active)', v_status;
  END IF;

  RAISE NOTICE '0058 T13 ok: INSERT e UPDATE refletem em tenants na mesma transacao';
END $$;
ROLLBACK;

-- ============ T14 — free trial->active: 1 auditoria com reason ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5700000-0000-4000-8000-0000000001a1';
  v_audits int;
  v_reason text;
  v_from text;
  v_to text;
  v_status text;
BEGIN
  PERFORM pg_catalog.set_config('app.tenant_reason', 'onboarding', true);
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status)
  VALUES (v_tenant, 'free', 'active');

  SELECT subscription_status INTO v_status FROM public.tenants WHERE id = v_tenant;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION '0058 T14 falhou: status do tenant = % (esperado active)', v_status;
  END IF;

  SELECT count(*) INTO v_audits
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_audits <> 1 THEN
    RAISE EXCEPTION '0058 T14 falhou: auditorias = % (esperado 1)', v_audits;
  END IF;

  SELECT from_value, to_value, reason INTO v_from, v_to, v_reason
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_from IS DISTINCT FROM 'trial' OR v_to IS DISTINCT FROM 'active'
     OR v_reason IS DISTINCT FROM 'onboarding' THEN
    RAISE EXCEPTION '0058 T14 falhou: trilha from=% to=% reason=% (esperado trial/active/onboarding)',
      v_from, v_to, v_reason;
  END IF;

  RAISE NOTICE '0058 T14 ok: free trial->active gera exatamente 1 auditoria com reason';
END $$;
ROLLBACK;

-- ============ T15 — pago sem mudanca de espelho nao audita ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5700000-0000-4000-8000-0000000001b1';
  v_old timestamptz;
  v_new timestamptz;
  v_audits int;
BEGIN
  SELECT updated_at INTO v_old FROM public.tenants WHERE id = v_tenant;

  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, billing_day, trial_ends_at
  ) VALUES (
    v_tenant, 'standard', 'trial', 10, pg_catalog.now() + interval '14 days'
  );

  SELECT updated_at INTO v_new FROM public.tenants WHERE id = v_tenant;
  IF v_new IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION '0058 T15 falhou: updated_at mudou sem mudanca de espelho';
  END IF;

  SELECT count(*) INTO v_audits
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_audits <> 0 THEN
    RAISE EXCEPTION '0058 T15 falhou: auditorias = % (esperado 0)', v_audits;
  END IF;
  RAISE NOTICE '0058 T15 ok: plano/status iguais nao atualizam tenants nem auditam';
END $$;
ROLLBACK;

-- ============ T16 — no-op nao altera updated_at nem audita ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5700000-0000-4000-8000-0000000001c1';
  v_sub uuid;
  v_old timestamptz;
  v_new timestamptz;
  v_audits int;
BEGIN
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES (v_tenant, 'standard', 'active', 10)
  RETURNING id INTO v_sub;

  SELECT updated_at INTO v_old FROM public.tenants WHERE id = v_tenant;

  -- UPDATE que nao muda plan/status (so o ciclo).
  UPDATE public.tenant_subscriptions
  SET period_start = DATE '2026-01-01', period_end = DATE '2026-01-31'
  WHERE id = v_sub;

  SELECT updated_at INTO v_new FROM public.tenants WHERE id = v_tenant;
  IF v_new IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION '0058 T16 falhou: updated_at do tenant mudou em UPDATE no-op';
  END IF;

  SELECT count(*) INTO v_audits
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_audits <> 0 THEN
    RAISE EXCEPTION '0058 T16 falhou: auditorias = % (esperado 0)', v_audits;
  END IF;
  RAISE NOTICE '0058 T16 ok: UPDATE no-op nao toca updated_at nem auditoria';
END $$;
ROLLBACK;

-- ============ T17 — reason correto na trilha do status ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5700000-0000-4000-8000-0000000001b1';
  v_sub uuid;
  v_audits int;
  v_reason text;
  v_from text;
  v_to text;
BEGIN
  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, billing_day, trial_ends_at
  ) VALUES (
    v_tenant, 'standard', 'trial', 10, pg_catalog.now() + interval '14 days'
  ) RETURNING id INTO v_sub;

  PERFORM pg_catalog.set_config('app.tenant_reason', 'psp:payment_confirmed', true);
  UPDATE public.tenant_subscriptions
  SET status = 'active', trial_ends_at = NULL
  WHERE id = v_sub;

  SELECT count(*) INTO v_audits
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_audits <> 1 THEN
    RAISE EXCEPTION '0058 T17 falhou: auditorias = % (esperado 1)', v_audits;
  END IF;

  SELECT from_value, to_value, reason INTO v_from, v_to, v_reason
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_from IS DISTINCT FROM 'trial' OR v_to IS DISTINCT FROM 'active'
     OR v_reason IS DISTINCT FROM 'psp:payment_confirmed' THEN
    RAISE EXCEPTION '0058 T17 falhou: trilha from=% to=% reason=% (esperado trial/active/psp:payment_confirmed)',
      v_from, v_to, v_reason;
  END IF;
  RAISE NOTICE '0058 T17 ok: reason do chamador viaja intacto para a trilha';
END $$;
ROLLBACK;

-- ============ T50 — admin_set_tenant_status deprecado (42501) ============
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF pg_catalog.has_function_privilege(
      v_role,
      'public.admin_set_tenant_status(uuid,text,text,text)',
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION '0058 T50 falhou: % ainda tem EXECUTE em admin_set_tenant_status', v_role;
    END IF;
  END LOOP;

  BEGIN
    PERFORM public.admin_set_tenant_status(
      'c5700000-0000-4000-8000-0000000001d1', 'active', NULL, 'teste'
    );
    RAISE EXCEPTION '0058 T50 falhou: authenticated executou admin_set_tenant_status';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RAISE NOTICE '0058 T50 ok: admin_set_tenant_status sem EXECUTE; authenticated recebe 42501';
END $$;
ROLLBACK;

-- ============ B5 — RPCs de escrita (0059): T18–T35 ============
-- Fixtures c59*: usuario + tenant + assinatura criados DENTRO do cenario
-- (BEGIN/ROLLBACK), portanto sem residuo permanente. O CONSTRAINT TRIGGER
-- diferido `tenant_acceptance_required` (0024) nao dispara em ROLLBACK, por
-- isso nao precisa ser desligado aqui. Todo cenario roda como postgres e cada
-- RPC de escrita e chamada no corpo do teste; o grant por papel e provado em
-- T18a via `has_function_privilege`.

CREATE OR REPLACE FUNCTION pg_temp.c59_hoje() RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date
$$;

CREATE OR REPLACE FUNCTION pg_temp.c59_next_start(p_anchor date, p_day int)
RETURNS date LANGUAGE plpgsql AS $$
DECLARE
  v_first date := (pg_catalog.date_trunc('month', p_anchor)::date + interval '1 month')::date;
  v_last date := (v_first + interval '1 month' - interval '1 day')::date;
BEGIN
  RETURN v_first + (LEAST(p_day, EXTRACT(DAY FROM v_last)::int) - 1);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c59_seed(
  p_tenant uuid, p_user uuid, p_cpf text, p_plan text, p_status text,
  p_trial_ends timestamptz DEFAULT NULL,
  p_billing_day smallint DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end date DEFAULT NULL,
  p_psp_subscription text DEFAULT NULL,
  p_psp_customer text DEFAULT NULL,
  p_past_due_since timestamptz DEFAULT NULL,
  p_pending_plan text DEFAULT NULL,
  p_pending_at date DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_sub uuid;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (p_user, replace(p_user::text, '-', '') || '@c59.test');
  INSERT INTO public.tenants (
    id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status
  ) VALUES (
    p_tenant, 'pf', p_user, p_cpf, 'C59 Billing', p_plan, p_status
  );
  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, trial_ends_at, billing_day,
    period_start, period_end, psp_subscription_id, psp_customer_id,
    past_due_since, pending_plan_slug, pending_plan_at
  ) VALUES (
    p_tenant, p_plan, p_status, p_trial_ends, p_billing_day,
    p_period_start, p_period_end, p_psp_subscription, p_psp_customer,
    p_past_due_since, p_pending_plan, p_pending_at
  ) RETURNING id INTO v_sub;
  RETURN v_sub;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c59_event(
  p_event_id text, p_event_type text,
  p_psp_subscription text DEFAULT NULL,
  p_psp_invoice text DEFAULT NULL,
  p_psp_payment text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.psp_events (
    provider, event_id, event_type, psp_subscription_id,
    psp_invoice_id, psp_payment_id, payload
  ) VALUES (
    'asaas', p_event_id, p_event_type, p_psp_subscription,
    p_psp_invoice, p_psp_payment, p_payload
  );
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c59_expect_error(
  p_label text, p_sql text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'C59-FALHOU-DEVERIA: %', p_label;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'C59-FALHOU-DEVERIA:%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION 'C59 falhou: % levantou "%" (esperado "%")',
        p_label, SQLERRM, p_expected;
    END IF;
  END;
END $$;

-- ============ T18a — estrutura das RPCs de escrita (0059) ============
BEGIN;
DO $$
DECLARE
  v_sig text;
  v_proc record;
  v_role text;
  v_helper text[] := ARRAY[
    'private.billing_next_cycle_start(date,smallint)',
    'private.billing_ensure_invoice(uuid,uuid,text,date,date,boolean,text,text)',
    'private.billing_audit(uuid,text,text,text)'
  ];
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.apply_psp_event(text)',
    'public.expire_subscriptions(integer)',
    'public.roll_period(uuid)'
  ] LOOP
    SELECT p.prosecdef, p.proconfig INTO v_proc
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = pg_catalog.to_regprocedure(v_sig);
    IF NOT FOUND THEN
      RAISE EXCEPTION '0059 T18a falhou: funcao % ausente', v_sig;
    END IF;
    IF v_proc.prosecdef IS DISTINCT FROM true THEN
      RAISE EXCEPTION '0059 T18a falhou: % sem SECURITY DEFINER', v_sig;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION '0059 T18a falhou: % sem search_path vazio', v_sig;
    END IF;
  END LOOP;

  IF pg_catalog.pg_get_function_result(
       'public.apply_psp_event(text)'::regprocedure) IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION '0059 T18a falhou: apply_psp_event nao retorna jsonb';
  END IF;
  IF pg_catalog.pg_get_function_result(
       'public.expire_subscriptions(integer)'::regprocedure) IS DISTINCT FROM 'integer' THEN
    RAISE EXCEPTION '0059 T18a falhou: expire_subscriptions nao retorna integer';
  END IF;
  IF pg_catalog.pg_get_function_result(
       'public.roll_period(uuid)'::regprocedure) IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION '0059 T18a falhou: roll_period nao retorna jsonb';
  END IF;

  -- apply: endurecimento do Ed6/Adendo A2 (0067) — `service_role` NAO tem
  -- EXECUTE no apply direto; a porta unica do Worker passa a ser
  -- `drain_psp_events` (que chama o apply como owner). Nao e afrouxamento:
  -- o assert anterior (EXECUTE concedido em 0059) foi revogado por desenho.
  -- roll: so service_role. expire: somente service_role (§4.6 revisado).
  IF pg_catalog.has_function_privilege(
       'service_role', 'public.apply_psp_event(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0059 T18a falhou: service_role ainda com EXECUTE em apply_psp_event (0067/A2 deveria revogar)';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.drain_psp_events(integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0059 T18a falhou: service_role sem EXECUTE em drain_psp_events';
  END IF;
  IF pg_catalog.has_function_privilege(
       'authenticated', 'public.apply_psp_event(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'anon', 'public.apply_psp_event(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0059 T18a falhou: apply_psp_event executavel por cliente';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.roll_period(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0059 T18a falhou: service_role sem EXECUTE em roll_period';
  END IF;
  IF pg_catalog.has_function_privilege(
       'authenticated', 'public.roll_period(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'anon', 'public.roll_period(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0059 T18a falhou: roll_period executavel por cliente';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.expire_subscriptions(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0059 T18a falhou: service_role sem EXECUTE em expire_subscriptions';
  END IF;
  IF pg_catalog.has_function_privilege(
       'authenticated', 'public.expire_subscriptions(integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'anon', 'public.expire_subscriptions(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0059 T18a falhou: expire_subscriptions executavel por cliente';
  END IF;

  -- Helpers privados existem e nao sao executaveis por papel cliente.
  FOREACH v_sig IN ARRAY v_helper LOOP
    IF pg_catalog.to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '0059 T18a falhou: helper % ausente', v_sig;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF pg_catalog.has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION '0059 T18a falhou: helper % executavel por %', v_sig, v_role;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '0059 T18a ok: 3 RPCs DEFINER/search_path com grants fechados; helper privado sem grant';
END $$;
ROLLBACK;

-- ============ T18b — expire_subscriptions negado ao cliente (42501) ============
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.expire_subscriptions(1);
    RAISE EXCEPTION '0059 T18b falhou: authenticated executou expire_subscriptions';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T18 — idempotencia por event_id (3x) ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010018';
  v_sub uuid;
  v_res jsonb;
  v_status text;
  v_outcome text;
  v_processed boolean;
  v_n int;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000018', '59000000018',
    'standard', 'trial', pg_catalog.now() + interval '10 days', 10::smallint,
    NULL, NULL, 'c59-t18-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t18', 'PAYMENT_CONFIRMED', 'c59-t18-sub', NULL, 'c59-t18-pay'
  );

  v_res := public.apply_psp_event('c59-evt-t18');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T18 falhou: 1a chamada outcome % (esperado applied)', v_res;
  END IF;
  IF v_res->>'transition' IS DISTINCT FROM 'trial->active' THEN
    RAISE EXCEPTION '0059 T18 falhou: transition % (esperado trial->active)', v_res;
  END IF;

  PERFORM pg_temp.c59_expect_error(
    '2a chamada', 'SELECT public.apply_psp_event(''c59-evt-t18'')',
    'psp-event-already-processed'
  );
  PERFORM pg_temp.c59_expect_error(
    '3a chamada', 'SELECT public.apply_psp_event(''c59-evt-t18'')',
    'psp-event-already-processed'
  );

  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T18 falhou: status % (esperado active)', v_status;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T18 falhou: faturas = % (esperado 1; sem dupla transicao)', v_n;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T18 falhou: auditorias de status = % (esperado 1)', v_n;
  END IF;

  SELECT process_outcome, processed_at IS NOT NULL
    INTO v_outcome, v_processed
  FROM public.psp_events WHERE event_id = 'c59-evt-t18';
  IF v_outcome IS DISTINCT FROM 'applied' OR NOT v_processed THEN
    RAISE EXCEPTION '0059 T18 falhou: evento outcome=% processed=% (esperado applied/true)',
      v_outcome, v_processed;
  END IF;

  RAISE NOTICE '0059 T18 ok: mesmo event_id 3x => 1 aplicacao + 2 already-processed';
END $$;
ROLLBACK;

-- ============ T19 — mesmo psp_payment_id nao duplica fatura ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010019';
  v_sub uuid;
  v_res jsonb;
  v_first_invoice uuid;
  v_second_invoice uuid;
  v_n int;
  v_amount bigint;
  v_outcome text;
  v_hoje date := pg_temp.c59_hoje();
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000019', '59000000019',
    'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c59-t19-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t19a', 'PAYMENT_CONFIRMED', 'c59-t19-sub', NULL, 'c59-t19-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t19a');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T19 falhou: 1o evento outcome %', v_res;
  END IF;
  v_first_invoice := (v_res->>'invoice_id')::uuid;

  PERFORM pg_temp.c59_event(
    'c59-evt-t19b', 'PAYMENT_CONFIRMED', 'c59-t19-sub', NULL, 'c59-t19-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t19b');
  IF v_res->>'outcome' IS DISTINCT FROM 'duplicate' THEN
    RAISE EXCEPTION '0059 T19 falhou: 2o evento outcome % (esperado duplicate)', v_res;
  END IF;
  v_second_invoice := (v_res->>'invoice_id')::uuid;
  IF v_second_invoice IS DISTINCT FROM v_first_invoice THEN
    RAISE EXCEPTION '0059 T19 falhou: invoice_id mudou (% -> %)',
      v_first_invoice, v_second_invoice;
  END IF;

  SELECT count(*), min(amount_cents) INTO v_n, v_amount
  FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T19 falhou: faturas = % (esperado 1)', v_n;
  END IF;
  IF v_amount <> public.get_plan_price('standard') THEN
    RAISE EXCEPTION '0059 T19 falhou: amount % (esperado catalogo)', v_amount;
  END IF;

  SELECT process_outcome INTO v_outcome
  FROM public.psp_events WHERE event_id = 'c59-evt-t19b';
  IF v_outcome IS DISTINCT FROM 'duplicate' THEN
    RAISE EXCEPTION '0059 T19 falhou: evento 2 outcome % (esperado duplicate)', v_outcome;
  END IF;

  RAISE NOTICE '0059 T19 ok: mesmo psp_payment_id => 1 fatura, 2o evento duplicate';
END $$;
ROLLBACK;

-- ============ T19x — psp_payment_id de outro tenant => psp-key-conflict ============
-- Um id de PSP ja vinculado ao tenant A nunca pode ser gravado no tenant B: a
-- RPC nao deixa o `23505` cru escapar, nao cria fatura para B e avanca attempts.
BEGIN;
DO $$
DECLARE
  v_tenant_a uuid := 'c5900000-0000-4000-8000-000000010046';
  v_tenant_b uuid := 'c5900000-0000-4000-8000-000000010047';
  v_sub_a uuid;
  v_sub_b uuid;
  v_res jsonb;
  v_status text;
  v_n int;
  v_attempts int;
  v_outcome text;
  v_processed boolean;
  v_inv_a_status text;
  v_inv_a_amount bigint;
BEGIN
  v_sub_a := pg_temp.c59_seed(
    v_tenant_a, 'c5900000-0000-4000-8000-000000000046', '59000000046',
    'standard', 'trial', pg_catalog.now() + interval '10 days', 10::smallint,
    NULL, NULL, 'c59-t19x-sub-a', NULL, NULL, NULL, NULL
  );
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end,
    due_date, amount_cents, status, paid_at, psp_payment_id
  ) VALUES (
    v_tenant_a, v_sub_a, pg_catalog.date_trunc('month', pg_temp.c59_hoje())::date,
    pg_temp.c59_hoje(), pg_temp.c59_hoje() + 10, pg_temp.c59_hoje(),
    public.get_plan_price('standard'), 'paid', pg_catalog.now(), 'c59-t19x-pay'
  );

  v_sub_b := pg_temp.c59_seed(
    v_tenant_b, 'c5900000-0000-4000-8000-000000000047', '59000000047',
    'standard', 'trial', pg_catalog.now() + interval '10 days', 10::smallint,
    NULL, NULL, 'c59-t19x-sub-b', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t19x', 'PAYMENT_CONFIRMED', 'c59-t19x-sub-b', NULL, 'c59-t19x-pay'
  );

  v_res := public.apply_psp_event('c59-evt-t19x');
  IF v_res->>'outcome' IS DISTINCT FROM 'rejected'
     OR v_res->>'reason' IS DISTINCT FROM 'psp-key-conflict'
     OR v_res->>'invoice_id' IS NOT NULL THEN
    RAISE EXCEPTION '0059 T19x falhou: envelope de colisao %', v_res;
  END IF;

  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub_b;
  IF v_status IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION '0059 T19x falhou: tenant B mudou de status (%)', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE tenant_id = v_tenant_b;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T19x falhou: tenant B ganhou % fatura(s)', v_n;
  END IF;

  SELECT status, amount_cents INTO v_inv_a_status, v_inv_a_amount
  FROM public.tenant_invoices WHERE tenant_id = v_tenant_a;
  IF v_inv_a_status IS DISTINCT FROM 'paid'
     OR v_inv_a_amount <> public.get_plan_price('standard') THEN
    RAISE EXCEPTION '0059 T19x falhou: fatura do tenant A tocada (%/%)',
      v_inv_a_status, v_inv_a_amount;
  END IF;

  SELECT attempts, process_outcome, processed_at IS NOT NULL
    INTO v_attempts, v_outcome, v_processed
  FROM public.psp_events WHERE event_id = 'c59-evt-t19x';
  IF v_attempts <> 1 OR v_outcome IS DISTINCT FROM 'rejected' OR NOT v_processed THEN
    RAISE EXCEPTION '0059 T19x falhou: evento attempts=% outcome=% processed=%',
      v_attempts, v_outcome, v_processed;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE tenant_id = v_tenant_b AND action = 'other' AND reason = 'psp-key-conflict';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T19x falhou: trilha psp-key-conflict = %', v_n;
  END IF;

  RAISE NOTICE '0059 T19x ok: colisao cross-tenant => rejected/psp-key-conflict, attempts avanca';
END $$;
ROLLBACK;

-- ============ T19y — concorrencia na colisao de chave (2 sessoes) ============
-- O TOCTOU classico: a fatura concorrente so existe DEPOIS do COMMIT do outro
-- evento, logo a pre-checagem roda em snapshot antigo e o `23505` chegaria no
-- INSERT — depois do UPDATE de estado. Aqui as duas sessoes usam o MESMO
-- psp_payment_id em tenants distintos: a sessao A segura o lock consultivo da
-- transacao aberta, a sessao B espera; ao acordar, a pre-checagem ja ve a fatura
-- de A e o evento B sai rejected/psp-key-conflict SEM tocar a assinatura de B
-- (estado comparado por snapshot integral, exceto `updated_at`).
-- Fixtures permanentes (dblink so enxerga COMMIT) removidas ao fim do bloco.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

BEGIN;
ALTER TABLE public.tenants DISABLE TRIGGER tenant_acceptance_required;
DO $$
DECLARE
  v_sub_a uuid;
  v_sub_b uuid;
BEGIN
  v_sub_a := pg_temp.c59_seed(
    'c5800000-0000-4000-8000-0000000001a1', 'c5800000-0000-4000-8000-0000000000a1',
    '58000000187', 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c58-t19y-sub-a', NULL, NULL, NULL, NULL
  );
  v_sub_b := pg_temp.c59_seed(
    'c5800000-0000-4000-8000-0000000001b1', 'c5800000-0000-4000-8000-0000000000b1',
    '58000000268', 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c58-t19y-sub-b', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c58-evt-t19y-a', 'PAYMENT_CONFIRMED', 'c58-t19y-sub-a', NULL, 'c58-t19y-pay'
  );
  PERFORM pg_temp.c59_event(
    'c58-evt-t19y-b', 'PAYMENT_CONFIRMED', 'c58-t19y-sub-b', NULL, 'c58-t19y-pay'
  );
  CREATE TEMP TABLE t19y_b_before AS
  SELECT (pg_catalog.to_jsonb(s) - 'updated_at') AS snap
  FROM public.tenant_subscriptions AS s
  WHERE s.id = v_sub_b;
END $$;
ALTER TABLE public.tenants ENABLE TRIGGER tenant_acceptance_required;
COMMIT;

SELECT extensions.dblink_connect(
  'c59_conc',
  format(
    'host=%s port=%s dbname=%s user=postgres password=postgres',
    host(inet_server_addr()), inet_server_port(), current_database()
  )
);

-- A aplica primeiro e mantem a transacao aberta (lock consultivo + linhas);
-- B e disparada assincronamente e fica bloqueada ate o COMMIT de A.
BEGIN;
SELECT public.apply_psp_event('c58-evt-t19y-a');
SELECT extensions.dblink_send_query(
  'c59_conc', 'SELECT public.apply_psp_event(''c58-evt-t19y-b'')'
);
SELECT pg_catalog.pg_sleep(0.5);
COMMIT;

DO $$
DECLARE
  v_res jsonb;
  v_snap_before jsonb;
  v_snap_after jsonb;
  v_sub_status text;
  v_tenant_status text;
  v_n int;
  v_outcome text;
BEGIN
  SELECT t.res INTO v_res
  FROM extensions.dblink_get_result('c59_conc') AS t(res jsonb);
  IF v_res->>'outcome' IS DISTINCT FROM 'rejected'
     OR v_res->>'reason' IS DISTINCT FROM 'psp-key-conflict'
     OR v_res->>'invoice_id' IS NOT NULL THEN
    RAISE EXCEPTION '0059 T19y falhou: evento B => %', v_res;
  END IF;

  -- Prova do TOCTOU: a assinatura de B tem de estar IDENTICA ao snapshot.
  SELECT snap INTO v_snap_before FROM t19y_b_before;
  SELECT (pg_catalog.to_jsonb(s) - 'updated_at') INTO v_snap_after
  FROM public.tenant_subscriptions AS s
  WHERE s.tenant_id = 'c5800000-0000-4000-8000-0000000001b1';
  IF v_snap_after IS DISTINCT FROM v_snap_before THEN
    RAISE EXCEPTION '0059 T19y falhou: assinatura B mudou no conflito (% -> %)',
      v_snap_before, v_snap_after;
  END IF;

  SELECT status INTO v_sub_status
  FROM public.tenant_subscriptions
  WHERE tenant_id = 'c5800000-0000-4000-8000-0000000001b1';
  IF v_sub_status IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION '0059 T19y falhou: status de B = % (esperado trial)', v_sub_status;
  END IF;

  SELECT subscription_status INTO v_tenant_status
  FROM public.tenants WHERE id = 'c5800000-0000-4000-8000-0000000001b1';
  IF v_tenant_status IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION '0059 T19y falhou: espelho de B = % (esperado trial)', v_tenant_status;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.tenant_invoices
  WHERE tenant_id = 'c5800000-0000-4000-8000-0000000001b1';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T19y falhou: B ganhou % fatura(s)', v_n;
  END IF;

  SELECT process_outcome INTO v_outcome
  FROM public.psp_events WHERE event_id = 'c58-evt-t19y-b';
  IF v_outcome IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION '0059 T19y falhou: evento B outcome % (esperado rejected)', v_outcome;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE tenant_id = 'c5800000-0000-4000-8000-0000000001b1'
    AND action = 'other' AND reason = 'psp-key-conflict';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T19y falhou: trilha psp-key-conflict = %', v_n;
  END IF;

  RAISE NOTICE '0059 T19y ok: concorrencia na chave => rejected com assinatura intacta';
END $$;

SELECT extensions.dblink_disconnect('c59_conc');

-- Cleanup das fixtures permanentes de T19y.
BEGIN;
DELETE FROM public.tenant_invoices AS i
USING public.tenants AS t
WHERE i.tenant_id = t.id
  AND t.owner_user_id = ANY (ARRAY[
    'c5800000-0000-4000-8000-0000000000a1',
    'c5800000-0000-4000-8000-0000000000b1'
  ]::uuid[]);
DELETE FROM public.psp_events WHERE event_id LIKE 'c58-%';
DELETE FROM public.tenant_subscriptions AS s
USING public.tenants AS t
WHERE s.tenant_id = t.id
  AND t.owner_user_id = ANY (ARRAY[
    'c5800000-0000-4000-8000-0000000000a1',
    'c5800000-0000-4000-8000-0000000000b1'
  ]::uuid[]);
DELETE FROM public.admin_audit AS a
USING public.tenants AS t
WHERE t.owner_user_id = ANY (ARRAY[
    'c5800000-0000-4000-8000-0000000000a1',
    'c5800000-0000-4000-8000-0000000000b1'
  ]::uuid[])
  AND (a.tenant_id = t.id OR a.target_id = t.id);
DELETE FROM auth.users
WHERE id = ANY (ARRAY[
  'c5800000-0000-4000-8000-0000000000a1',
  'c5800000-0000-4000-8000-0000000000b1'
]::uuid[]);
COMMIT;

-- ============ T20 — trial + payment_confirmed ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010020';
  v_sub uuid;
  v_res jsonb;
  v_status text;
  v_trial_null boolean;
  v_start date;
  v_end date;
  v_expected_end date;
  v_hoje date := pg_temp.c59_hoje();
  v_inv_status text;
  v_amount bigint;
  v_competencia date;
  v_payment text;
  v_audit int;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000020', '59000000020',
    'standard', 'trial', pg_catalog.now() + interval '10 days', 10::smallint,
    NULL, NULL, 'c59-t20-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t20', 'PAYMENT_RECEIVED', 'c59-t20-sub', NULL, 'c59-t20-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t20');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied'
     OR v_res->>'transition' IS DISTINCT FROM 'trial->active' THEN
    RAISE EXCEPTION '0059 T20 falhou: envelope %', v_res;
  END IF;

  SELECT status, trial_ends_at IS NULL, period_start, period_end
    INTO v_status, v_trial_null, v_start, v_end
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' OR NOT v_trial_null THEN
    RAISE EXCEPTION '0059 T20 falhou: status=% trial_null=%', v_status, v_trial_null;
  END IF;
  v_expected_end := pg_temp.c59_next_start(v_hoje, 10) - 1;
  IF v_start IS DISTINCT FROM v_hoje OR v_end IS DISTINCT FROM v_expected_end THEN
    RAISE EXCEPTION '0059 T20 falhou: ciclo %..% (esperado %..%)',
      v_start, v_end, v_hoje, v_expected_end;
  END IF;

  SELECT status, amount_cents, competencia, psp_payment_id
    INTO v_inv_status, v_amount, v_competencia, v_payment
  FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_inv_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION '0059 T20 falhou: fatura status % (esperado paid)', v_inv_status;
  END IF;
  IF v_amount <> public.get_plan_price('standard') THEN
    RAISE EXCEPTION '0059 T20 falhou: amount % (esperado catalogo)', v_amount;
  END IF;
  IF v_competencia IS DISTINCT FROM pg_catalog.date_trunc('month', v_start)::date THEN
    RAISE EXCEPTION '0059 T20 falhou: competencia % (esperado 1o dia do ciclo)', v_competencia;
  END IF;
  IF v_payment IS DISTINCT FROM 'c59-t20-pay' THEN
    RAISE EXCEPTION '0059 T20 falhou: psp_payment_id %', v_payment;
  END IF;

  SELECT count(*) INTO v_audit
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed'
    AND reason = 'psp:payment_confirmed';
  IF v_audit <> 1 THEN
    RAISE EXCEPTION '0059 T20 falhou: trilha psp:payment_confirmed = %', v_audit;
  END IF;

  RAISE NOTICE '0059 T20 ok: trial->active com ciclo aberto e fatura paid do catalogo';
END $$;
ROLLBACK;

-- ============ T20b — payment_confirmed sem psp_payment_id ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010021';
  v_sub uuid;
  v_status text;
  v_n int;
  v_outcome text;
  v_processed timestamp with time zone;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000021', '59000000021',
    'standard', 'trial', pg_catalog.now() + interval '10 days', 10::smallint,
    NULL, NULL, 'c59-t20b-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t20b', 'PAYMENT_CONFIRMED', 'c59-t20b-sub', NULL, NULL
  );
  PERFORM pg_temp.c59_expect_error(
    'confirmed sem payment id',
    'SELECT public.apply_psp_event(''c59-evt-t20b'')',
    'psp-event-invalid'
  );

  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION '0059 T20b falhou: status % (esperado trial)', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T20b falhou: % fatura(s) criada(s)', v_n;
  END IF;
  SELECT process_outcome, processed_at INTO v_outcome, v_processed
  FROM public.psp_events WHERE event_id = 'c59-evt-t20b';
  IF v_outcome IS NOT NULL OR v_processed IS NOT NULL THEN
    RAISE EXCEPTION '0059 T20b falhou: evento marcado como processado';
  END IF;

  RAISE NOTICE '0059 T20b ok: payment_confirmed sem lastro => psp-event-invalid, 0 escrita';
END $$;
ROLLBACK;

-- ============ T21 — renovacao avanca ao ciclo que contem hoje ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010022';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_old_start date := pg_temp.c59_hoje() - 90;
  v_old_end date := pg_temp.c59_hoje() - 1;
  v_expected_start date := v_old_start;
  v_expected_end date := v_old_end;
  v_start date;
  v_end date;
  v_n int;
  v_status text;
  v_competencia date;
BEGIN
  WHILE v_expected_end < v_hoje LOOP
    v_expected_start := pg_temp.c59_next_start(v_expected_start, 10);
    v_expected_end := pg_temp.c59_next_start(v_expected_start, 10) - 1;
  END LOOP;

  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000022', '59000000022',
    'standard', 'active', NULL, 10::smallint,
    v_old_start, v_old_end, 'c59-t21-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t21', 'PAYMENT_CONFIRMED', 'c59-t21-sub', NULL, 'c59-t21-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t21');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T21 falhou: outcome %', v_res;
  END IF;

  SELECT status, period_start, period_end INTO v_status, v_start, v_end
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T21 falhou: status % (esperado active)', v_status;
  END IF;
  IF v_start IS DISTINCT FROM v_expected_start OR v_end IS DISTINCT FROM v_expected_end THEN
    RAISE EXCEPTION '0059 T21 falhou: ciclo %..% (esperado %..%)',
      v_start, v_end, v_expected_start, v_expected_end;
  END IF;

  SELECT count(*), min(competencia) INTO v_n, v_competencia
  FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T21 falhou: faturas = % (esperado 1)', v_n;
  END IF;
  IF v_competencia IS DISTINCT FROM pg_catalog.date_trunc('month', v_start)::date THEN
    RAISE EXCEPTION '0059 T21 falhou: competencia % (esperado ciclo final)', v_competencia;
  END IF;

  RAISE NOTICE '0059 T21 ok: renovacao avanca ao ciclo de hoje; 1 fatura paga';
END $$;
ROLLBACK;

-- ============ T21b — renovacao aplica pending_plan antes de emitir a fatura ============
-- O pendente vence no limite do ciclo antigo: a fatura do novo ciclo sai com o
-- preco do plano NOVO, o pendente e limpo e a troca deixa trilha propria; virar
-- `free` limpa o ciclo e nao emite fatura.
BEGIN;
DO $$
DECLARE
  v_tenant_p uuid := 'c5900000-0000-4000-8000-000000010048';
  v_tenant_f uuid := 'c5900000-0000-4000-8000-000000010049';
  v_sub_p uuid;
  v_sub_f uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_old_start date := pg_temp.c59_hoje() - 90;
  v_old_end date := pg_temp.c59_hoje() - 1;
  v_exp_start date := v_old_start;
  v_exp_end date := v_old_end;
  v_plan text;
  v_pending text;
  v_pending_at date;
  v_billing smallint;
  v_status text;
  v_start date;
  v_end date;
  v_n int;
  v_amount bigint;
  v_audit int;
BEGIN
  WHILE v_exp_end < v_hoje LOOP
    v_exp_start := pg_temp.c59_next_start(v_exp_start, 10);
    v_exp_end := pg_temp.c59_next_start(v_exp_start, 10) - 1;
  END LOOP;

  v_sub_p := pg_temp.c59_seed(
    v_tenant_p, 'c5900000-0000-4000-8000-000000000048', '59000000048',
    'standard', 'active', NULL, 10::smallint,
    v_old_start, v_old_end, 'c59-t21b-p-sub', NULL, NULL, 'pro', v_old_end
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t21b-p', 'PAYMENT_CONFIRMED', 'c59-t21b-p-sub', NULL, 'c59-t21b-p-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t21b-p');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T21b falhou: pending pro outcome %', v_res;
  END IF;

  SELECT plan_slug, pending_plan_slug, pending_plan_at, billing_day, status,
         period_start, period_end
    INTO v_plan, v_pending, v_pending_at, v_billing, v_status, v_start, v_end
  FROM public.tenant_subscriptions WHERE id = v_sub_p;
  IF v_plan IS DISTINCT FROM 'pro' OR v_pending IS NOT NULL OR v_pending_at IS NOT NULL THEN
    RAISE EXCEPTION '0059 T21b falhou: plano=% pending=%/% (esperado pro/NULL)',
      v_plan, v_pending, v_pending_at;
  END IF;
  IF v_start IS DISTINCT FROM v_exp_start OR v_end IS DISTINCT FROM v_exp_end THEN
    RAISE EXCEPTION '0059 T21b falhou: ciclo %..% (esperado %..%)',
      v_start, v_end, v_exp_start, v_exp_end;
  END IF;
  IF v_billing IS DISTINCT FROM 10::smallint OR v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T21b falhou: billing=% status=%', v_billing, v_status;
  END IF;

  SELECT count(*), min(amount_cents), min(status) INTO v_n, v_amount, v_status
  FROM public.tenant_invoices WHERE subscription_id = v_sub_p;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T21b falhou: faturas = % (esperado 1)', v_n;
  END IF;
  IF v_amount IS DISTINCT FROM public.get_plan_price('pro') THEN
    RAISE EXCEPTION '0059 T21b falhou: fatura com preco % (esperado catalogo pro)',
      v_amount;
  END IF;
  IF v_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION '0059 T21b falhou: fatura status % (esperado paid)', v_status;
  END IF;

  SELECT count(*) INTO v_audit
  FROM public.admin_audit
  WHERE tenant_id = v_tenant_p AND action = 'other'
    AND reason = 'psp:pending_plan_applied'
    AND from_value = 'standard' AND to_value = 'pro';
  IF v_audit <> 1 THEN
    RAISE EXCEPTION '0059 T21b falhou: trilha da troca de plano = %', v_audit;
  END IF;

  -- Pendente `free`: limpa ciclo/aniversario e NAO emite fatura.
  v_sub_f := pg_temp.c59_seed(
    v_tenant_f, 'c5900000-0000-4000-8000-000000000049', '59000000049',
    'standard', 'active', NULL, 10::smallint,
    v_old_start, v_old_end, 'c59-t21b-f-sub', NULL, NULL, 'free', v_old_end
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t21b-f', 'PAYMENT_CONFIRMED', 'c59-t21b-f-sub', NULL, 'c59-t21b-f-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t21b-f');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' OR v_res->>'invoice_id' IS NOT NULL THEN
    RAISE EXCEPTION '0059 T21b falhou: pending free envelope %', v_res;
  END IF;

  SELECT plan_slug, pending_plan_slug, billing_day, period_start, period_end, status
    INTO v_plan, v_pending, v_billing, v_start, v_end, v_status
  FROM public.tenant_subscriptions WHERE id = v_sub_f;
  IF v_plan IS DISTINCT FROM 'free' OR v_pending IS NOT NULL
     OR v_billing IS NOT NULL OR v_start IS NOT NULL OR v_end IS NOT NULL THEN
    RAISE EXCEPTION '0059 T21b falhou: free plan=% pending=% billing=% period=%..%',
      v_plan, v_pending, v_billing, v_start, v_end;
  END IF;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T21b falhou: free status % (esperado active)', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub_f;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T21b falhou: free ganhou % fatura(s)', v_n;
  END IF;

  RAISE NOTICE '0059 T21b ok: renovacao aplica pendente, cobra plano novo e limpa ciclo no free';
END $$;
ROLLBACK;

-- ============ T22 — active com ciclo corrente nao avanca ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010023';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_start date;
  v_end date;
  v_status text;
  v_n int;
  v_amount bigint;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000023', '59000000023',
    'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c59-t22-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t22', 'PAYMENT_CONFIRMED', 'c59-t22-sub', NULL, 'c59-t22-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t22');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T22 falhou: outcome % (esperado applied)', v_res;
  END IF;

  SELECT status, period_start, period_end INTO v_status, v_start, v_end
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_start IS DISTINCT FROM v_hoje OR v_end IS DISTINCT FROM v_hoje + 10 THEN
    RAISE EXCEPTION '0059 T22 falhou: ciclo mudou para %..%', v_start, v_end;
  END IF;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T22 falhou: status %', v_status;
  END IF;

  SELECT count(*), min(amount_cents) INTO v_n, v_amount
  FROM public.tenant_invoices WHERE subscription_id = v_sub
    AND competencia = pg_catalog.date_trunc('month', v_hoje)::date AND status = 'paid';
  IF v_n <> 1 OR v_amount <> public.get_plan_price('standard') THEN
    RAISE EXCEPTION '0059 T22 falhou: fatura corrente n=% amount=%', v_n, v_amount;
  END IF;

  RAISE NOTICE '0059 T22 ok: ciclo corrente nao avanca; fatura do ciclo paga';
END $$;
ROLLBACK;

-- ============ T23 — active + payment_overdue ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010024';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_status text;
  v_past_due timestamptz;
  v_inv_status text;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000024', '59000000024',
    'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c59-t23-sub', NULL, NULL, NULL, NULL
  );
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents
  ) VALUES (
    v_tenant, v_sub, pg_catalog.date_trunc('month', v_hoje)::date,
    v_hoje, v_hoje + 10, v_hoje, public.get_plan_price('standard')
  );

  PERFORM pg_temp.c59_event(
    'c59-evt-t23', 'PAYMENT_OVERDUE', 'c59-t23-sub', NULL, NULL
  );
  v_res := public.apply_psp_event('c59-evt-t23');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied'
     OR v_res->>'transition' IS DISTINCT FROM 'active->past_due' THEN
    RAISE EXCEPTION '0059 T23 falhou: envelope %', v_res;
  END IF;

  SELECT status, past_due_since INTO v_status, v_past_due
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'past_due' OR v_past_due IS NULL THEN
    RAISE EXCEPTION '0059 T23 falhou: status=% past_due_since=%', v_status, v_past_due;
  END IF;

  SELECT status INTO v_inv_status
  FROM public.tenant_invoices WHERE subscription_id = v_sub
  ORDER BY competencia DESC LIMIT 1;
  IF v_inv_status IS DISTINCT FROM 'overdue' THEN
    RAISE EXCEPTION '0059 T23 falhou: fatura % (esperado overdue)', v_inv_status;
  END IF;

  RAISE NOTICE '0059 T23 ok: active+overdue => past_due, past_due_since e fatura overdue';
END $$;
ROLLBACK;

-- ============ T24 — past_due + payment_overdue e no-op ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010025';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_since timestamptz := '2026-01-02T00:00:00Z';
  v_status text;
  v_past_due timestamptz;
  v_audit int;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000025', '59000000025',
    'standard', 'past_due', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c59-t24-sub', NULL, v_since, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t24', 'PAYMENT_OVERDUE', 'c59-t24-sub', NULL, NULL
  );
  v_res := public.apply_psp_event('c59-evt-t24');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop' THEN
    RAISE EXCEPTION '0059 T24 falhou: outcome % (esperado noop)', v_res;
  END IF;

  SELECT status, past_due_since INTO v_status, v_past_due
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'past_due' OR v_past_due IS DISTINCT FROM v_since THEN
    RAISE EXCEPTION '0059 T24 falhou: status=% since=% (esperado past_due/% )',
      v_status, v_past_due, v_since;
  END IF;

  SELECT count(*) INTO v_audit
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'tenant_status_changed';
  IF v_audit <> 0 THEN
    RAISE EXCEPTION '0059 T24 falhou: % auditoria(s) em no-op', v_audit;
  END IF;

  RAISE NOTICE '0059 T24 ok: past_due+overdue nao reinicia past_due_since nem audita';
END $$;
ROLLBACK;

-- ============ T25 — past_due + payment_confirmed reactivates ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010026';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_status text;
  v_past_due timestamptz;
  v_inv_status text;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000026', '59000000026',
    'standard', 'past_due', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c59-t25-sub', NULL,
    pg_catalog.now() - interval '2 days', NULL, NULL
  );
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date, amount_cents
  ) VALUES (
    v_tenant, v_sub, pg_catalog.date_trunc('month', v_hoje)::date,
    v_hoje, v_hoje + 10, v_hoje, public.get_plan_price('standard')
  );

  PERFORM pg_temp.c59_event(
    'c59-evt-t25', 'PAYMENT_CONFIRMED', 'c59-t25-sub', NULL, 'c59-t25-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t25');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied'
     OR v_res->>'transition' IS DISTINCT FROM 'past_due->active' THEN
    RAISE EXCEPTION '0059 T25 falhou: envelope %', v_res;
  END IF;

  SELECT status, past_due_since INTO v_status, v_past_due
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' OR v_past_due IS NOT NULL THEN
    RAISE EXCEPTION '0059 T25 falhou: status=% since=%', v_status, v_past_due;
  END IF;

  SELECT status INTO v_inv_status
  FROM public.tenant_invoices WHERE subscription_id = v_sub
  ORDER BY competencia DESC LIMIT 1;
  IF v_inv_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION '0059 T25 falhou: fatura % (esperado paid)', v_inv_status;
  END IF;

  RAISE NOTICE '0059 T25 ok: past_due+confirmed => active, past_due_since NULL, fatura paga';
END $$;
ROLLBACK;

-- ============ T26 — trial + payment_overdue/refunded e no-op ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010027';
  v_sub uuid;
  v_res jsonb;
  v_status text;
  v_trial_ends timestamptz := pg_catalog.now() + interval '10 days';
  v_trial_after timestamptz;
  v_n int;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000027', '59000000027',
    'standard', 'trial', v_trial_ends, 10::smallint,
    NULL, NULL, 'c59-t26-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event('c59-evt-t26a', 'PAYMENT_OVERDUE', 'c59-t26-sub');
  v_res := public.apply_psp_event('c59-evt-t26a');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop' THEN
    RAISE EXCEPTION '0059 T26 falhou: overdue outcome % (esperado noop)', v_res;
  END IF;

  PERFORM pg_temp.c59_event(
    'c59-evt-t26b', 'PAYMENT_REFUNDED', 'c59-t26-sub', NULL, 'c59-t26-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t26b');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop' THEN
    RAISE EXCEPTION '0059 T26 falhou: refunded outcome % (esperado noop)', v_res;
  END IF;

  SELECT status, trial_ends_at INTO v_status, v_trial_after
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'trial' OR v_trial_after IS DISTINCT FROM v_trial_ends THEN
    RAISE EXCEPTION '0059 T26 falhou: status=% trial_ends=%', v_status, v_trial_after;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T26 falhou: % fatura(s) em trial', v_n;
  END IF;

  RAISE NOTICE '0059 T26 ok: trial+overdue/refunded sao no-op (nada a cobrar)';
END $$;
ROLLBACK;

-- ============ T27 — active + payment_refunded marca fatura ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010028';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_status text;
  v_inv_status text;
  v_amount bigint;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000028', '59000000028',
    'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c59-t27-sub', NULL, NULL, NULL, NULL
  );
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, status, paid_at, psp_payment_id
  ) VALUES (
    v_tenant, v_sub, pg_catalog.date_trunc('month', v_hoje)::date,
    v_hoje, v_hoje + 10, v_hoje, public.get_plan_price('standard'),
    'paid', pg_catalog.now(), 'c59-t27-pay'
  );

  PERFORM pg_temp.c59_event(
    'c59-evt-t27', 'PAYMENT_PARTIALLY_REFUNDED', 'c59-t27-sub', NULL, 'c59-t27-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t27');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T27 falhou: outcome % (esperado applied)', v_res;
  END IF;

  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T27 falhou: status % (esperado active)', v_status;
  END IF;

  SELECT status, amount_cents INTO v_inv_status, v_amount
  FROM public.tenant_invoices WHERE subscription_id = v_sub
  ORDER BY competencia DESC LIMIT 1;
  IF v_inv_status IS DISTINCT FROM 'refunded' THEN
    RAISE EXCEPTION '0059 T27 falhou: fatura % (esperado refunded)', v_inv_status;
  END IF;
  IF v_amount <> public.get_plan_price('standard') THEN
    RAISE EXCEPTION '0059 T27 falhou: refund reescreveu valor (%)', v_amount;
  END IF;

  RAISE NOTICE '0059 T27 ok: refund marca fatura refunded e nao mexe no status';
END $$;
ROLLBACK;

-- ============ T27b — estorno resolve a fatura pelo id do PSP do evento ============
-- Duas faturas pagas do mesmo tenant: o estorno da competencia ANTERIOR nao pode
-- marcar a mais recente. Sem match de PSP => noop + trilha propria, nenhuma
-- fatura e estornada por adivinhacao.
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010050';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_mes date := pg_catalog.date_trunc('month', pg_temp.c59_hoje())::date;
  v_prev date := (pg_catalog.date_trunc('month', pg_temp.c59_hoje())::date
                  - interval '1 month')::date;
  v_status text;
  v_n int;
  v_audit int;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000050', '59000000050',
    'standard', 'active', NULL, 10::smallint,
    v_mes, v_mes + 10, 'c59-t27b-sub', NULL, NULL, NULL, NULL
  );
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, status, paid_at, psp_payment_id
  ) VALUES
  (
    v_tenant, v_sub, v_prev, v_prev, v_prev + 10, v_prev,
    public.get_plan_price('standard'), 'paid', pg_catalog.now(), 'c59-t27b-oct'
  ),
  (
    v_tenant, v_sub, v_mes, v_mes, v_mes + 10, v_mes,
    public.get_plan_price('standard'), 'paid', pg_catalog.now(), 'c59-t27b-nov'
  );

  PERFORM pg_temp.c59_event(
    'c59-evt-t27b', 'PAYMENT_REFUNDED', 'c59-t27b-sub', NULL, 'c59-t27b-oct'
  );
  v_res := public.apply_psp_event('c59-evt-t27b');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T27b falhou: outcome % (esperado applied)', v_res;
  END IF;

  SELECT status INTO v_status
  FROM public.tenant_invoices
  WHERE subscription_id = v_sub AND competencia = v_prev;
  IF v_status IS DISTINCT FROM 'refunded' THEN
    RAISE EXCEPTION '0059 T27b falhou: fatura anterior % (esperado refunded)', v_status;
  END IF;
  SELECT status INTO v_status
  FROM public.tenant_invoices
  WHERE subscription_id = v_sub AND competencia = v_mes;
  IF v_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION '0059 T27b falhou: fatura recente % (esperado paid intacta)', v_status;
  END IF;

  -- Estorno cujo id de PSP nao casa nenhuma fatura: nao estorna nada.
  PERFORM pg_temp.c59_event(
    'c59-evt-t27b-x', 'PAYMENT_REFUNDED', 'c59-t27b-sub', NULL, 'c59-t27b-missing'
  );
  v_res := public.apply_psp_event('c59-evt-t27b-x');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop' OR v_res->>'invoice_id' IS NOT NULL THEN
    RAISE EXCEPTION '0059 T27b falhou: refund sem match => %', v_res;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.tenant_invoices
  WHERE subscription_id = v_sub AND status IN ('paid', 'refunded');
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0059 T27b falhou: faturas = % (esperado 2)', v_n;
  END IF;
  SELECT status INTO v_status
  FROM public.tenant_invoices
  WHERE subscription_id = v_sub AND competencia = v_mes;
  IF v_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION '0059 T27b falhou: refund sem match tocou a fatura recente (%)', v_status;
  END IF;

  SELECT count(*) INTO v_audit
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'other'
    AND reason = 'psp:refund_invoice_not_found';
  IF v_audit <> 1 THEN
    RAISE EXCEPTION '0059 T27b falhou: trilha de refund sem match = %', v_audit;
  END IF;

  RAISE NOTICE '0059 T27b ok: estorno marca a fatura do psp_payment_id; sem match => noop auditado';
END $$;
ROLLBACK;

-- ============ T27c — ids cruzados: payment de uma fatura, invoice de outra ============
-- O evento traz `psp_payment_id` da competencia anterior e `psp_invoice_id` da
-- competencia corrente. Sao faturas diferentes: adivinhar qual estornar e
-- proibido. Resultado: `noop` + trilha, ZERO UPDATE. Resolucao e por
-- `psp_payment_id` primeiro; `psp_invoice_id` so entra quando o payment nao casa.
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010051';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_mes date := pg_catalog.date_trunc('month', pg_temp.c59_hoje())::date;
  v_prev date := (pg_catalog.date_trunc('month', pg_temp.c59_hoje())::date
                  - interval '1 month')::date;
  v_status text;
  v_n int;
  v_audit int;
  v_outcome text;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000051', '59000000051',
    'standard', 'active', NULL, 10::smallint,
    v_mes, v_mes + 10, 'c59-t27c-sub', NULL, NULL, NULL, NULL
  );
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, status, paid_at, psp_invoice_id, psp_payment_id
  ) VALUES
  (
    v_tenant, v_sub, v_prev, v_prev, v_prev + 10, v_prev,
    public.get_plan_price('standard'), 'paid', pg_catalog.now(),
    'c59-t27c-prev-inv', 'c59-t27c-prev-pay'
  ),
  (
    v_tenant, v_sub, v_mes, v_mes, v_mes + 10, v_mes,
    public.get_plan_price('standard'), 'paid', pg_catalog.now(),
    'c59-t27c-mes-inv', 'c59-t27c-mes-pay'
  );

  -- Cruzado: payment da fatura anterior + invoice da fatura corrente.
  PERFORM pg_temp.c59_event(
    'c59-evt-t27c-x', 'PAYMENT_REFUNDED', 'c59-t27c-sub',
    'c59-t27c-mes-inv', 'c59-t27c-prev-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t27c-x');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop' OR v_res->>'invoice_id' IS NOT NULL THEN
    RAISE EXCEPTION '0059 T27c falhou: ids cruzados => %', v_res;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.tenant_invoices
  WHERE subscription_id = v_sub AND status = 'paid';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0059 T27c falhou: faturas pagas = % (esperado 2 intactas)', v_n;
  END IF;

  SELECT count(*) INTO v_audit
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'other'
    AND reason = 'psp:refund_invoice_not_found';
  IF v_audit <> 1 THEN
    RAISE EXCEPTION '0059 T27c falhou: trilha de ids cruzados = %', v_audit;
  END IF;

  SELECT process_outcome INTO v_outcome
  FROM public.psp_events WHERE event_id = 'c59-evt-t27c-x';
  IF v_outcome IS DISTINCT FROM 'noop' THEN
    RAISE EXCEPTION '0059 T27c falhou: evento cruzado outcome %', v_outcome;
  END IF;

  -- Sem `psp_payment_id`, a resolucao cai no `psp_invoice_id`.
  -- Ordem do fixture (REQ-16, 0067): os dois refunds nascem na MESMA transacao
  -- => `received_at` identico; mesmo `event_type` => mesmo rank (30). A chave
  -- total desempata por `event_id`, logo este nome PRECISA ordenar depois do
  -- primeiro (`c59-evt-t27c-x` < `c59-evt-t27c-y`). O cenario testado aqui e o
  -- fallback por `psp_invoice_id`, nao a ordem.
  PERFORM pg_temp.c59_event(
    'c59-evt-t27c-y', 'PAYMENT_REFUNDED', 'c59-t27c-sub',
    'c59-t27c-prev-inv', NULL
  );
  v_res := public.apply_psp_event('c59-evt-t27c-y');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T27c falhou: refund por invoice => % (esperado applied)', v_res;
  END IF;

  SELECT status INTO v_status
  FROM public.tenant_invoices
  WHERE subscription_id = v_sub AND competencia = v_prev;
  IF v_status IS DISTINCT FROM 'refunded' THEN
    RAISE EXCEPTION '0059 T27c falhou: fatura anterior % (esperado refunded)', v_status;
  END IF;
  SELECT status INTO v_status
  FROM public.tenant_invoices
  WHERE subscription_id = v_sub AND competencia = v_mes;
  IF v_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION '0059 T27c falhou: fatura recente % (esperado paid)', v_status;
  END IF;

  RAISE NOTICE '0059 T27c ok: ids cruzados => noop auditado sem estorno; fallback por invoice resolve';
END $$;
ROLLBACK;

-- ============ T28 — subscription_canceled so marca a flag ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010029';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_status text;
  v_cancel boolean;
  v_n int;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000029', '59000000029',
    'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c59-t28-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t28', 'SUBSCRIPTION_DELETED', 'c59-t28-sub'
  );
  v_res := public.apply_psp_event('c59-evt-t28');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T28 falhou: outcome % (esperado applied)', v_res;
  END IF;

  SELECT status, cancel_at_period_end INTO v_status, v_cancel
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' OR v_cancel IS NOT TRUE THEN
    RAISE EXCEPTION '0059 T28 falhou: status=% cancel=%', v_status, v_cancel;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T28 falhou: cancelamento criou fatura';
  END IF;

  RAISE NOTICE '0059 T28 ok: subscription_canceled => flag true, status intacto';
END $$;
ROLLBACK;

-- ============ T29 — canceled + payment_confirmed mesmo id = invalida ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010030';
  v_sub uuid;
  v_res jsonb;
  v_status text;
  v_psp text;
  v_n int;
  v_outcome text;
  v_processed boolean;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000030', '59000000030',
    'standard', 'canceled', NULL, 10::smallint,
    NULL, NULL, 'c59-t29-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t29', 'PAYMENT_CONFIRMED', 'c59-t29-sub', NULL, 'c59-t29-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t29');
  IF v_res->>'outcome' IS DISTINCT FROM 'rejected'
     OR v_res->>'transition' IS NOT NULL OR v_res->>'invoice_id' IS NOT NULL THEN
    RAISE EXCEPTION '0059 T29 falhou: envelope %', v_res;
  END IF;

  SELECT status, psp_subscription_id INTO v_status, v_psp
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'canceled' OR v_psp IS DISTINCT FROM 'c59-t29-sub' THEN
    RAISE EXCEPTION '0059 T29 falhou: UPDATE de estado (status=% psp=%)', v_status, v_psp;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T29 falhou: transicao invalida criou fatura';
  END IF;

  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'other'
    AND reason = 'subscription-transition-invalid';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T29 falhou: auditorias invalidas = % (esperado 1)', v_n;
  END IF;

  SELECT process_outcome, processed_at IS NOT NULL INTO v_outcome, v_processed
  FROM public.psp_events WHERE event_id = 'c59-evt-t29';
  IF v_outcome IS DISTINCT FROM 'rejected' OR NOT v_processed THEN
    RAISE EXCEPTION '0059 T29 falhou: evento outcome=% processed=%', v_outcome, v_processed;
  END IF;

  RAISE NOTICE '0059 T29 ok: canceled+confirmed (mesmo id) => rejected + 1 auditoria, 0 UPDATE';
END $$;
ROLLBACK;

-- ============ T30 — canceled + payment_confirmed id novo via customer ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010031';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_status text;
  v_psp text;
  v_trial_null boolean;
  v_start date;
  v_inv_status text;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000031', '59000000031',
    'standard', 'canceled', NULL, 10::smallint,
    NULL, NULL, 'c59-t30-old', 'c59-t30-cust', NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t30', 'PAYMENT_CONFIRMED', 'c59-t30-new', NULL, 'c59-t30-pay',
    '{"payment":{"customer":"c59-t30-cust","value":19.90}}'::jsonb
  );
  v_res := public.apply_psp_event('c59-evt-t30');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied'
     OR v_res->>'transition' IS DISTINCT FROM 'canceled->active' THEN
    RAISE EXCEPTION '0059 T30 falhou: envelope %', v_res;
  END IF;

  SELECT status, psp_subscription_id, trial_ends_at IS NULL, period_start
    INTO v_status, v_psp, v_trial_null, v_start
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' OR v_psp IS DISTINCT FROM 'c59-t30-new' THEN
    RAISE EXCEPTION '0059 T30 falhou: status=% psp=%', v_status, v_psp;
  END IF;
  IF NOT v_trial_null OR v_start IS DISTINCT FROM v_hoje THEN
    RAISE EXCEPTION '0059 T30 falhou: reactivacao sem ciclo em hoje (%)', v_start;
  END IF;

  SELECT status INTO v_inv_status
  FROM public.tenant_invoices WHERE subscription_id = v_sub
  ORDER BY competencia DESC LIMIT 1;
  IF v_inv_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION '0059 T30 falhou: fatura % (esperado paid)', v_inv_status;
  END IF;

  RAISE NOTICE '0059 T30 ok: canceled + id novo via customer => active com ciclo e fatura';
END $$;
ROLLBACK;

-- ============ T31 — evento nao mapeado e noop ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010032';
  v_sub uuid;
  v_res jsonb;
  v_hoje date := pg_temp.c59_hoje();
  v_status text;
  v_kind text;
  v_outcome text;
  v_processed boolean;
  v_audit int;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000032', '59000000032',
    'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c59-t31-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t31', 'SUBSCRIPTION_UPDATED', 'c59-t31-sub'
  );
  v_res := public.apply_psp_event('c59-evt-t31');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop' THEN
    RAISE EXCEPTION '0059 T31 falhou: outcome % (esperado noop)', v_res;
  END IF;

  SELECT event_kind, process_outcome, processed_at IS NOT NULL
    INTO v_kind, v_outcome, v_processed
  FROM public.psp_events WHERE event_id = 'c59-evt-t31';
  IF v_kind IS DISTINCT FROM 'unmapped' OR v_outcome IS DISTINCT FROM 'noop'
     OR NOT v_processed THEN
    RAISE EXCEPTION '0059 T31 falhou: kind=% outcome=% processed=%',
      v_kind, v_outcome, v_processed;
  END IF;

  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T31 falhou: unmapped mexeu no status (%)', v_status;
  END IF;

  SELECT count(*) INTO v_audit
  FROM public.admin_audit WHERE tenant_id = v_tenant;
  IF v_audit <> 0 THEN
    RAISE EXCEPTION '0059 T31 falhou: % auditoria(s) para unmapped', v_audit;
  END IF;

  RAISE NOTICE '0059 T31 ok: evento nao mapeado => noop sem auditoria';
END $$;
ROLLBACK;

-- ============ T32 — combinacoes nao previstas => rejected ============
BEGIN;
DO $$
DECLARE
  v_tenant_a uuid := 'c5900000-0000-4000-8000-000000010033';
  v_tenant_b uuid := 'c5900000-0000-4000-8000-000000010034';
  v_hoje date := pg_temp.c59_hoje();
  v_sub_a uuid;
  v_sub_b uuid;
  v_res jsonb;
  v_status text;
  v_n int;
BEGIN
  -- a) canceled + payment_overdue nao esta na matriz.
  v_sub_a := pg_temp.c59_seed(
    v_tenant_a, 'c5900000-0000-4000-8000-000000000033', '59000000033',
    'standard', 'canceled', NULL, 10::smallint,
    NULL, NULL, 'c59-t32a-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t32a', 'PAYMENT_OVERDUE', 'c59-t32a-sub'
  );
  v_res := public.apply_psp_event('c59-evt-t32a');
  IF v_res->>'outcome' IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION '0059 T32 falhou: canceled+overdue outcome %', v_res;
  END IF;
  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub_a;
  IF v_status IS DISTINCT FROM 'canceled' THEN
    RAISE EXCEPTION '0059 T32 falhou: canceled+overdue alterou status (%)', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = v_tenant_a AND reason = 'subscription-transition-invalid';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T32 falhou: auditorias canceled+overdue = %', v_n;
  END IF;

  -- b) plano free nunca aceita payment_*.
  v_sub_b := pg_temp.c59_seed(
    v_tenant_b, 'c5900000-0000-4000-8000-000000000034', '59000000034',
    'free', 'active', NULL, NULL,
    NULL, NULL, 'c59-t32b-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t32b', 'PAYMENT_CONFIRMED', 'c59-t32b-sub', NULL, 'c59-t32b-pay'
  );
  v_res := public.apply_psp_event('c59-evt-t32b');
  IF v_res->>'outcome' IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION '0059 T32 falhou: free+confirmed outcome %', v_res;
  END IF;
  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub_b;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T32 falhou: free+confirmed alterou status (%)', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub_b;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T32 falhou: free+confirmed criou fatura';
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = v_tenant_b AND reason = 'subscription-transition-invalid';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T32 falhou: auditorias free+confirmed = %', v_n;
  END IF;

  RAISE NOTICE '0059 T32 ok: combinacoes nao previstas => rejected + 1 auditoria, 0 escrita';
END $$;
ROLLBACK;

-- ============ T33 — divergencia de value nao escreve dinheiro ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010035';
  v_sub uuid;
  v_res jsonb;
  v_status text;
  v_amount bigint;
  v_from text;
  v_to text;
  v_n int;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000035', '59000000035',
    'standard', 'trial', pg_catalog.now() + interval '10 days', 10::smallint,
    NULL, NULL, 'c59-t33-sub', NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.c59_event(
    'c59-evt-t33', 'PAYMENT_CONFIRMED', 'c59-t33-sub', NULL, 'c59-t33-pay',
    '{"payment":{"value":99.90}}'::jsonb
  );
  v_res := public.apply_psp_event('c59-evt-t33');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T33 falhou: outcome % (esperado applied)', v_res;
  END IF;

  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T33 falhou: transicao nao aplicada (%)', v_status;
  END IF;

  SELECT amount_cents INTO v_amount
  FROM public.tenant_invoices WHERE subscription_id = v_sub
  ORDER BY competencia DESC LIMIT 1;
  IF v_amount IS DISTINCT FROM public.get_plan_price('standard') THEN
    RAISE EXCEPTION '0059 T33 falhou: valor persistido % (esperado catalogo)', v_amount;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND action = 'other' AND reason = 'psp-amount-divergence';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T33 falhou: trilha de divergencia = % (esperado 1)', v_n;
  END IF;

  SELECT from_value, to_value INTO v_from, v_to
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND reason = 'psp-amount-divergence';
  IF v_from::numeric IS DISTINCT FROM 99.90 THEN
    RAISE EXCEPTION '0059 T33 falhou: from_value % (esperado 99.90)', v_from;
  END IF;
  IF v_to IS DISTINCT FROM v_amount::text THEN
    RAISE EXCEPTION '0059 T33 falhou: to_value % (esperado %)', v_to, v_amount;
  END IF;

  RAISE NOTICE '0059 T33 ok: value divergente => transicao aplicada + trilha; dinheiro do catalogo';
END $$;
ROLLBACK;

-- ============ T33b — comparacao de value: virgula, sinal, expoente e truncamento ============
-- A comparacao normaliza `,`->`.`, aceita sinal e NUNCA descarta em silencio:
-- formato nao comparavel (expoente, 3 casas) deixa trilha propria.
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c5900000-0000-4000-8000-000000010051';
  v_sub uuid;
  v_res jsonb;
  v_div int;
  v_uncomp int;
  v_from text;
BEGIN
  v_sub := pg_temp.c59_seed(
    v_tenant, 'c5900000-0000-4000-8000-000000000051', '59000000051',
    'standard', 'trial', pg_catalog.now() + interval '10 days', 10::smallint,
    NULL, NULL, 'c59-t33b-sub', NULL, NULL, NULL, NULL
  );

  -- 1) virgula decimal equivale ao valor do catalogo (sem trilha).
  PERFORM pg_temp.c59_event(
    'c59-evt-t33b-a', 'PAYMENT_CONFIRMED', 'c59-t33b-sub', NULL, 'c59-t33b-pay-a',
    '{"payment":{"value":"19,90"}}'::jsonb
  );
  PERFORM public.apply_psp_event('c59-evt-t33b-a');

  -- 2) sinal positivo explicito tambem compara.
  PERFORM pg_temp.c59_event(
    'c59-evt-t33b-b', 'PAYMENT_CONFIRMED', 'c59-t33b-sub', NULL, 'c59-t33b-pay-b',
    '{"payment":{"value":"+19.90"}}'::jsonb
  );
  PERFORM public.apply_psp_event('c59-evt-t33b-b');

  SELECT count(*) INTO v_div
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND reason = 'psp-amount-divergence';
  IF v_div <> 0 THEN
    RAISE EXCEPTION '0059 T33b falhou: valor equivalente auditado como divergente (%)', v_div;
  END IF;

  -- 3) truncamento (3 casas) nao vira 19.99 em silencio.
  PERFORM pg_temp.c59_event(
    'c59-evt-t33b-c', 'PAYMENT_CONFIRMED', 'c59-t33b-sub', NULL, 'c59-t33b-pay-c',
    '{"payment":{"value":"19.999"}}'::jsonb
  );
  PERFORM public.apply_psp_event('c59-evt-t33b-c');

  -- 4) expoente nao e formato monetario comparavel.
  PERFORM pg_temp.c59_event(
    'c59-evt-t33b-d', 'PAYMENT_CONFIRMED', 'c59-t33b-sub', NULL, 'c59-t33b-pay-d',
    '{"payment":{"value":"1.99E2"}}'::jsonb
  );
  PERFORM public.apply_psp_event('c59-evt-t33b-d');

  SELECT count(*) INTO v_uncomp
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND reason = 'psp-amount-uncomparable';
  IF v_uncomp <> 2 THEN
    RAISE EXCEPTION '0059 T33b falhou: trilha de formato nao comparavel = % (esperado 2)',
      v_uncomp;
  END IF;
  SELECT count(*) INTO v_div
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND reason = 'psp-amount-uncomparable'
    AND from_value = '19.999';
  IF v_div <> 1 THEN
    RAISE EXCEPTION '0059 T33b falhou: truncamento nao auditado (%)', v_div;
  END IF;

  -- 5) sinal negativo e aceito na leitura e acusa divergencia.
  PERFORM pg_temp.c59_event(
    'c59-evt-t33b-e', 'PAYMENT_CONFIRMED', 'c59-t33b-sub', NULL, 'c59-t33b-pay-e',
    '{"payment":{"value":"-19.90"}}'::jsonb
  );
  PERFORM public.apply_psp_event('c59-evt-t33b-e');

  SELECT count(*), min(from_value) INTO v_div, v_from
  FROM public.admin_audit
  WHERE tenant_id = v_tenant AND reason = 'psp-amount-divergence';
  IF v_div <> 1 OR v_from IS DISTINCT FROM '-19.90' THEN
    RAISE EXCEPTION '0059 T33b falhou: divergencia com sinal = %/%', v_div, v_from;
  END IF;

  RAISE NOTICE '0059 T33b ok: value com virgula/sinal compara; expoente e truncamento auditados';
END $$;
ROLLBACK;

-- ============ T34 — expire_subscriptions ============
BEGIN;
DO $$
DECLARE
  v_tenant_exp uuid := 'c5900000-0000-4000-8000-000000010036';
  v_tenant_fut uuid := 'c5900000-0000-4000-8000-000000010037';
  v_tenant_act uuid := 'c5900000-0000-4000-8000-000000010038';
  v_sub_exp uuid;
  v_sub_fut uuid;
  v_sub_act uuid;
  v_n int;
  v_audit int;
  v_status text;
BEGIN
  v_sub_exp := pg_temp.c59_seed(
    v_tenant_exp, 'c5900000-0000-4000-8000-000000000036', '59000000036',
    'standard', 'trial', '2000-01-01T00:00:00Z', 10::smallint,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  v_sub_fut := pg_temp.c59_seed(
    v_tenant_fut, 'c5900000-0000-4000-8000-000000000037', '59000000037',
    'standard', 'trial', pg_catalog.now() + interval '30 days', 10::smallint,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  v_sub_act := pg_temp.c59_seed(
    v_tenant_act, 'c5900000-0000-4000-8000-000000000038', '59000000038',
    'standard', 'active', NULL, 10::smallint,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );

  v_n := public.expire_subscriptions(1);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T34 falhou: 1a chamada devolveu % (esperado 1)', v_n;
  END IF;

  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub_exp;
  IF v_status IS DISTINCT FROM 'canceled' THEN
    RAISE EXCEPTION '0059 T34 falhou: trial vencido status % (esperado canceled)', v_status;
  END IF;
  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub_fut;
  IF v_status IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION '0059 T34 falhou: trial futuro mudou (%)', v_status;
  END IF;
  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub_act;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T34 falhou: active mudou (%)', v_status;
  END IF;

  SELECT count(*) INTO v_audit
  FROM public.admin_audit
  WHERE tenant_id = v_tenant_exp AND action = 'tenant_status_changed'
    AND reason = 'psp:internal_trial_expired'
    AND from_value = 'trial' AND to_value = 'canceled';
  IF v_audit <> 1 THEN
    RAISE EXCEPTION '0059 T34 falhou: trilha de expiracao = %', v_audit;
  END IF;

  v_n := public.expire_subscriptions(100);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0059 T34 falhou: 2a chamada devolveu % (esperado 0)', v_n;
  END IF;

  RAISE NOTICE '0059 T34 ok: expire cancela trial vencido, preserva futuro/active e e idempotente';
END $$;
ROLLBACK;

-- ============ T35 — roll_period ============
BEGIN;
DO $$
DECLARE
  v_hoje date := pg_temp.c59_hoje();
  v_tenant_np uuid := 'c5900000-0000-4000-8000-000000010039';
  v_tenant_ne uuid := 'c5900000-0000-4000-8000-000000010040';
  v_tenant_cx uuid := 'c5900000-0000-4000-8000-000000010041';
  v_tenant_ok uuid := 'c5900000-0000-4000-8000-000000010042';
  v_tenant_pd uuid := 'c5900000-0000-4000-8000-000000010043';
  v_tenant_pp uuid := 'c5900000-0000-4000-8000-000000010044';
  v_tenant_fr uuid := 'c5900000-0000-4000-8000-000000010045';
  v_tenant_up uuid := 'c5900000-0000-4000-8000-000000010052';
  v_sub_np uuid;
  v_sub_ne uuid;
  v_sub_cx uuid;
  v_sub_ok uuid;
  v_sub_pd uuid;
  v_sub_pp uuid;
  v_sub_fr uuid;
  v_sub_up uuid;
  v_res jsonb;
  v_old_start date := pg_temp.c59_hoje() - 60;
  v_old_end date := pg_temp.c59_hoje() - 1;
  v_exp_start date;
  v_exp_end date;
  v_start date;
  v_end date;
  v_plan text;
  v_billing smallint;
  v_pending text;
  v_status text;
  v_n int;
BEGIN
  v_sub_np := pg_temp.c59_seed(
    v_tenant_np, 'c5900000-0000-4000-8000-000000000039', '59000000039',
    'standard', 'active', NULL, 10::smallint,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  v_sub_ne := pg_temp.c59_seed(
    v_tenant_ne, 'c5900000-0000-4000-8000-000000000040', '59000000040',
    'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 5, NULL, NULL, NULL, NULL, NULL
  );
  v_sub_cx := pg_temp.c59_seed(
    v_tenant_cx, 'c5900000-0000-4000-8000-000000000041', '59000000041',
    'standard', 'canceled', NULL, 10::smallint,
    v_old_start, v_old_end, NULL, NULL, NULL, NULL, NULL
  );
  v_sub_ok := pg_temp.c59_seed(
    v_tenant_ok, 'c5900000-0000-4000-8000-000000000042', '59000000042',
    'standard', 'active', NULL, 10::smallint,
    v_old_start, v_old_end, NULL, NULL, NULL, NULL, NULL
  );
  v_sub_pd := pg_temp.c59_seed(
    v_tenant_pd, 'c5900000-0000-4000-8000-000000000043', '59000000043',
    'standard', 'past_due', NULL, 10::smallint,
    v_old_start, v_old_end, NULL, NULL, NULL, 'free', v_old_end
  );
  v_sub_pp := pg_temp.c59_seed(
    v_tenant_pp, 'c5900000-0000-4000-8000-000000000044', '59000000044',
    'standard', 'active', NULL, 10::smallint,
    v_old_start, v_old_end, NULL, NULL, NULL, 'pro', v_old_end
  );
  v_sub_fr := pg_temp.c59_seed(
    v_tenant_fr, 'c5900000-0000-4000-8000-000000000045', '59000000045',
    'standard', 'active', NULL, 10::smallint,
    v_old_start, v_old_end, NULL, NULL, NULL, 'free', v_old_end
  );
  v_sub_up := pg_temp.c59_seed(
    v_tenant_up, 'c5900000-0000-4000-8000-000000000052', '59000000052',
    'standard', 'active', NULL, 10::smallint,
    v_old_start, v_old_end, NULL, NULL, NULL, NULL, NULL
  );

  -- Lastro do ciclo que sera encerrado: fatura `paid` da competencia do ciclo.
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, competencia, period_start, period_end, due_date,
    amount_cents, status, paid_at
  ) VALUES
  (
    v_tenant_ok, v_sub_ok, pg_catalog.date_trunc('month', v_old_start)::date,
    v_old_start, v_old_end, v_old_start, public.get_plan_price('standard'),
    'paid', pg_catalog.now()
  ),
  (
    v_tenant_pp, v_sub_pp, pg_catalog.date_trunc('month', v_old_start)::date,
    v_old_start, v_old_end, v_old_start, public.get_plan_price('standard'),
    'paid', pg_catalog.now()
  ),
  (
    v_tenant_fr, v_sub_fr, pg_catalog.date_trunc('month', v_old_start)::date,
    v_old_start, v_old_end, v_old_start, public.get_plan_price('standard'),
    'paid', pg_catalog.now()
  );

  -- Sem periodo aberto.
  v_res := public.roll_period(v_sub_np);
  IF v_res->>'applied' IS DISTINCT FROM 'false'
     OR v_res->>'reason' IS DISTINCT FROM 'period-not-open' THEN
    RAISE EXCEPTION '0059 T35 falhou: sem periodo => %', v_res;
  END IF;

  -- Ciclo corrente ainda nao terminou.
  v_res := public.roll_period(v_sub_ne);
  IF v_res->>'applied' IS DISTINCT FROM 'false'
     OR v_res->>'reason' IS DISTINCT FROM 'period-not-ended' THEN
    RAISE EXCEPTION '0059 T35 falhou: period_end>=hoje => %', v_res;
  END IF;

  -- Canceled nao roda.
  v_res := public.roll_period(v_sub_cx);
  IF v_res->>'applied' IS DISTINCT FROM 'false'
     OR v_res->>'reason' IS DISTINCT FROM 'subscription-canceled' THEN
    RAISE EXCEPTION '0059 T35 falhou: canceled => %', v_res;
  END IF;

  -- Assinatura inexistente devolve envelope, sem RAISE.
  v_res := public.roll_period('c5900000-0000-4000-8000-00000001ffff');
  IF v_res->>'applied' IS DISTINCT FROM 'false'
     OR v_res->>'reason' IS DISTINCT FROM 'subscription-not-found' THEN
    RAISE EXCEPTION '0059 T35 falhou: inexistente => %', v_res;
  END IF;

  -- Sem lastro: ciclo encerrado sem fatura `paid` da competencia => period-not-paid.
  v_res := public.roll_period(v_sub_up);
  IF v_res->>'applied' IS DISTINCT FROM 'false'
     OR v_res->>'reason' IS DISTINCT FROM 'period-not-paid' THEN
    RAISE EXCEPTION '0059 T35 falhou: sem lastro => %', v_res;
  END IF;
  SELECT period_start, period_end, plan_slug INTO v_start, v_end, v_plan
  FROM public.tenant_subscriptions WHERE id = v_sub_up;
  IF v_start IS DISTINCT FROM v_old_start OR v_end IS DISTINCT FROM v_old_end
     OR v_plan IS DISTINCT FROM 'standard' THEN
    RAISE EXCEPTION '0059 T35 falhou: period-not-paid alterou estado (%..% / %)',
      v_start, v_end, v_plan;
  END IF;

  -- Ciclo vencido: avanca exatamente um ciclo.
  v_exp_start := pg_temp.c59_next_start(v_old_start, 10);
  v_exp_end := pg_temp.c59_next_start(v_exp_start, 10) - 1;
  v_res := public.roll_period(v_sub_ok);
  IF v_res->>'applied' IS DISTINCT FROM 'true'
     OR v_res->>'reason' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION '0059 T35 falhou: ciclo vencido => %', v_res;
  END IF;
  SELECT period_start, period_end INTO v_start, v_end
  FROM public.tenant_subscriptions WHERE id = v_sub_ok;
  IF v_start IS DISTINCT FROM v_exp_start OR v_end IS DISTINCT FROM v_exp_end THEN
    RAISE EXCEPTION '0059 T35 falhou: avancou para %..% (esperado %..%)',
      v_start, v_end, v_exp_start, v_exp_end;
  END IF;

  -- Downgrade pendente e aplicado no limite do ciclo (standard -> pro).
  v_res := public.roll_period(v_sub_pp);
  IF v_res->>'applied' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '0059 T35 falhou: pendente pro => %', v_res;
  END IF;
  SELECT plan_slug, pending_plan_slug INTO v_plan, v_pending
  FROM public.tenant_subscriptions WHERE id = v_sub_pp;
  IF v_plan IS DISTINCT FROM 'pro' OR v_pending IS NOT NULL THEN
    RAISE EXCEPTION '0059 T35 falhou: pendente pro plan=% pending=%', v_plan, v_pending;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE tenant_id = v_tenant_pp AND action = 'tenant_status_changed'
    AND reason = 'psp:internal_period_ended'
    AND from_value = 'standard' AND to_value = 'pro';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T35 falhou: trilha do downgrade pro = %', v_n;
  END IF;

  -- Downgrade pendente para free limpa aniversario e ciclo.
  v_res := public.roll_period(v_sub_fr);
  IF v_res->>'applied' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '0059 T35 falhou: pendente free => %', v_res;
  END IF;
  SELECT plan_slug, billing_day, period_start, period_end, status
    INTO v_plan, v_billing, v_start, v_end, v_status
  FROM public.tenant_subscriptions WHERE id = v_sub_fr;
  IF v_plan IS DISTINCT FROM 'free' OR v_billing IS NOT NULL
     OR v_start IS NOT NULL OR v_end IS NOT NULL THEN
    RAISE EXCEPTION '0059 T35 falhou: free plan=% billing=% period=%..%',
      v_plan, v_billing, v_start, v_end;
  END IF;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '0059 T35 falhou: free status % (esperado active)', v_status;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.admin_audit
  WHERE tenant_id = v_tenant_fr AND action = 'tenant_status_changed'
    AND reason = 'psp:internal_period_ended'
    AND from_value = 'standard' AND to_value = 'free';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0059 T35 falhou: trilha do downgrade free = %', v_n;
  END IF;

  -- past_due + pendente free e recusado (free nao admite past_due).
  v_res := public.roll_period(v_sub_pd);
  IF v_res->>'applied' IS DISTINCT FROM 'false'
     OR v_res->>'reason' IS DISTINCT FROM 'subscription-past-due' THEN
    RAISE EXCEPTION '0059 T35 falhou: past_due+free => %', v_res;
  END IF;
  SELECT plan_slug, status INTO v_plan, v_status
  FROM public.tenant_subscriptions WHERE id = v_sub_pd;
  IF v_plan IS DISTINCT FROM 'standard' OR v_status IS DISTINCT FROM 'past_due' THEN
    RAISE EXCEPTION '0059 T35 falhou: past_due+free alterou estado (%/%)', v_plan, v_status;
  END IF;

  RAISE NOTICE '0059 T35 ok: roll_period respeita bordas, avanca 1 ciclo, aplica pendente e limpa free';
END $$;
ROLLBACK;

-- ============ B6/B7 — RPCs de leitura e override (0060): T36–T49 ============
-- Fixtures c60* criadas DENTRO de cada cenario (BEGIN/ROLLBACK) => 0 residuo.
-- Leituras/override rodam como `authenticated` (SET LOCAL ROLE + claims); as
-- assercoes de estado rodam como postgres depois de RESET ROLE.

CREATE OR REPLACE FUNCTION pg_temp.c60_user(p_user uuid, p_email text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES (p_user, p_email);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c60_super(p_user uuid, p_email text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES (p_user, p_email);
  UPDATE public.profiles SET role = 'super_admin' WHERE id = p_user;
  INSERT INTO public.internal_operators (user_id, active) VALUES (p_user, true);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c60_tenant(
  p_tenant uuid, p_user uuid, p_cpf text, p_plan text, p_status text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- O tenant nasce `active` para que a membership nao caia em
  -- `subscription-canceled-readonly` (0054); o status alvo entra no UPDATE
  -- seguinte, ainda como postgres (tenants_write_guard permite DBA).
  INSERT INTO public.tenants (
    id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status
  ) VALUES (
    p_tenant, 'pf', p_user, p_cpf, 'C60 Billing', p_plan, 'active'
  );
  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (p_tenant, p_user, 'owner');
  IF p_status IS DISTINCT FROM 'active' THEN
    UPDATE public.tenants
    SET subscription_status = p_status, updated_at = pg_catalog.now()
    WHERE id = p_tenant;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c60_sub(
  p_tenant uuid, p_plan text, p_status text,
  p_trial timestamptz DEFAULT NULL,
  p_billing smallint DEFAULT NULL,
  p_start date DEFAULT NULL,
  p_end date DEFAULT NULL,
  p_psp_sub text DEFAULT NULL,
  p_psp_cust text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_sub uuid;
BEGIN
  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, trial_ends_at, billing_day,
    period_start, period_end, psp_subscription_id, psp_customer_id
  ) VALUES (
    p_tenant, p_plan, p_status, p_trial, p_billing,
    p_start, p_end, p_psp_sub, p_psp_cust
  ) RETURNING id INTO v_sub;
  RETURN v_sub;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c60_invoice(
  p_tenant uuid, p_sub uuid, p_comp date, p_amount bigint,
  p_kind text DEFAULT 'cycle', p_status text DEFAULT 'open',
  p_psp_invoice text DEFAULT NULL, p_psp_payment text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_first date := pg_catalog.date_trunc('month', p_comp)::date;
  v_last date := (pg_catalog.date_trunc('month', p_comp)::date
    + interval '1 month' - interval '1 day')::date;
BEGIN
  INSERT INTO public.tenant_invoices (
    tenant_id, subscription_id, kind, competencia, period_start, period_end,
    due_date, amount_cents, status, psp_invoice_id, psp_payment_id, paid_at
  ) VALUES (
    p_tenant, p_sub, p_kind, v_first, v_first, v_last,
    v_first, p_amount, p_status, p_psp_invoice, p_psp_payment,
    CASE WHEN p_status = 'paid' THEN pg_catalog.now() ELSE NULL END
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c60_errors(
  p_label text, p_sql text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'C60-FALHOU-DEVERIA: %', p_label;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'C60-FALHOU-DEVERIA:%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION '0060 % falhou: levantou "%" (esperado "%")',
        p_label, SQLERRM, p_expected;
    END IF;
  END;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.c60_errors(text, text, text) TO authenticated;

-- ============ T49 — estrutura das 4 RPCs de 0060 ============
BEGIN;
DO $$
DECLARE
  v_sig text;
  v_def boolean;
  v_cfg text[];
  v_retset boolean;
  v_names text[];
  v_n int;
  v_role text;
  v_res text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.get_my_subscription()',
    'public.list_my_invoices(integer,integer)',
    'public.admin_get_tenant_billing(uuid)',
    'public.admin_override_subscription(uuid,text,text,text,date)'
  ] LOOP
    IF pg_catalog.to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '0060 T49 falhou: funcao % ausente', v_sig;
    END IF;
    SELECT p.prosecdef, p.proconfig
      INTO v_def, v_cfg
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = pg_catalog.to_regprocedure(v_sig);
    IF v_def IS DISTINCT FROM true THEN
      RAISE EXCEPTION '0060 T49 falhou: % sem SECURITY DEFINER', v_sig;
    END IF;
    IF v_cfg IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_cfg) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION '0060 T49 falhou: % sem search_path vazio', v_sig;
    END IF;
    IF NOT pg_catalog.has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '0060 T49 falhou: authenticated sem EXECUTE em %', v_sig;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF pg_catalog.has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION '0060 T49 falhou: % executavel por %', v_sig, v_role;
      END IF;
    END LOOP;
  END LOOP;

  -- Contagem exata: cada teste novo falha se uma RPC sumir.
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_my_subscription', 'list_my_invoices',
      'admin_get_tenant_billing', 'admin_override_subscription'
    );
  IF v_n <> 4 THEN
    RAISE EXCEPTION '0060 T49 falhou: % funcoes de 0060 (esperado 4)', v_n;
  END IF;

  -- Retornos congelados de §4.5.
  IF pg_catalog.pg_get_function_result(
       'public.list_my_invoices(integer,integer)'::regprocedure) IS DISTINCT FROM 'jsonb'
     OR pg_catalog.pg_get_function_result(
       'public.admin_get_tenant_billing(uuid)'::regprocedure) IS DISTINCT FROM 'jsonb'
     OR pg_catalog.pg_get_function_result(
       'public.admin_override_subscription(uuid,text,text,text,date)'::regprocedure) IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION '0060 T49 falhou: RPC de 0060 nao retorna jsonb';
  END IF;

  SELECT p.proargnames, p.proretset
    INTO v_names, v_retset
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.get_my_subscription()');
  IF v_retset IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0060 T49 falhou: get_my_subscription nao retorna conjunto';
  END IF;
  IF v_names IS DISTINCT FROM ARRAY[
       'plan_slug', 'status', 'trial_ends_at', 'period_start',
       'period_end', 'pending_plan_slug', 'cancel_at_period_end'
     ] THEN
    RAISE EXCEPTION '0060 T49 falhou: get_my_subscription colunas = %', v_names;
  END IF;

  -- Defaults: list_my_invoices(limit,offset)=2; override expoe 4 defaults
  -- (p_reason usa DEFAULT NULL para ser aceito pelo Postgres — NOT NULL
  --  semantico e exigido no corpo; ver COMMENT da 0060).
  SELECT p.pronargdefaults INTO v_n
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.list_my_invoices(integer,integer)');
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0060 T49 falhou: list_my_invoices defaults = % (esperado 2)', v_n;
  END IF;
  SELECT p.pronargdefaults INTO v_n
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.admin_override_subscription(uuid,text,text,text,date)');
  IF v_n <> 4 THEN
    RAISE EXCEPTION '0060 T49 falhou: admin_override_subscription defaults = % (esperado 4)', v_n;
  END IF;

  SELECT pg_catalog.pg_get_function_result(
    'public.get_my_subscription()'::regprocedure) INTO v_res;
  IF v_res IS NULL OR position('cancel_at_period_end' IN v_res) = 0 THEN
    RAISE EXCEPTION '0060 T49 falhou: retorno de get_my_subscription inesperado (%)', v_res;
  END IF;

  -- A constraint de ciclo (adendo §14) continua sendo a guarda do free/pago.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conname = 'tenant_subscriptions_plan_cycle_check'
      AND c.conrelid = 'public.tenant_subscriptions'::regclass
  ) THEN
    RAISE EXCEPTION '0060 T49 falhou: tenant_subscriptions_plan_cycle_check ausente';
  END IF;

  RAISE NOTICE '0060 T49 ok: 4 RPCs DEFINER/search_path com grants so authenticated';
END $$;
ROLLBACK;

-- ============ T36 — get_my_subscription (propria; free sem cobranca) ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000a1', 'c60-t36-a@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001a1',
    'c6000000-0000-4000-8000-0000000000a1', '60000000187', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001a1', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-03-01', DATE '2026-03-31', 'psp-c60-a', 'cus-c60-a');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', true);
DO $$
DECLARE
  v_n int;
  v_plan text; v_status text; v_trial timestamptz; v_ps date;
  v_pe date; v_pend text; v_cancel boolean;
BEGIN
  SELECT count(*) INTO v_n FROM public.get_my_subscription();
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T36 falhou: linhas = % (esperado 1)', v_n;
  END IF;
  SELECT plan_slug, status, trial_ends_at, period_start, period_end,
         pending_plan_slug, cancel_at_period_end
    INTO v_plan, v_status, v_trial, v_ps, v_pe, v_pend, v_cancel
  FROM public.get_my_subscription();
  IF v_plan <> 'standard' OR v_status <> 'active'
     OR v_trial IS NOT NULL OR v_ps <> DATE '2026-03-01'
     OR v_pe <> DATE '2026-03-31' OR v_pend IS NOT NULL OR v_cancel THEN
    RAISE EXCEPTION '0060 T36 falhou: assinatura propria inesperada (%/%/%/%/%)',
      v_plan, v_status, v_ps, v_pe, v_cancel;
  END IF;
  RAISE NOTICE '0060 T36 ok: tenant le a propria assinatura (sem ids de PSP)';
END $$;
RESET ROLE;
ROLLBACK;

-- free = estado "sem cobranca" (plan free, active, sem trial/ciclo/pendencia).
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000a2', 'c60-t36-free@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001a2',
    'c6000000-0000-4000-8000-0000000000a2', '60000000268', 'free', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001a2', 'free', 'active');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a2', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal1"}', true);
DO $$
DECLARE
  v_plan text; v_status text; v_trial timestamptz; v_ps date; v_pe date;
  v_pend text; v_cancel boolean;
BEGIN
  SELECT plan_slug, status, trial_ends_at, period_start, period_end,
         pending_plan_slug, cancel_at_period_end
    INTO v_plan, v_status, v_trial, v_ps, v_pe, v_pend, v_cancel
  FROM public.get_my_subscription();
  IF v_plan <> 'free' OR v_status <> 'active'
     OR v_trial IS NOT NULL OR v_ps IS NOT NULL OR v_pe IS NOT NULL
     OR v_pend IS NOT NULL OR v_cancel THEN
    RAISE EXCEPTION '0060 T36 falhou: free nao esta sem cobranca (%/%/%)',
      v_plan, v_status, v_ps;
  END IF;
  RAISE NOTICE '0060 T36 ok: free responde sem cobranca (sem trial/ciclo)';
END $$;
RESET ROLE;
ROLLBACK;

-- Sem tenant => 0 linhas.
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000a3', 'c60-t36-none@example.com');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a3', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.get_my_subscription();
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0060 T36 falhou: sem tenant devolveu % linhas', v_n;
  END IF;
  RAISE NOTICE '0060 T36 ok: sem tenant => 0 linhas';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T37 — list_my_invoices (envelope, ordem, clamp) ============
BEGIN;
DO $$
DECLARE
  v_sub uuid;
  v_comp date;
  i int;
BEGIN
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000b1', 'c60-t37@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001b1',
    'c6000000-0000-4000-8000-0000000000b1', '60100000187', 'standard', 'active');
  v_sub := pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001b1', 'standard', 'active',
    NULL, 10::smallint, DATE '2014-12-01', DATE '2014-12-31');
  FOR i IN 0..100 LOOP
    v_comp := (DATE '2015-01-01' + (i::text || ' months')::interval)::date;
    PERFORM pg_temp.c60_invoice('c6000000-0000-4000-8000-0000000001b1', v_sub, v_comp, 1234::bigint);
  END LOOP;
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000b1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal1"}', true);
DO $$
DECLARE
  v_res jsonb;
  v_keys text[];
BEGIN
  v_res := public.list_my_invoices();
  IF (v_res->>'total')::int <> 101 THEN
    RAISE EXCEPTION '0060 T37 falhou: total default = % (esperado 101)', v_res->>'total';
  END IF;
  IF pg_catalog.jsonb_array_length(v_res->'items') <> 20 THEN
    RAISE EXCEPTION '0060 T37 falhou: pagina default = % (esperado 20)',
      pg_catalog.jsonb_array_length(v_res->'items');
  END IF;
  IF v_res->'items'->0->>'competencia' <> '2023-05-01' THEN
    RAISE EXCEPTION '0060 T37 falhou: ordem/competencia = %', v_res->'items'->0->>'competencia';
  END IF;

  v_res := public.list_my_invoices(1000, 0);
  IF pg_catalog.jsonb_array_length(v_res->'items') <> 100 THEN
    RAISE EXCEPTION '0060 T37 falhou: clamp maximo = % (esperado 100)',
      pg_catalog.jsonb_array_length(v_res->'items');
  END IF;

  v_res := public.list_my_invoices(0, -5);
  IF pg_catalog.jsonb_array_length(v_res->'items') <> 1 THEN
    RAISE EXCEPTION '0060 T37 falhou: clamp minimo = % (esperado 1)',
      pg_catalog.jsonb_array_length(v_res->'items');
  END IF;

  v_res := public.list_my_invoices(5, 100);
  IF pg_catalog.jsonb_array_length(v_res->'items') <> 1
     OR (v_res->>'total')::int <> 101 THEN
    RAISE EXCEPTION '0060 T37 falhou: offset 100 devolveu % (total %)',
      pg_catalog.jsonb_array_length(v_res->'items'), v_res->>'total';
  END IF;

  SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_keys
  FROM pg_catalog.jsonb_object_keys(v_res->'items'->0) AS k;
  IF v_keys IS DISTINCT FROM ARRAY[
       'amount_cents', 'competencia', 'due_date', 'id',
       'paid_at', 'period_end', 'period_start', 'status'
     ] THEN
    RAISE EXCEPTION '0060 T37 falhou: campos do item = %', v_keys;
  END IF;
  RAISE NOTICE '0060 T37 ok: envelope, ordem competencia DESC, clamp 1..100 e sem ids de PSP';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T38a — owner de A nao le faturas/assinatura de B ============
BEGIN;
DO $$
DECLARE v_sub uuid;
BEGIN
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000c1', 'c60-t38a-a@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001c1',
    'c6000000-0000-4000-8000-0000000000c1', '60200000187', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001c1', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-01-01', DATE '2026-01-31');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000c2', 'c60-t38a-b@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001c2',
    'c6000000-0000-4000-8000-0000000000c2', '60200000268', 'pro', 'active');
  v_sub := pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001c2', 'pro', 'active',
    NULL, 20::smallint, DATE '2026-02-01', DATE '2026-02-28');
  PERFORM pg_temp.c60_invoice('c6000000-0000-4000-8000-0000000001c2', v_sub,
    DATE '2026-02-01', 3990::bigint, 'cycle', 'paid', 'psp-i-b', 'psp-p-b');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000c1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal1"}', true);
DO $$
DECLARE
  v_res jsonb;
  v_plan text;
BEGIN
  v_res := public.list_my_invoices();
  IF pg_catalog.jsonb_array_length(v_res->'items') <> 0 OR (v_res->>'total')::int <> 0 THEN
    RAISE EXCEPTION '0060 T38a falhou: A leu faturas de B (% itens, total %)',
      pg_catalog.jsonb_array_length(v_res->'items'), v_res->>'total';
  END IF;
  SELECT plan_slug INTO v_plan FROM public.get_my_subscription();
  IF v_plan <> 'standard' THEN
    RAISE EXCEPTION '0060 T38a falhou: A viu assinatura de B (%)', v_plan;
  END IF;
  RAISE NOTICE '0060 T38a ok: A nao le faturas nem assinatura de B';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T38b — admin_get_tenant_billing audita leitura alheia ============
BEGIN;
DO $$
DECLARE v_sub uuid;
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000d1', 'c60-t38b-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000d2', 'c60-t38b-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001d2',
    'c6000000-0000-4000-8000-0000000000d2', '60300000187', 'standard', 'active');
  v_sub := pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001d2', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-03-01', DATE '2026-03-31');
  PERFORM pg_temp.c60_invoice('c6000000-0000-4000-8000-0000000001d2', v_sub,
    DATE '2026-03-01', 1990::bigint);
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000d1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000d1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_get_tenant_billing('c6000000-0000-4000-8000-0000000001d2');
  IF v_res->'subscription'->>'plan_slug' <> 'standard' THEN
    RAISE EXCEPTION '0060 T38b falhou: assinatura de B nao lida pelo operador';
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001d2'
    AND action = 'other' AND reason = 'internal_admin_read';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T38b falhou: trilha internal_admin_read = % (esperado 1)', v_n;
  END IF;
  RAISE NOTICE '0060 T38b ok: leitura cross-tenant auditada (1 linha)';
END $$;
ROLLBACK;

-- ============ T38c — authenticated => 42501 nas 3 tabelas ============
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.tenant_subscriptions LIMIT 1;
    RAISE EXCEPTION '0060 T38c falhou: authenticated leu tenant_subscriptions';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.tenant_invoices LIMIT 1;
    RAISE EXCEPTION '0060 T38c falhou: authenticated leu tenant_invoices';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.psp_events LIMIT 1;
    RAISE EXCEPTION '0060 T38c falhou: authenticated leu psp_events';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE '0060 T38c ok: authenticated recebe 42501 nas 3 tabelas';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T38d — service_role nao le assinatura/faturas ============
BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.tenant_subscriptions LIMIT 1;
    RAISE EXCEPTION '0060 T38d falhou: service_role leu tenant_subscriptions';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.tenant_invoices LIMIT 1;
    RAISE EXCEPTION '0060 T38d falhou: service_role leu tenant_invoices';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE '0060 T38d ok: service_role recebe 42501 nas tabelas de billing';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T39 — admin_get_tenant_billing (gate, lastro, usage null) ============
BEGIN;
DO $$
DECLARE
  v_sub uuid;
  i int;
  v_comp date;
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000e1', 'c60-t39-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000e2', 'c60-t39-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001e2',
    'c6000000-0000-4000-8000-0000000000e2', '60400000187', 'standard', 'past_due');
  v_sub := pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001e2', 'standard', 'past_due',
    NULL, 10::smallint, DATE '2026-03-01', DATE '2026-03-31', 'psp-sub-e', 'cus-e');
  UPDATE public.tenant_subscriptions
  SET past_due_since = pg_catalog.now(),
      pending_plan_slug = 'free', pending_plan_at = DATE '2026-03-31'
  WHERE id = v_sub;
  FOR i IN 0..54 LOOP
    v_comp := (DATE '2018-01-01' + (i::text || ' months')::interval)::date;
    PERFORM pg_temp.c60_invoice('c6000000-0000-4000-8000-0000000001e2', v_sub, v_comp,
      1990::bigint, 'cycle', 'paid', 'psp-i-' || i::text, 'psp-p-' || i::text);
  END LOOP;
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000e1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_get_tenant_billing('c6000000-0000-4000-8000-0000000001e2');
  IF v_res->'subscription'->>'plan_slug' <> 'standard'
     OR v_res->'subscription'->>'status' <> 'past_due'
     OR v_res->'subscription'->>'psp_subscription_id' <> 'psp-sub-e'
     OR v_res->'subscription'->>'psp_customer_id' <> 'cus-e'
     OR v_res->'subscription'->>'pending_plan_slug' <> 'free' THEN
    RAISE EXCEPTION '0060 T39 falhou: assinatura incompleta para o operador (%)', v_res->'subscription';
  END IF;
  IF v_res->'usage' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION '0060 T39 falhou: usage deveria ser null (%)', v_res->'usage';
  END IF;
  IF (v_res->'invoices'->>'total')::int <> 55 THEN
    RAISE EXCEPTION '0060 T39 falhou: total = % (esperado 55)', v_res->'invoices'->>'total';
  END IF;
  IF pg_catalog.jsonb_array_length(v_res->'invoices'->'items') <> 50 THEN
    RAISE EXCEPTION '0060 T39 falhou: itens = % (esperado 50)',
      pg_catalog.jsonb_array_length(v_res->'invoices'->'items');
  END IF;
  IF v_res->'invoices'->'items'->0->>'psp_invoice_id' IS NULL
     OR v_res->'invoices'->'items'->0->>'psp_payment_id' IS NULL THEN
    RAISE EXCEPTION '0060 T39 falhou: lastro de PSP ausente para o operador';
  END IF;
  RAISE NOTICE '0060 T39 ok: gate/admin ve lastro de PSP, 50 faturas e usage null';
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001e2'
    AND reason = 'internal_admin_read';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T39 falhou: auditoria de leitura = % (esperado 1)', v_n;
  END IF;
END $$;
ROLLBACK;

-- nao-admin => not-admin; tenant inexistente => tenant-not-found.
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000e3', 'c60-t39-user@example.com');
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000e4', 'c60-t39-op2@example.com');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000e3', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000e3","role":"authenticated","aal":"aal1"}', true);
SELECT pg_temp.c60_errors(
  'T39 nao-admin',
  'SELECT public.admin_get_tenant_billing(''c6000000-0000-4000-8000-0000000001e2'')',
  'not-admin');
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000e4', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000e4","role":"authenticated","aal":"aal2"}', true);
SELECT pg_temp.c60_errors(
  'T39 tenant-not-found',
  'SELECT public.admin_get_tenant_billing(''c6000000-0000-4000-8000-0000000001ff'')',
  'tenant-not-found');
RESET ROLE;
ROLLBACK;

-- ============ T40 — legado sem assinatura: null + vazio, sem erro ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000f1', 'c60-t40-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000f2', 'c60-t40-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001f2',
    'c6000000-0000-4000-8000-0000000000f2', '60500000187', 'free', 'active');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000f1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_get_tenant_billing('c6000000-0000-4000-8000-0000000001f2');
  IF v_res->'subscription' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION '0060 T40 falhou: legado devolveu assinatura (%)', v_res->'subscription';
  END IF;
  IF v_res->'invoices'->>'total' <> '0'
     OR pg_catalog.jsonb_array_length(v_res->'invoices'->'items') <> 0 THEN
    RAISE EXCEPTION '0060 T40 falhou: legado devolveu faturas (%)', v_res->'invoices';
  END IF;
  RAISE NOTICE '0060 T40 ok: legado sem assinatura => subscription null, faturas vazias';
END $$;
RESET ROLE;
ROLLBACK;

-- ============ T41 — override: not-admin / tenant / motivo ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000a4', 'c60-t41-user@example.com');
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000b4', 'c60-t41-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000c4', 'c60-t41-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001c4',
    'c6000000-0000-4000-8000-0000000000c4', '60600000187', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001c4', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-04-01', DATE '2026-04-30');
  -- tenant sem assinatura (legado)
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000d4', 'c60-t41-legacy@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001d4',
    'c6000000-0000-4000-8000-0000000000d4', '60600000268', 'free', 'active');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a4', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal1"}', true);
SELECT pg_temp.c60_errors(
  'T41 nao-admin',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-0000000001c4'', p_plan => ''pro'', p_reason => ''promocao'')',
  'not-admin');
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000b4', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000b4","role":"authenticated","aal":"aal2"}', true);
SELECT pg_temp.c60_errors(
  'T41 tenant-not-found',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-0000000001ff'', p_plan => ''pro'', p_reason => ''promocao'')',
  'tenant-not-found');
SELECT pg_temp.c60_errors(
  'T41 subscription-not-found',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-0000000001d4'', p_plan => ''pro'', p_reason => ''promocao'')',
  'subscription-not-found');
SELECT pg_temp.c60_errors(
  'T41 motivo curto',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-0000000001c4'', p_plan => ''pro'', p_reason => ''ab'')',
  'tenant-reason-invalid');
SELECT pg_temp.c60_errors(
  'T41 motivo vazio',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-0000000001c4'', p_plan => ''pro'', p_reason => ''   '')',
  'tenant-reason-invalid');
RESET ROLE;
ROLLBACK;

-- ============ T42 — override: enums e free/past_due ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000a5', 'c60-t42-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000b5', 'c60-t42-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001b5',
    'c6000000-0000-4000-8000-0000000000b5', '60700000187', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001b5', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-05-01', DATE '2026-05-31');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000c5', 'c60-t42-pastdue@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001c5',
    'c6000000-0000-4000-8000-0000000000c5', '60700000268', 'standard', 'past_due');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001c5', 'standard', 'past_due',
    NULL, 10::smallint, DATE '2026-05-01', DATE '2026-05-31');
  UPDATE public.tenant_subscriptions SET past_due_since = pg_catalog.now()
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001c5';
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a5', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a5","role":"authenticated","aal":"aal2"}', true);
SELECT pg_temp.c60_errors(
  'T42 tenant-plan-invalid',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-0000000001b5'', p_plan => ''enterprise'', p_reason => ''plano invalido'')',
  'tenant-plan-invalid');
SELECT pg_temp.c60_errors(
  'T42 tenant-status-invalid enum',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-0000000001b5'', p_status => ''frozen'', p_reason => ''status invalido'')',
  'tenant-status-invalid');
SELECT pg_temp.c60_errors(
  'T42 past_due para free',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-0000000001c5'', p_plan => ''free'', p_reason => ''regularize antes'')',
  'tenant-status-invalid');
RESET ROLE;
ROLLBACK;

-- ============ T43 — upgrade imediato preserva ciclo e espelha ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000a6', 'c60-t43-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000b6', 'c60-t43-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001b6',
    'c6000000-0000-4000-8000-0000000000b6', '60800000187', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001b6', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-06-01', DATE '2026-06-30');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a6', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a6","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_override_subscription(
    p_tenant => 'c6000000-0000-4000-8000-0000000001b6',
    p_plan => 'pro', p_reason => 'upgrade para pro');
  IF v_res->>'outcome' <> 'applied' OR v_res->>'plan_slug' <> 'pro'
     OR v_res->>'status' <> 'active' OR v_res->'invoice_id' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION '0060 T43 falhou: envelope = %', v_res;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE
  v_plan text; v_start date; v_end date; v_n int;
  v_mirror text; v_audit_reason text; v_from text; v_to text;
BEGIN
  SELECT plan_slug, period_start, period_end INTO v_plan, v_start, v_end
  FROM public.tenant_subscriptions WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001b6';
  IF v_plan <> 'pro' OR v_start <> DATE '2026-06-01' OR v_end <> DATE '2026-06-30' THEN
    RAISE EXCEPTION '0060 T43 falhou: plano/ciclo apos upgrade (%/%/%)', v_plan, v_start, v_end;
  END IF;
  SELECT plan_id INTO v_mirror FROM public.tenants
  WHERE id = 'c6000000-0000-4000-8000-0000000001b6';
  IF v_mirror <> 'pro' THEN
    RAISE EXCEPTION '0060 T43 falhou: espelho nao acompanhou o upgrade (%)', v_mirror;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001b6';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0060 T43 falhou: upgrade emitiu fatura (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001b6'
    AND reason = 'subscription_override:upgrade para pro'
    AND from_value = 'plan:standard;status:active'
    AND to_value = 'plan:pro;status:active';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T43 falhou: trilha explicita = % (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001b6'
    AND action = 'tenant_status_changed' AND from_value = 'standard' AND to_value = 'pro'
    AND reason = 'upgrade para pro';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T43 falhou: trilha do espelho = % (esperado 1)', v_n;
  END IF;
  RAISE NOTICE '0060 T43 ok: upgrade imediato, ciclo preservado, espelho e auditoria';
END $$;
ROLLBACK;

-- ============ T44 — downgrade com ciclo aberto e diferido ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000a7', 'c60-t44-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000b7', 'c60-t44-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001b7',
    'c6000000-0000-4000-8000-0000000000b7', '60900000187', 'pro', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001b7', 'pro', 'active',
    NULL, 10::smallint, DATE '2026-12-01', DATE '2026-12-31');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a7', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a7","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_override_subscription(
    p_tenant => 'c6000000-0000-4000-8000-0000000001b7',
    p_plan => 'standard', p_reason => 'downgrade para standard');
  IF v_res->>'outcome' <> 'applied' OR v_res->>'plan_slug' <> 'pro' THEN
    RAISE EXCEPTION '0060 T44 falhou: envelope = %', v_res;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE
  v_plan text; v_pend text; v_pend_at date; v_mirror text;
BEGIN
  SELECT plan_slug, pending_plan_slug, pending_plan_at
    INTO v_plan, v_pend, v_pend_at
  FROM public.tenant_subscriptions WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001b7';
  IF v_plan <> 'pro' OR v_pend <> 'standard' OR v_pend_at <> DATE '2026-12-31' THEN
    RAISE EXCEPTION '0060 T44 falhou: downgrade nao diferido (%/%/%)', v_plan, v_pend, v_pend_at;
  END IF;
  SELECT plan_id INTO v_mirror FROM public.tenants
  WHERE id = 'c6000000-0000-4000-8000-0000000001b7';
  IF v_mirror <> 'pro' THEN
    RAISE EXCEPTION '0060 T44 falhou: espelho mudou antes do roll (%)', v_mirror;
  END IF;
  RAISE NOTICE '0060 T44 ok: downgrade agendado em pending_plan sem tocar plano/ciclo';
END $$;
ROLLBACK;

-- ============ T45a — free -> pago preenche billing_day ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000a8', 'c60-t45a-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000b8', 'c60-t45a-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001b8',
    'c6000000-0000-4000-8000-0000000000b8', '61000000187', 'free', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001b8', 'free', 'active');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a8', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a8","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_override_subscription(
    p_tenant => 'c6000000-0000-4000-8000-0000000001b8',
    p_plan => 'standard', p_reason => 'ativacao do plano pago');
  IF v_res->>'outcome' <> 'applied' OR v_res->>'plan_slug' <> 'standard' THEN
    RAISE EXCEPTION '0060 T45a falhou: envelope = %', v_res;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_billing smallint; v_day int; v_mirror text;
BEGIN
  SELECT billing_day INTO v_billing FROM public.tenant_subscriptions
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001b8';
  v_day := EXTRACT(DAY FROM (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date);
  IF v_billing IS DISTINCT FROM v_day::smallint THEN
    RAISE EXCEPTION '0060 T45a falhou: billing_day = % (esperado %)', v_billing, v_day;
  END IF;
  SELECT plan_id INTO v_mirror FROM public.tenants
  WHERE id = 'c6000000-0000-4000-8000-0000000001b8';
  IF v_mirror <> 'standard' THEN
    RAISE EXCEPTION '0060 T45a falhou: espelho = % (esperado standard)', v_mirror;
  END IF;
  RAISE NOTICE '0060 T45a ok: free->pago preenche billing_day de hoje (SP)';
END $$;
ROLLBACK;

-- ============ T45b — pago -> free imediato limpa o ciclo (sem 23514) ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000a9', 'c60-t45b-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000b9', 'c60-t45b-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001b9',
    'c6000000-0000-4000-8000-0000000000b9', '61100000187', 'standard', 'trial');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001b9', 'standard', 'trial',
    pg_catalog.now() + interval '7 days', 10::smallint);
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000a9', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000a9","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_override_subscription(
    p_tenant => 'c6000000-0000-4000-8000-0000000001b9',
    p_plan => 'free', p_reason => 'migracao para free');
  IF v_res->>'outcome' <> 'applied' OR v_res->>'plan_slug' <> 'free'
     OR v_res->>'status' <> 'active' THEN
    RAISE EXCEPTION '0060 T45b falhou: envelope = %', v_res;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE
  v_plan text; v_status text; v_billing smallint; v_start date;
  v_end date; v_trial timestamptz;
BEGIN
  SELECT plan_slug, status, billing_day, period_start, period_end, trial_ends_at
    INTO v_plan, v_status, v_billing, v_start, v_end, v_trial
  FROM public.tenant_subscriptions WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001b9';
  IF v_plan <> 'free' OR v_status <> 'active'
     OR v_billing IS NOT NULL OR v_start IS NOT NULL OR v_end IS NOT NULL
     OR v_trial IS NOT NULL THEN
    RAISE EXCEPTION '0060 T45b falhou: free com residuo de ciclo (%/%/%)',
      v_plan, v_status, v_billing;
  END IF;
  RAISE NOTICE '0060 T45b ok: pago->free imediato limpa billing_day/period_* na mesma instrucao';
END $$;
ROLLBACK;

-- ============ T45c — pago -> free com ciclo aberto e diferido ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000aa', 'c60-t45c-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000ba', 'c60-t45c-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001ba',
    'c6000000-0000-4000-8000-0000000000ba', '61200000187', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001ba', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-09-01', DATE '2026-09-30');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000aa', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000aa","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_override_subscription(
    p_tenant => 'c6000000-0000-4000-8000-0000000001ba',
    p_plan => 'free', p_reason => 'downgrade para free');
  IF v_res->>'outcome' <> 'applied' OR v_res->>'plan_slug' <> 'standard' THEN
    RAISE EXCEPTION '0060 T45c falhou: envelope = %', v_res;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_plan text; v_pend text; v_pend_at date;
BEGIN
  SELECT plan_slug, pending_plan_slug, pending_plan_at
    INTO v_plan, v_pend, v_pend_at
  FROM public.tenant_subscriptions WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001ba';
  IF v_plan <> 'standard' OR v_pend <> 'free' OR v_pend_at <> DATE '2026-09-30' THEN
    RAISE EXCEPTION '0060 T45c falhou: free com ciclo aberto nao foi diferido (%/%/%)',
      v_plan, v_pend, v_pend_at;
  END IF;
  RAISE NOTICE '0060 T45c ok: pago->free com ciclo aberto => pending_plan_slug=free';
END $$;
ROLLBACK;

-- ============ T46 — alvo fora da matriz: rejected + 1 auditoria, 0 UPDATE ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000ab', 'c60-t46-op@example.com');
  -- canceled standard
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000bb', 'c60-t46-cancel@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001bb',
    'c6000000-0000-4000-8000-0000000000bb', '61300000187', 'standard', 'canceled');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001bb', 'standard', 'canceled',
    NULL, 10::smallint, DATE '2026-02-01', DATE '2026-02-28', 'psp-cancel');
  -- active standard
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000bc', 'c60-t46-active@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001bc',
    'c6000000-0000-4000-8000-0000000000bc', '61300000268', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001bc', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-02-01', DATE '2026-02-28');
  -- trial standard
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-0000000000bd', 'c60-t46-trial@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-0000000001bd',
    'c6000000-0000-4000-8000-0000000000bd', '61300000349', 'standard', 'trial');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-0000000001bd', 'standard', 'trial',
    pg_catalog.now() + interval '10 days', 10::smallint);
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000ab', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000ab","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_res jsonb;
  v_tenant uuid;
  v_case text;
  v_new_status text;
  v_cases text[] := ARRAY['canceled->trial', 'canceled->active', 'active->canceled', 'trial->past_due'];
  i int;
BEGIN
  FOR i IN 1..4 LOOP
    v_case := v_cases[i];
    IF v_case = 'canceled->trial' THEN
      v_tenant := 'c6000000-0000-4000-8000-0000000001bb'; v_new_status := 'trial';
    ELSIF v_case = 'canceled->active' THEN
      v_tenant := 'c6000000-0000-4000-8000-0000000001bb'; v_new_status := 'active';
    ELSIF v_case = 'active->canceled' THEN
      v_tenant := 'c6000000-0000-4000-8000-0000000001bc'; v_new_status := 'canceled';
    ELSE
      v_tenant := 'c6000000-0000-4000-8000-0000000001bd'; v_new_status := 'past_due';
    END IF;

    v_res := public.admin_override_subscription(
      p_tenant => v_tenant, p_status => v_new_status,
      p_reason => 'tentativa fora da matriz');

    IF v_res->>'outcome' <> 'rejected'
       OR v_res->>'reason' <> 'subscription-transition-invalid'
       OR v_res->'plan_slug' IS DISTINCT FROM 'null'::jsonb
       OR v_res->'invoice_id' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION '0060 T46 falhou: envelope de recusa = % (%)', v_res, v_case;
    END IF;
  END LOOP;
END $$;
RESET ROLE;
DO $$
DECLARE v_status text; v_plan text; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001bb'
    AND reason = 'subscription-transition-invalid';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0060 T46 falhou: auditoria de canceled = % (esperado 2)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001bc'
    AND reason = 'subscription-transition-invalid';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T46 falhou: auditoria de active = % (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001bd'
    AND reason = 'subscription-transition-invalid';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T46 falhou: auditoria de trial = % (esperado 1)', v_n;
  END IF;
  SELECT status, plan_slug INTO v_status, v_plan FROM public.tenant_subscriptions
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001bb';
  IF v_status <> 'canceled' OR v_plan <> 'standard' THEN
    RAISE EXCEPTION '0060 T46 falhou: estado de canceled mudou (%/%)', v_status, v_plan;
  END IF;
  SELECT status INTO v_status FROM public.tenant_subscriptions
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001bc';
  IF v_status <> 'active' THEN
    RAISE EXCEPTION '0060 T46 falhou: estado de active mudou (%)', v_status;
  END IF;
  SELECT status INTO v_status FROM public.tenant_subscriptions
  WHERE tenant_id = 'c6000000-0000-4000-8000-0000000001bd';
  IF v_status <> 'trial' THEN
    RAISE EXCEPTION '0060 T46 falhou: estado de trial mudou (%)', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices
  WHERE tenant_id IN (
    'c6000000-0000-4000-8000-0000000001bb',
    'c6000000-0000-4000-8000-0000000001bc',
    'c6000000-0000-4000-8000-0000000001bd');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0060 T46 falhou: recusa emitiu fatura (%)', v_n;
  END IF;
  RAISE NOTICE '0060 T46 ok: 4 alvos invalidos => rejected, 1 auditoria cada, 0 UPDATE';
END $$;
ROLLBACK;

-- ============ T47 — fatura manual (competencia normalizada, catalogo) ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000ac', 'c60-t47-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-000000000bc2', 'c60-t47-own@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-000000001bc2',
    'c6000000-0000-4000-8000-000000000bc2', '61400000187', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-000000001bc2', 'standard', 'active',
    NULL, 10::smallint, DATE '2026-03-01', DATE '2026-03-31');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000ac', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000ac","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_override_subscription(
    p_tenant => 'c6000000-0000-4000-8000-000000001bc2',
    p_reason => 'cobranca manual marco',
    p_competencia => DATE '2026-03-17');
  IF v_res->>'outcome' <> 'applied' OR v_res->'invoice_id' IS NOT DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION '0060 T47 falhou: envelope = %', v_res;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE
  v_kind text; v_status text; v_comp date; v_start date; v_end date;
  v_due date; v_amount bigint; v_expected bigint; v_n int;
BEGIN
  v_expected := public.get_plan_price('standard');
  SELECT kind, status, competencia, period_start, period_end, due_date, amount_cents
    INTO v_kind, v_status, v_comp, v_start, v_end, v_due, v_amount
  FROM public.tenant_invoices WHERE tenant_id = 'c6000000-0000-4000-8000-000000001bc2';
  IF v_kind <> 'manual' OR v_status <> 'open'
     OR v_comp <> DATE '2026-03-01' OR v_start <> DATE '2026-03-01'
     OR v_end <> DATE '2026-03-31' OR v_due <> DATE '2026-03-10'
     OR v_amount <> v_expected THEN
    RAISE EXCEPTION '0060 T47 falhou: fatura manual = %/%/%/%/%/%',
      v_kind, v_comp, v_start, v_end, v_due, v_amount;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE tenant_id = 'c6000000-0000-4000-8000-000000001bc2'
    AND reason = 'subscription_override:cobranca manual marco';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T47 falhou: trilha da fatura manual = %', v_n;
  END IF;
  RAISE NOTICE '0060 T47 ok: fatura manual normalizada, valor do catalogo, auditada';
END $$;

-- T47b — segunda fatura na mesma competencia => tenant-invoice-duplicate.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000ac', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000ac","role":"authenticated","aal":"aal2"}', true);
SELECT pg_temp.c60_errors(
  'T47b fatura manual duplicada',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-000000001bc2'', p_reason => ''cobranca manual marco 2'', p_competencia => DATE ''2026-03-02'')',
  'tenant-invoice-duplicate');
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenant_invoices
  WHERE tenant_id = 'c6000000-0000-4000-8000-000000001bc2';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0060 T47b falhou: faturas = % (esperado 1)', v_n;
  END IF;
  RAISE NOTICE '0060 T47b ok: competencia duplicada nao cria 2a fatura';
END $$;
ROLLBACK;

-- ============ T48 — fatura manual clampa vencimento; free => invalido ============
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.c60_super('c6000000-0000-4000-8000-0000000000ad', 'c60-t48-op@example.com');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-000000000bd2', 'c60-t48-pago@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-000000001bd2',
    'c6000000-0000-4000-8000-000000000bd2', '61500000187', 'standard', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-000000001bd2', 'standard', 'active',
    NULL, 31::smallint, DATE '2026-02-01', DATE '2026-02-28');
  PERFORM pg_temp.c60_user('c6000000-0000-4000-8000-000000000bd3', 'c60-t48-free@example.com');
  PERFORM pg_temp.c60_tenant('c6000000-0000-4000-8000-000000001bd3',
    'c6000000-0000-4000-8000-000000000bd3', '61500000268', 'free', 'active');
  PERFORM pg_temp.c60_sub('c6000000-0000-4000-8000-000000001bd3', 'free', 'active');
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6000000-0000-4000-8000-0000000000ad', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6000000-0000-4000-8000-0000000000ad","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_override_subscription(
    p_tenant => 'c6000000-0000-4000-8000-000000001bd2',
    p_reason => 'cobranca manual fevereiro',
    p_competencia => DATE '2026-02-15');
  IF v_res->>'outcome' <> 'applied' OR v_res->'invoice_id' IS NOT DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION '0060 T48 falhou: envelope = %', v_res;
  END IF;
END $$;
SELECT pg_temp.c60_errors(
  'T48 fatura manual em free',
  'SELECT public.admin_override_subscription(p_tenant => ''c6000000-0000-4000-8000-000000001bd3'', p_reason => ''cobranca em free'', p_competencia => DATE ''2026-02-15'')',
  'tenant-plan-invalid');
RESET ROLE;
DO $$
DECLARE v_comp date; v_end date; v_due date; v_n int;
BEGIN
  SELECT competencia, period_end, due_date INTO v_comp, v_end, v_due
  FROM public.tenant_invoices WHERE tenant_id = 'c6000000-0000-4000-8000-000000001bd2';
  IF v_comp <> DATE '2026-02-01' OR v_end <> DATE '2026-02-28'
     OR v_due <> DATE '2026-02-28' THEN
    RAISE EXCEPTION '0060 T48 falhou: clamp de vencimento (%/%/%)', v_comp, v_end, v_due;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices
  WHERE tenant_id = 'c6000000-0000-4000-8000-000000001bd3';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0060 T48 falhou: free emitiu fatura (%)', v_n;
  END IF;
  RAISE NOTICE '0060 T48 ok: vencimento clampado no mes curto; free recusa fatura manual';
END $$;
ROLLBACK;

-- ============ Fixtures cleanup (fim) ============
BEGIN;
DO $$
DECLARE
  v_users uuid[] := ARRAY[
    'c5500000-0000-4000-8000-0000000000a1',
    'c5500000-0000-4000-8000-0000000000b1',
    'c5500000-0000-4000-8000-0000000000c1',
    'c5500000-0000-4000-8000-0000000000d1',
    'c5600000-0000-4000-8000-0000000000a1',
    'c5600000-0000-4000-8000-0000000000b1',
    'c5700000-0000-4000-8000-0000000000a1',
    'c5700000-0000-4000-8000-0000000000b1',
    'c5700000-0000-4000-8000-0000000000c1',
    'c5700000-0000-4000-8000-0000000000d1',
    'c5800000-0000-4000-8000-0000000000a1',
    'c5800000-0000-4000-8000-0000000000b1'
  ]::uuid[];
BEGIN
  IF to_regclass('public.tenant_invoices') IS NOT NULL THEN
    DELETE FROM public.tenant_invoices AS i
    USING public.tenants AS t
    WHERE i.tenant_id = t.id
      AND t.owner_user_id = ANY(v_users);
  END IF;
  IF to_regclass('public.psp_events') IS NOT NULL THEN
    DELETE FROM public.psp_events
    WHERE event_id LIKE 'c57-%' OR event_id LIKE 'c58-%';
  END IF;
  IF to_regclass('public.tenant_subscriptions') IS NOT NULL THEN
    DELETE FROM public.tenant_subscriptions AS s
    USING public.tenants AS t
    WHERE s.tenant_id = t.id
      AND t.owner_user_id = ANY(v_users);
  END IF;
  DELETE FROM public.admin_audit AS a
  USING public.tenants AS t
  WHERE t.owner_user_id = ANY(v_users)
    AND (a.tenant_id = t.id OR a.target_id = t.id);
END $$;
DELETE FROM auth.users
WHERE id = ANY (ARRAY[
  'c5500000-0000-4000-8000-0000000000a1',
  'c5500000-0000-4000-8000-0000000000b1',
  'c5500000-0000-4000-8000-0000000000c1',
  'c5500000-0000-4000-8000-0000000000d1',
  'c5600000-0000-4000-8000-0000000000a1',
  'c5600000-0000-4000-8000-0000000000b1',
  'c5700000-0000-4000-8000-0000000000a1',
  'c5700000-0000-4000-8000-0000000000b1',
  'c5700000-0000-4000-8000-0000000000c1',
  'c5700000-0000-4000-8000-0000000000d1',
  'c5800000-0000-4000-8000-0000000000a1',
  'c5800000-0000-4000-8000-0000000000b1'
]::uuid[]);
COMMIT;

\echo '0055-0060 subscription-billing: T00-T50 OK (T36-T49 = 0060)'
