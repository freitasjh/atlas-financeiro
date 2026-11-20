-- 0065-0068-psp-webhook.spec.sql — asaas-webhook / F5 / ADR-003 (BE-54..BE-56).
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0065-0068-psp-webhook.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova em banco real (mock não avalia coluna, CHECK, índice parcial, ACL,
-- SECURITY DEFINER, search_path nem idempotência de migration):
--   T00 estrutura de 0065/0066: `psp_event_at`/`process_reason`/
--       `payload_scrubbed_at` (nullable, sem default), CHECK de
--       `process_reason` com EXATAMENTE os 8 rótulos de SPEC §4.8,
--       `idx_psp_events_pending` parcial (`WHERE processed_at IS NULL`),
--       `last_event_at`/`last_event_id` + CHECK de par e de comprimento,
--       COMMENT em cada coluna nova (incl. a fonte de `psp_event_at`),
--       `private.psp_kind_rank(text)` IMMUTABLE/STRICT/search_path vazio/sem
--       grant, `private.safe_ts(text)` IMMUTABLE/search_path vazio/sem grant,
--       `public.ingest_psp_event(...)` DEFINER/search_path vazio/
--       EXECUTE só service_role, e `service_role` SEM `INSERT` de tabela.
--   T01 admissão persiste (`outcome=stored`), `received_at` do servidor e
--       ids/`psp_event_at` extraídos do payload.
--   T02 `service_role` sem INSERT direto na tabela (42501) e com EXECUTE.
--   T03 payload/id/tipo inválidos ⇒ rótulo fixo `psp-event-invalid`, 0 escrita,
--       sem interpolar valor recebido.
--   T04 mesmo `event_id` 3× ⇒ stored, duplicate, duplicate; 1 linha; payload,
--       received_at e event_type da 1ª intactos (REQ-12).
--   T05 `psp_event_at`: precedência do parâmetro, `payment.dateCreated`,
--       fallback `subscription.dateCreated`, ausente ⇒ NULL, inválido ⇒ NULL,
--       candidato inválido com fallback válido ⇒ usa o fallback.
--   T06 `authenticated`/`anon` sem EXECUTE (42501) e sem privilégio na tabela.
--   T19 evento novo aplica e avança a marca d'água (aplicado + `last_event_*`).
--   T20 evento velho ⇒ `noop`/`stale-event`, zero transição, zero fatura e
--       marca intacta (REQ-17/REQ-18).
--   T21 rank desempata no mesmo instante (confirmed 40 × overdue 20).
--   T22 `event_id` fecha a ordem total (maior aplica, menor é stale).
--   T23 Adendo A1: `event_type` de rank 0 não envenena a comparação de linha
--       (unmapped nunca vira `stale`; marca com rank 0 não bloqueia o próximo).
--   T24 Adendo A2: `service_role` sem `EXECUTE` no apply (42501) e com
--       `EXECUTE` no dreno; `authenticated`/`anon` sem nenhum dos dois.
--   T25 Adendo A3: marca = `LEAST(psp_event_at, now())`; `psp_event_at`
--       original preservado; evento real seguinte não é bloqueado.
--   T26 dreno processa pendentes, conta applied/noop e a 2ª chamada é 0.
--   T27 evento já processado não é reaplicado (`duplicate` ⇒ `noop`).
--   T28 erro de apply isolado em subtransação (`attempts+1`, `apply-error`).
--   T29 teto de `attempts` = 10 ⇒ `rejected`/`apply-error`, linha preservada.
--   T27b REQ-25: `drain(p_event_id)` com id inexistente ⇒ `failed=1`, sem RAISE.
--   T28b REQ-26: backoff `received_at + attempts²×30s` respeitado e clamp do
--       `p_limit` (0 ⇒ 1; 9999 ⇒ 500).
--   T30 `0067` idempotente 2× (funções, ACL, `COMMENT` e corpos intactos).
--   T31 `0068` scrub por WHITELIST: payload com `cpfCnpj`/`email`/`creditCard`/
--       endereço/descrição + chave inventada (`extraPii`) ⇒ reduzido ao
--       conjunto exato de chaves; `payload_scrubbed_at` preenchido; identidade,
--       ordem e terminal intactos; linha preservada; ACL só `service_role`.
--   T31b `0068` whitelist por TIPO: objeto forjado em `payment.subscription`
--       (a API manda string) com PII dentro ⇒ descartado, nunca serializado;
--       escalares legítimos das demais chaves sobrevivem (SPEC §9: o token não
--       prova a integridade do corpo).
--   T32 só evento PROCESSADO e > 90 dias é scrubado (pendente e recente
--       intocados); `remaining_overdue` respeita o `p_limit` e o clamp
--       (0 ⇒ 1; 9999 ⇒ 500).
--   T33 idempotência da 2ª passada (`scrubbed = 0`, nada reescrito) e
--       `COMMENT` da tabela com a política A3 (90 / 24 / 5 anos).
--   T33b `0068` idempotente 2× (função, ACL e `COMMENT` intactos).
--   T34 reenvio pós-scrub ⇒ `duplicate` (sem devolver PII); dreno ⇒ `noop`,
--       `applied = 0`; `apply_psp_event` mantém `psp-event-already-processed`;
--       e a ordem de §6.1 continua funcionando com o payload reduzido.
--   T40 0065/0066 idempotentes 2× (mesma estrutura, nenhum erro).
--
-- REQ-29 (2 sessões concorrentes) NÃO é provado neste arquivo: ele roda em uma
-- única sessão psql e a 2ª conexão não enxerga fixtures não commitadas
-- (`BEGIN/ROLLBACK`), então o lock não é contendido de forma determinística.
-- Cobertura parcial: T27 (`psp-event-already-processed` ⇒ `duplicate`) e T30
-- (corpo com `SKIP LOCKED` + `processed_at IS NULL`). Lacuna declarada.
--
-- Fixtures `c65*`/`c66*`/`c67*`/`c68*`; todo cenário mutável roda em transação
-- com ROLLBACK. Nenhuma escrita permanente, nenhum rótulo com PII/id.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (inicio; rerunnable) ============
BEGIN;
DELETE FROM public.psp_events
WHERE event_id LIKE 'c65%' OR event_id LIKE 'c66%'
   OR event_id LIKE 'c67%' OR event_id LIKE 'c68%';
DELETE FROM public.tenant_invoices AS i
USING public.tenants AS t
WHERE i.tenant_id = t.id
  AND t.owner_user_id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  );
DELETE FROM public.tenant_subscriptions AS s
USING public.tenants AS t
WHERE s.tenant_id = t.id
  AND t.owner_user_id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  );
DELETE FROM public.admin_audit AS a
USING public.tenants AS t
WHERE t.owner_user_id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  )
  AND (a.tenant_id = t.id OR a.target_id = t.id);
DELETE FROM public.tenants
WHERE owner_user_id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  );
DELETE FROM auth.users
WHERE id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  );
COMMIT;

-- ============ T00 — estrutura de 0065 e 0066 ============
DO $$
DECLARE
  v_rel oid;
  v_proc record;
  v_exp record;
  v_count int;
  v_def text;
  v_cmt text;
  v_vol "char";
