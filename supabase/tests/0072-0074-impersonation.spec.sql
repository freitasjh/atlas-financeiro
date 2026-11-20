-- 0072-0074-impersonation.spec.sql — internal-control-plane / F7 / ADR-005.
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0072-0074-impersonation.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Cobertura deste arquivo (fatia BE-69..BE-72 = migrations 0072 + 0073):
--   T-IM-00(a)  estrutura de `impersonation_sessions` (11 colunas, 5 CHECK,
--               3 índices, 0 FK, RLS deny-all, COMMENTs, pgcrypto, admin_audit
--               intacto) + as 4 funções de 0073 (DEFINER, search_path='',
--               sem current_user).
--   T-IM-21     grants: tabela deny-all para os 4 papéis; EXECUTE só
--               `authenticated` nas 5 RPCs públicas; `private.impersonation_gate`
--               sem EXECUTE para nenhum dos 4.
--   T-IM-01     start: token devolvido UMA vez, sha256 no banco, TTL 15 min,
--               trilha `impersonation_start:<motivo>`; token ausente da trilha.
--   T-IM-02     start sem aal2 ⇒ `mfa-required`, 0 sessão.
--   T-IM-03     start com operador inativo ⇒ `operator-inactive`, 0 sessão.
--   T-IM-04     4 motivos inválidos (curto, com ':', e-mail, 11–14 dígitos) ⇒
--               `impersonation-reason-invalid`, 0 sessão e 0 trilha de início.
--   T-IM-05     self-target (operador é membro) ⇒ `impersonation-self-target`.
--   T-IM-06     tenant inexistente ⇒ `tenant-not-found`.
--   T-IM-07     supersessão: 2ª abertura encerra a 1ª, 1 `impersonation_end:superseded`
--               com o tenant ANTERIOR, estado final 1 aberta.
--   T-IM-08     I1 pelo índice parcial (2ª sessão aberta ⇒ unique_violation) +
--               mapeamento `impersonation-session-conflict` no prosrc (corrida
--               real em 2 conexões: prova PARCIAL declarada, ver PLAN §5.1#4).
--   T-IM-09     gate READ-ONLY: sessão expirada ⇒ `impersonation-expired`; após
--               capturar o erro, DELTA de `pg_stat_xact_user_tables` = 0
--               (prova runtime, sobrevive ao rollback do savepoint), 0 trilha do
--               fixture e sessão ainda `ended_at IS NULL`. Selo é do sweep (T-IM-23).
--   T-IM-11     gate READ-ONLY: mismatch ⇒ `impersonation-tenant-mismatch`; DELTA
--               de escritas = 0; 0 trilha do fixture; sessão intacta.
--   T-IM-12     end: sela + audita `stopped_by_operator` ⇒ true.
--   T-IM-13     end idempotente: 2ª chamada ⇒ false, sem 2ª trilha.
--   T-IM-14     end com token alheio ⇒ not-found; sem sessão ⇒ not-authenticated.
--   T-IM-15     falha do gate de operador (mfa-required) NÃO sela e NÃO audita:
--               DELTA de escritas = 0, 0 `impersonation_end:*`, sessão aberta.
--   T-IM-16     rótulos sem cobertura: (a) `impersonation-session-ended` no gate
--               (passo 4), (b) `impersonation-session-not-found` no gate (passo 3,
--               token de outro operador), (c) `first-access-password-change-required`
--               via `start` (fixture a3). Todos com rótulo literal e 0 linhas.
--   T-IM-17     list: not-admin; clamp 1000⇒100 e 0⇒1; ordem `started_at DESC, id DESC`;
--               filtro por operador; 10 colunas sem PII.
--   T-IM-18     superfície: DML ⊆ {admin_audit, impersonation_sessions}; gate sem
--               INSERT/UPDATE; sem set_config/current_setting; sem RPC de escrita.
--   T-IM-22(a)  objetos presentes e assinatura única (idempotência 2× provada no
--               harness reaplicando 0072/0073).
--   T-IM-23     `admin_sweep_impersonation_sessions` (REQ-48): drena residuais e
--               prova sela 2 do FIXTURE por delta de trilha (não global) + 1
--               `impersonation_end:expired` por sessão; 2ª ⇒ 0; clamp 0⇒1 e
--               9999⇒500; not-admin.
--
--   (0074 — BE-73/74/75 · impersonation_read)
--   T-IM-19     envelope EXATO de 4 chaves; `tenant` com 7 chaves e SEM document;
--               `billing` sem as 4 `psp_*` e com `amount_cents`; `usage` 5 linhas;
--               `members` total>limit e ordem `created_at ASC, user_id ASC`;
--               `audit` total pelo predicado + `reason` redigido (CPF/CNPJ
--               formatados, corrida de 11+ dígitos sem teto, e-mail normal,
--               `foo@localhost`, `+tag`; telefone permanece); `reads` +1.
--   T-IM-10     5 valores fora do enum (incl. NULL) ⇒ `impersonation-read-only`,
--               0 leituras, `reads` inalterado, 0 delegação.
--   T-IM-24     ausência de `token_hash`/token/hash em TODOS os 5 escopos.
--   T-IM-20     6 rótulos literais sem UUID/e-mail/11–14 dígitos (inclui
--               `tenant-audit-action-invalid` herdado).
--   T-IM-22(b)  `impersonation_read`: 1 assinatura, DEFINER, search_path,
--               EXECUTE só `authenticated` (idempotência 2× no harness).
--
-- NOTA DE MEDIÇÃO (I8 × semântica de transação do Postgres) — Opção C aprovada:
--   O padrão de §6.2/§4.3 (INSERT em subtransação + RAISE fora) NÃO faz a linha
--   sobreviver quando o CHAMADOR captura o RAISE: a exceção capturada faz
--   ROLLBACK ao savepoint do BEGIN do chamador e desfaz também o INSERT já
--   "liberado" da subtransação (medido: count_after_catch = 0). Em Postgres puro,
--   persistir escrita através de um erro exige transação autônoma
--   (dblink/pg_background), vedada por REQ-47. Decisão humana (adendo ADR-005):
--   o gate é READ-ONLY (não grava); selo e trilha da EXPIRAÇÃO são assíncronos
--   via `admin_sweep_impersonation_sessions` (T-IM-23), cuja transação COMMITA.
--   `end_impersonation` e a supersessão de `start_impersonation` persistem porque
--   NÃO levantam (T-IM-12/13/07).
--
-- Erros por rótulo fixo, sem token/id/PII. Rerunnable: fixtures c72*/c73* apagadas
-- no início e no fim; cenários mutáveis vivem em transação com ROLLBACK.

\set ON_ERROR_STOP on

-- ============ Cleanup de fixtures (início; postgres bypass RLS) ============
BEGIN;
DELETE FROM public.impersonation_sessions
WHERE operator_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5'
);

DELETE FROM public.admin_audit
WHERE actor_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5'
)
OR target_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5',
  'c7200000-0000-4000-8000-0000000000b1',
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.tenant_members
WHERE user_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5'
)
OR tenant_id IN (
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.tenant_invoices
WHERE tenant_id IN (
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.tenants
WHERE id IN (
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5'
);

DELETE FROM auth.users
WHERE id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5',
  'c7200000-0000-4000-8000-0000000000b1',
  'c7200000-0000-4000-8000-0000000000b2',
  'c7200000-0000-4000-8000-0000000000b3',
  'c7200000-0000-4000-8000-0000000000b4',
  'c7200000-0000-4000-8000-0000000000b5'
);
COMMIT;

-- ============ Fixtures (committed) ============
INSERT INTO auth.users (id, email) VALUES
  ('c7200000-0000-4000-8000-0000000000a1', 'im-op-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000a2', 'im-opinactive-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000a3', 'im-firstaccess-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000a4', 'im-user-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000a5', 'im-op2-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000b1', 'im-owner-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000b2', 'im-m2-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000b3', 'im-m3-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000b4', 'im-m4-0072@example.com'),
  ('c7200000-0000-4000-8000-0000000000b5', 'im-m5-0072@example.com');

-- a1: operador canônico (super_admin + aal2 + ativo).
-- a2: super_admin + aal2 + operador INATIVO.
-- a3: super_admin + operador ativo + primeiro acesso pendente.
-- a4: usuário comum (not-admin).
-- a5: segundo operador canônico (token alheio / list).
UPDATE public.profiles SET role = 'super_admin', must_change_password = false
WHERE id = 'c7200000-0000-4000-8000-0000000000a1';
UPDATE public.profiles SET role = 'super_admin', must_change_password = false
WHERE id = 'c7200000-0000-4000-8000-0000000000a2';
UPDATE public.profiles SET role = 'super_admin', must_change_password = true
WHERE id = 'c7200000-0000-4000-8000-0000000000a3';
UPDATE public.profiles SET role = 'user', must_change_password = false
WHERE id = 'c7200000-0000-4000-8000-0000000000a4';
UPDATE public.profiles SET role = 'super_admin', must_change_password = false
WHERE id = 'c7200000-0000-4000-8000-0000000000a5';
UPDATE public.profiles SET role = 'user', must_change_password = false
WHERE id = 'c7200000-0000-4000-8000-0000000000b1';

INSERT INTO public.internal_operators (user_id, active) VALUES
  ('c7200000-0000-4000-8000-0000000000a1', true),
  ('c7200000-0000-4000-8000-0000000000a2', false),
  ('c7200000-0000-4000-8000-0000000000a3', true),
  ('c7200000-0000-4000-8000-0000000000a5', true);

BEGIN;
ALTER TABLE public.tenants DISABLE TRIGGER tenant_acceptance_required;
INSERT INTO public.tenants
  (id, kind, owner_user_id, cpf, razao_social, nome_fantasia, plan_id, subscription_status)
VALUES
  ('c7200000-0000-4000-8000-0000000000d1', 'pf',
   'c7200000-0000-4000-8000-0000000000b1', '72000000101',
   'Impersonation Alfa', 'Alfa', 'full', 'active'),
  ('c7200000-0000-4000-8000-0000000000d2', 'pf',
   'c7200000-0000-4000-8000-0000000000b1', '72000000102',
   'Impersonation Beta', 'Beta', 'full', 'active'),
  ('c7200000-0000-4000-8000-0000000000d3', 'pf',
   'c7200000-0000-4000-8000-0000000000b1', '72000000103',
   'Impersonation Gama', NULL, 'full', 'active');
ALTER TABLE public.tenants ENABLE TRIGGER tenant_acceptance_required;
COMMIT;

-- a1 é membro de d3 ⇒ alvo de self-target.
INSERT INTO public.tenant_members (tenant_id, user_id, role)
VALUES ('c7200000-0000-4000-8000-0000000000d3',
        'c7200000-0000-4000-8000-0000000000a1', 'member');

-- ============ Fixtures 0074 (committed): membros/billing/trilha PII de d1 ============
-- 5 membros em d1 (b1 owner; b2..b5 member) com created_at distintos para
-- provar a ordem `created_at ASC, user_id ASC` e `total` > limit.
INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at) VALUES
  ('c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000b1', 'owner',  now() - interval '5 minutes'),
  ('c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000b2', 'member', now() - interval '4 minutes'),
  ('c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000b3', 'member', now() - interval '3 minutes'),
  ('c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000b4', 'member', now() - interval '2 minutes'),
  ('c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000b5', 'member', now() - interval '1 minutes');

-- Assinatura + fatura de billing de d1 com lastro de PSP (para provar a remoção).
INSERT INTO public.tenant_subscriptions
  (id, tenant_id, plan_slug, status, billing_day, psp_subscription_id, psp_customer_id)
VALUES
  ('c7400000-0000-4000-8000-0000000000c1',
   'c7200000-0000-4000-8000-0000000000d1', 'full', 'active', 10,
   'sub_PSP_0074', 'cus_PSP_0074');

INSERT INTO public.tenant_invoices
  (tenant_id, subscription_id, competencia, period_start, period_end, due_date,
   amount_cents, status, psp_invoice_id, psp_payment_id)
VALUES
  ('c7200000-0000-4000-8000-0000000000d1',
   'c7400000-0000-4000-8000-0000000000c1',
   '2026-11-01', '2026-11-01', '2026-12-01', '2026-11-10',
   9900, 'open', 'inv_PSP_0074', 'pay_PSP_0074');

-- Trilha com PII (inserida como postgres; start proíbe PII no motivo).
-- Os 10 casos medidos pelo review + telefone (residual declarado, deve permanecer).
INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason) VALUES
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'cpf 123.456.789-01 fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'cnpj 12.345.678/0001-90 fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'cartao 4111111111111111 fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'corrida 12345678901234567890 fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'corrida 123456789012345 fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'telefone (11) 98765-4321 fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'email foo@example.com fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'local foo@localhost fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'tag joao.silva+tag@example.com fim'),
  (NULL, 'c7200000-0000-4000-8000-0000000000d1', 'c7200000-0000-4000-8000-0000000000d1',
   'other', 'doc 12345678901 fim');

-- ============ T-IM-00(a) — estrutura 0072 + funções 0073 ============
DO $$
DECLARE
  v_n int;
  v_txt text;
  v_idx text;
  v_att int;
  v_def text;
  v_pk regprocedure;
  v_pks text;
  v_pk_list text[] := ARRAY[
    'public.start_impersonation(uuid,text)',
    'public.end_impersonation(uuid)',
    'private.impersonation_gate(uuid,uuid)',
    'public.admin_list_impersonation_sessions(uuid,int,int)',
    'public.admin_sweep_impersonation_sessions(int)',
    'public.impersonation_read(uuid,uuid,text,jsonb)'
  ];
BEGIN
  -- 11 colunas exatas
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'impersonation_sessions';
  IF v_n <> 11 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: % colunas (esperado 11)', v_n;
  END IF;

  -- tipos exatos
  FOR v_txt, v_idx IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'impersonation_sessions'
  LOOP
    IF (v_txt, v_idx) NOT IN (
      ('id','uuid'), ('token_hash','text'), ('operator_id','uuid'),
      ('tenant_id','uuid'), ('reason','text'), ('started_at','timestamp with time zone'),
      ('expires_at','timestamp with time zone'), ('ended_at','timestamp with time zone'),
      ('revoked_at','timestamp with time zone'), ('reads','bigint'),
      ('last_read_at','timestamp with time zone')
    ) THEN
      RAISE EXCEPTION 'T-IM-00 falhou: coluna % tem tipo inesperado %', v_txt, v_idx;
    END IF;
  END LOOP;

  -- nulabilidade
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'impersonation_sessions'
    AND is_nullable = 'NO'
    AND column_name IN ('id','token_hash','operator_id','tenant_id','reason',
                        'started_at','expires_at','reads');
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: NOT NULL esperado em 8 colunas, achei %', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'impersonation_sessions'
    AND is_nullable = 'YES'
    AND column_name IN ('ended_at','revoked_at','last_read_at');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: nuláveis esperadas 3, achei %', v_n;
  END IF;

  -- reads é bigint (nunca numeric/float)
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'impersonation_sessions'
    AND data_type IN ('numeric','double precision','real');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: % coluna(s) numeric/float', v_n;
  END IF;

  -- 5 CHECK
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE conrelid = 'public.impersonation_sessions'::regclass
    AND contype = 'c'
    AND conname IN (
      'impersonation_sessions_expiry_check',
      'impersonation_sessions_reason_len_check',
      'impersonation_sessions_reason_colon_check',
      'impersonation_sessions_reads_check',
      'impersonation_sessions_ended_check'
    );
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: % CHECK (esperado 5)', v_n;
  END IF;

  -- 0 FK
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE conrelid = 'public.impersonation_sessions'::regclass AND contype = 'f';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: % FK (esperado 0)', v_n;
  END IF;

  -- 3 índices nomeados com a forma congelada
  SELECT count(*) INTO v_n
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'impersonation_sessions'
    AND indexname IN (
      'impersonation_sessions_token_hash_key',
      'impersonation_sessions_operator_open_uq',
      'impersonation_sessions_operator_started_idx'
    );
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: % índices nomeados (esperado 3)', v_n;
  END IF;

  SELECT indexdef INTO v_idx FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'impersonation_sessions'
    AND indexname = 'impersonation_sessions_operator_open_uq';
  IF v_idx NOT LIKE '%UNIQUE%'
     OR v_idx NOT LIKE '%(operator_id)%'
     OR v_idx NOT LIKE '%ended_at IS NULL%'
     OR v_idx NOT LIKE '%revoked_at IS NULL%' THEN
    RAISE EXCEPTION 'T-IM-00 falhou: índice parcial incorreto (%)', v_idx;
  END IF;

  -- nenhum índice com tenant_id como coluna líder
  SELECT count(*) INTO v_n
  FROM pg_index AS i
  JOIN pg_attribute AS a
    ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
  WHERE i.indrelid = 'public.impersonation_sessions'::regclass
    AND a.attname = 'tenant_id';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: índice especulativo em tenant_id';
  END IF;

  -- RLS deny-all
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.impersonation_sessions'::regclass) THEN
    RAISE EXCEPTION 'T-IM-00 falhou: RLS desligada';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_policy WHERE polrelid = 'public.impersonation_sessions'::regclass;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: % policy (esperado 0)', v_n;
  END IF;

  -- REVOKE dos 4 papéis (nenhum privilégio de tabela)
  IF has_table_privilege('authenticated', 'public.impersonation_sessions', 'SELECT')
     OR has_table_privilege('anon', 'public.impersonation_sessions', 'SELECT')
     OR has_table_privilege('service_role', 'public.impersonation_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'T-IM-00 falhou: SELECT de tabela concedido a papel de cliente';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_class AS c, pg_catalog.aclexplode(c.relacl) AS a
  WHERE c.oid = 'public.impersonation_sessions'::regclass AND a.grantee = 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: PUBLIC com privilégio na tabela';
  END IF;

  -- COMMENT por coluna (11) e da tabela
  SELECT count(*) INTO v_n
  FROM pg_description AS d
  JOIN pg_attribute AS a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
  WHERE d.objoid = 'public.impersonation_sessions'::regclass
    AND a.attnum > 0 AND a.attisdropped = false;
  IF v_n <> 11 THEN
    RAISE EXCEPTION 'T-IM-00 falhou: % COMMENTs de coluna (esperado 11)', v_n;
  END IF;
  IF obj_description('public.impersonation_sessions'::regclass, 'pg_class') IS NULL THEN
    RAISE EXCEPTION 'T-IM-00 falhou: COMMENT da tabela ausente';
  END IF;

  -- pgcrypto em extensions
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'pgcrypto' AND extnamespace = 'extensions'::regnamespace
  ) THEN
    RAISE EXCEPTION 'T-IM-00 falhou: pgcrypto fora de extensions';
  END IF;

  -- admin_audit intacto (CHECK de 9 ações)
  SELECT pg_get_constraintdef(oid) INTO v_txt
  FROM pg_constraint
  WHERE conrelid = 'public.admin_audit'::regclass
    AND conname = 'admin_audit_action_check';
  IF v_txt IS NULL THEN
    RAISE EXCEPTION 'T-IM-00 falhou: admin_audit_action_check ausente';
  END IF;
  IF v_txt NOT LIKE '%''other''%'
     OR v_txt NOT LIKE '%''grant_admin''%'
     OR v_txt NOT LIKE '%''revoke_admin''%'
     OR v_txt NOT LIKE '%''change_plan''%'
     OR v_txt NOT LIKE '%''tenant_status_changed''%'
     OR v_txt NOT LIKE '%''quota_override''%'
     OR v_txt NOT LIKE '%''grant_super_admin''%'
     OR v_txt NOT LIKE '%''revoke_super_admin''%'
     OR v_txt NOT LIKE '%''mfa_enrolled''%' THEN
    RAISE EXCEPTION 'T-IM-00 falhou: admin_audit_action_check mudou (%)', v_txt;
  END IF;

  -- 4 funções de 0073: DEFINER, search_path vazio, sem current_user
  FOREACH v_pks IN ARRAY v_pk_list LOOP
    v_pk := v_pks::regprocedure;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_pk) THEN
      RAISE EXCEPTION 'T-IM-00 falhou: % não é SECURITY DEFINER', v_pks;
    END IF;
    SELECT array_to_string(proconfig, ',') INTO v_txt FROM pg_proc WHERE oid = v_pk;
    IF v_txt IS NULL OR v_txt NOT LIKE '%search_path=%' THEN
      RAISE EXCEPTION 'T-IM-00 falhou: % sem search_path no proconfig (%)', v_pks, v_txt;
    END IF;
    SELECT prosrc INTO v_def FROM pg_proc WHERE oid = v_pk;
    IF v_def ~* 'current_user' THEN
      RAISE EXCEPTION 'T-IM-00 falhou: % usa current_user', v_pks;
    END IF;
  END LOOP;

  RAISE NOTICE 'T-IM-00(a) ok: 11 colunas/5 CHECK/3 indices/0 FK/RLS deny-all/COMMENTs/pgcrypto/admin_audit intacto/6 funcoes DEFINER search_path=';
END $$;

-- ============ T-IM-21 — grants ============
DO $$
DECLARE
  v_n int;
  v_pks text;
  v_pk_list text[] := ARRAY[
    'public.start_impersonation(uuid,text)',
    'public.end_impersonation(uuid)',
    'public.admin_list_impersonation_sessions(uuid,int,int)',
    'public.admin_sweep_impersonation_sessions(int)',
    'public.impersonation_read(uuid,uuid,text,jsonb)'
  ];
  v_pk regprocedure;