BEGIN
  v_rel := to_regclass('public.psp_events');
  IF v_rel IS NULL THEN
    RAISE EXCEPTION 'F5 T00 falhou: public.psp_events ausente';
  END IF;

  -- 3 colunas novas de 0065 (Ed1–Ed3): nullable, sem default.
  FOR v_exp IN
    SELECT * FROM (VALUES
      ('psp_event_at',        'timestamp with time zone'),
      ('process_reason',      'text'),
      ('payload_scrubbed_at', 'timestamp with time zone')
    ) AS t(col, dt)
  LOOP
    SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'psp_events'
      AND column_name = v_exp.col
      AND data_type = v_exp.dt
      AND is_nullable = 'YES'
      AND column_default IS NULL;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'F5 T00 falhou: psp_events.% ausente/nula/default inesperado', v_exp.col;
    END IF;
    v_cmt := col_description(v_rel, (
      SELECT attnum FROM pg_catalog.pg_attribute
      WHERE attrelid = v_rel AND attname = v_exp.col
    ));
    IF v_cmt IS NULL OR v_cmt = '' THEN
      RAISE EXCEPTION 'F5 T00 falhou: psp_events.% sem COMMENT', v_exp.col;
    END IF;
  END LOOP;

  -- psp_event_at: COMMENT declara a fonte (REQ-10/REQ-06).
  v_cmt := col_description(v_rel, (
    SELECT attnum FROM pg_catalog.pg_attribute
    WHERE attrelid = v_rel AND attname = 'psp_event_at'
  ));
  IF v_cmt NOT LIKE '%dateCreated%' OR v_cmt NOT LIKE '%payload%' THEN
    RAISE EXCEPTION 'F5 T00 falhou: COMMENT de psp_event_at nao documenta a fonte (dateCreated/payload)';
  END IF;

  -- CHECK de process_reason: EXATAMENTE os 8 rótulos de §4.8.
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = v_rel
    AND c.conname = 'psp_events_process_reason_check'
    AND c.contype = 'c';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'F5 T00 falhou: CHECK psp_events_process_reason_check ausente';
  END IF;
  SELECT count(*) INTO v_count
  FROM pg_catalog.regexp_matches(v_def, '''([a-z-]+)''', 'g');
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'F5 T00 falhou: CHECK de process_reason com % rotulos (esperado 8)', v_count;
  END IF;
  FOREACH v_cmt IN ARRAY ARRAY[
    'stale-event', 'unmapped-event-type', 'already-processed',
    'transition-invalid', 'subscription-not-found', 'invoice-not-found',
    'amount-divergence', 'apply-error'
  ]
  LOOP
    IF v_def NOT LIKE '%''' || v_cmt || '''%' THEN
      RAISE EXCEPTION 'F5 T00 falhou: rotulo % ausente do CHECK de process_reason', v_cmt;
    END IF;
  END LOOP;

  -- Índice parcial da fila (Ed4).
  SELECT indexdef INTO v_def
  FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'idx_psp_events_pending';
  IF v_def IS NULL
     OR v_def NOT LIKE '%(received_at)%'
     OR v_def NOT LIKE '%WHERE (processed_at IS NULL)%' THEN
    RAISE EXCEPTION 'F5 T00 falhou: idx_psp_events_pending ausente ou nao parcial em received_at';
  END IF;

  -- tenant_subscriptions: par de marca d'água + CHECKs (Ed5).
  v_rel := to_regclass('public.tenant_subscriptions');
  FOR v_exp IN
    SELECT * FROM (VALUES
      ('last_event_at', 'timestamp with time zone'),
      ('last_event_id', 'text')
    ) AS t(col, dt)
  LOOP
    SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenant_subscriptions'
      AND column_name = v_exp.col
      AND data_type = v_exp.dt
      AND is_nullable = 'YES';
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'F5 T00 falhou: tenant_subscriptions.% ausente', v_exp.col;
    END IF;
    v_cmt := col_description(v_rel, (
      SELECT attnum FROM pg_catalog.pg_attribute
      WHERE attrelid = v_rel AND attname = v_exp.col
    ));
    IF v_cmt IS NULL OR v_cmt = '' THEN
      RAISE EXCEPTION 'F5 T00 falhou: tenant_subscriptions.% sem COMMENT', v_exp.col;
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = v_rel
    AND c.conname = 'tenant_subscriptions_last_event_pair_check'
    AND c.contype = 'c';
  IF v_def IS NULL OR v_def NOT LIKE '%last_event_at IS NULL%'
     OR v_def NOT LIKE '%last_event_id IS NULL%' THEN
    RAISE EXCEPTION 'F5 T00 falhou: CHECK de par last_event_* ausente';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = v_rel
    AND c.conname = 'tenant_subscriptions_last_event_id_len_check'
    AND c.contype = 'c';
  IF v_def IS NULL OR v_def NOT LIKE '%char_length(last_event_id)%' THEN
    RAISE EXCEPTION 'F5 T00 falhou: CHECK de comprimento de last_event_id ausente';
  END IF;

  -- private.psp_kind_rank(text): IMMUTABLE, STRICT, search_path vazio, sem grant.
  SELECT * INTO v_proc FROM pg_catalog.pg_proc
  WHERE oid = to_regprocedure('private.psp_kind_rank(text)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F5 T00 falhou: private.psp_kind_rank(text) ausente';
  END IF;
  IF v_proc.provolatile <> 'i' THEN
    RAISE EXCEPTION 'F5 T00 falhou: psp_kind_rank provolatile=% (esperado i)', v_proc.provolatile;
  END IF;
  IF v_proc.proisstrict IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'F5 T00 falhou: psp_kind_rank sem STRICT (REQ-07)';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'F5 T00 falhou: psp_kind_rank nao deveria ser SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'F5 T00 falhou: psp_kind_rank sem search_path='' travado';
  END IF;
  IF v_proc.proacl IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(v_proc.proacl) AS a
    WHERE a.grantee = 0
       OR a.grantee = 'anon'::regrole::oid
       OR a.grantee = 'authenticated'::regrole::oid
       OR a.grantee = 'service_role'::regrole::oid
  ) THEN
    RAISE EXCEPTION 'F5 T00 falhou: psp_kind_rank com grant para PUBLIC/anon/authenticated/service_role';
  END IF;

  -- private.safe_ts(text): IMMUTABLE, search_path vazio, sem EXECUTE para ninguem.
  SELECT * INTO v_proc FROM pg_catalog.pg_proc
  WHERE oid = to_regprocedure('private.safe_ts(text)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F5 T00 falhou: private.safe_ts(text) ausente';
  END IF;
  IF v_proc.provolatile <> 'i' THEN
    RAISE EXCEPTION 'F5 T00 falhou: safe_ts provolatile=% (esperado i)', v_proc.provolatile;
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'F5 T00 falhou: safe_ts nao deveria ser SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'F5 T00 falhou: safe_ts sem search_path='' travado';
  END IF;
  IF v_proc.proacl IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(v_proc.proacl) AS a
    WHERE a.grantee = 0
       OR a.grantee = 'anon'::regrole::oid
       OR a.grantee = 'authenticated'::regrole::oid
       OR a.grantee = 'service_role'::regrole::oid
  ) THEN
    RAISE EXCEPTION 'F5 T00 falhou: safe_ts com grant para PUBLIC/anon/authenticated/service_role';
  END IF;

  -- public.ingest_psp_event(...): assinatura exata, DEFINER, search_path vazio.
  SELECT * INTO v_proc FROM pg_catalog.pg_proc
  WHERE oid = to_regprocedure(
    'public.ingest_psp_event(jsonb,text,text,timestamp with time zone,text)'
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F5 T00 falhou: public.ingest_psp_event(...) ausente com a assinatura de §4.2';
  END IF;
  IF v_proc.prosecdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'F5 T00 falhou: ingest_psp_event sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
    WHERE c IN ('search_path=', 'search_path=""')
  ) THEN
    RAISE EXCEPTION 'F5 T00 falhou: ingest_psp_event sem search_path='' travado';
  END IF;
  IF v_proc.proowner <> 'postgres'::regrole::oid THEN
    RAISE EXCEPTION 'F5 T00 falhou: ingest_psp_event com owner diferente de postgres';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.ingest_psp_event(jsonb,text,text,timestamp with time zone,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'F5 T00 falhou: ingest_psp_event sem EXECUTE para service_role';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.ingest_psp_event(jsonb,text,text,timestamp with time zone,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.ingest_psp_event(jsonb,text,text,timestamp with time zone,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'F5 T00 falhou: ingest_psp_event com EXECUTE para cliente';
  END IF;

  -- Ed6: service_role sem DML de tabela no inbox; cliente sem nada.
  IF has_table_privilege('service_role', 'public.psp_events', 'INSERT') THEN
    RAISE EXCEPTION 'F5 T00 falhou: service_role ainda com INSERT direto (Ed6 nao aplicado)';
  END IF;
  IF has_table_privilege('service_role', 'public.psp_events', 'UPDATE')
     OR has_table_privilege('service_role', 'public.psp_events', 'DELETE')
     OR has_table_privilege('service_role', 'public.psp_events', 'SELECT') THEN
    RAISE EXCEPTION 'F5 T00 falhou: service_role com DML de tabela no inbox';
  END IF;
  IF has_table_privilege('authenticated', 'public.psp_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.psp_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.psp_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.psp_events', 'DELETE') THEN
    RAISE EXCEPTION 'F5 T00 falhou: authenticated com privilegio no inbox';
  END IF;
  IF has_table_privilege('anon', 'public.psp_events', 'SELECT')
     OR has_table_privilege('anon', 'public.psp_events', 'INSERT') THEN
    RAISE EXCEPTION 'F5 T00 falhou: anon com privilegio no inbox';
  END IF;

  -- psp_kind_rank: mapa fechado de §4.4 (event_type cru e kind normalizado).
  IF private.psp_kind_rank('PAYMENT_CONFIRMED') <> 40
     OR private.psp_kind_rank('payment_confirmed') <> 40
     OR private.psp_kind_rank('PAYMENT_REFUNDED') <> 30
     OR private.psp_kind_rank('PAYMENT_OVERDUE') <> 20
     OR private.psp_kind_rank('SUBSCRIPTION_DELETED') <> 10
     OR private.psp_kind_rank('PAYMENT_CREATED') <> 0
     OR private.psp_kind_rank('qualquer-outro') <> 0 THEN
    RAISE EXCEPTION 'F5 T00 falhou: mapa de psp_kind_rank diverge de §4.4';
  END IF;
  -- STRICT (REQ-07): NULL entra como NULL; o chamador COALESCE(...,0).
  IF private.psp_kind_rank(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T00 falhou: psp_kind_rank(NULL) deveria ser NULL (STRICT)';
  END IF;

  RAISE NOTICE 'F5 T00 ok: 0065/0066 aplicadas (colunas, CHECKs, indice parcial, ACLs)';
END $$;

-- ============ T00b — CHECK de par e de rótulo (comportamento) ============
BEGIN;
INSERT INTO auth.users (id, email)
VALUES ('c6500000-0000-4000-8000-0000000000a1', 'c65-f5@example.com');
INSERT INTO public.tenants (id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status)
VALUES ('c6500000-0000-4000-8000-0000000001a1', 'pf',
        'c6500000-0000-4000-8000-0000000000a1', '65000000187',
        'C65 F5', 'free', 'active');
INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status)
VALUES ('c6500000-0000-4000-8000-0000000001a1', 'free', 'active');

DO $$
DECLARE
  v_ok boolean := false;
BEGIN
  -- Par incompleto (só last_event_at) viola o CHECK.
  BEGIN
    UPDATE public.tenant_subscriptions
    SET last_event_at = pg_catalog.now()
    WHERE tenant_id = 'c6500000-0000-4000-8000-0000000001a1';
    RAISE EXCEPTION 'F5 T00b falhou: par incompleto aceito';
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'F5 T00b falhou: violacao de par nao levantou check_violation';
  END IF;

  -- Par completo passa.
  UPDATE public.tenant_subscriptions
  SET last_event_at = pg_catalog.now(), last_event_id = 'evt-c65'
  WHERE tenant_id = 'c6500000-0000-4000-8000-0000000001a1';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F5 T00b falhou: par completo nao atualizou';
  END IF;

  -- last_event_id acima de 255 viola o CHECK de comprimento.
  BEGIN
    UPDATE public.tenant_subscriptions
    SET last_event_id = repeat('a', 256)
    WHERE tenant_id = 'c6500000-0000-4000-8000-0000000001a1';
    RAISE EXCEPTION 'F5 T00b falhou: last_event_id de 256 aceito';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Rótulo fora de §4.8 é recusado; um dos 8 é aceito.
  BEGIN
    INSERT INTO public.psp_events (event_id, event_type, payload, process_reason)
    VALUES ('c65-label-bad', 'PAYMENT_CREATED', '{}'::jsonb, 'qualquer-coisa');
    RAISE EXCEPTION 'F5 T00b falhou: process_reason fora de §4.8 aceito';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO public.psp_events (event_id, event_type, payload, process_reason)
  VALUES ('c65-label-ok', 'PAYMENT_CREATED', '{}'::jsonb, 'stale-event');
  RAISE NOTICE 'F5 T00b ok: CHECK de par e de rotulo de process_reason';
END $$;
ROLLBACK;

-- ============ T01 — admissão persiste e devolve stored ============
BEGIN;
DO $$
DECLARE
  v_out jsonb;
  v_row public.psp_events%ROWTYPE;
BEGIN
  SET LOCAL ROLE service_role;
  v_out := public.ingest_psp_event(
    '{"id":"evt-c66-001","event":"PAYMENT_CONFIRMED","payment":{"id":"pay-c66-1","subscription":"sub-c66-1","dateCreated":"2026-11-18"}}'::jsonb,
    'c66-001', 'PAYMENT_CONFIRMED'
  );
  RESET ROLE;

  IF v_out IS DISTINCT FROM '{"stored": true, "outcome": "stored"}'::jsonb THEN
    RAISE EXCEPTION 'F5 T01 falhou: retorno inesperado %', v_out;
  END IF;

  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c66-001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F5 T01 falhou: evento nao persistido';
  END IF;
  IF v_row.provider <> 'asaas' OR v_row.event_type <> 'PAYMENT_CONFIRMED' THEN
    RAISE EXCEPTION 'F5 T01 falhou: provider/event_type errados';
  END IF;
  IF v_row.received_at <> pg_catalog.now() THEN
    RAISE EXCEPTION 'F5 T01 falhou: received_at nao veio do relogio do servidor';
  END IF;
  IF v_row.psp_payment_id <> 'pay-c66-1'
     OR v_row.psp_subscription_id <> 'sub-c66-1'
     OR v_row.psp_invoice_id <> 'pay-c66-1' THEN
    RAISE EXCEPTION 'F5 T01 falhou: ids do payload nao extraidos (%,%,%)',
      v_row.psp_payment_id, v_row.psp_subscription_id, v_row.psp_invoice_id;
  END IF;
  IF v_row.psp_event_at IS NULL OR v_row.psp_event_at::date <> DATE '2026-11-18' THEN
    RAISE EXCEPTION 'F5 T01 falhou: psp_event_at nao derivado do payload';
  END IF;
  IF v_row.processed_at IS NOT NULL OR v_row.process_outcome IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T01 falhou: admissao marcou terminal (nao deveria)';
  END IF;
  RAISE NOTICE 'F5 T01 ok: ingest persiste e devolve stored';
END $$;
ROLLBACK;

-- ============ T02 — service_role sem INSERT direto (Ed6), com EXECUTE ============
DO $$
DECLARE
  v_msg text;
BEGIN
  IF NOT has_function_privilege(
    'service_role',
    'public.ingest_psp_event(jsonb,text,text,timestamp with time zone,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'F5 T02 falhou: service_role sem EXECUTE em ingest_psp_event';
  END IF;

  BEGIN
    SET LOCAL ROLE service_role;
    INSERT INTO public.psp_events (event_id, event_type, payload)
    VALUES ('c66-direct', 'PAYMENT_CREATED', '{}'::jsonb);
    RAISE EXCEPTION 'F5 T02 falhou: INSERT direto de service_role aceito';
  EXCEPTION WHEN insufficient_privilege THEN
    v_msg := SQLERRM;
  END;
  RESET ROLE;

  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'F5 T02 falhou: INSERT direto nao levantou 42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.psp_events WHERE event_id = 'c66-direct') THEN
    RAISE EXCEPTION 'F5 T02 falhou: linha gravada por INSERT direto';
  END IF;
  RAISE NOTICE 'F5 T02 ok: service_role sem INSERT direto (42501) e com EXECUTE';
END $$;

-- ============ T03 — validação fechada, rótulo fixo, 0 escrita ============
BEGIN;
DO $$
DECLARE
  v_msg text;
  v_count int;
BEGIN
  -- (1) provider diferente de asaas.
  BEGIN
    PERFORM public.ingest_psp_event('{}'::jsonb, 'c66-bad-provider', 'PAYMENT_CREATED', NULL, 'outro');
    RAISE EXCEPTION 'F5 T03 falhou: provider invalido aceito';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'psp-event-invalid' THEN
    RAISE EXCEPTION 'F5 T03 falhou: provider invalido -> %', v_msg;
  END IF;

  -- (2) event_id vazio (payload sem `id`).
  v_msg := NULL;
  BEGIN
    PERFORM public.ingest_psp_event('{"event":"PAYMENT_CREATED"}'::jsonb, '', 'PAYMENT_CREATED');
    RAISE EXCEPTION 'F5 T03 falhou: event_id vazio aceito';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'psp-event-invalid' THEN
    RAISE EXCEPTION 'F5 T03 falhou: event_id vazio -> %', v_msg;
  END IF;

  -- (3) event_id com 256 caracteres.
  v_msg := NULL;
  BEGIN
    PERFORM public.ingest_psp_event('{}'::jsonb, repeat('a', 256), 'PAYMENT_CREATED');
    RAISE EXCEPTION 'F5 T03 falhou: event_id de 256 aceito';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'psp-event-invalid' THEN
    RAISE EXCEPTION 'F5 T03 falhou: event_id 256 -> %', v_msg;
  END IF;

  -- (4) event_type ausente (payload sem `event`).
  v_msg := NULL;
  BEGIN
    PERFORM public.ingest_psp_event('{"id":"evt-c66-002"}'::jsonb, 'c66-002', NULL);
    RAISE EXCEPTION 'F5 T03 falhou: event_type NULL aceito';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'psp-event-invalid' THEN
    RAISE EXCEPTION 'F5 T03 falhou: event_type NULL -> %', v_msg;
  END IF;

  -- (5) event_type com 129 caracteres.
  v_msg := NULL;
  BEGIN
    PERFORM public.ingest_psp_event('{}'::jsonb, 'c66-003', repeat('a', 129));
    RAISE EXCEPTION 'F5 T03 falhou: event_type de 129 aceito';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'psp-event-invalid' THEN
    RAISE EXCEPTION 'F5 T03 falhou: event_type 129 -> %', v_msg;
  END IF;

  -- (6) payload acima de 64 KiB.
  v_msg := NULL;
  BEGIN
    PERFORM public.ingest_psp_event(
      pg_catalog.jsonb_build_object('blob', repeat('a', 70000)),
      'c66-004', 'PAYMENT_CREATED'
    );
    RAISE EXCEPTION 'F5 T03 falhou: payload > 64 KiB aceito';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'psp-event-invalid' THEN
    RAISE EXCEPTION 'F5 T03 falhou: payload grande -> %', v_msg;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.psp_events
  WHERE event_id LIKE 'c66-%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'F5 T03 falhou: % linha(s) gravada(s) em chamada invalida', v_count;
  END IF;
  RAISE NOTICE 'F5 T03 ok: 6 chamadas invalidas -> psp-event-invalid, 0 escrita';
END $$;
ROLLBACK;

-- ============ T04 — mesmo event_id 3× => 1 linha, sem alterar a 1ª ============
BEGIN;
DO $$
DECLARE
  v_out jsonb;
  v_count int;
  v_row public.psp_events%ROWTYPE;
BEGIN
  v_out := public.ingest_psp_event(
    '{"id":"evt-c66-010","event":"PAYMENT_OVERDUE","payment":{"id":"pay-c66-10"}}'::jsonb,
    'c66-010', 'PAYMENT_OVERDUE'
  );
  IF v_out->>'outcome' <> 'stored' OR (v_out->>'stored')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'F5 T04 falhou: 1a chamada deveria ser stored (%)', v_out;
  END IF;

  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c66-010';

  v_out := public.ingest_psp_event(
    '{"id":"evt-c66-010","event":"PAYMENT_CONFIRMED","payment":{"id":"outro"}}'::jsonb,
    'c66-010', 'PAYMENT_CONFIRMED'
  );
  IF v_out IS DISTINCT FROM '{"stored": false, "outcome": "duplicate"}'::jsonb THEN
    RAISE EXCEPTION 'F5 T04 falhou: 2a chamada deveria ser duplicate (%)', v_out;
  END IF;

  v_out := public.ingest_psp_event(
    '{"id":"evt-c66-010","event":"PAYMENT_CONFIRMED"}'::jsonb,
    'c66-010', 'PAYMENT_CONFIRMED'
  );
  IF v_out->>'outcome' <> 'duplicate' THEN
    RAISE EXCEPTION 'F5 T04 falhou: 3a chamada deveria ser duplicate (%)', v_out;
  END IF;

  SELECT count(*) INTO v_count FROM public.psp_events WHERE event_id = 'c66-010';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F5 T04 falhou: % linhas para o mesmo event_id', v_count;
  END IF;

  -- REQ-12: o duplicado nao altera nada da linha existente.
  IF NOT EXISTS (
    SELECT 1 FROM public.psp_events
    WHERE event_id = 'c66-010'
      AND event_type = 'PAYMENT_OVERDUE'
      AND payload = '{"id":"evt-c66-010","event":"PAYMENT_OVERDUE","payment":{"id":"pay-c66-10"}}'::jsonb
      AND received_at = v_row.received_at
      AND psp_payment_id = 'pay-c66-10'
      AND processed_at IS NULL
      AND attempts = 0
  ) THEN
    RAISE EXCEPTION 'F5 T04 falhou: duplicado alterou a linha existente';
  END IF;
  RAISE NOTICE 'F5 T04 ok: stored/duplicate/duplicate com 1 linha intacta';
END $$;
ROLLBACK;

-- ============ T05 — psp_event_at derivado (fonte documentada) ============
BEGIN;
DO $$
DECLARE
  v_row public.psp_events%ROWTYPE;
BEGIN
  -- (a) payment.dateCreated.
  PERFORM public.ingest_psp_event(
    '{"id":"evt-c66-020","event":"PAYMENT_CONFIRMED","payment":{"dateCreated":"2026-11-18"}}'::jsonb,
    'c66-020', 'PAYMENT_CONFIRMED'
  );
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c66-020';
  IF v_row.psp_event_at IS NULL OR v_row.psp_event_at::date <> DATE '2026-11-18' THEN
    RAISE EXCEPTION 'F5 T05 falhou: payment.dateCreated nao virou psp_event_at';
  END IF;

  -- (b) fallback subscription.dateCreated.
  PERFORM public.ingest_psp_event(
    '{"id":"evt-c66-021","event":"SUBSCRIPTION_DELETED","subscription":{"id":"sub-c66-2","dateCreated":"2026-11-17 10:30:00"}}'::jsonb,
    'c66-021', 'SUBSCRIPTION_DELETED'
  );
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c66-021';
  IF v_row.psp_event_at IS NULL OR v_row.psp_event_at::date <> DATE '2026-11-17' THEN
    RAISE EXCEPTION 'F5 T05 falhou: subscription.dateCreated nao virou psp_event_at';
  END IF;

  -- (c) parâmetro vence o payload.
  PERFORM public.ingest_psp_event(
    '{"id":"evt-c66-022","event":"PAYMENT_OVERDUE","payment":{"dateCreated":"2026-11-18"}}'::jsonb,
    'c66-022', 'PAYMENT_OVERDUE', '2026-01-02T03:04:05Z'::timestamptz
  );
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c66-022';
  IF v_row.psp_event_at IS DISTINCT FROM '2026-01-02T03:04:05Z'::timestamptz THEN
    RAISE EXCEPTION 'F5 T05 falhou: p_event_at nao teve precedencia';
  END IF;

  -- (d) ausente => NULL (nunca now()).
  PERFORM public.ingest_psp_event(
    '{"id":"evt-c66-023","event":"PAYMENT_CREATED"}'::jsonb,
    'c66-023', 'PAYMENT_CREATED'
  );
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c66-023';
  IF v_row.psp_event_at IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T05 falhou: psp_event_at deveria ser NULL sem data no payload';
  END IF;

  -- (e) inválido => NULL, sem levantar erro.
  PERFORM public.ingest_psp_event(
    '{"id":"evt-c66-024","event":"PAYMENT_CREATED","payment":{"dateCreated":"nao-e-data"}}'::jsonb,
    'c66-024', 'PAYMENT_CREATED'
  );
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c66-024';
  IF v_row.psp_event_at IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T05 falhou: data invalida deveria virar NULL';
  END IF;

  -- (f) candidato inválido não anula o fallback válido (COALESCE por candidato).
  PERFORM public.ingest_psp_event(
    '{"id":"evt-c66-025","event":"PAYMENT_CREATED","payment":{"dateCreated":"lixo"},"dateCreated":"2026-11-18"}'::jsonb,
    'c66-025', 'PAYMENT_CREATED'
  );
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c66-025';
  IF v_row.psp_event_at IS NULL OR v_row.psp_event_at::date <> DATE '2026-11-18' THEN
    RAISE EXCEPTION 'F5 T05 falhou: candidato invalido abortou fallback valido';
  END IF;
  RAISE NOTICE 'F5 T05 ok: psp_event_at com precedencia, fallback, NULL, invalido e fallback pos-invalido';
END $$;
ROLLBACK;

-- ============ T06 — cliente sem EXECUTE (42501) ============
DO $$
DECLARE
  v_msg text;
BEGIN
  FOREACH v_msg IN ARRAY ARRAY['authenticated', 'anon']
  LOOP
    IF has_function_privilege(
      v_msg,
      'public.ingest_psp_event(jsonb,text,text,timestamp with time zone,text)',
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'F5 T06 falhou: % com EXECUTE em ingest_psp_event', v_msg;
    END IF;
  END LOOP;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.ingest_psp_event('{"id":"evt-c66-030","event":"PAYMENT_CREATED"}'::jsonb,
                                   'c66-030', 'PAYMENT_CREATED');
    RAISE EXCEPTION 'F5 T06 falhou: authenticated executou ingest_psp_event';
  EXCEPTION WHEN insufficient_privilege THEN
    v_msg := SQLERRM;
  END;
  RESET ROLE;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'F5 T06 falhou: authenticated nao recebeu 42501';
  END IF;

  v_msg := NULL;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.ingest_psp_event('{"id":"evt-c66-031","event":"PAYMENT_CREATED"}'::jsonb,
                                   'c66-031', 'PAYMENT_CREATED');
    RAISE EXCEPTION 'F5 T06 falhou: anon executou ingest_psp_event';
  EXCEPTION WHEN insufficient_privilege THEN
    v_msg := SQLERRM;
  END;
  RESET ROLE;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'F5 T06 falhou: anon nao recebeu 42501';
  END IF;
  RAISE NOTICE 'F5 T06 ok: authenticated/anon sem EXECUTE (42501)';
END $$;

-- ============ T40 — 0065/0066 idempotentes 2× ============
BEGIN;
\ir ../migrations/0065_psp_event_order_retention.sql
\ir ../migrations/0065_psp_event_order_retention.sql
\ir ../migrations/0066_psp_ingest.sql
\ir ../migrations/0066_psp_ingest.sql

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'psp_events'
    AND column_name IN ('psp_event_at', 'process_reason', 'payload_scrubbed_at');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'F5 T40 falhou: %/3 colunas novas apos 2a passada', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.psp_events'::regclass
    AND conname = 'psp_events_process_reason_check';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F5 T40 falhou: CHECK de process_reason duplicado/ausente (%)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'idx_psp_events_pending';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F5 T40 falhou: idx_psp_events_pending duplicado/ausente (%)', v_count;
  END IF;

  IF to_regprocedure('public.ingest_psp_event(jsonb,text,text,timestamp with time zone,text)') IS NULL THEN
    RAISE EXCEPTION 'F5 T40 falhou: ingest_psp_event ausente apos re-run';
  END IF;

  IF has_table_privilege('service_role', 'public.psp_events', 'INSERT') THEN
    RAISE EXCEPTION 'F5 T40 falhou: re-run devolveu INSERT a service_role';
  END IF;
  RAISE NOTICE 'F5 T40 ok: 0065/0066 idempotentes 2x';
END $$;
ROLLBACK;

-- ============ Fixtures c67 — assinatura + evento do inbox ============
-- `pg_temp.c67_seed` cria tenant (dono fixo `c67...a1`) + assinatura, com a
-- marca d'agua opcional. `pg_temp.c67_event` grava o evento direto na tabela
-- (owner; o caminho do Worker e `ingest_psp_event`, provado em T01–T06).
CREATE OR REPLACE FUNCTION pg_temp.c67_seed(
  p_tenant uuid,
  p_plan text,
  p_status text,
  p_trial_ends timestamptz,
  p_billing_day smallint,
  p_period_start date,
  p_period_end date,
  p_psp_sub text,
  p_last_at timestamptz DEFAULT NULL,
  p_last_id text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_sub uuid;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES ('c6700000-0000-4000-8000-0000000000a1', 'c67-billing@c67.test')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants (
    id, kind, owner_user_id, cpf, razao_social, plan_id, subscription_status
  ) VALUES (
    p_tenant, 'pf', 'c6700000-0000-4000-8000-0000000000a1',
    right(replace(p_tenant::text, '-', ''), 11),
    'C67 Billing', p_plan, p_status
  );
  INSERT INTO public.tenant_subscriptions (
    tenant_id, plan_slug, status, trial_ends_at, billing_day,
    period_start, period_end, psp_subscription_id,
    last_event_at, last_event_id
  ) VALUES (
    p_tenant, p_plan, p_status, p_trial_ends, p_billing_day,
    p_period_start, p_period_end, p_psp_sub,
    p_last_at, p_last_id
  ) RETURNING id INTO v_sub;
  RETURN v_sub;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.c67_event(
  p_event_id text,
  p_event_type text,
  p_psp_sub text DEFAULT NULL,
  p_psp_payment text DEFAULT NULL,
  p_event_at timestamptz DEFAULT NULL,
  p_attempts int DEFAULT 0,
  p_received_at timestamptz DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.psp_events (
    provider, event_id, event_type, psp_subscription_id, psp_payment_id,
    psp_invoice_id, payload, received_at, psp_event_at, attempts
  ) VALUES (
    'asaas', p_event_id, p_event_type, p_psp_sub, p_psp_payment,
    p_psp_payment, p_payload,
    COALESCE(p_received_at, pg_catalog.now()), p_event_at, p_attempts
  );
END $$;

-- ============ T19 — evento novo aplica e avanca a marca d'agua ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010019';
  v_sub uuid;
  v_res jsonb;
  v_row public.psp_events%ROWTYPE;
  v_status text;
  v_last_at timestamptz;
  v_last_id text;
  v_ev_at timestamptz := pg_catalog.now() - interval '5 minutes';
BEGIN
  v_sub := pg_temp.c67_seed(
    v_tenant, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t19-sub'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t19', 'PAYMENT_CONFIRMED', 'c67-t19-sub', 'c67-t19-pay', v_ev_at
  );

  v_res := public.apply_psp_event('c67-evt-t19');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION 'F5 T19 falhou: outcome % (esperado applied)', v_res;
  END IF;
  IF v_res->>'transition' IS DISTINCT FROM 'trial->active' THEN
    RAISE EXCEPTION 'F5 T19 falhou: transition % (esperado trial->active)', v_res;
  END IF;

  SELECT status, last_event_at, last_event_id
    INTO v_status, v_last_at, v_last_id
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'F5 T19 falhou: status % (esperado active)', v_status;
  END IF;
  IF v_last_at IS DISTINCT FROM v_ev_at OR v_last_id IS DISTINCT FROM 'c67-evt-t19' THEN
    RAISE EXCEPTION 'F5 T19 falhou: marca d''agua %/% (esperado %/c67-evt-t19)',
      v_last_at, v_last_id, v_ev_at;
  END IF;

  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c67-evt-t19';
  IF v_row.process_outcome IS DISTINCT FROM 'applied'
     OR v_row.process_reason IS NOT NULL
     OR v_row.processed_at IS NULL THEN
    RAISE EXCEPTION 'F5 T19 falhou: terminal outcome=% reason=% processed=%',
      v_row.process_outcome, v_row.process_reason, v_row.processed_at;
  END IF;

  RAISE NOTICE 'F5 T19 ok: evento novo aplica e avanca a marca d''agua';
END $$;
ROLLBACK;

-- ============ T20 — evento velho => noop/stale-event, zero transicao ============
-- O caso que motivou a regra: `PAYMENT_OVERDUE` (mais velho) nao pode rebaixar
-- `active` para `past_due` depois de um `PAYMENT_CONFIRMED` ja aplicado.
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010020';
  v_sub uuid;
  v_res jsonb;
  v_row public.psp_events%ROWTYPE;
  v_status text;
  v_past timestamptz;
  v_last_at timestamptz;
  v_last_id text;
  v_n int;
  v_wm timestamptz := pg_catalog.now() - interval '1 hour';
  v_hoje date := (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  v_sub := pg_temp.c67_seed(
    v_tenant, 'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c67-t20-sub', v_wm, 'c67-evt-t20-a'
  );
  -- Linha do evento apontado pela marca (fonte do rank do ultimo aplicado).
  PERFORM pg_temp.c67_event(
    'c67-evt-t20-a', 'PAYMENT_CONFIRMED', 'c67-t20-sub', 'c67-t20-pay-a', v_wm
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t20-old', 'PAYMENT_OVERDUE', 'c67-t20-sub', NULL,
    pg_catalog.now() - interval '2 hours'
  );

  v_res := public.apply_psp_event('c67-evt-t20-old');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop'
     OR v_res->>'reason' IS DISTINCT FROM 'stale-event' THEN
    RAISE EXCEPTION 'F5 T20 falhou: evento velho => % (esperado noop/stale-event)', v_res;
  END IF;

  SELECT status, past_due_since, last_event_at, last_event_id
    INTO v_status, v_past, v_last_at, v_last_id
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' OR v_past IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T20 falhou: stale transicionou (status=% past_due_since=%)',
      v_status, v_past;
  END IF;
  IF v_last_at IS DISTINCT FROM v_wm OR v_last_id IS DISTINCT FROM 'c67-evt-t20-a' THEN
    RAISE EXCEPTION 'F5 T20 falhou: stale mexeu na marca (%/%)', v_last_at, v_last_id;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'F5 T20 falhou: stale escreveu % fatura(s)', v_n;
  END IF;

  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c67-evt-t20-old';
  IF v_row.process_outcome IS DISTINCT FROM 'noop'
     OR v_row.process_reason IS DISTINCT FROM 'stale-event'
     OR v_row.processed_at IS NULL
     OR v_row.event_kind IS DISTINCT FROM 'payment_overdue' THEN
    RAISE EXCEPTION 'F5 T20 falhou: terminal stale outcome=% reason=% kind=%',
      v_row.process_outcome, v_row.process_reason, v_row.event_kind;
  END IF;

  RAISE NOTICE 'F5 T20 ok: evento velho => noop/stale-event, zero transicao e zero fatura';
END $$;
ROLLBACK;

-- ============ T21 — desempate por rank no mesmo instante ============
BEGIN;
DO $$
DECLARE
  v_tenant_a uuid := 'c6700000-0000-4000-8000-000000010021';
  v_tenant_b uuid := 'c6700000-0000-4000-8000-000000010022';
  v_res jsonb;
  v_status text;
  v_last_id text;
  v_ts timestamptz := pg_catalog.now() - interval '1 hour';
  v_hoje date := (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  -- (a) confirmed (rank 40) ja aplicado; overdue (rank 20) no MESMO instante
  -- e mais novo por event_id, mas o rank o torna velho => stale.
  PERFORM pg_temp.c67_seed(
    v_tenant_a, 'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c67-t21a-sub', v_ts, 'c67-evt-t21-a'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t21-a', 'PAYMENT_CONFIRMED', 'c67-t21a-sub', 'c67-t21a-pay', v_ts
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t21-b', 'PAYMENT_OVERDUE', 'c67-t21a-sub', NULL, v_ts
  );

  v_res := public.apply_psp_event('c67-evt-t21-b');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop'
     OR v_res->>'reason' IS DISTINCT FROM 'stale-event' THEN
    RAISE EXCEPTION 'F5 T21 falhou: overdue no mesmo instante => %', v_res;
  END IF;
  SELECT status, last_event_id INTO v_status, v_last_id
  FROM public.tenant_subscriptions
  WHERE tenant_id = v_tenant_a;
  IF v_status IS DISTINCT FROM 'active' OR v_last_id IS DISTINCT FROM 'c67-evt-t21-a' THEN
    RAISE EXCEPTION 'F5 T21 falhou: stale por rank transicionou (%, %)', v_status, v_last_id;
  END IF;

  -- (b) inverso: overdue aplicado e confirmed no mesmo instante (rank maior)
  -- => aplica. Rank e o desempate, nao o event_id.
  PERFORM pg_temp.c67_seed(
    v_tenant_b, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t21b-sub', v_ts, 'c67-evt-t21-c'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t21-c', 'PAYMENT_OVERDUE', 'c67-t21b-sub', NULL, v_ts
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t21-d', 'PAYMENT_CONFIRMED', 'c67-t21b-sub', 'c67-t21b-pay', v_ts
  );

  v_res := public.apply_psp_event('c67-evt-t21-d');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION 'F5 T21 falhou: confirmed sobre overdue no mesmo instante => %', v_res;
  END IF;

  RAISE NOTICE 'F5 T21 ok: rank decide no mesmo instante (40 vence 20, 20 perde de 40)';
END $$;
ROLLBACK;

-- ============ T22 — desempate por event_id (ordem total) ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010023';
  v_res jsonb;
  v_last_id text;
  v_ts timestamptz := pg_catalog.now() - interval '1 hour';
BEGIN
  PERFORM pg_temp.c67_seed(
    v_tenant, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t22-sub', v_ts, 'c67-evt-t22-a'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t22-a', 'PAYMENT_CONFIRMED', 'c67-t22-sub', 'c67-t22-pay-a', v_ts
  );

  -- Mesmo instante e mesmo rank: `event_id` maior aplica (totality).
  PERFORM pg_temp.c67_event(
    'c67-evt-t22-b', 'PAYMENT_CONFIRMED', 'c67-t22-sub', 'c67-t22-pay-b', v_ts
  );
  v_res := public.apply_psp_event('c67-evt-t22-b');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied'
     AND v_res->>'outcome' IS DISTINCT FROM 'duplicate'
     AND v_res->>'outcome' IS DISTINCT FROM 'noop' THEN
    RAISE EXCEPTION 'F5 T22 falhou: event_id maior => %', v_res;
  END IF;
  IF v_res->>'reason' IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'F5 T22 falhou: event_id maior virou stale (%)', v_res;
  END IF;
  SELECT last_event_id INTO v_last_id
  FROM public.tenant_subscriptions WHERE tenant_id = v_tenant;
  IF v_last_id IS DISTINCT FROM 'c67-evt-t22-b' THEN
    RAISE EXCEPTION 'F5 T22 falhou: marca nao avancou para o event_id maior (%)', v_last_id;
  END IF;

  -- Mesmo instante e mesmo rank: `event_id` menor e stale.
  PERFORM pg_temp.c67_event(
    'c67-evt-t22-0', 'PAYMENT_CONFIRMED', 'c67-t22-sub', 'c67-t22-pay-0', v_ts
  );
  v_res := public.apply_psp_event('c67-evt-t22-0');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop'
     OR v_res->>'reason' IS DISTINCT FROM 'stale-event' THEN
    RAISE EXCEPTION 'F5 T22 falhou: event_id menor => % (esperado stale)', v_res;
  END IF;

  RAISE NOTICE 'F5 T22 ok: event_id fecha a ordem total (maior aplica, menor e stale)';
END $$;
ROLLBACK;

-- ============ T23 — Adendo A1: event_type de rank 0 ============
-- `private.psp_kind_rank` e STRICT e devolve 0 para tipo desconhecido. Sem
-- `COALESCE(...,0)` a comparacao de linha vira NULL e o evento vira
-- `stale-event` em silencio (`IS NOT TRUE`). Duas provas:
--   (a) tipo de rank 0 (unmapped) e terminal `unmapped-event-type`, nunca stale;
--   (b) marca cujo ultimo evento tem rank 0 nao envenena a comparacao — o
--       proximo evento real aplica (sem COALESCE a linha seria NULL => stale).
BEGIN;
DO $$
DECLARE
  v_tenant_a uuid := 'c6700000-0000-4000-8000-000000010024';
  v_tenant_b uuid := 'c6700000-0000-4000-8000-000000010025';
  v_res jsonb;
  v_row public.psp_events%ROWTYPE;
  v_last_id text;
  v_ts timestamptz := pg_catalog.now() - interval '1 hour';
BEGIN
  -- (a) rank 0 no PROPRIO evento.
  PERFORM pg_temp.c67_seed(
    v_tenant_a, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t23a-sub', v_ts, 'c67-evt-t23-a'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t23-a', 'PAYMENT_CONFIRMED', 'c67-t23a-sub', 'c67-t23a-pay', v_ts
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t23-zero', 'PAYMENT_CREATED', 'c67-t23a-sub', NULL,
    pg_catalog.now() - interval '2 days'
  );

  v_res := public.apply_psp_event('c67-evt-t23-zero');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop'
     OR v_res->>'reason' IS DISTINCT FROM 'unmapped-event-type' THEN
    RAISE EXCEPTION 'F5 T23 falhou: tipo de rank 0 => % (esperado noop/unmapped-event-type)', v_res;
  END IF;
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c67-evt-t23-zero';
  IF v_row.process_reason IS DISTINCT FROM 'unmapped-event-type' THEN
    RAISE EXCEPTION 'F5 T23 falhou: tipo de rank 0 marcado como %', v_row.process_reason;
  END IF;

  -- (b) rank 0 na marca d'agua (ultimo event_id aponta para tipo desconhecido).
  PERFORM pg_temp.c67_seed(
    v_tenant_b, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t23b-sub', v_ts, 'c67-evt-t23-rank0'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t23-rank0', 'PAYMENT_CREATED', 'c67-t23b-sub', NULL, v_ts
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t23-next', 'PAYMENT_CONFIRMED', 'c67-t23b-sub', 'c67-t23b-pay', v_ts
  );

  v_res := public.apply_psp_event('c67-evt-t23-next');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied'
     OR v_res->>'transition' IS DISTINCT FROM 'trial->active' THEN
    RAISE EXCEPTION 'F5 T23 falhou: marca com rank 0 bloqueou o evento seguinte (%)', v_res;
  END IF;
  SELECT last_event_id INTO v_last_id
  FROM public.tenant_subscriptions WHERE tenant_id = v_tenant_b;
  IF v_last_id IS DISTINCT FROM 'c67-evt-t23-next' THEN
    RAISE EXCEPTION 'F5 T23 falhou: marca nao avancou (%)', v_last_id;
  END IF;

  RAISE NOTICE 'F5 T23 ok: rank 0 nao envenena a comparacao (A1/COALESCE)';
END $$;
ROLLBACK;

-- ============ T24 — Adendo A2: ACL do apply e do dreno ============
BEGIN;
DO $$
DECLARE
  v_role text;
  v_msg text;
  v_res jsonb;
BEGIN
  IF pg_catalog.has_function_privilege(
       'service_role', 'public.apply_psp_event(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F5 T24 falhou: service_role com EXECUTE em apply_psp_event';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.drain_psp_events(integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F5 T24 falhou: service_role sem EXECUTE em drain_psp_events';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon']
  LOOP
    IF pg_catalog.has_function_privilege(
         v_role, 'public.apply_psp_event(text)', 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         v_role, 'public.drain_psp_events(integer,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'F5 T24 falhou: % com EXECUTE em apply/drain', v_role;
    END IF;
  END LOOP;

  -- Chamada direta do Worker => 42501 (a porta unica e o dreno).
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM public.apply_psp_event('c67-evt-t24');
    RAISE EXCEPTION 'F5 T24 falhou: service_role executou apply_psp_event';
  EXCEPTION WHEN insufficient_privilege THEN
    v_msg := SQLERRM;
  END;
  RESET ROLE;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'F5 T24 falhou: chamada direta nao levantou 42501';
  END IF;

  -- O dreno continua alcancavel pelo service_role (e roda como owner).
  BEGIN
    SET LOCAL ROLE service_role;
    v_res := public.drain_psp_events(1);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION 'F5 T24 falhou: service_role nao executou drain_psp_events (%)', SQLERRM;
  END;
  RESET ROLE;
  IF v_res IS NULL OR v_res->>'pending' IS NULL THEN
    RAISE EXCEPTION 'F5 T24 falhou: retorno do dreno inesperado (%)', v_res;
  END IF;

  RAISE NOTICE 'F5 T24 ok: service_role sem apply direto (42501) e com drain';
END $$;
ROLLBACK;

-- ============ T25 — Adendo A3: psp_event_at no futuro nao trava a marca ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010026';
  v_sub uuid;
  v_res jsonb;
  v_last_at timestamptz;
  v_last_id text;
  v_orig timestamptz;
  v_future timestamptz := pg_catalog.now() + interval '10 days';
BEGIN
  v_sub := pg_temp.c67_seed(
    v_tenant, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t25-sub'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t25-a', 'PAYMENT_CONFIRMED', 'c67-t25-sub', 'c67-t25-pay-a', v_future
  );

  v_res := public.apply_psp_event('c67-evt-t25-a');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION 'F5 T25 falhou: evento futuro outcome %', v_res;
  END IF;

  SELECT last_event_at, last_event_id INTO v_last_at, v_last_id
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_last_at > pg_catalog.now() THEN
    RAISE EXCEPTION 'F5 T25 falhou: marca gravou o futuro (%)', v_last_at;
  END IF;
  IF v_last_id IS DISTINCT FROM 'c67-evt-t25-a' THEN
    RAISE EXCEPTION 'F5 T25 falhou: marca sem event_id (%)', v_last_id;
  END IF;

  -- Auditoria: a coluna preserva o valor ORIGINAL do PSP.
  SELECT psp_event_at INTO v_orig
  FROM public.psp_events WHERE event_id = 'c67-evt-t25-a';
  IF v_orig IS DISTINCT FROM v_future THEN
    RAISE EXCEPTION 'F5 T25 falhou: psp_event_at original perdido (% <> %)',
      v_orig, v_future;
  END IF;

  -- Evento real seguinte (mesmo instante do teto) NAO e bloqueado.
  PERFORM pg_temp.c67_event(
    'c67-evt-t25-b', 'PAYMENT_CONFIRMED', 'c67-t25-sub', 'c67-t25-pay-b',
    pg_catalog.now()
  );
  v_res := public.apply_psp_event('c67-evt-t25-b');
  IF v_res->>'reason' IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'F5 T25 falhou: evento real seguinte virou stale (%)', v_res;
  END IF;
  SELECT last_event_id INTO v_last_id
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_last_id IS DISTINCT FROM 'c67-evt-t25-b' THEN
    RAISE EXCEPTION 'F5 T25 falhou: marca nao avancou no evento real (%)', v_last_id;
  END IF;

  -- E um evento realmente velho continua stale.
  PERFORM pg_temp.c67_event(
    'c67-evt-t25-c', 'PAYMENT_OVERDUE', 'c67-t25-sub', NULL,
    pg_catalog.now() - interval '2 days'
  );
  v_res := public.apply_psp_event('c67-evt-t25-c');
  IF v_res->>'outcome' IS DISTINCT FROM 'noop'
     OR v_res->>'reason' IS DISTINCT FROM 'stale-event' THEN
    RAISE EXCEPTION 'F5 T25 falhou: evento de 2 dias atras => %', v_res;
  END IF;

  RAISE NOTICE 'F5 T25 ok: marca limitada a now(); psp_event_at preservado (A3)';
END $$;
ROLLBACK;

-- ============ T26 — dreno processa pendentes e devolve contagem ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010027';
  v_res jsonb;
  v_pending int;
BEGIN
  -- Sonda: zera a fila (qualquer residuo de execucao anterior e desfeito no
  -- ROLLBACK deste bloco) para as contagens serem deterministas.
  PERFORM public.drain_psp_events(500);
  SELECT count(*) INTO v_pending FROM public.psp_events WHERE processed_at IS NULL;
  IF v_pending <> 0 THEN
    RAISE EXCEPTION 'F5 T26 falhou: fila nao zerou (% pendentes)', v_pending;
  END IF;

  PERFORM pg_temp.c67_seed(
    v_tenant, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t26-sub'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t26-a', 'PAYMENT_CONFIRMED', 'c67-t26-sub', 'c67-t26-pay-a',
    pg_catalog.now() - interval '1 minute'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t26-b', 'PAYMENT_OVERDUE', 'c67-t26-sub', NULL,
    pg_catalog.now() - interval '2 minutes'
  );

  v_res := public.drain_psp_events(50);
  IF (v_res->>'applied')::int <> 1
     OR (v_res->>'noop')::int <> 1
     OR (v_res->>'rejected')::int <> 0
     OR (v_res->>'failed')::int <> 0
     OR (v_res->>'pending')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T26 falhou: 1o dreno % (esperado applied=1 noop=1 pending=0)', v_res;
  END IF;
  IF (v_res - ARRAY['applied','noop','rejected','failed','pending'])::text <> '{}' THEN
    RAISE EXCEPTION 'F5 T26 falhou: retorno com chave extra (%)', v_res;
  END IF;

  -- 2a chamada imediata: nada pendente.
  v_res := public.drain_psp_events(50);
  IF (v_res->>'applied')::int <> 0
     OR (v_res->>'noop')::int <> 0
     OR (v_res->>'rejected')::int <> 0
     OR (v_res->>'failed')::int <> 0
     OR (v_res->>'pending')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T26 falhou: 2o dreno % (esperado tudo 0)', v_res;
  END IF;

  RAISE NOTICE 'F5 T26 ok: dreno conta applied/noop e a 2a chamada imediata e 0';
END $$;
ROLLBACK;

-- ============ T27 — dreno nao reprocessa evento ja processado ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010028';
  v_sub uuid;
  v_res jsonb;
  v_status text;
  v_n int;
BEGIN
  PERFORM public.drain_psp_events(500);

  v_sub := pg_temp.c67_seed(
    v_tenant, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t27-sub'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t27', 'PAYMENT_CONFIRMED', 'c67-t27-sub', 'c67-t27-pay',
    pg_catalog.now() - interval '1 minute'
  );
  v_res := public.apply_psp_event('c67-evt-t27');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION 'F5 T27 falhou: apply inicial %', v_res;
  END IF;

  -- Varredura: nao ha pendente, nada roda.
  v_res := public.drain_psp_events(50);
  IF (v_res->>'applied')::int <> 0 OR (v_res->>'noop')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T27 falhou: varredura reprocessou (%)', v_res;
  END IF;

  -- Caminho da fila: ja processado => duplicate mapeado para noop, sem RAISE.
  v_res := public.drain_psp_events(50, 'c67-evt-t27');
  IF (v_res->>'noop')::int <> 1 OR (v_res->>'applied')::int <> 0
     OR (v_res->>'failed')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T27 falhou: dreno explicito de processado => %', v_res;
  END IF;

  SELECT status INTO v_status FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'F5 T27 falhou: status % (esperado active)', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM public.tenant_invoices WHERE subscription_id = v_sub;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'F5 T27 falhou: faturas = % (esperado 1; sem 2a aplicacao)', v_n;
  END IF;

  RAISE NOTICE 'F5 T27 ok: evento processado nao e reaplicado (duplicate => noop)';
END $$;
ROLLBACK;

-- ============ T28 — erro de apply nao derruba os demais do lote ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010029';
  v_res jsonb;
  v_row public.psp_events%ROWTYPE;
BEGIN
  PERFORM public.drain_psp_events(500);

  PERFORM pg_temp.c67_seed(
    v_tenant, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t28-sub'
  );
  -- O dreno ordena por `received_at` SEM desempate (0067). Os dois eventos
  -- gravados na mesma transacao receberiam o mesmo `now()` e a ordem seria a
  -- fisica — nao garantida. `p_received_at` distintos fixam o ruim ANTES do
  -- bom: sem isso, se o bom fosse processado primeiro, o ruim (mais velho)
  -- viraria `stale-event` e `failed` ficaria 0, derrubando o assert.
  -- Ruim: `payment_confirmed` sem `psp_payment_id` => psp-event-invalid (RAISE).
  PERFORM pg_temp.c67_event(
    'c67-evt-t28-bad', 'PAYMENT_CONFIRMED', 'c67-t28-sub', NULL,
    pg_catalog.now() - interval '2 minutes',
    0, pg_catalog.now() - interval '2 minutes'
  );
  -- Bom: mesmo lote, depois do ruim.
  PERFORM pg_temp.c67_event(
    'c67-evt-t28-ok', 'PAYMENT_CONFIRMED', 'c67-t28-sub', 'c67-t28-pay',
    pg_catalog.now() - interval '1 minute',
    0, pg_catalog.now() - interval '1 minute'
  );

  v_res := public.drain_psp_events(50);
  IF (v_res->>'applied')::int <> 1 OR (v_res->>'failed')::int <> 1 THEN
    RAISE EXCEPTION 'F5 T28 falhou: lote % (esperado applied=1 failed=1)', v_res;
  END IF;

  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c67-evt-t28-bad';
  IF v_row.attempts <> 1
     OR v_row.process_reason IS DISTINCT FROM 'apply-error'
     OR v_row.processed_at IS NOT NULL
     OR v_row.process_outcome IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T28 falhou: linha com erro attempts=% reason=% processed=% outcome=%',
      v_row.attempts, v_row.process_reason, v_row.processed_at, v_row.process_outcome;
  END IF;

  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c67-evt-t28-ok';
  IF v_row.process_outcome IS DISTINCT FROM 'applied' OR v_row.processed_at IS NULL THEN
    RAISE EXCEPTION 'F5 T28 falhou: evento bom nao aplicou (%, %)',
      v_row.process_outcome, v_row.processed_at;
  END IF;

  RAISE NOTICE 'F5 T28 ok: erro por linha isolado em subtransacao (attempts=1, apply-error)';
END $$;
ROLLBACK;

-- ============ T29 — teto de attempts respeitado ============
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010030';
  v_res jsonb;
  v_row public.psp_events%ROWTYPE;
BEGIN
  PERFORM public.drain_psp_events(500);

  PERFORM pg_temp.c67_seed(
    v_tenant, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t29-sub'
  );
  -- attempts=9 e backoff de 9^2*30s = 40min ja vencido.
  PERFORM pg_temp.c67_event(
    'c67-evt-t29', 'PAYMENT_CONFIRMED', 'c67-t29-sub', NULL,
    pg_catalog.now() - interval '2 days',
    9,
    pg_catalog.now() - interval '1 hour'
  );

  v_res := public.drain_psp_events(50);
  IF (v_res->>'failed')::int <> 1 THEN
    RAISE EXCEPTION 'F5 T29 falhou: 1o dreno % (esperado failed=1)', v_res;
  END IF;

  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c67-evt-t29';
  IF v_row.attempts <> 10
     OR v_row.process_outcome IS DISTINCT FROM 'rejected'
     OR v_row.process_reason IS DISTINCT FROM 'apply-error'
     OR v_row.processed_at IS NULL THEN
    RAISE EXCEPTION 'F5 T29 falhou: teto attempts=% outcome=% reason=% processed=%',
      v_row.attempts, v_row.process_outcome, v_row.process_reason, v_row.processed_at;
  END IF;

  -- Linha preservada e fora da fila: nada mais roda.
  v_res := public.drain_psp_events(50);
  IF (v_res->>'failed')::int <> 0 OR (v_res->>'pending')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T29 falhou: linha no teto voltou a fila (%)', v_res;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.psp_events WHERE event_id = 'c67-evt-t29') THEN
    RAISE EXCEPTION 'F5 T29 falhou: linha do evento apagada no teto';
  END IF;

  RAISE NOTICE 'F5 T29 ok: attempts=10 => rejected/apply-error, linha preservada fora da fila';
END $$;
ROLLBACK;

-- ============ T27b — REQ-25: id inexistente no caminho da fila ============
-- `p_event_id` não nulo aponta para UM evento. Id que não existe não é erro de
-- chamada: conta em `failed` e a função retorna normalmente (sem RAISE). Um
-- RAISE aqui derrubaria o lote do Worker por um id que já saiu da fila.
BEGIN;
DO $$
DECLARE
  v_res jsonb;
  v_pending int;
BEGIN
  PERFORM public.drain_psp_events(500);

  -- Notação nomeada: `p_limit` fica no DEFAULT (200); só o id é passado.
  v_res := public.drain_psp_events(p_event_id => 'c67-evt-t27b-missing');

  IF (v_res->>'failed')::int <> 1 THEN
    RAISE EXCEPTION 'F5 T27b falhou: failed=% (esperado 1)', v_res;
  END IF;
  IF (v_res->>'applied')::int <> 0
     OR (v_res->>'noop')::int <> 0
     OR (v_res->>'rejected')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T27b falhou: id inexistente contou fora de failed (%)', v_res;
  END IF;

  -- `pending` é global (REQ-28): comparar com a contagem real, não com 0.
  SELECT count(*) INTO v_pending FROM public.psp_events WHERE processed_at IS NULL;
  IF (v_res->>'pending')::int <> v_pending THEN
    RAISE EXCEPTION 'F5 T27b falhou: pending=% (count=%)', v_res->>'pending', v_pending;
  END IF;
  IF EXISTS (SELECT 1 FROM public.psp_events WHERE event_id = 'c67-evt-t27b-missing') THEN
    RAISE EXCEPTION 'F5 T27b falhou: caminho da fila criou linha para id inexistente';
  END IF;

  RAISE NOTICE 'F5 T27b ok: id inexistente => failed=1, sem RAISE (REQ-25)';
END $$;
ROLLBACK;

-- ============ T28b — REQ-26: backoff quadrático e clamp de p_limit ============
-- (a) pendente com `attempts > 0` só entra quando
--     `received_at + attempts²×30s <= now()`;
-- (b) `p_limit = 0` ⇒ `LEAST(GREATEST(0,1),500)` = 1;
-- (c) `p_limit = 9999` ⇒ 500.
-- Os eventos de (b)/(c) são `stale` (marca d'água à frente): `noop` barato, sem
-- escrita de assinatura — o limite é o único fator da contagem.
BEGIN;
DO $$
DECLARE
  v_tenant_a uuid := 'c6700000-0000-4000-8000-000000010032';
  v_tenant_b uuid := 'c6700000-0000-4000-8000-000000010033';
  v_tenant_c uuid := 'c6700000-0000-4000-8000-000000010034';
  v_res jsonb;
  v_row public.psp_events%ROWTYPE;
  v_pending int;
  v_hoje date := (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM public.drain_psp_events(500);

  -- (a) attempts=2 => backoff de 2²×30s = 120s. `received_at = now()`.
  PERFORM pg_temp.c67_seed(
    v_tenant_a, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c67-t28b-a-sub'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t28b-a', 'PAYMENT_CONFIRMED', 'c67-t28b-a-sub', 'c67-t28b-a-pay',
    pg_catalog.now() - interval '1 minute',
    2, pg_catalog.now()
  );

  v_res := public.drain_psp_events(50);
  IF (v_res->>'applied')::int <> 0
     OR (v_res->>'noop')::int <> 0
     OR (v_res->>'rejected')::int <> 0
     OR (v_res->>'failed')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T28b falhou: backoff não respeitado (%)', v_res;
  END IF;
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c67-evt-t28b-a';
  IF v_row.attempts <> 2
     OR v_row.processed_at IS NOT NULL
     OR v_row.process_outcome IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T28b falhou: linha tocada antes do backoff (attempts=% processed=% outcome=%)',
      v_row.attempts, v_row.processed_at, v_row.process_outcome;
  END IF;

  -- Vencido o backoff (received_at + 120s <= now()), a mesma linha entra.
  UPDATE public.psp_events
  SET received_at = pg_catalog.now() - interval '121 seconds'
  WHERE event_id = 'c67-evt-t28b-a';
  v_res := public.drain_psp_events(50);
  IF (v_res->>'applied')::int <> 1 THEN
    RAISE EXCEPTION 'F5 T28b falhou: linha não entrou após o backoff (%)', v_res;
  END IF;

  -- (b) clamp inferior: 2 pendentes elegíveis, `p_limit=0` => processa 1.
  PERFORM pg_temp.c67_seed(
    v_tenant_b, 'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c67-t28b-b-sub',
    pg_catalog.now(), 'c67-evt-t28b-b-wm'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t28b-b-wm', 'PAYMENT_CONFIRMED', 'c67-t28b-b-sub', 'c67-t28b-b-wm-pay',
    pg_catalog.now(), 0, pg_catalog.now()
  );
  UPDATE public.psp_events
  SET processed_at = pg_catalog.now(), process_outcome = 'applied'
  WHERE event_id = 'c67-evt-t28b-b-wm';
  PERFORM pg_temp.c67_event(
    'c67-evt-t28b-b1', 'PAYMENT_CONFIRMED', 'c67-t28b-b-sub', NULL,
    pg_catalog.now() - interval '1 hour', 0, pg_catalog.now() - interval '1 hour'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t28b-b2', 'PAYMENT_CONFIRMED', 'c67-t28b-b-sub', NULL,
    pg_catalog.now() - interval '2 hours', 0, pg_catalog.now() - interval '2 hours'
  );

  v_res := public.drain_psp_events(0);
  IF (v_res->>'noop')::int <> 1
     OR (v_res->>'applied')::int <> 0
     OR (v_res->>'failed')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T28b falhou: p_limit=0 não foi tratado como 1 (%)', v_res;
  END IF;
  SELECT count(*) INTO v_pending
  FROM public.psp_events
  WHERE processed_at IS NULL
    AND event_id IN ('c67-evt-t28b-b1', 'c67-evt-t28b-b2');
  IF v_pending <> 1 THEN
    RAISE EXCEPTION 'F5 T28b falhou: p_limit=0 deixou % pendente(s) de 2 (esperado 1)', v_pending;
  END IF;

  v_res := public.drain_psp_events(50);
  IF (v_res->>'noop')::int <> 1 THEN
    RAISE EXCEPTION 'F5 T28b falhou: 2º dreno com p_limit folgado => %', v_res;
  END IF;

  -- (c) clamp superior: 501 elegíveis, `p_limit=9999` => 500 processados.
  PERFORM pg_temp.c67_seed(
    v_tenant_c, 'standard', 'active', NULL, 10::smallint,
    v_hoje, v_hoje + 10, 'c67-t28b-c-sub',
    pg_catalog.now(), 'c67-evt-t28b-c-wm'
  );
  PERFORM pg_temp.c67_event(
    'c67-evt-t28b-c-wm', 'PAYMENT_CONFIRMED', 'c67-t28b-c-sub', 'c67-t28b-c-wm-pay',
    pg_catalog.now(), 0, pg_catalog.now()
  );
  UPDATE public.psp_events
  SET processed_at = pg_catalog.now(), process_outcome = 'applied'
  WHERE event_id = 'c67-evt-t28b-c-wm';
  INSERT INTO public.psp_events (
    provider, event_id, event_type, psp_subscription_id, payload,
    received_at, psp_event_at, attempts
  )
  SELECT 'asaas', 'c67-evt-t28b-c' || pg_catalog.lpad(g::text, 4, '0'),
         'PAYMENT_CONFIRMED', 'c67-t28b-c-sub', '{}'::jsonb,
         pg_catalog.now() - interval '1 hour',
         pg_catalog.now() - interval '1 hour', 0
  FROM pg_catalog.generate_series(1, 501) AS g;

  v_res := public.drain_psp_events(9999);
  IF (v_res->>'noop')::int <> 500
     OR (v_res->>'applied')::int <> 0
     OR (v_res->>'failed')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T28b falhou: p_limit=9999 não foi clampado em 500 (%)', v_res;
  END IF;
  SELECT count(*) INTO v_pending
  FROM public.psp_events
  WHERE processed_at IS NULL AND event_id LIKE 'c67-evt-t28b-c%';
  IF v_pending <> 1 THEN
    RAISE EXCEPTION 'F5 T28b falhou: % linha(s) do lote de 501 ainda na fila (esperado 1)', v_pending;
  END IF;

  -- REQ-28: `pending` do retorno = `count(*) WHERE processed_at IS NULL` no fim.
  SELECT count(*) INTO v_pending FROM public.psp_events WHERE processed_at IS NULL;
  IF (v_res->>'pending')::int <> v_pending THEN
    RAISE EXCEPTION 'F5 T28b falhou: pending=% (count=%)', v_res->>'pending', v_pending;
  END IF;

  RAISE NOTICE 'F5 T28b ok: backoff respeitado; p_limit clampado 0=>1 e 9999=>500 (REQ-26)';
END $$;
ROLLBACK;

-- ============ T30 — 0067 idempotente 2x ============
BEGIN;
\ir ../migrations/0067_psp_apply_drain.sql
\ir ../migrations/0067_psp_apply_drain.sql

DO $$
DECLARE
  v_proc record;
  v_cmt text;
  v_def text;
  v_count int;
BEGIN
  IF to_regprocedure('public.apply_psp_event(text)') IS NULL THEN
    RAISE EXCEPTION 'F5 T30 falhou: apply_psp_event ausente apos 2a passada';
  END IF;
  IF to_regprocedure('public.drain_psp_events(integer,text)') IS NULL THEN
    RAISE EXCEPTION 'F5 T30 falhou: drain_psp_events ausente apos 2a passada';
  END IF;

  IF pg_catalog.pg_get_function_result(
       'public.apply_psp_event(text)'::regprocedure) IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'F5 T30 falhou: apply_psp_event nao retorna jsonb';
  END IF;
  IF pg_catalog.pg_get_function_result(
       'public.drain_psp_events(integer,text)'::regprocedure) IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'F5 T30 falhou: drain_psp_events nao retorna jsonb';
  END IF;

  FOR v_proc IN
    SELECT p.oid, p.prosecdef, p.proconfig
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid IN (
      'public.apply_psp_event(text)'::regprocedure,
      'public.drain_psp_events(integer,text)'::regprocedure
    )
  LOOP
    IF NOT v_proc.prosecdef THEN
      RAISE EXCEPTION 'F5 T30 falhou: RPC sem SECURITY DEFINER';
    END IF;
    IF v_proc.proconfig IS NULL
       OR NOT ('search_path=""' = ANY (v_proc.proconfig)) THEN
      RAISE EXCEPTION 'F5 T30 falhou: RPC sem search_path vazio (%)', v_proc.proconfig;
    END IF;
    v_cmt := pg_catalog.obj_description(v_proc.oid, 'pg_proc');
    IF v_cmt IS NULL OR v_cmt = '' THEN
      RAISE EXCEPTION 'F5 T30 falhou: RPC sem COMMENT';
    END IF;
  END LOOP;

  -- ACL reaplicada pela 2a passada.
  IF pg_catalog.has_function_privilege(
       'service_role', 'public.apply_psp_event(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F5 T30 falhou: re-run devolveu EXECUTE do apply ao service_role';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.drain_psp_events(integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F5 T30 falhou: re-run perdeu EXECUTE do dreno';
  END IF;

  -- A guarda de ordem e o dreno continuam no corpo (grep estrutural).
  SELECT pg_get_functiondef('public.apply_psp_event(text)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%stale-event%'
     OR v_def NOT LIKE '%psp_kind_rank%'
     OR v_def NOT LIKE '%last_event_at%' THEN
    RAISE EXCEPTION 'F5 T30 falhou: apply sem guarda de ordem apos re-run';
  END IF;
  SELECT pg_get_functiondef('public.drain_psp_events(integer,text)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%SKIP LOCKED%'
     OR v_def NOT LIKE '%apply-error%'
     OR v_def NOT LIKE '%pending%' THEN
    RAISE EXCEPTION 'F5 T30 falhou: dreno sem SKIP LOCKED/apply-error/pending apos re-run';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_proc
  WHERE proname IN ('apply_psp_event', 'drain_psp_events')
    AND pronamespace = 'public'::regnamespace;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'F5 T30 falhou: % funcoes apos re-run (esperado 2)', v_count;
  END IF;

  RAISE NOTICE 'F5 T30 ok: 0067 idempotente 2x (funcoes, ACL e COMMENT intactos)';
END $$;
ROLLBACK;

-- ============ Fixtures c68 — retenção A3 (payload com PII) ============
-- `pg_temp.c68_payload` devolve um payload REALISTA do PSP com PII em todos os
-- lugares onde o Asaas a coloca (customer/cpfCnpj/email/cartão/endereço/
-- descrição livre) MAIS uma chave inventada (`extraPii`) que não existe no PSP
-- hoje: é a prova de que a redução é WHITELIST, não blacklist — uma chave nova
-- do PSP não sobrevive por não estar prevista.
CREATE OR REPLACE FUNCTION pg_temp.c68_payload(p_suffix text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', 'c68-pay-' || p_suffix,
    'event', 'PAYMENT_CONFIRMED',
    'dateCreated', '2026-08-01 10:00:00',
    'payment', pg_catalog.jsonb_build_object(
      'id', 'c68-pay-' || p_suffix,
      'status', 'CONFIRMED',
      'value', 199.90,
      'netValue', 191.20,
      'dueDate', '2026-08-10',
      'paymentDate', '2026-08-09',
      'subscription', 'c68-sub-' || p_suffix,
      'description', 'Mensalidade Plano Standard ' || p_suffix,
      'customer', pg_catalog.jsonb_build_object(
        'name', 'Fulana de Tal',
        'cpfCnpj', '12345678909',
        'email', 'fulana.tal@example.com',
        'address', 'Rua Sigilosa 42',
        'addressNumber', '42',
        'postalCode', '01310100'
      ),
      'creditCard', pg_catalog.jsonb_build_object(
        'number', '4111111111111111',
        'cvv', '123',
        'holderName', 'FULANA DE TAL'
      )
    ),
    'subscription', pg_catalog.jsonb_build_object(
      'id', 'c68-sub-' || p_suffix,
      'status', 'ACTIVE',
      'description', 'Assinatura Fulana de Tal',
      'customer', pg_catalog.jsonb_build_object(
        'name', 'Fulana de Tal',
        'cpfCnpj', '12345678909'
      )
    ),
    'extraPii', 'chave-inventada-' || p_suffix
  );
$$;

-- `pg_temp.c68_event` grava a linha do inbox direto na tabela (owner; o caminho
-- do Worker é `ingest_psp_event`, provado em T01–T06). `received_at` e
-- `processed_at` são controlados para a janela de 90 dias.
CREATE OR REPLACE FUNCTION pg_temp.c68_event(
  p_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_received_at timestamptz,
  p_processed_at timestamptz DEFAULT NULL,
  p_event_at timestamptz DEFAULT NULL,
  p_psp_sub text DEFAULT NULL,
  p_psp_payment text DEFAULT NULL,
  p_outcome text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.psp_events (
    provider, event_id, event_type, psp_subscription_id, psp_invoice_id,
    psp_payment_id, payload, received_at, psp_event_at, processed_at,
    process_outcome
  ) VALUES (
    'asaas', p_event_id, p_event_type, p_psp_sub, p_psp_payment,
    p_psp_payment, p_payload, p_received_at, p_event_at, p_processed_at,
    p_outcome
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ============ T31 — REQ-30..REQ-32: scrub por whitelist ============
BEGIN;
DO $$
DECLARE
  v_before public.psp_events%ROWTYPE;
  v_after public.psp_events%ROWTYPE;
  v_proc record;
  v_res jsonb;
  v_role text;
  v_msg text;
  v_count int;
  v_keys text[];
  v_txt text;
BEGIN
  PERFORM pg_temp.c68_event(
    'c68-evt-t31', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t31'),
    pg_catalog.now() - interval '91 days',
    pg_catalog.now() - interval '90 days',
    pg_catalog.now() - interval '91 days',
    'c68-sub-t31', 'c68-pay-t31', 'applied'
  );

  SELECT * INTO v_before FROM public.psp_events WHERE event_id = 'c68-evt-t31';

  -- REQ-30: assinatura exata (1 arg com DEFAULT 500) e retorno jsonb.
  IF to_regprocedure('public.scrub_psp_events(integer)') IS NULL THEN
    RAISE EXCEPTION 'F5 T31 falhou: scrub_psp_events(integer) ausente';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_proc
  WHERE proname = 'scrub_psp_events'
    AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F5 T31 falhou: % sobrecargas de scrub_psp_events (esperado 1)', v_count;
  END IF;

  IF pg_catalog.pg_get_function_result(
       'public.scrub_psp_events(integer)'::regprocedure) IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'F5 T31 falhou: scrub_psp_events nao retorna jsonb';
  END IF;
  IF pg_catalog.pg_get_function_arguments(
       'public.scrub_psp_events(integer)'::regprocedure)
     IS DISTINCT FROM 'p_limit integer DEFAULT 500' THEN
    RAISE EXCEPTION 'F5 T31 falhou: assinatura inesperada (%)',
      pg_catalog.pg_get_function_arguments('public.scrub_psp_events(integer)'::regprocedure);
  END IF;

  SELECT p.prosecdef, p.proconfig,
         pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.proacl
    INTO v_proc
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'public.scrub_psp_events(integer)'::regprocedure;

  IF NOT v_proc.prosecdef THEN
    RAISE EXCEPTION 'F5 T31 falhou: scrub_psp_events sem SECURITY DEFINER';
  END IF;
  IF v_proc.proconfig IS NULL OR NOT ('search_path=""' = ANY (v_proc.proconfig)) THEN
    RAISE EXCEPTION 'F5 T31 falhou: scrub_psp_events sem search_path vazio (%)', v_proc.proconfig;
  END IF;
  IF v_proc.owner IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'F5 T31 falhou: owner % (esperado postgres)', v_proc.owner;
  END IF;

  -- REQ-30: EXECUTE so service_role; PUBLIC/anon/authenticated sem nada.
  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.scrub_psp_events(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F5 T31 falhou: service_role sem EXECUTE em scrub_psp_events';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF pg_catalog.has_function_privilege(
         v_role, 'public.scrub_psp_events(integer)', 'EXECUTE') THEN
      RAISE EXCEPTION 'F5 T31 falhou: % com EXECUTE em scrub_psp_events', v_role;
    END IF;
  END LOOP;
  IF v_proc.proacl IS NULL THEN
    RAISE EXCEPTION 'F5 T31 falhou: proacl nulo (DEFAULT daria EXECUTE a PUBLIC)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(v_proc.proacl) AS a WHERE a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'F5 T31 falhou: PUBLIC com privilegio em scrub_psp_events';
  END IF;

  -- 42501 medido, nao so declarado na ACL.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.scrub_psp_events(1);
    RAISE EXCEPTION 'F5 T31 falhou: authenticated executou scrub_psp_events';
  EXCEPTION WHEN insufficient_privilege THEN
    v_msg := SQLERRM;
  END;
  RESET ROLE;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'F5 T31 falhou: authenticated nao recebeu 42501';
  END IF;

  -- Execucao real pelo service_role (prova o GRANT, nao so a ACL).
  BEGIN
    SET LOCAL ROLE service_role;
    v_res := public.scrub_psp_events(500);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION 'F5 T31 falhou: service_role nao executou scrub (%)', SQLERRM;
  END;
  RESET ROLE;

  -- REQ-33: retorno com exatamente as 2 chaves.
  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM pg_catalog.jsonb_object_keys(v_res) AS k;
  IF v_keys IS DISTINCT FROM ARRAY['remaining_overdue', 'scrubbed'] THEN
    RAISE EXCEPTION 'F5 T31 falhou: chaves do retorno %', v_keys;
  END IF;
  IF (v_res->>'scrubbed')::int < 1 THEN
    RAISE EXCEPTION 'F5 T31 falhou: scrubbed=% (esperado >= 1)', v_res;
  END IF;

  SELECT * INTO v_after FROM public.psp_events WHERE event_id = 'c68-evt-t31';

  IF v_after.payload_scrubbed_at IS NULL THEN
    RAISE EXCEPTION 'F5 T31 falhou: payload_scrubbed_at nulo apos scrub';
  END IF;

  -- REQ-32: linha preservada e colunas de identidade/ordem/terminal intactas.
  SELECT count(*) INTO v_count
  FROM public.psp_events WHERE event_id = 'c68-evt-t31';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F5 T31 falhou: % linha(s) apos scrub (esperado 1)', v_count;
  END IF;

  IF ROW(v_after.event_id, v_after.event_type, v_after.psp_event_at,
         v_after.psp_subscription_id, v_after.psp_invoice_id, v_after.psp_payment_id,
         v_after.received_at, v_after.processed_at, v_after.process_outcome,
         v_after.process_reason, v_after.attempts, v_after.provider,
         v_after.event_kind)
     IS DISTINCT FROM
     ROW(v_before.event_id, v_before.event_type, v_before.psp_event_at,
         v_before.psp_subscription_id, v_before.psp_invoice_id, v_before.psp_payment_id,
         v_before.received_at, v_before.processed_at, v_before.process_outcome,
         v_before.process_reason, v_before.attempts, v_before.provider,
         v_before.event_kind)
  THEN
    RAISE EXCEPTION 'F5 T31 falhou: colunas de identidade/ordem alteradas pelo scrub';
  END IF;

  -- REQ-31: whitelist — PII nao sobrevive em NENHUMA forma, nem a chave nova.
  v_txt := v_after.payload::text;
  IF v_txt LIKE '%cpfCnpj%'
     OR v_txt LIKE '%email%'
     OR v_txt LIKE '%creditCard%'
     OR v_txt LIKE '%12345678909%'
     OR v_txt LIKE '%fulana.tal@example.com%'
     OR v_txt LIKE '%4111111111111111%'
     OR v_txt LIKE '%Rua Sigilosa%'
     OR v_txt LIKE '%Fulana%'
     OR v_txt LIKE '%description%'
     OR v_txt LIKE '%extraPii%'
     OR v_txt LIKE '%chave-inventada%'
  THEN
    RAISE EXCEPTION 'F5 T31 falhou: PII/chave fora da whitelist sobreviveu (%)', v_txt;
  END IF;

  -- E o que a whitelist MANDA manter continua la.
  IF v_after.payload->>'id' IS DISTINCT FROM 'c68-pay-t31'
     OR v_after.payload->>'event' IS DISTINCT FROM 'PAYMENT_CONFIRMED'
     OR v_after.payload->>'dateCreated' IS DISTINCT FROM '2026-08-01 10:00:00'
     OR v_after.payload->'payment'->>'id' IS DISTINCT FROM 'c68-pay-t31'
     OR v_after.payload->'payment'->>'status' IS DISTINCT FROM 'CONFIRMED'
     OR v_after.payload->'payment'->>'value' IS DISTINCT FROM '199.90'
     OR v_after.payload->'payment'->>'netValue' IS DISTINCT FROM '191.20'
     OR v_after.payload->'payment'->>'dueDate' IS DISTINCT FROM '2026-08-10'
     OR v_after.payload->'payment'->>'paymentDate' IS DISTINCT FROM '2026-08-09'
     OR v_after.payload->'payment'->>'subscription' IS DISTINCT FROM 'c68-sub-t31'
     OR v_after.payload->'subscription'->>'id' IS DISTINCT FROM 'c68-sub-t31'
     OR v_after.payload->'subscription'->>'status' IS DISTINCT FROM 'ACTIVE'
  THEN
    RAISE EXCEPTION 'F5 T31 falhou: whitelist perdeu campo previsto (%)', v_after.payload;
  END IF;

  -- Conjunto de chaves exato: nem sobra nem falta.
  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM pg_catalog.jsonb_object_keys(v_after.payload) AS k;
  IF v_keys IS DISTINCT FROM ARRAY['dateCreated', 'event', 'id', 'payment', 'subscription'] THEN
    RAISE EXCEPTION 'F5 T31 falhou: chaves da raiz %', v_keys;
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM pg_catalog.jsonb_object_keys(v_after.payload->'payment') AS k;
  IF v_keys IS DISTINCT FROM ARRAY['dueDate', 'id', 'netValue', 'paymentDate',
                                   'status', 'subscription', 'value'] THEN
    RAISE EXCEPTION 'F5 T31 falhou: chaves de payment %', v_keys;
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM pg_catalog.jsonb_object_keys(v_after.payload->'subscription') AS k;
  IF v_keys IS DISTINCT FROM ARRAY['id', 'status'] THEN
    RAISE EXCEPTION 'F5 T31 falhou: chaves de subscription %', v_keys;
  END IF;

  RAISE NOTICE 'F5 T31 ok: scrub por whitelist remove PII, marca payload_scrubbed_at e preserva a linha';
END $$;
ROLLBACK;

-- ============ T31b — whitelist por TIPO (endurecimento) ============
-- O token do webhook nao prova a integridade do corpo (SPEC §9). Um corpo
-- forjado pode trazer um OBJETO numa chave que a API manda como string
-- (`payment.subscription`). Copiar verbatim deixaria a PII aninhada sobreviver
-- ao scrub; por isso so escalar (`string`/`number`/`boolean`) e copiado —
-- objeto ou array em chave whitelisted e descartado, nunca serializado.
BEGIN;
DO $$
DECLARE
  v_after public.psp_events%ROWTYPE;
  v_res jsonb;
  v_keys text[];
  v_txt text;
BEGIN
  PERFORM pg_temp.c68_event(
    'c68-evt-t31b', 'PAYMENT_CONFIRMED',
    pg_catalog.jsonb_build_object(
      'id', 'c68-pay-t31b',
      'event', 'PAYMENT_CONFIRMED',
      'dateCreated', '2026-08-01 10:00:00',
      'payment', pg_catalog.jsonb_build_object(
        'id', 'c68-pay-t31b',
        'status', 'CONFIRMED',
        'value', 199.90,
        'netValue', 191.20,
        'dueDate', '2026-08-10',
        'paymentDate', '2026-08-09',
        -- FORJADO: o PSP manda string aqui; o corpo traz objeto com PII.
        'subscription', pg_catalog.jsonb_build_object(
          'cpfCnpj', '98765432100',
          'email', 'forjado@example.com'
        )
      ),
      'subscription', pg_catalog.jsonb_build_object(
        'id', 'c68-sub-t31b',
        'status', 'ACTIVE'
      )
    ),
    pg_catalog.now() - interval '91 days',
    pg_catalog.now() - interval '90 days',
    pg_catalog.now() - interval '91 days',
    'c68-sub-t31b', 'c68-pay-t31b', 'applied'
  );

  v_res := public.scrub_psp_events(500);
  IF (v_res->>'scrubbed')::int < 1 THEN
    RAISE EXCEPTION 'F5 T31b falhou: scrub %', v_res;
  END IF;

  SELECT * INTO v_after FROM public.psp_events WHERE event_id = 'c68-evt-t31b';
  IF v_after.payload_scrubbed_at IS NULL THEN
    RAISE EXCEPTION 'F5 T31b falhou: payload_scrubbed_at nulo apos scrub';
  END IF;

  -- A PII aninhada nao sobrevive em NENHUMA forma textual.
  v_txt := v_after.payload::text;
  IF v_txt LIKE '%98765432100%'
     OR v_txt LIKE '%forjado@example.com%'
     OR v_txt LIKE '%cpfCnpj%'
     OR v_txt LIKE '%email%' THEN
    RAISE EXCEPTION 'F5 T31b falhou: PII aninhada em chave whitelisted sobreviveu (%)', v_txt;
  END IF;

  -- `payment.subscription` ausente (jsonb_strip_nulls) ou NULL — nunca objeto.
  IF pg_catalog.jsonb_exists(v_after.payload->'payment', 'subscription') THEN
    RAISE EXCEPTION 'F5 T31b falhou: payment.subscription sobreviveu com tipo % (%)',
      pg_catalog.jsonb_typeof(v_after.payload->'payment'->'subscription'),
      v_after.payload->'payment'->'subscription';
  END IF;

  -- Escalares legitimos das demais chaves continuam intactos.
  IF v_after.payload->'payment'->>'id' IS DISTINCT FROM 'c68-pay-t31b'
     OR v_after.payload->'payment'->>'value' IS DISTINCT FROM '199.90'
     OR v_after.payload->'payment'->>'status' IS DISTINCT FROM 'CONFIRMED'
     OR v_after.payload->'subscription'->>'id' IS DISTINCT FROM 'c68-sub-t31b'
     OR v_after.payload->>'id' IS DISTINCT FROM 'c68-pay-t31b' THEN
    RAISE EXCEPTION 'F5 T31b falhou: escalar legitimo perdido (%)', v_after.payload;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM pg_catalog.jsonb_object_keys(v_after.payload->'payment') AS k;
  IF v_keys IS DISTINCT FROM ARRAY['dueDate', 'id', 'netValue', 'paymentDate',
                                   'status', 'value'] THEN
    RAISE EXCEPTION 'F5 T31b falhou: chaves de payment %', v_keys;
  END IF;

  RAISE NOTICE 'F5 T31b ok: objeto em chave whitelisted e descartado (so escalar sobrevive)';
END $$;
ROLLBACK;

-- ============ T32 — REQ-30/REQ-33: pendente e recente intocados; p_limit ============
-- O scrub so pega evento PROCESSADO e mais velho que 90 dias. Evento pendente
-- precisa do payload para o apply; evento recente ainda esta na janela de
-- payload completo. `remaining_overdue` e o backlog de retencao (limitado pelo
-- `p_limit`), nunca o total da tabela.
BEGIN;
DO $$
DECLARE
  v_res jsonb;
  v_eligible int;
  v_row public.psp_events%ROWTYPE;
  v_count int;
BEGIN
  -- (a) PENDENTE, 120 dias: nunca e scrubado.
  PERFORM pg_temp.c68_event(
    'c68-evt-t32-pend', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t32pend'),
    pg_catalog.now() - interval '120 days', NULL,
    pg_catalog.now() - interval '120 days', 'c68-sub-t32', 'c68-pay-t32pend'
  );

  -- (b) PROCESSADO mas RECENTE (30 dias): dentro da janela de payload completo.
  PERFORM pg_temp.c68_event(
    'c68-evt-t32-recent', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t32recent'),
    pg_catalog.now() - interval '30 days', pg_catalog.now() - interval '29 days',
    pg_catalog.now() - interval '30 days', 'c68-sub-t32', 'c68-pay-t32recent', 'applied'
  );

  -- (c) 3 elegiveis para exercitar o `remaining_overdue` do `p_limit`.
  PERFORM pg_temp.c68_event(
    'c68-evt-t32-old1', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t32old1'),
    pg_catalog.now() - interval '95 days', pg_catalog.now() - interval '94 days',
    pg_catalog.now() - interval '95 days', 'c68-sub-t32', 'c68-pay-t32old1', 'applied'
  );
  PERFORM pg_temp.c68_event(
    'c68-evt-t32-old2', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t32old2'),
    pg_catalog.now() - interval '96 days', pg_catalog.now() - interval '94 days',
    pg_catalog.now() - interval '96 days', 'c68-sub-t32', 'c68-pay-t32old2', 'applied'
  );
  PERFORM pg_temp.c68_event(
    'c68-evt-t32-old3', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t32old3'),
    pg_catalog.now() - interval '97 days', pg_catalog.now() - interval '94 days',
    pg_catalog.now() - interval '97 days', 'c68-sub-t32', 'c68-pay-t32old3', 'applied'
  );

  SELECT count(*) INTO v_eligible
  FROM public.psp_events AS e
  WHERE e.processed_at IS NOT NULL
    AND e.received_at < pg_catalog.now() - interval '90 days'
    AND e.payload_scrubbed_at IS NULL;
  IF v_eligible < 3 THEN
    RAISE EXCEPTION 'F5 T32 falhou: % elegiveis (esperado >= 3)', v_eligible;
  END IF;

  -- p_limit = 1: so 1 sai; o resto fica como backlog de retencao.
  v_res := public.scrub_psp_events(1);
  IF (v_res->>'scrubbed')::int <> 1 THEN
    RAISE EXCEPTION 'F5 T32 falhou: scrubbed=% (esperado 1)', v_res;
  END IF;
  IF (v_res->>'remaining_overdue')::int <> v_eligible - 1 THEN
    RAISE EXCEPTION 'F5 T32 falhou: remaining_overdue=% (esperado %)',
      v_res->>'remaining_overdue', v_eligible - 1;
  END IF;

  -- (a) pendente intocado, payload completo.
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c68-evt-t32-pend';
  IF v_row.payload_scrubbed_at IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T32 falhou: evento PENDENTE foi scrubado';
  END IF;
  IF v_row.payload->'payment'->'customer'->>'cpfCnpj' IS DISTINCT FROM '12345678909'
     OR v_row.payload->>'extraPii' IS NULL THEN
    RAISE EXCEPTION 'F5 T32 falhou: payload do pendente perdeu dado (%)', v_row.payload;
  END IF;

  -- (b) recente intocado.
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c68-evt-t32-recent';
  IF v_row.payload_scrubbed_at IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T32 falhou: evento RECENTE foi scrubado';
  END IF;
  IF v_row.payload->'payment'->'customer'->>'email'
     IS DISTINCT FROM 'fulana.tal@example.com' THEN
    RAISE EXCEPTION 'F5 T32 falhou: payload do recente perdeu dado (%)', v_row.payload;
  END IF;

  -- p_limit = 0 => clamp inferior 1; 9999 => clamp superior 500.
  v_res := public.scrub_psp_events(0);
  IF (v_res->>'scrubbed')::int <> 1 THEN
    RAISE EXCEPTION 'F5 T32 falhou: p_limit=0 scrubou % (esperado 1)', v_res;
  END IF;
  v_res := public.scrub_psp_events(9999);
  IF (v_res->>'scrubbed')::int < 1 THEN
    RAISE EXCEPTION 'F5 T32 falhou: p_limit=9999 scrubou % (esperado >= 1)', v_res;
  END IF;
  IF (v_res->>'remaining_overdue')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T32 falhou: remaining_overdue=% apos drenar o backlog', v_res;
  END IF;

  -- Pendente/recente continuam fora do alvo mesmo apos tres execucoes.
  SELECT count(*) INTO v_count
  FROM public.psp_events
  WHERE event_id IN ('c68-evt-t32-pend', 'c68-evt-t32-recent')
    AND payload_scrubbed_at IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'F5 T32 falhou: % linha(s) fora do alvo scrubadas', v_count;
  END IF;

  RAISE NOTICE 'F5 T32 ok: pendente e recente intocados; p_limit clampa e remaining_overdue respeita o limite';
END $$;
ROLLBACK;

-- ============ T33 — REQ-32..REQ-34: idempotencia e COMMENT A3 ============
BEGIN;
DO $$
DECLARE
  v_res jsonb;
  v_first public.psp_events%ROWTYPE;
  v_second public.psp_events%ROWTYPE;
  v_cmt text;
  v_count int;
BEGIN
  PERFORM pg_temp.c68_event(
    'c68-evt-t33', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t33'),
    pg_catalog.now() - interval '400 days', pg_catalog.now() - interval '399 days',
    pg_catalog.now() - interval '400 days', 'c68-sub-t33', 'c68-pay-t33', 'applied'
  );

  v_res := public.scrub_psp_events(500);
  IF (v_res->>'scrubbed')::int < 1 THEN
    RAISE EXCEPTION 'F5 T33 falhou: 1a passada scrubou %', v_res;
  END IF;

  SELECT * INTO v_first FROM public.psp_events WHERE event_id = 'c68-evt-t33';
  IF v_first.payload_scrubbed_at IS NULL THEN
    RAISE EXCEPTION 'F5 T33 falhou: payload_scrubbed_at nulo na 1a passada';
  END IF;

  -- 2a passada: nada a fazer e nada reescrito.
  v_res := public.scrub_psp_events(500);
  IF (v_res->>'scrubbed')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T33 falhou: 2a passada scrubou % (esperado 0)', v_res;
  END IF;

  SELECT * INTO v_second FROM public.psp_events WHERE event_id = 'c68-evt-t33';
  IF v_second.payload IS DISTINCT FROM v_first.payload THEN
    RAISE EXCEPTION 'F5 T33 falhou: 2a passada reescreveu o payload';
  END IF;
  IF v_second.payload_scrubbed_at IS DISTINCT FROM v_first.payload_scrubbed_at THEN
    RAISE EXCEPTION 'F5 T33 falhou: 2a passada reescreveu payload_scrubbed_at';
  END IF;
  IF v_second.event_id IS DISTINCT FROM 'c68-evt-t33'
     OR v_second.processed_at IS DISTINCT FROM v_first.processed_at
     OR v_second.psp_event_at IS DISTINCT FROM v_first.psp_event_at THEN
    RAISE EXCEPTION 'F5 T33 falhou: metadados mudaram na 2a passada';
  END IF;

  SELECT count(*) INTO v_count FROM public.psp_events WHERE event_id = 'c68-evt-t33';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F5 T33 falhou: linha apagada (% linhas)', v_count;
  END IF;

  -- REQ-34: COMMENT da tabela declara a politica A3 completa.
  v_cmt := pg_catalog.obj_description('public.psp_events'::regclass, 'pg_class');
  IF v_cmt IS NULL OR v_cmt = '' THEN
    RAISE EXCEPTION 'F5 T33 falhou: psp_events sem COMMENT';
  END IF;
  IF v_cmt NOT LIKE '%90%' OR v_cmt NOT LIKE '%24%' OR v_cmt NOT LIKE '%5 anos%' THEN
    RAISE EXCEPTION 'F5 T33 falhou: COMMENT sem a politica A3 (90/24/5 anos): %', v_cmt;
  END IF;
  IF v_cmt NOT LIKE '%tenant_invoices%' OR v_cmt NOT LIKE '%scrub_psp_events%' THEN
    RAISE EXCEPTION 'F5 T33 falhou: COMMENT nao cita tenant_invoices/scrub_psp_events: %', v_cmt;
  END IF;
  -- Adendo A5: 24 meses e PISO de disponibilidade, nao teto. Retencao efetiva
  -- indefinida e purge fora da v1 — o COMMENT nao pode prometer minimizacao
  -- que o mecanismo nao faz.
  IF pg_catalog.lower(v_cmt) NOT LIKE '%indeterminad%' THEN
    RAISE EXCEPTION 'F5 T33 falhou: COMMENT nao declara retencao indeterminada (piso de 24 meses): %',
      v_cmt;
  END IF;
  IF pg_catalog.lower(v_cmt) NOT LIKE '%piso%' THEN
    RAISE EXCEPTION 'F5 T33 falhou: COMMENT nao declara 24 meses como piso: %', v_cmt;
  END IF;

  RAISE NOTICE 'F5 T33 ok: scrub idempotente, linha preservada e COMMENT A3 com 90/24/5 anos';
END $$;
ROLLBACK;

-- ============ T33b — 0068 idempotente 2x ============
BEGIN;
\ir ../migrations/0068_psp_retention.sql
\ir ../migrations/0068_psp_retention.sql

DO $$
DECLARE
  v_count int;
  v_cmt text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_proc
  WHERE proname = 'scrub_psp_events'
    AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F5 T33b falhou: % funcoes scrub apos re-run (esperado 1)', v_count;
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.scrub_psp_events(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F5 T33b falhou: re-run perdeu EXECUTE do service_role';
  END IF;
  IF pg_catalog.has_function_privilege(
       'authenticated', 'public.scrub_psp_events(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F5 T33b falhou: re-run devolveu EXECUTE a authenticated';
  END IF;
  v_cmt := pg_catalog.obj_description('public.psp_events'::regclass, 'pg_class');
  IF v_cmt IS NULL OR v_cmt NOT LIKE '%5 anos%' THEN
    RAISE EXCEPTION 'F5 T33b falhou: re-run perdeu o COMMENT A3';
  END IF;
  RAISE NOTICE 'F5 T33b ok: 0068 idempotente 2x (funcao, ACL e COMMENT intactos)';
END $$;
ROLLBACK;

-- ============ T34 — REQ-35: idempotencia e ordem sobrevivem ao scrub ============
-- (Existe outro `T34` em `0055-0060-subscription-billing.spec.sql` para
-- `expire_subscriptions`; este é o `T34` de F5 — os NOTICEs levam o prefixo.)
BEGIN;
DO $$
DECLARE
  v_tenant uuid := 'c6700000-0000-4000-8000-000000010068';
  v_sub uuid;
  v_res jsonb;
  v_row public.psp_events%ROWTYPE;
  v_msg text;
  v_last_id text;
  v_count int;
BEGIN
  -- Assinatura cuja marca d'agua aponta para o evento que sera scrubado: e a
  -- prova de que a comparacao de §6.1 le COLUNA, nao payload.
  v_sub := pg_temp.c67_seed(
    v_tenant, 'standard', 'trial', pg_catalog.now() + interval '10 days',
    10::smallint, NULL, NULL, 'c68-sub-t34',
    pg_catalog.now() - interval '95 days', 'c68-evt-t34'
  );

  PERFORM pg_temp.c68_event(
    'c68-evt-t34', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t34'),
    pg_catalog.now() - interval '95 days', pg_catalog.now() - interval '94 days',
    pg_catalog.now() - interval '95 days', 'c68-sub-t34', 'c68-pay-t34', 'applied'
  );

  v_res := public.scrub_psp_events(500);
  IF (v_res->>'scrubbed')::int < 1 THEN
    RAISE EXCEPTION 'F5 T34 falhou: scrub inicial %', v_res;
  END IF;
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c68-evt-t34';
  IF v_row.payload_scrubbed_at IS NULL THEN
    RAISE EXCEPTION 'F5 T34 falhou: evento nao foi scrubado';
  END IF;

  -- (a) reentrega do PSP pos-scrub: duplicate, sem 2a linha e sem devolver PII.
  v_res := public.ingest_psp_event(
    pg_temp.c68_payload('t34'), 'c68-evt-t34', 'PAYMENT_CONFIRMED'
  );
  IF v_res->>'outcome' IS DISTINCT FROM 'duplicate' OR (v_res->>'stored')::boolean THEN
    RAISE EXCEPTION 'F5 T34 falhou: reenvio pos-scrub % (esperado duplicate)', v_res;
  END IF;

  SELECT count(*) INTO v_count FROM public.psp_events WHERE event_id = 'c68-evt-t34';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F5 T34 falhou: reenvio criou linha extra (% linhas)', v_count;
  END IF;

  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c68-evt-t34';
  IF v_row.payload::text LIKE '%cpfCnpj%'
     OR v_row.payload::text LIKE '%extraPii%'
     OR v_row.payload->'payment'->'customer' IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T34 falhou: reenvio restaurou o payload cru (%)', v_row.payload;
  END IF;

  -- (b) dreno: ja processado => noop, nunca applied.
  v_res := public.drain_psp_events(p_event_id => 'c68-evt-t34');
  IF (v_res->>'applied')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T34 falhou: dreno aplicou evento scrubado (%)', v_res;
  END IF;
  IF (v_res->>'noop')::int <> 1 OR (v_res->>'failed')::int <> 0 THEN
    RAISE EXCEPTION 'F5 T34 falhou: dreno de evento ja processado % (esperado noop=1)', v_res;
  END IF;

  -- (c) apply direto continua com o erro congelado.
  v_msg := NULL;
  BEGIN
    PERFORM public.apply_psp_event('c68-evt-t34');
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS DISTINCT FROM 'psp-event-already-processed' THEN
    RAISE EXCEPTION 'F5 T34 falhou: apply direto devolveu % (esperado psp-event-already-processed)',
      v_msg;
  END IF;

  -- (d) a ORDEM segue funcionando com o payload do evento anterior reduzido:
  -- evento mais novo aplica e avanca a marca d'agua (nunca vira stale).
  PERFORM pg_temp.c68_event(
    'c68-evt-t34-new', 'PAYMENT_CONFIRMED', pg_temp.c68_payload('t34new'),
    pg_catalog.now() - interval '94 days', NULL,
    pg_catalog.now() - interval '94 days', 'c68-sub-t34', 'c68-pay-t34new'
  );
  v_res := public.apply_psp_event('c68-evt-t34-new');
  IF v_res->>'outcome' IS DISTINCT FROM 'applied'
     AND v_res->>'outcome' IS DISTINCT FROM 'noop' THEN
    RAISE EXCEPTION 'F5 T34 falhou: evento posterior % (esperado applied/noop)', v_res;
  END IF;
  IF v_res->>'reason' IS NOT DISTINCT FROM 'stale-event' THEN
    RAISE EXCEPTION 'F5 T34 falhou: evento posterior virou stale apos o scrub (%)', v_res;
  END IF;

  SELECT last_event_id INTO v_last_id
  FROM public.tenant_subscriptions WHERE id = v_sub;
  IF v_last_id IS DISTINCT FROM 'c68-evt-t34-new' THEN
    RAISE EXCEPTION 'F5 T34 falhou: marca d''agua % (esperado c68-evt-t34-new)', v_last_id;
  END IF;

  -- O scrub nao e desfeito pela aplicacao seguinte.
  SELECT * INTO v_row FROM public.psp_events WHERE event_id = 'c68-evt-t34';
  IF v_row.payload_scrubbed_at IS NULL
     OR v_row.payload->'payment'->'customer' IS NOT NULL THEN
    RAISE EXCEPTION 'F5 T34 falhou: payload do evento scrubado foi restaurado';
  END IF;

  RAISE NOTICE 'F5 T34 ok: reenvio duplicate, dreno noop e ordem intacta apos o scrub';
END $$;
ROLLBACK;

-- ============ Fixtures cleanup (fim; rerunnable) ============
BEGIN;
DELETE FROM public.psp_events
WHERE event_id LIKE 'c65%' OR event_id LIKE 'c66%'
   OR event_id LIKE 'c67%' OR event_id LIKE 'c68%';
DELETE FROM public.tenant_invoices AS i
USING public.tenants AS t
WHERE i.tenant_id = t.id
  AND t.owner_user_id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  );
DELETE FROM public.tenant_subscriptions AS s
USING public.tenants AS t
WHERE s.tenant_id = t.id
  AND t.owner_user_id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  );
DELETE FROM public.admin_audit AS a
USING public.tenants AS t
WHERE t.owner_user_id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  )
  AND (a.tenant_id = t.id OR a.target_id = t.id);
DELETE FROM public.tenants
WHERE owner_user_id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  );
DELETE FROM auth.users
WHERE id IN (
    'c6500000-0000-4000-8000-0000000000a1',
    'c6700000-0000-4000-8000-0000000000a1'
  );
COMMIT;