BEGIN
  -- tabela: authenticated/anon/service_role sem nenhum privilégio
  IF has_table_privilege('authenticated', 'public.impersonation_sessions', 'SELECT')
     OR has_table_privilege('anon', 'public.impersonation_sessions', 'SELECT')
     OR has_table_privilege('service_role', 'public.impersonation_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'T-IM-21 falhou: SELECT de tabela concedido';
  END IF;

  -- 5 RPCs públicas: EXECUTE só authenticated
  FOREACH v_pks IN ARRAY v_pk_list LOOP
    v_pk := v_pks::regprocedure;
    IF NOT has_function_privilege('authenticated', v_pk, 'EXECUTE') THEN
      RAISE EXCEPTION 'T-IM-21 falhou: authenticated sem EXECUTE em %', v_pks;
    END IF;
    IF has_function_privilege('anon', v_pk, 'EXECUTE')
       OR has_function_privilege('service_role', v_pk, 'EXECUTE') THEN
      RAISE EXCEPTION 'T-IM-21 falhou: anon/service_role com EXECUTE em %', v_pks;
    END IF;
    SELECT count(*) INTO v_n
    FROM pg_proc AS p, pg_catalog.aclexplode(p.proacl) AS a
    WHERE p.oid = v_pk AND a.grantee = 0;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'T-IM-21 falhou: PUBLIC com EXECUTE em %', v_pks;
    END IF;
  END LOOP;

  -- gate: SEM EXECUTE para os 4 papéis
  v_pk := 'private.impersonation_gate(uuid,uuid)'::regprocedure;
  IF has_function_privilege('authenticated', v_pk, 'EXECUTE')
     OR has_function_privilege('anon', v_pk, 'EXECUTE')
     OR has_function_privilege('service_role', v_pk, 'EXECUTE') THEN
    RAISE EXCEPTION 'T-IM-21 falhou: gate com EXECUTE para papel de cliente';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_proc AS p, pg_catalog.aclexplode(p.proacl) AS a
  WHERE p.oid = v_pk AND a.grantee = 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-21 falhou: PUBLIC com EXECUTE no gate';
  END IF;

  RAISE NOTICE 'T-IM-21 ok: tabela deny-all nos 4 papeis; 5 RPCs EXECUTE so authenticated; gate sem EXECUTE';
END $$;

-- ============ T-IM-01 — start: token, sha256, TTL 15 min, trilha ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_token text; v_exp timestamptz;
BEGIN
  SELECT s.token, s.expires_at INTO v_token, v_exp
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'acesso de suporte') AS s;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'T-IM-01 falhou: token nulo';
  END IF;
  PERFORM set_config('atlas.tok', v_token, true);
END $$;
RESET ROLE;
DO $$
DECLARE
  v_token text := current_setting('atlas.tok', true);
  v_row public.impersonation_sessions;
  v_n int;
  v_leak int;
BEGIN
  SELECT * INTO v_row FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND ended_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T-IM-01 falhou: sessão não criada';
  END IF;

  IF v_row.expires_at - v_row.started_at <> interval '15 minutes' THEN
    RAISE EXCEPTION 'T-IM-01 falhou: TTL % (esperado 15 min)',
      (v_row.expires_at - v_row.started_at);
  END IF;
  IF v_row.expires_at <= now() THEN
    RAISE EXCEPTION 'T-IM-01 falhou: expires_at no passado';
  END IF;

  IF v_row.token_hash <> encode(extensions.digest(v_token, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'T-IM-01 falhou: token_hash != sha256(token)';
  END IF;
  IF length(v_row.token_hash) <> 64 THEN
    RAISE EXCEPTION 'T-IM-01 falhou: token_hash com % chars', length(v_row.token_hash);
  END IF;
  IF v_row.token_hash = v_token THEN
    RAISE EXCEPTION 'T-IM-01 falhou: token cru persistido';
  END IF;

  -- trilha de início exata
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND action = 'other'
    AND reason = 'impersonation_start:acesso de suporte'
    AND target_id = 'c7200000-0000-4000-8000-0000000000d1'
    AND tenant_id = 'c7200000-0000-4000-8000-0000000000d1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-IM-01 falhou: trilha de início = % (esperado 1)', v_n;
  END IF;

  -- token nunca na trilha
  SELECT count(*) INTO v_leak FROM public.admin_audit
  WHERE coalesce(reason,'') LIKE '%' || v_token || '%'
     OR coalesce(from_value,'') LIKE '%' || v_token || '%'
     OR coalesce(to_value,'') LIKE '%' || v_token || '%';
  IF v_leak <> 0 THEN
    RAISE EXCEPTION 'T-IM-01 falhou: token vazou para admin_audit';
  END IF;

  RAISE NOTICE 'T-IM-01 ok: token uma vez + sha256 + TTL 15 min + trilha de inicio sem token';
END $$;
ROLLBACK;

-- ============ T-IM-02 — start sem aal2 ⇒ mfa-required ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                       'acesso de suporte');
    RAISE EXCEPTION 'T-IM-02 falhou: aceitou sem aal2';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-02 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'mfa-required' THEN
      RAISE EXCEPTION 'T-IM-02 falhou: rótulo % (esperado mfa-required)', SQLERRM;
    END IF;
  END;
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-02 falhou: % sessão criada sem aal2', v_n;
  END IF;
  RAISE NOTICE 'T-IM-02 ok: mfa-required, 0 sessao';
END $$;
ROLLBACK;

-- ============ T-IM-03 — operador inativo ⇒ operator-inactive ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                       'acesso de suporte');
    RAISE EXCEPTION 'T-IM-03 falhou: aceitou operador inativo';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-03 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'operator-inactive' THEN
      RAISE EXCEPTION 'T-IM-03 falhou: rótulo % (esperado operator-inactive)', SQLERRM;
    END IF;
  END;
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a2';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-03 falhou: % sessão criada por operador inativo', v_n;
  END IF;
  RAISE NOTICE 'T-IM-03 ok: operator-inactive, 0 sessao';
END $$;
ROLLBACK;

-- ============ T-IM-04 — 4 motivos inválidos ============
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_reason text;
  v_lbl text;
  v_sessions int;
  v_audit int;
BEGIN
  FOREACH v_reason IN ARRAY ARRAY[
    'curto',                               -- (1) < 10 chars
    'motivo com dois: pontos',             -- (2) contém ':'
    'contato foo@example.com agora',       -- (3) e-mail
    'documento 12345678901 anexo'          -- (4) sequência 11–14 dígitos
  ] LOOP
    BEGIN
      PERFORM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1', v_reason);
      RAISE EXCEPTION 'T-IM-04 falhou: aceitou motivo inválido (%)', v_reason;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-IM-04 falhou%' THEN RAISE; END IF;
      v_lbl := SQLERRM;
    END;
    IF v_lbl <> 'impersonation-reason-invalid' THEN
      RAISE EXCEPTION 'T-IM-04 falhou: motivo % deu rótulo %', v_reason, v_lbl;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_sessions FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1';
  SELECT count(*) INTO v_audit FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND reason LIKE 'impersonation_start:%';
  IF v_sessions <> 0 OR v_audit <> 0 THEN
    RAISE EXCEPTION 'T-IM-04 falhou: % sessão / % trilha de início', v_sessions, v_audit;
  END IF;

  RAISE NOTICE 'T-IM-04 ok: 4 motivos invalidos -> impersonation-reason-invalid, 0 sessao, 0 trilha';
END $$;
ROLLBACK;

-- ============ T-IM-05 — self-target ============
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_n int;
BEGIN
  BEGIN
    PERFORM public.start_impersonation('c7200000-0000-4000-8000-0000000000d3',
                                       'acesso de suporte');
    RAISE EXCEPTION 'T-IM-05 falhou: aceitou self-target';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-05 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'impersonation-self-target' THEN
      RAISE EXCEPTION 'T-IM-05 falhou: rótulo %', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-05 falhou: % sessão criada em self-target', v_n;
  END IF;
  RAISE NOTICE 'T-IM-05 ok: impersonation-self-target, 0 sessao';
END $$;
ROLLBACK;

-- ============ T-IM-06 — tenant inexistente ============
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.start_impersonation('c7200000-0000-4000-8000-0000000000d9',
                                       'acesso de suporte');
    RAISE EXCEPTION 'T-IM-06 falhou: aceitou tenant inexistente';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-06 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'tenant-not-found' THEN
      RAISE EXCEPTION 'T-IM-06 falhou: rótulo %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-IM-06 ok: tenant-not-found';
END $$;
ROLLBACK;

-- ============ T-IM-07 — supersessão auditada com o tenant ANTERIOR ============
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok1 text;
  v_tok2 text;
  v_open int;
  v_sup int;
  v_sup_tenant uuid;
BEGIN
  SELECT s.token INTO v_tok1
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'primeiro acesso') AS s;
  SELECT s.token INTO v_tok2
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d2',
                                  'segundo acesso') AS s;

  SELECT count(*) INTO v_open FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND ended_at IS NULL AND revoked_at IS NULL;
  IF v_open <> 1 THEN
    RAISE EXCEPTION 'T-IM-07 falhou: % sessões abertas (esperado 1)', v_open;
  END IF;

  SELECT count(*) INTO v_sup
  FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND reason = 'impersonation_end:superseded';
  SELECT tenant_id INTO v_sup_tenant
  FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND reason = 'impersonation_end:superseded'
  LIMIT 1;
  IF v_sup <> 1 THEN
    RAISE EXCEPTION 'T-IM-07 falhou: % trilha superseded (esperado 1)', v_sup;
  END IF;
  IF v_sup_tenant <> 'c7200000-0000-4000-8000-0000000000d1' THEN
    RAISE EXCEPTION 'T-IM-07 falhou: superseded auditou tenant % (esperado o ANTERIOR d1)',
      v_sup_tenant;
  END IF;

  -- a 1ª sessão está encerrada; a 2ª aberta
  IF NOT EXISTS (
    SELECT 1 FROM public.impersonation_sessions
    WHERE token_hash = encode(extensions.digest(v_tok1, 'sha256'), 'hex')
      AND ended_at IS NOT NULL AND revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'T-IM-07 falhou: 1ª sessão não encerrada';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.impersonation_sessions
    WHERE token_hash = encode(extensions.digest(v_tok2, 'sha256'), 'hex')
      AND ended_at IS NULL AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'T-IM-07 falhou: 2ª sessão não aberta';
  END IF;

  RAISE NOTICE 'T-IM-07 ok: 1 aberta + 1 superseded com tenant anterior (d1)';
END $$;
ROLLBACK;

-- ============ T-IM-08 — I1 pelo índice parcial + mapeamento do conflito ============
BEGIN;
DO $$
DECLARE v_n int;
BEGIN
  -- I1 provado pelo índice: 1ª sessão aberta ok; 2ª aberta ⇒ unique_violation.
  INSERT INTO public.impersonation_sessions
    (token_hash, operator_id, tenant_id, reason, expires_at)
  VALUES
    (encode(extensions.digest('race-1', 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a5',
     'c7200000-0000-4000-8000-0000000000d1',
     'corrida primeira', now() + interval '15 minutes');

  BEGIN
    INSERT INTO public.impersonation_sessions
      (token_hash, operator_id, tenant_id, reason, expires_at)
    VALUES
      (encode(extensions.digest('race-2', 'sha256'), 'hex'),
       'c7200000-0000-4000-8000-0000000000a5',
       'c7200000-0000-4000-8000-0000000000d2',
       'corrida segunda', now() + interval '15 minutes');
    RAISE EXCEPTION 'T-IM-08 falhou: 2ª sessão aberta aceita';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  SELECT count(*) INTO v_n FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a5'
    AND ended_at IS NULL AND revoked_at IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-IM-08 falhou: % sessões abertas (esperado 1)', v_n;
  END IF;

  -- mapeamento declarado no prosrc (corrida real em 2 conexões: prova PARCIAL)
  IF (SELECT prosrc FROM pg_proc
      WHERE oid = 'public.start_impersonation(uuid,text)'::regprocedure)
     NOT LIKE '%impersonation-session-conflict%' THEN
    RAISE EXCEPTION 'T-IM-08 falhou: start sem rótulo impersonation-session-conflict';
  END IF;
  IF (SELECT prosrc FROM pg_proc
      WHERE oid = 'public.start_impersonation(uuid,text)'::regprocedure)
     NOT LIKE '%CONSTRAINT_NAME%' THEN
    RAISE EXCEPTION 'T-IM-08 falhou: start sem GET STACKED DIAGNOSTICS CONSTRAINT_NAME';
  END IF;

  RAISE NOTICE 'T-IM-08 ok (parcial): I1 pelo indice parcial + mapeamento do conflito no prosrc';
END $$;
ROLLBACK;

-- ============ T-IM-09 — gate READ-ONLY: expiração (delta de escritas = 0) ============
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok uuid := 'c7300000-0000-4000-8000-0000000000e1';
  v_lbl text;
  v_writes_antes bigint;
  v_writes_depois bigint;
  v_n int;
  v_ended timestamptz;
  v_revoked timestamptz;
  v_def text;
BEGIN
  INSERT INTO public.impersonation_sessions
    (token_hash, operator_id, tenant_id, reason, started_at, expires_at)
  VALUES
    (encode(extensions.digest(v_tok::text, 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a1',
     'c7200000-0000-4000-8000-0000000000d1',
     'sessao expirada',
     now() - interval '20 minutes', now() - interval '5 minutes');

  -- PROVA RUNTIME de 0 gravação: pg_stat_xact_user_tables sobrevive ao
  -- rollback do savepoint do chamador (medido). Baseline DEPOIS do INSERT acima.
  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_writes_antes
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');

  BEGIN
    PERFORM private.impersonation_gate(v_tok, 'c7200000-0000-4000-8000-0000000000d1');
    RAISE EXCEPTION 'T-IM-09 falhou: gate aceitou sessão expirada';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-09 falhou%' THEN RAISE; END IF;
    v_lbl := SQLERRM;
  END;
  IF v_lbl <> 'impersonation-expired' THEN
    RAISE EXCEPTION 'T-IM-09 falhou: rótulo %', v_lbl;
  END IF;

  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_writes_depois
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');
  IF v_writes_depois - v_writes_antes <> 0 THEN
    RAISE EXCEPTION 'T-IM-09 falhou: gate gravou % escrita(s) (esperado 0)',
      v_writes_depois - v_writes_antes;
  END IF;

  -- Defesa secundária (não é a prova): 0 trilha filtrada pelo fixture.
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND reason = 'impersonation_end:expired';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-09 falhou: % trilha impersonation_end:expired do fixture (gate deve gravar 0)', v_n;
  END IF;

  SELECT ended_at, revoked_at INTO v_ended, v_revoked
  FROM public.impersonation_sessions
  WHERE token_hash = encode(extensions.digest(v_tok::text, 'sha256'), 'hex');
  IF v_ended IS NOT NULL OR v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'T-IM-09 falhou: gate selou a sessão (deve ser 0 gravação)';
  END IF;

  SELECT prosrc INTO v_def FROM pg_proc
  WHERE oid = 'private.impersonation_gate(uuid,uuid)'::regprocedure;
  IF v_def ~* '\minsert\M' OR v_def ~* '\mupdate\M' THEN
    RAISE EXCEPTION 'T-IM-09 falhou: gate prosrc contem INSERT/UPDATE';
  END IF;

  RAISE NOTICE 'T-IM-09 ok: impersonation-expired + delta_escritas=0 + 0 trilha (fixture) + sessao aberta';
END $$;
ROLLBACK;

-- ============ T-IM-11 — gate READ-ONLY: mismatch (delta de escritas = 0) ============
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok uuid := 'c7300000-0000-4000-8000-0000000000e2';
  v_lbl text;
  v_writes_antes bigint;
  v_writes_depois bigint;
  v_n int;
  v_ended timestamptz;
  v_revoked timestamptz;
  v_def text;
BEGIN
  INSERT INTO public.impersonation_sessions
    (token_hash, operator_id, tenant_id, reason, expires_at)
  VALUES
    (encode(extensions.digest(v_tok::text, 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a1',
     'c7200000-0000-4000-8000-0000000000d1',
     'sessao valida', now() + interval '15 minutes');

  -- PROVA RUNTIME de 0 gravação (baseline DEPOIS do INSERT acima).
  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_writes_antes
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');

  BEGIN
    PERFORM private.impersonation_gate(v_tok, 'c7200000-0000-4000-8000-0000000000d2');
    RAISE EXCEPTION 'T-IM-11 falhou: gate aceitou tenant divergente';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-11 falhou%' THEN RAISE; END IF;
    v_lbl := SQLERRM;
  END;
  IF v_lbl <> 'impersonation-tenant-mismatch' THEN
    RAISE EXCEPTION 'T-IM-11 falhou: rótulo %', v_lbl;
  END IF;

  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_writes_depois
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');
  IF v_writes_depois - v_writes_antes <> 0 THEN
    RAISE EXCEPTION 'T-IM-11 falhou: gate gravou % escrita(s) (esperado 0)',
      v_writes_depois - v_writes_antes;
  END IF;

  -- Defesa secundária (não é a prova): 0 trilha filtrada pelo fixture.
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND reason = 'impersonation_scope_violation';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-11 falhou: % trilha impersonation_scope_violation do fixture (gate deve gravar 0)', v_n;
  END IF;

  SELECT ended_at, revoked_at INTO v_ended, v_revoked
  FROM public.impersonation_sessions
  WHERE token_hash = encode(extensions.digest(v_tok::text, 'sha256'), 'hex');
  IF v_ended IS NOT NULL OR v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'T-IM-11 falhou: gate gravou na sessão (deve ser 0 gravação)';
  END IF;

  SELECT prosrc INTO v_def FROM pg_proc
  WHERE oid = 'private.impersonation_gate(uuid,uuid)'::regprocedure;
  IF v_def ~* '\minsert\M' OR v_def ~* '\mupdate\M' THEN
    RAISE EXCEPTION 'T-IM-11 falhou: gate prosrc contem INSERT/UPDATE';
  END IF;

  RAISE NOTICE 'T-IM-11 ok: impersonation-tenant-mismatch + delta_escritas=0 + 0 trilha (fixture) + sessao intacta';
END $$;
ROLLBACK;

-- ============ T-IM-15 — falha do gate de operador (delta de escritas = 0) ============
BEGIN;
-- Sessão aberta válida do a1 (criada como postgres, antes do SET ROLE).
INSERT INTO public.impersonation_sessions
  (token_hash, operator_id, tenant_id, reason, expires_at)
VALUES
  (encode(extensions.digest('c7300000-0000-4000-8000-0000000000e3', 'sha256'), 'hex'),
   'c7200000-0000-4000-8000-0000000000a1',
   'c7200000-0000-4000-8000-0000000000d1',
   'sessao pre-existente', now() + interval '15 minutes');

-- Baseline das escritas DEPOIS do INSERT acima (prova runtime).
SELECT set_config('atlas.w0',
  (SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text
   FROM pg_catalog.pg_stat_xact_user_tables
   WHERE schemaname = 'public'
     AND relname IN ('admin_audit', 'impersonation_sessions')),
  true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', true);
DO $$
DECLARE v_lbl text;
BEGIN
  BEGIN
    PERFORM public.start_impersonation('c7200000-0000-4000-8000-0000000000d2',
                                       'acesso de suporte');
    RAISE EXCEPTION 'T-IM-15 falhou: aceitou aal1';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-15 falhou%' THEN RAISE; END IF;
    v_lbl := SQLERRM;
  END;
  IF v_lbl <> 'mfa-required' THEN
    RAISE EXCEPTION 'T-IM-15 falhou: rótulo %', v_lbl;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE
  v_w0 bigint := current_setting('atlas.w0')::bigint;
  v_w1 bigint;
  v_n int;
  v_ended timestamptz;
BEGIN
  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_w1
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');
  IF v_w1 - v_w0 <> 0 THEN
    RAISE EXCEPTION 'T-IM-15 falhou: falha de gate gravou % escrita(s) (esperado 0)', v_w1 - v_w0;
  END IF;

  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND reason LIKE 'impersonation_end:%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-15 falhou: % trilha impersonation_end:* na falha de gate', v_n;
  END IF;

  SELECT ended_at INTO v_ended FROM public.impersonation_sessions
  WHERE token_hash = encode(extensions.digest('c7300000-0000-4000-8000-0000000000e3', 'sha256'), 'hex');
  IF v_ended IS NOT NULL THEN
    RAISE EXCEPTION 'T-IM-15 falhou: sessão selada na falha de gate (deve ser 0 gravação)';
  END IF;

  RAISE NOTICE 'T-IM-15 ok: falha de gate (mfa-required) + delta_escritas=0 + 0 trilha + sessao aberta';
END $$;
ROLLBACK;

-- ============ T-IM-16 — rótulos sem cobertura ============
-- 16a: gate passo 4 — sessão já encerrada ⇒ impersonation-session-ended
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok uuid := 'c7300000-0000-4000-8000-0000000000f1';
  v_lbl text;
  v_writes_antes bigint;
  v_writes_depois bigint;
BEGIN
  INSERT INTO public.impersonation_sessions
    (token_hash, operator_id, tenant_id, reason, expires_at, ended_at, revoked_at)
  VALUES
    (encode(extensions.digest(v_tok::text, 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a1',
     'c7200000-0000-4000-8000-0000000000d1',
     'sessao encerrada', now() + interval '15 minutes', now(), now());

  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_writes_antes
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');

  BEGIN
    PERFORM private.impersonation_gate(v_tok, 'c7200000-0000-4000-8000-0000000000d1');
    RAISE EXCEPTION 'T-IM-16a falhou: gate aceitou sessão encerrada';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-16a falhou%' THEN RAISE; END IF;
    v_lbl := SQLERRM;
  END;
  IF v_lbl <> 'impersonation-session-ended' THEN
    RAISE EXCEPTION 'T-IM-16a falhou: rótulo % (esperado impersonation-session-ended)', v_lbl;
  END IF;

  -- 0 linhas: o gate levanta (não retorna linha) e não grava.
  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_writes_depois
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');
  IF v_writes_depois - v_writes_antes <> 0 THEN
    RAISE EXCEPTION 'T-IM-16a falhou: gate gravou % escrita(s)', v_writes_depois - v_writes_antes;
  END IF;

  RAISE NOTICE 'T-IM-16a ok: impersonation-session-ended (0 linhas, 0 gravacao)';
END $$;
ROLLBACK;

-- 16b: gate passo 3 — token de OUTRO operador ⇒ impersonation-session-not-found
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok uuid := 'c7300000-0000-4000-8000-0000000000f2';
  v_lbl text;
  v_row public.impersonation_sessions;
  v_w0 bigint;
  v_w1 bigint;
BEGIN
  -- sessão válida do a5 (estrangeira para a1)
  INSERT INTO public.impersonation_sessions
    (token_hash, operator_id, tenant_id, reason, expires_at)
  VALUES
    (encode(extensions.digest(v_tok::text, 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a5',
     'c7200000-0000-4000-8000-0000000000d1',
     'sessao de outro operador', now() + interval '15 minutes');

  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_w0
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');

  BEGIN
    SELECT * INTO v_row
    FROM private.impersonation_gate(v_tok, 'c7200000-0000-4000-8000-0000000000d1');
    RAISE EXCEPTION 'T-IM-16b falhou: gate aceitou token de outro operador';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-16b falhou%' THEN RAISE; END IF;
    v_lbl := SQLERRM;
  END;
  IF v_lbl <> 'impersonation-session-not-found' THEN
    RAISE EXCEPTION 'T-IM-16b falhou: rótulo % (esperado impersonation-session-not-found)', v_lbl;
  END IF;

  -- 0 linhas: a variável de retorno ficou NULL (o gate levantou antes de devolver).
  IF v_row.id IS NOT NULL THEN
    RAISE EXCEPTION 'T-IM-16b falhou: gate devolveu linha';
  END IF;

  -- 0 gravação: delta de escritas = 0.
  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) INTO v_w1
  FROM pg_catalog.pg_stat_xact_user_tables
  WHERE schemaname = 'public'
    AND relname IN ('admin_audit', 'impersonation_sessions');
  IF v_w1 - v_w0 <> 0 THEN
    RAISE EXCEPTION 'T-IM-16b falhou: gate gravou % escrita(s)', v_w1 - v_w0;
  END IF;

  RAISE NOTICE 'T-IM-16b ok: impersonation-session-not-found + 0 linhas + 0 gravacao';
END $$;
ROLLBACK;

-- 16c: start — first-access-password-change-required (fixture a3)
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_lbl text; v_n int;
BEGIN
  BEGIN
    PERFORM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                       'acesso de suporte');
    RAISE EXCEPTION 'T-IM-16c falhou: aceitou operador com primeiro acesso pendente';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-16c falhou%' THEN RAISE; END IF;
    v_lbl := SQLERRM;
  END;
  IF v_lbl <> 'first-access-password-change-required' THEN
    RAISE EXCEPTION 'T-IM-16c falhou: rótulo % (esperado first-access-password-change-required)', v_lbl;
  END IF;

  SELECT count(*) INTO v_n FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a3';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-16c falhou: % sessão criada com primeiro acesso pendente', v_n;
  END IF;

  RAISE NOTICE 'T-IM-16c ok: first-access-password-change-required, 0 sessao';
END $$;
ROLLBACK;

-- ============ T-IM-12 — end: sela + audita ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_token text; v_ok boolean;
BEGIN
  SELECT s.token INTO v_token
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'acesso de suporte') AS s;
  PERFORM set_config('atlas.tok', v_token, true);
  v_ok := public.end_impersonation(v_token::uuid);
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'T-IM-12 falhou: end devolveu % (esperado true)', v_ok;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE
  v_token text := current_setting('atlas.tok', true);
  v_n int;
  v_row public.impersonation_sessions;
BEGIN
  SELECT * INTO v_row FROM public.impersonation_sessions
  WHERE token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');
  IF v_row.ended_at IS NULL OR v_row.revoked_at IS NULL THEN
    RAISE EXCEPTION 'T-IM-12 falhou: sessão não selada/revogada';
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND reason = 'impersonation_end:stopped_by_operator'
    AND target_id = 'c7200000-0000-4000-8000-0000000000d1'
    AND tenant_id = 'c7200000-0000-4000-8000-0000000000d1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-IM-12 falhou: % trilha stopped_by_operator', v_n;
  END IF;
  RAISE NOTICE 'T-IM-12 ok: end sela+revoga e audita stopped_by_operator';
END $$;
ROLLBACK;

-- ============ T-IM-13 — end idempotente (sem 2ª trilha) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE v_token text; v_ok1 boolean; v_ok2 boolean;
BEGIN
  SELECT s.token INTO v_token
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'acesso de suporte') AS s;
  PERFORM set_config('atlas.tok', v_token, true);
  v_ok1 := public.end_impersonation(v_token::uuid);
  v_ok2 := public.end_impersonation(v_token::uuid);
  IF v_ok1 IS NOT TRUE OR v_ok2 IS NOT FALSE THEN
    RAISE EXCEPTION 'T-IM-13 falhou: end1=% end2=% (esperado true/false)', v_ok1, v_ok2;
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.admin_audit
  WHERE actor_id = 'c7200000-0000-4000-8000-0000000000a1'
    AND reason = 'impersonation_end:stopped_by_operator';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-IM-13 falhou: % trilha de fim (esperado 1)', v_n;
  END IF;
  RAISE NOTICE 'T-IM-13 ok: end idempotente, 1 trilha';
END $$;
ROLLBACK;

-- ============ T-IM-14 — end: token alheio / sem sessão ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
BEGIN
  -- token inexistente/estrangeiro
  BEGIN
    PERFORM public.end_impersonation('c7300000-0000-4000-8000-0000000000e9');
    RAISE EXCEPTION 'T-IM-14 falhou: end aceitou token inexistente';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-14 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'impersonation-session-not-found' THEN
      RAISE EXCEPTION 'T-IM-14 falhou: rótulo %', SQLERRM;
    END IF;
  END;
END $$;
RESET ROLE;
ROLLBACK;

-- T-IM-14b: end sem sessão ⇒ not-authenticated
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.end_impersonation('c7300000-0000-4000-8000-0000000000e9');
    RAISE EXCEPTION 'T-IM-14b falhou: end sem sessão aceitou';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-14b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-authenticated' THEN
      RAISE EXCEPTION 'T-IM-14b falhou: rótulo %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-IM-14 ok: token alheio -> not-found; sem sessão -> not-authenticated';
END $$;
ROLLBACK;

-- ============ T-IM-17 — list: not-admin, clamp, ordem, filtro ============
-- not-admin (usuário comum)
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.admin_list_impersonation_sessions();
    RAISE EXCEPTION 'T-IM-17 falhou: list aceitou usuário comum';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-17 falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' THEN
      RAISE EXCEPTION 'T-IM-17 falhou: rótulo %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-IM-17a ok: not-admin';
END $$;
ROLLBACK;

-- clamp + ordem + filtro (150 sessões encerradas para a5)
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  i int;
  v_got uuid[];
  v_exp uuid[];
  v_n int;
  v_first timestamptz;
BEGIN
  FOR i IN 1..150 LOOP
    INSERT INTO public.impersonation_sessions
      (token_hash, operator_id, tenant_id, reason, started_at, expires_at, ended_at, revoked_at)
    VALUES
      (encode(extensions.digest('list-' || i, 'sha256'), 'hex'),
       'c7200000-0000-4000-8000-0000000000a5',
       'c7200000-0000-4000-8000-0000000000d1',
       'sessao numero ' || i,
       now() - (i || ' seconds')::interval,
       now() - (i || ' seconds')::interval + interval '15 minutes',
       now() - (i || ' seconds')::interval + interval '1 minute',
       now() - (i || ' seconds')::interval + interval '1 minute');
  END LOOP;

  -- clamp 1000 ⇒ 100 (preserva a ordem de saída da função)
  SELECT array_agg(q.id ORDER BY q.rn) INTO v_got
  FROM (
    SELECT x.id, row_number() OVER () AS rn
    FROM public.admin_list_impersonation_sessions(
      'c7200000-0000-4000-8000-0000000000a5', 1000, 0) AS x
  ) AS q;
  IF coalesce(array_length(v_got, 1), 0) <> 100 THEN
    RAISE EXCEPTION 'T-IM-17 falhou: clamp 1000 devolveu % (esperado 100)',
      coalesce(array_length(v_got, 1), 0);
  END IF;

  -- ordem idêntica a started_at DESC, id DESC LIMIT 100
  SELECT array_agg(q.id) INTO v_exp FROM (
    SELECT s.id FROM public.impersonation_sessions AS s
    WHERE s.operator_id = 'c7200000-0000-4000-8000-0000000000a5'
    ORDER BY s.started_at DESC, s.id DESC
    LIMIT 100
  ) AS q;
  IF v_got <> v_exp THEN
    RAISE EXCEPTION 'T-IM-17 falhou: ordem divergente de started_at DESC, id DESC';
  END IF;

  -- clamp 0 ⇒ 1
  SELECT count(*) INTO v_n
  FROM public.admin_list_impersonation_sessions(
    'c7200000-0000-4000-8000-0000000000a5', 0, 0) AS x;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-IM-17 falhou: clamp 0 devolveu % (esperado 1)', v_n;
  END IF;

  -- offset negativo ⇒ 0
  SELECT count(*) INTO v_n
  FROM public.admin_list_impersonation_sessions(
    'c7200000-0000-4000-8000-0000000000a5', 5, -10) AS x;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'T-IM-17 falhou: offset negativo devolveu % (esperado 5)', v_n;
  END IF;

  -- filtro por operador
  SELECT count(*) INTO v_n
  FROM public.admin_list_impersonation_sessions(
    'c7200000-0000-4000-8000-0000000000a5', 100, 0) AS x
  WHERE x.operator_id <> 'c7200000-0000-4000-8000-0000000000a5';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'T-IM-17 falhou: filtro por operador vazou % linhas', v_n;
  END IF;

  RAISE NOTICE 'T-IM-17 ok: not-admin, clamp 1000=>100 / 0=>1, offset<0=>0, ordem started_at DESC id DESC, filtro por operador';
END $$;
ROLLBACK;

-- ============ T-IM-18 — superfície: DML ⊆ {admin_audit, impersonation_sessions}; sem GUC; sem RPC de escrita ============
DO $$
DECLARE
  v_pks text;
  v_pk_list text[] := ARRAY[
    'public.start_impersonation(uuid,text)',
    'public.end_impersonation(uuid)',
    'private.impersonation_gate(uuid,uuid)',
    'public.admin_list_impersonation_sessions(uuid,int,int)',
    'public.admin_sweep_impersonation_sessions(int)',
    'public.impersonation_read(uuid,uuid,text,jsonb)'
  ];
  v_pk regprocedure;
  v_def text;
  v_clean text;
  v_target text;
  v_arr text[];
BEGIN
  FOREACH v_pks IN ARRAY v_pk_list LOOP
    v_pk := v_pks::regprocedure;
    SELECT prosrc INTO v_def FROM pg_proc WHERE oid = v_pk;

    -- nenhum GUC
    IF v_def ILIKE '%set_config%' OR v_def ILIKE '%current_setting%' THEN
      RAISE EXCEPTION 'T-IM-18 falhou: % usa GUC', v_pks;
    END IF;

    -- nenhuma RPC de escrita
    IF v_def ~* '(admin_override_subscription|admin_set_tenant_status|switch_tenant|pay_invoice)' THEN
      RAISE EXCEPTION 'T-IM-18 falhou: % chama RPC de escrita', v_pks;
    END IF;

    -- remove comentários de linha antes de procurar DML
    v_clean := regexp_replace(v_def, '--[^\n]*', '', 'g');

    FOR v_arr IN
      SELECT regexp_matches(v_clean,
        '(?i)(?:insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+([a-z_]+[.][a-z_]+)',
        'g')
    LOOP
      v_target := v_arr[1];
      IF v_target NOT IN ('public.admin_audit', 'public.impersonation_sessions') THEN
        RAISE EXCEPTION 'T-IM-18 falhou: % escreve em %', v_pks, v_target;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'T-IM-18 ok: DML so em admin_audit/impersonation_sessions; sem GUC; sem RPC de escrita';
END $$;

-- ============ T-IM-22(a) — objetos presentes / assinatura única ============
DO $$
DECLARE
  v_pks text;
  v_pk_list text[] := ARRAY[
    'public.start_impersonation(uuid,text)',
    'public.end_impersonation(uuid)',
    'private.impersonation_gate(uuid,uuid)',
    'public.admin_list_impersonation_sessions(uuid,int,int)',
    'public.admin_sweep_impersonation_sessions(int)',
    'public.impersonation_read(uuid,uuid,text,jsonb)'
  ];
  v_pk regprocedure;
  v_n int;
BEGIN
  IF to_regclass('public.impersonation_sessions') IS NULL THEN
    RAISE EXCEPTION 'T-IM-22 falhou: tabela ausente';
  END IF;
  FOREACH v_pks IN ARRAY v_pk_list LOOP
    v_pk := v_pks::regprocedure;
    SELECT count(*) INTO v_n FROM pg_proc WHERE oid = v_pk;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'T-IM-22 falhou: % com % assinatura(s)', v_pks, v_n;
    END IF;
  END LOOP;
  RAISE NOTICE 'T-IM-22(a) ok: tabela + 6 funcoes com assinatura unica (idempotencia 2x provada no harness)';
END $$;

-- ============ T-IM-23 — sweep assíncrono de sessões expiradas (REQ-48) ============
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_n int;
  v_sealed int;
  v_ended timestamptz;
  v_valid_token uuid := 'c7300000-0000-4000-8000-0000000000e4';
  v_audit_antes int;
  v_audit_depois int;
  v_drain int;
  i int;
BEGIN
  -- Drena expiradas RESIDUAIS de outros cenários (bounded) para que as
  -- contagens abaixo sejam determinísticas e independentes do banco global.
  FOR i IN 1..20 LOOP
    v_drain := public.admin_sweep_impersonation_sessions(500);
    EXIT WHEN v_drain = 0;
  END LOOP;

  -- Baseline da trilha do FIXTURE (tenants d1/d2), depois do dreno.
  SELECT count(*) INTO v_audit_antes FROM public.admin_audit
  WHERE reason = 'impersonation_end:expired'
    AND tenant_id IN ('c7200000-0000-4000-8000-0000000000d1',
                      'c7200000-0000-4000-8000-0000000000d2');

  -- 2 expiradas (operadores distintos) + 1 válida.
  INSERT INTO public.impersonation_sessions
    (token_hash, operator_id, tenant_id, reason, started_at, expires_at)
  VALUES
    (encode(extensions.digest('c7300000-0000-4000-8000-0000000000e5', 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a1', 'c7200000-0000-4000-8000-0000000000d1',
     'expirada um', now() - interval '20 minutes', now() - interval '5 minutes'),
    (encode(extensions.digest('c7300000-0000-4000-8000-0000000000e6', 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a5', 'c7200000-0000-4000-8000-0000000000d2',
     'expirada dois', now() - interval '20 minutes', now() - interval '5 minutes'),
    (encode(extensions.digest(v_valid_token::text, 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a3', 'c7200000-0000-4000-8000-0000000000d1',
     'sessao valida sweep', now(), now() + interval '15 minutes');

  v_sealed := public.admin_sweep_impersonation_sessions(100);
  IF v_sealed <> 2 THEN
    RAISE EXCEPTION 'T-IM-23 falhou: sweep selou % (esperado 2)', v_sealed;
  END IF;

  -- Delta da trilha do fixture = 2 (não valor global).
  SELECT count(*) INTO v_audit_depois FROM public.admin_audit
  WHERE reason = 'impersonation_end:expired'
    AND tenant_id IN ('c7200000-0000-4000-8000-0000000000d1',
                      'c7200000-0000-4000-8000-0000000000d2');
  IF v_audit_depois - v_audit_antes <> 2 THEN
    RAISE EXCEPTION 'T-IM-23 falhou: delta de trilha do fixture = % (esperado 2)',
      v_audit_depois - v_audit_antes;
  END IF;

  -- válida intacta
  SELECT ended_at INTO v_ended FROM public.impersonation_sessions
  WHERE token_hash = encode(extensions.digest(v_valid_token::text, 'sha256'), 'hex');
  IF v_ended IS NOT NULL THEN
    RAISE EXCEPTION 'T-IM-23 falhou: sweep selou a sessão válida';
  END IF;

  -- idempotente: 2ª execução ⇒ 0
  v_sealed := public.admin_sweep_impersonation_sessions(100);
  IF v_sealed <> 0 THEN
    RAISE EXCEPTION 'T-IM-23 falhou: 2ª execução selou % (esperado 0)', v_sealed;
  END IF;

  -- clamp 0 ⇒ 1
  INSERT INTO public.impersonation_sessions
    (token_hash, operator_id, tenant_id, reason, started_at, expires_at)
  VALUES
    (encode(extensions.digest('c7300000-0000-4000-8000-0000000000e7', 'sha256'), 'hex'),
     'c7200000-0000-4000-8000-0000000000a2', 'c7200000-0000-4000-8000-0000000000d1',
     'expirada clamp zero', now() - interval '20 minutes', now() - interval '5 minutes');
  v_sealed := public.admin_sweep_impersonation_sessions(0);
  IF v_sealed <> 1 THEN
    RAISE EXCEPTION 'T-IM-23 falhou: clamp 0 selou % (esperado 1)', v_sealed;
  END IF;

  -- clamp 9999 ⇒ 500: 501 expiradas (operadores distintos; sem conflito no índice parcial)
  FOR i IN 1..501 LOOP
    INSERT INTO public.impersonation_sessions
      (token_hash, operator_id, tenant_id, reason, started_at, expires_at)
    VALUES
      (encode(extensions.digest('sweep-' || i, 'sha256'), 'hex'),
       gen_random_uuid(), 'c7200000-0000-4000-8000-0000000000d1',
       'sweep em massa ' || i, now() - interval '20 minutes', now() - interval '5 minutes');
  END LOOP;

  v_sealed := public.admin_sweep_impersonation_sessions(9999);
  IF v_sealed <> 500 THEN
    RAISE EXCEPTION 'T-IM-23 falhou: clamp 9999 selou % (esperado 500)', v_sealed;
  END IF;
  v_sealed := public.admin_sweep_impersonation_sessions(9999);
  IF v_sealed <> 1 THEN
    RAISE EXCEPTION 'T-IM-23 falhou: resto selou % (esperado 1)', v_sealed;
  END IF;
  v_sealed := public.admin_sweep_impersonation_sessions(9999);
  IF v_sealed <> 0 THEN
    RAISE EXCEPTION 'T-IM-23 falhou: 3ª execução selou % (esperado 0)', v_sealed;
  END IF;

  RAISE NOTICE 'T-IM-23 ok: sweep drena residuais; sela 2 do fixture (delta trilha=2) + 1/sessao; 2a=0; clamp 0=>1 e 9999=>500; valida intacta';
END $$;
ROLLBACK;

-- T-IM-23b: sweep sem is_super_admin ⇒ not-admin
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.admin_sweep_impersonation_sessions();
    RAISE EXCEPTION 'T-IM-23b falhou: sweep aceitou usuário comum';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'T-IM-23b falhou%' THEN RAISE; END IF;
    IF SQLERRM <> 'not-admin' THEN
      RAISE EXCEPTION 'T-IM-23b falhou: rótulo %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'T-IM-23b ok: sweep not-admin';
END $$;
ROLLBACK;

-- ============ 0074 — impersonation_read (BE-73/74/75) ============

-- T-IM-19 — envelope de 4 chaves, projeções por escopo, reads, redação (O-F7-4)
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok text;
  v_r jsonb;
  v_keys text[];
  v_n int;
  v_reads0 bigint;
  v_reads1 bigint;
  v_item jsonb;
BEGIN
  SELECT s.token INTO v_tok
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'leitura de suporte') AS s;

  -- tenant: envelope 4 chaves + data 7 chaves exatas + sem document + reads +1
  SELECT reads INTO v_reads0 FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1' AND ended_at IS NULL;

  v_r := public.impersonation_read(v_tok::uuid,
           'c7200000-0000-4000-8000-0000000000d1', 'tenant', '{}');

  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_r) AS k;
  IF v_keys IS DISTINCT FROM ARRAY['data','expires_at','scope','tenant']::text[] THEN
    RAISE EXCEPTION 'T-IM-19a falhou: envelope com chaves %', v_keys;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_r->'data') AS k;
  IF v_keys IS DISTINCT FROM
     ARRAY['created_at','id','kind','nome_fantasia','plan_id','razao_social','subscription_status']::text[] THEN
    RAISE EXCEPTION 'T-IM-19a falhou: data do tenant com chaves %', v_keys;
  END IF;
  IF v_r->'data' ? 'document' THEN
    RAISE EXCEPTION 'T-IM-19a falhou: document vazou';
  END IF;

  SELECT reads INTO v_reads1 FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1' AND ended_at IS NULL;
  IF v_reads1 - v_reads0 <> 1 THEN
    RAISE EXCEPTION 'T-IM-19a falhou: reads % -> %', v_reads0, v_reads1;
  END IF;
  IF (SELECT last_read_at FROM public.impersonation_sessions
      WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1' AND ended_at IS NULL) IS NULL THEN
    RAISE EXCEPTION 'T-IM-19a falhou: last_read_at nulo';
  END IF;

  -- billing: sem as 4 chaves psp_*; amount_cents preservado; usage null
  v_r := public.impersonation_read(v_tok::uuid,
           'c7200000-0000-4000-8000-0000000000d1', 'billing', '{}');
  IF (v_r->'data'->'subscription') ? 'psp_subscription_id'
     OR (v_r->'data'->'subscription') ? 'psp_customer_id' THEN
    RAISE EXCEPTION 'T-IM-19b falhou: psp_* no subscription';
  END IF;
  IF jsonb_typeof(v_r->'data'->'invoices'->'items') <> 'array'
     OR jsonb_array_length(v_r->'data'->'invoices'->'items') < 1 THEN
    RAISE EXCEPTION 'T-IM-19b falhou: invoices.items vazio/ausente';
  END IF;
  v_item := v_r->'data'->'invoices'->'items'->0;
  IF jsonb_typeof(v_item) <> 'object' THEN
    RAISE EXCEPTION 'T-IM-19b falhou: item de fatura nao e objeto (%)',
      jsonb_typeof(v_item);
  END IF;
  IF v_item ? 'psp_invoice_id' OR v_item ? 'psp_payment_id' THEN
    RAISE EXCEPTION 'T-IM-19b falhou: psp_* no item de fatura';
  END IF;
  IF NOT (v_item ? 'amount_cents') THEN
    RAISE EXCEPTION 'T-IM-19b falhou: amount_cents ausente';
  END IF;
  IF NOT ((v_r->'data') ? 'usage') THEN
    RAISE EXCEPTION 'T-IM-19b falhou: usage ausente';
  END IF;
  IF jsonb_typeof(v_r->'data'->'usage') <> 'null' THEN
    RAISE EXCEPTION 'T-IM-19b falhou: usage deveria ser null (%)',
      jsonb_typeof(v_r->'data'->'usage');
  END IF;

  -- usage: 5 linhas fixas
  v_r := public.impersonation_read(v_tok::uuid,
           'c7200000-0000-4000-8000-0000000000d1', 'usage', '{}');
  IF jsonb_array_length(v_r->'data'->'rows') <> 5 THEN
    RAISE EXCEPTION 'T-IM-19c falhou: % linhas de usage',
      jsonb_array_length(v_r->'data'->'rows');
  END IF;

  -- members: total > limit; ordem created_at ASC (b1, b2)
  v_r := public.impersonation_read(v_tok::uuid,
           'c7200000-0000-4000-8000-0000000000d1', 'members', '{"p_limit":2}');
  IF (v_r->'data'->>'total')::int <> 5 THEN
    RAISE EXCEPTION 'T-IM-17/19d falhou: total=% (esperado 5)', v_r->'data'->>'total';
  END IF;
  IF jsonb_array_length(v_r->'data'->'items') <> 2 THEN
    RAISE EXCEPTION 'T-IM-17/19d falhou: % itens (esperado 2)',
      jsonb_array_length(v_r->'data'->'items');
  END IF;
  IF (v_r->'data'->'items'->0->>'user_id') <> 'c7200000-0000-4000-8000-0000000000b1'
     OR (v_r->'data'->'items'->1->>'user_id') <> 'c7200000-0000-4000-8000-0000000000b2' THEN
    RAISE EXCEPTION 'T-IM-17/19d falhou: ordem de members incorreta';
  END IF;

  -- audit: total pelo predicado; PII redigida (ausência dos literais) + forma preservada
  v_r := public.impersonation_read(v_tok::uuid,
           'c7200000-0000-4000-8000-0000000000d1', 'audit', '{"p_limit":50}');
  SELECT count(*) INTO v_n FROM public.admin_audit AS a
  WHERE (a.tenant_id = 'c7200000-0000-4000-8000-0000000000d1'
         OR a.target_id = 'c7200000-0000-4000-8000-0000000000d1');
  IF (v_r->'data'->>'total')::int <> v_n THEN
    RAISE EXCEPTION 'T-IM-19e falhou: total=% (direto=%)', v_r->'data'->>'total', v_n;
  END IF;

  -- forma preservada: cada linha vira '<prefixo> *** fim'
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'data'->'items') AS e
                 WHERE e->>'reason' = 'cpf *** fim') THEN
    RAISE EXCEPTION 'T-IM-19e falhou: CPF formatado nao redigido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'data'->'items') AS e
                 WHERE e->>'reason' = 'cnpj *** fim') THEN
    RAISE EXCEPTION 'T-IM-19e falhou: CNPJ formatado nao redigido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'data'->'items') AS e
                 WHERE e->>'reason' = 'cartao *** fim') THEN
    RAISE EXCEPTION 'T-IM-19e falhou: corrida de 16 nao redigida inteira';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_r->'data'->'items') AS e
      WHERE e->>'reason' = 'corrida *** fim') <> 2 THEN
    RAISE EXCEPTION 'T-IM-19e falhou: corridas de 15/20 nao redigidas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'data'->'items') AS e
                 WHERE e->>'reason' = 'email *** fim') THEN
    RAISE EXCEPTION 'T-IM-19e falhou: e-mail normal nao redigido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'data'->'items') AS e
                 WHERE e->>'reason' = 'local *** fim') THEN
    RAISE EXCEPTION 'T-IM-19e falhou: foo@localhost nao redigido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'data'->'items') AS e
                 WHERE e->>'reason' = 'tag *** fim') THEN
    RAISE EXCEPTION 'T-IM-19e falhou: e-mail com +tag nao redigido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'data'->'items') AS e
                 WHERE e->>'reason' = 'doc *** fim') THEN
    RAISE EXCEPTION 'T-IM-19e falhou: corrida de 11 nao redigida';
  END IF;

  -- telefone permanece (residual declarado, não é escopo)
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'data'->'items') AS e
                 WHERE e->>'reason' = 'telefone (11) 98765-4321 fim') THEN
    RAISE EXCEPTION 'T-IM-19e falhou: telefone deveria permanecer';
  END IF;

  -- ausência dos literais (prova forte): formatado E trecho, corrida inteira
  IF v_r::text LIKE '%123.456.789-01%' OR v_r::text LIKE '%45678901%' THEN
    RAISE EXCEPTION 'T-IM-19e falhou: CPF (formatado/trecho) vazou';
  END IF;
  IF v_r::text LIKE '%12.345.678/0001-90%' OR v_r::text LIKE '%000190%' THEN
    RAISE EXCEPTION 'T-IM-19e falhou: CNPJ (formatado/trecho) vazou';
  END IF;
  IF v_r::text LIKE '%4111111111111111%' THEN
    RAISE EXCEPTION 'T-IM-19e falhou: corrida de 16 vazou';
  END IF;
  IF v_r::text LIKE '%12345678901234567890%' THEN
    RAISE EXCEPTION 'T-IM-19e falhou: corrida de 20 vazou';
  END IF;
  IF v_r::text LIKE '%123456789012345%' THEN
    RAISE EXCEPTION 'T-IM-19e falhou: corrida de 15 vazou';
  END IF;
  IF v_r::text LIKE '%foo@example.com%' OR v_r::text LIKE '%foo@localhost%'
     OR v_r::text LIKE '%joao.silva+tag@example.com%' THEN
    RAISE EXCEPTION 'T-IM-19e falhou: e-mail vazou';
  END IF;

  RAISE NOTICE 'T-IM-19 ok: tenant 7 chaves; billing sem psp_*; usage 5; members total>limit; audit redigido; reads +1';
END $$;
ROLLBACK;

-- T-IM-10 — enum fechado (5 valores fora, inclusive NULL) ⇒ impersonation-read-only
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok text;
  v_lbl text;
  v_scope text;
  v_reads0 bigint;
  v_reads1 bigint;
  v_n0 int;
  v_n1 int;
BEGIN
  SELECT s.token INTO v_tok
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'leitura de suporte') AS s;
  SELECT reads INTO v_reads0 FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1' AND ended_at IS NULL;
  SELECT count(*) INTO v_n0 FROM public.admin_audit
  WHERE reason = 'internal_admin_read'
    AND target_id = 'c7200000-0000-4000-8000-0000000000d1';

  FOREACH v_scope IN ARRAY ARRAY['write','override','end','Tenant',NULL]::text[] LOOP
    v_lbl := NULL;
    BEGIN
      PERFORM public.impersonation_read(v_tok::uuid,
        'c7200000-0000-4000-8000-0000000000d1', v_scope, '{}');
      RAISE EXCEPTION 'T-IM-10 falhou: aceitou escopo %', v_scope;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'T-IM-10 falhou%' THEN RAISE; END IF;
      v_lbl := SQLERRM;
    END;
    IF v_lbl <> 'impersonation-read-only' THEN
      RAISE EXCEPTION 'T-IM-10 falhou: escopo % deu %', v_scope, v_lbl;
    END IF;
  END LOOP;

  SELECT reads INTO v_reads1 FROM public.impersonation_sessions
  WHERE operator_id = 'c7200000-0000-4000-8000-0000000000a1' AND ended_at IS NULL;
  IF v_reads1 <> v_reads0 THEN
    RAISE EXCEPTION 'T-IM-10 falhou: reads mudou em falha (% -> %)', v_reads0, v_reads1;
  END IF;
  SELECT count(*) INTO v_n1 FROM public.admin_audit
  WHERE reason = 'internal_admin_read'
    AND target_id = 'c7200000-0000-4000-8000-0000000000d1';
  IF v_n1 <> v_n0 THEN
    RAISE EXCEPTION 'T-IM-10 falhou: delegou em escopo invalido (% -> %)', v_n0, v_n1;
  END IF;

  RAISE NOTICE 'T-IM-10 ok: 5 valores fora do enum -> impersonation-read-only, 0 leitura, reads inalterado';
END $$;
ROLLBACK;

-- T-IM-24 — ausência de token_hash/token/hash em TODOS os escopos
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok text;
  v_hash text;
  v_r jsonb;
  v_scope text;
BEGIN
  SELECT s.token INTO v_tok
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'leitura de suporte') AS s;
  v_hash := encode(extensions.digest(v_tok, 'sha256'), 'hex');

  FOREACH v_scope IN ARRAY ARRAY['tenant','billing','usage','members','audit']::text[] LOOP
    v_r := public.impersonation_read(v_tok::uuid,
      'c7200000-0000-4000-8000-0000000000d1', v_scope, '{}');
    IF v_r::text LIKE '%token_hash%' THEN
      RAISE EXCEPTION 'T-IM-24 falhou: token_hash no envelope de %', v_scope;
    END IF;
    IF v_r::text LIKE '%' || v_tok || '%' THEN
      RAISE EXCEPTION 'T-IM-24 falhou: token cru no envelope de %', v_scope;
    END IF;
    IF v_r::text LIKE '%' || v_hash || '%' THEN
      RAISE EXCEPTION 'T-IM-24 falhou: hash do token no envelope de %', v_scope;
    END IF;
    IF v_r->'data' ? 'token_hash' THEN
      RAISE EXCEPTION 'T-IM-24 falhou: chave token_hash em %', v_scope;
    END IF;
  END LOOP;

  RAISE NOTICE 'T-IM-24 ok: 5 escopos sem token_hash/token/hash';
END $$;
ROLLBACK;

-- T-IM-20 — rótulos literais, sem UUID/e-mail/11–14 dígitos
BEGIN;
DO $$
DECLARE
  v_tok text;
  v_lbl text;
  v_labels text[] := ARRAY[]::text[];
BEGIN
  -- not-authenticated
  PERFORM set_config('request.jwt.claims', '', true);
  v_lbl := NULL;
  BEGIN
    PERFORM public.impersonation_read(gen_random_uuid(),
      'c7200000-0000-4000-8000-0000000000d1', 'tenant', '{}');
  EXCEPTION WHEN OTHERS THEN v_lbl := SQLERRM; END;
  v_labels := v_labels || v_lbl;

  -- not-admin (a4)
  PERFORM set_config('request.jwt.claims',
    '{"sub":"c7200000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}', true);
  v_lbl := NULL;
  BEGIN
    PERFORM public.impersonation_read(gen_random_uuid(),
      'c7200000-0000-4000-8000-0000000000d1', 'tenant', '{}');
  EXCEPTION WHEN OTHERS THEN v_lbl := SQLERRM; END;
  v_labels := v_labels || v_lbl;

  -- session-not-found (a1, token inexistente)
  PERFORM set_config('request.jwt.claims',
    '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
  v_lbl := NULL;
  BEGIN
    PERFORM public.impersonation_read(gen_random_uuid(),
      'c7200000-0000-4000-8000-0000000000d1', 'tenant', '{}');
  EXCEPTION WHEN OTHERS THEN v_lbl := SQLERRM; END;
  v_labels := v_labels || v_lbl;

  -- sessão válida para os próximos casos
  SELECT s.token INTO v_tok
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'leitura de suporte') AS s;

  -- tenant-mismatch (p_tenant != sessão)
  v_lbl := NULL;
  BEGIN
    PERFORM public.impersonation_read(v_tok::uuid,
      'c7200000-0000-4000-8000-0000000000d2', 'tenant', '{}');
  EXCEPTION WHEN OTHERS THEN v_lbl := SQLERRM; END;
  v_labels := v_labels || v_lbl;

  -- read-only
  v_lbl := NULL;
  BEGIN
    PERFORM public.impersonation_read(v_tok::uuid,
      'c7200000-0000-4000-8000-0000000000d1', 'write', '{}');
  EXCEPTION WHEN OTHERS THEN v_lbl := SQLERRM; END;
  v_labels := v_labels || v_lbl;

  -- audit action inválido (herdado do delegado)
  v_lbl := NULL;
  BEGIN
    PERFORM public.impersonation_read(v_tok::uuid,
      'c7200000-0000-4000-8000-0000000000d1', 'audit', '{"p_action":"bogus"}');
  EXCEPTION WHEN OTHERS THEN v_lbl := SQLERRM; END;
  v_labels := v_labels || v_lbl;

  IF v_labels[1] <> 'not-authenticated' THEN RAISE EXCEPTION 'T-IM-20 falhou: %', v_labels[1]; END IF;
  IF v_labels[2] <> 'not-admin' THEN RAISE EXCEPTION 'T-IM-20 falhou: %', v_labels[2]; END IF;
  IF v_labels[3] <> 'impersonation-session-not-found' THEN RAISE EXCEPTION 'T-IM-20 falhou: %', v_labels[3]; END IF;
  IF v_labels[4] <> 'impersonation-tenant-mismatch' THEN RAISE EXCEPTION 'T-IM-20 falhou: %', v_labels[4]; END IF;
  IF v_labels[5] <> 'impersonation-read-only' THEN RAISE EXCEPTION 'T-IM-20 falhou: %', v_labels[5]; END IF;
  IF v_labels[6] <> 'tenant-audit-action-invalid' THEN RAISE EXCEPTION 'T-IM-20 falhou: %', v_labels[6]; END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_labels) AS l
             WHERE l ~ '[0-9a-f]{8}-' OR l LIKE '%@%' OR l ~ '[0-9]{11,14}') THEN
    RAISE EXCEPTION 'T-IM-20 falhou: rotulo com PII (%)', v_labels;
  END IF;

  RAISE NOTICE 'T-IM-20 ok: 6 rotulos literais, sem UUID/email/digitos';
END $$;
ROLLBACK;

-- T-IM-22(b) — impersonation_read: 1 assinatura, DEFINER, search_path, EXECUTE só authenticated
DO $$
DECLARE
  v_pk regprocedure := 'public.impersonation_read(uuid,uuid,text,jsonb)'::regprocedure;
  v_n int;
  v_cfg text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc WHERE oid = v_pk;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'T-IM-22b falhou: % assinatura(s)', v_n;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_pk) THEN
    RAISE EXCEPTION 'T-IM-22b falhou: nao DEFINER';
  END IF;
  SELECT array_to_string(proconfig, ',') INTO v_cfg FROM pg_proc WHERE oid = v_pk;
  IF v_cfg IS NULL OR v_cfg NOT LIKE '%search_path=%' THEN
    RAISE EXCEPTION 'T-IM-22b falhou: sem search_path no proconfig (%)', v_cfg;
  END IF;
  IF has_function_privilege('anon', v_pk, 'EXECUTE')
     OR has_function_privilege('service_role', v_pk, 'EXECUTE') THEN
    RAISE EXCEPTION 'T-IM-22b falhou: EXECUTE indevido';
  END IF;
  IF NOT has_function_privilege('authenticated', v_pk, 'EXECUTE') THEN
    RAISE EXCEPTION 'T-IM-22b falhou: authenticated sem EXECUTE';
  END IF;
  RAISE NOTICE 'T-IM-22(b) ok: 1 assinatura, DEFINER, search_path=, EXECUTE so authenticated (idempotencia 2x no harness)';
END $$;

-- T-IM-25 — p_limit/p_offset: default 20 vs clamp 100 distintos, sem erro cru de int
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"c7200000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
DO $$
DECLARE
  v_tok text;
  v_r jsonb;
  i int;
BEGIN
  -- 150 linhas de auditoria de d1 para distinguir default (20) de clamp (100).
  FOR i IN 1..150 LOOP
    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason, at)
    VALUES (NULL,
            'c7200000-0000-4000-8000-0000000000d1',
            'c7200000-0000-4000-8000-0000000000d1',
            'other', 'linha t-im-25 ' || i,
            now() - (i || ' seconds')::interval);
  END LOOP;

  SELECT s.token INTO v_tok
  FROM public.start_impersonation('c7200000-0000-4000-8000-0000000000d1',
                                  'leitura de suporte') AS s;

  -- p_limit gigante NÃO numérico (20 dígitos) ⇒ default 20 (não 100).
  v_r := public.impersonation_read(v_tok::uuid,
    'c7200000-0000-4000-8000-0000000000d1', 'audit',
    '{"p_limit":"99999999999999999999","p_offset":"99999999999999999999"}');
  IF jsonb_array_length(v_r->'data'->'items') <> 20 THEN
    RAISE EXCEPTION 'T-IM-25 falhou: default = % (esperado 20)',
      jsonb_array_length(v_r->'data'->'items');
  END IF;

  -- p_limit 1000 (numérico) ⇒ clamp 100 (distinto do default).
  v_r := public.impersonation_read(v_tok::uuid,
    'c7200000-0000-4000-8000-0000000000d1', 'audit', '{"p_limit":1000}');
  IF jsonb_array_length(v_r->'data'->'items') <> 100 THEN
    RAISE EXCEPTION 'T-IM-25 falhou: clamp 1000 = % (esperado 100)',
      jsonb_array_length(v_r->'data'->'items');
  END IF;

  -- p_limit 0 ⇒ clamp 1.
  v_r := public.impersonation_read(v_tok::uuid,
    'c7200000-0000-4000-8000-0000000000d1', 'audit', '{"p_limit":0}');
  IF jsonb_array_length(v_r->'data'->'items') <> 1 THEN
    RAISE EXCEPTION 'T-IM-25 falhou: clamp 0 = % (esperado 1)',
      jsonb_array_length(v_r->'data'->'items');
  END IF;

  RAISE NOTICE 'T-IM-25 ok: gigante => default 20; 1000 => clamp 100; 0 => clamp 1';
END $$;
ROLLBACK;

-- ============ Cleanup de fixtures (fim) ============
BEGIN;
DELETE FROM public.impersonation_sessions
WHERE operator_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5'
);

DELETE FROM public.admin_audit
WHERE actor_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5'
)
OR target_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5',
  'c7200000-0000-4000-8000-0000000000b1',
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.tenant_members
WHERE user_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5'
)
OR tenant_id IN (
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.tenant_invoices
WHERE tenant_id IN (
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.tenants
WHERE id IN (
  'c7200000-0000-4000-8000-0000000000d1',
  'c7200000-0000-4000-8000-0000000000d2',
  'c7200000-0000-4000-8000-0000000000d3'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5'
);

DELETE FROM auth.users
WHERE id IN (
  'c7200000-0000-4000-8000-0000000000a1',
  'c7200000-0000-4000-8000-0000000000a2',
  'c7200000-0000-4000-8000-0000000000a3',
  'c7200000-0000-4000-8000-0000000000a4',
  'c7200000-0000-4000-8000-0000000000a5',
  'c7200000-0000-4000-8000-0000000000b1',
  'c7200000-0000-4000-8000-0000000000b2',
  'c7200000-0000-4000-8000-0000000000b3',
  'c7200000-0000-4000-8000-0000000000b4',
  'c7200000-0000-4000-8000-0000000000b5'
);
COMMIT;

\echo '0072-0074 impersonation: T-IM-00(a),01..09,10,11..16,17,18,19,20,21,22(a,b),23,24,25 OK'
