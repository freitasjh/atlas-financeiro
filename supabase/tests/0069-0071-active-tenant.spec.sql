-- 0069-0071-active-tenant.spec.sql — internal-control-plane / F4 / ADR-004 (BE-43, BE-44).
-- Uso: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0069-0071-active-tenant.spec.sql
-- (DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres)
--
-- Prova em banco real (mock não avalia SECURITY DEFINER, search_path, RLS,
-- claims, FK, trigger nem transação):
--   T00 estrutura (0069+0070): `user_active_tenants` (PK user_id, FKs
--       CASCADE), `tenant_switches` (append-only, ZERO FK), RLS habilitada
--       SEM policy nas duas, REVOKE de tabela para os 4 papéis, 2 índices;
--       5 assinaturas (switch_tenant/list_my_tenants/admin_list_tenant_switches
--       + as 2 resoluções), DEFINER, search_path vazio, proacl sem
--       PUBLIC/anon/service_role, `resolve_*` com o pin no prosrc e SEM
--       EXECUTE para client; 0072-0074 ausentes (F5 entregou 0065–0068;
--       F6 entregou 0075–0076).
--   T-sw-01 `switch_tenant` sem sessão ⇒ `not-authenticated`, 0 escrita.
--   T-sw-02 sem membership (tenant alheio E uuid inexistente) ⇒
--       `tenant-not-member` — mensagem fixa, sem id.
--   T-sw-03 trocar para o tenant JÁ ativo ⇒ no-op, nenhuma linha de trilha,
--       `switched_at` intacto.
--   T-sw-04 troca grava pin E 1 linha em `tenant_switches` na MESMA transação
--       (from NULL na primeira, from = anterior na segunda).
--   T-sw-05 alvo `canceled` ⇒ `subscription-canceled-readonly`, 0 pin.
--   T-sw-06 `list_my_tenants`: só memberships, `is_active` = resolução, nome
--       COALESCE(nome_fantasia, razao_social), sem documento/PII, ordem
--       determinística; acompanha o pin.
--   T-sw-07 `admin_list_tenant_switches`: gate `not-admin` sem operador;
--       clamp 1..100 (p_limit 0/negativo ⇒ 1, 1000 ⇒ 100); filtro from|to;
--       ordem `switched_at DESC, id DESC`.
--   T-pin-01 `resolve_user_tenant` honra o pin.
--   T-pin-02 pin órfão (sem membership) é ignorado ⇒ fallback determinístico.
--   T-pin-03 `resolve_writable_tenant` honra o pin GRAVÁVEL.
--   T-pin-04 janela O-F4-3: pin cujo tenant virou `canceled` ⇒ leitura mantém
--       o pin, escrita cai no fallback gravável.
--   T-pin-05 sem pin ⇒ resultado IDÊNTICO a 0054/0061 (3 memberships, empate
--       de `created_at`) — contraprova do re-point de 0061 T00.
--   T-pin-06 as duas resoluções: 1 assinatura cada, STABLE, DEFINER,
--       search_path vazio, sujeito = parâmetro (sem `auth.uid()`), sem GRANT,
--       pin presente no `prosrc`.
--   T-usage-01 REQ-46: pin ativo muda LEITURA e ESCRITA juntas —
--       `get_tenant_usage(NULL)` segue o pin e o `INSERT` cai no MESMO tenant;
--       trocar o pin move os dois.
--   T-usage-02 sem pin: `get_tenant_usage(NULL)` = baseline de 0061/0064
--       (mesma contagem e mesmo tenant do gate).
--   T-read-01 (0071) `admin_usage_series(date,date,uuid)` e
--       `admin_mrr_summary(date)`: 1 assinatura cada, STABLE, DEFINER,
--       search_path vazio, retorno exato, EXECUTE só `authenticated`,
--       sem float/double/numeric.
--   T-read-02 default = 12 competências SP (mês corrente e 11 anteriores);
--       `count(*)` de `usage_events` por tenant/competência; range explícito
--       sobrepõe o default; ordem determinística.
--   T-read-03 `usage-range-invalid` para `p_to < p_from` e janela > 24 meses;
--       janela de exatamente 24 meses passa.
--   T-read-04 gate `not-admin` sem operador nas DUAS RPCs.
--   T-read-05 `admin_mrr_summary` devolve jsonb com as 6 chaves congeladas e
--       os tipos exatos (cents em inteiro); `p_competencia` normalizada ao dia 1.
--   T-read-06 prova do MRR (decisão de produto O-F4-5, 2026-11-19): base
--       zerada na transação; 2 `active` (free + pro) + 1 `past_due` + 1 `trial`
--       + 1 fatura `overdue` ⇒ `mrr_cents` = preço SÓ do `pro` ativo,
--       `active_count=2`, `past_due_count=1`, `overdue_cents`/`overdue_count`
--       = a fatura vencida. `past_due`/`trial` ficam FORA do MRR.
--   T-read-07 base vazia ⇒ `mrr_cents=0`, contadores 0 e `[]` na série.
--   T-par-01 matriz de paridade 16 casos (`must_change_password × role × aal ×
--       operator.active`) — a MESMA tabela de expectativa de
--       `supabase/functions/verify-operator/index_test.ts` (BE-46b).
--
-- Erros por rótulo fixo, sem PII/id. Rerunnable: fixtures (c69*/c70*/c71*)
-- apagadas no início e no fim; cenários mutáveis vivem em transação com
-- ROLLBACK.

\set ON_ERROR_STOP on

-- ============ Fixtures cleanup (início; postgres bypass RLS) ============
BEGIN;
SET LOCAL app.card_purge = 'on';

DELETE FROM public.user_active_tenants
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);

DELETE FROM public.tenant_switches
WHERE actor_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
)
OR from_tenant_id IN (
  'c6900000-0000-4000-8000-0000000000d1',
  'c6900000-0000-4000-8000-0000000000d2',
  'c6900000-0000-4000-8000-0000000000d3',
  'c7000000-0000-4000-8000-0000000000d4',
  'c7000000-0000-4000-8000-0000000000d5',
  'c7000000-0000-4000-8000-0000000000d6',
  'c7000000-0000-4000-8000-0000000000d7'
)
OR to_tenant_id IN (
  'c6900000-0000-4000-8000-0000000000d1',
  'c6900000-0000-4000-8000-0000000000d2',
  'c6900000-0000-4000-8000-0000000000d3',
  'c7000000-0000-4000-8000-0000000000d4',
  'c7000000-0000-4000-8000-0000000000d5',
  'c7000000-0000-4000-8000-0000000000d6',
  'c7000000-0000-4000-8000-0000000000d7'
);

DELETE FROM public.transactions
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);
DELETE FROM public.credit_cards
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);
DELETE FROM public.budgets
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);
DELETE FROM public.accounts
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);

DELETE FROM public.admin_audit
WHERE actor_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
)
OR target_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7',
  'c6900000-0000-4000-8000-0000000000d1',
  'c6900000-0000-4000-8000-0000000000d2',
  'c6900000-0000-4000-8000-0000000000d3',
  'c7000000-0000-4000-8000-0000000000d4',
  'c7000000-0000-4000-8000-0000000000d5',
  'c7000000-0000-4000-8000-0000000000d6',
  'c7000000-0000-4000-8000-0000000000d7'
);

DELETE FROM public.tenant_members
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
)
OR tenant_id IN (
  'c6900000-0000-4000-8000-0000000000d1',
  'c6900000-0000-4000-8000-0000000000d2',
  'c6900000-0000-4000-8000-0000000000d3',
  'c7000000-0000-4000-8000-0000000000d4',
  'c7000000-0000-4000-8000-0000000000d5',
  'c7000000-0000-4000-8000-0000000000d6',
  'c7000000-0000-4000-8000-0000000000d7'
);

DELETE FROM public.tenants
WHERE owner_user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2'
);

DELETE FROM auth.users
WHERE id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);

COMMIT;

-- ============ Fixtures: usuários ============
INSERT INTO auth.users (id, email) VALUES
  ('c6900000-0000-4000-8000-0000000000a1', 'at-a1-0069@example.com'),
  ('c6900000-0000-4000-8000-0000000000a2', 'at-a2-0069@example.com'),
  ('c6900000-0000-4000-8000-0000000000a3', 'at-a3-0069@example.com'),
  ('c6900000-0000-4000-8000-0000000000a4', 'at-a4-0069@example.com'),
  ('c6900000-0000-4000-8000-0000000000f1', 'at-op-0069@example.com'),
  ('c6900000-0000-4000-8000-0000000000f2', 'at-no-0069@example.com'),
  ('c7000000-0000-4000-8000-0000000000b1', 'at-p1-0070@example.com'),
  ('c7000000-0000-4000-8000-0000000000c5', 'at-ow5-0070@example.com'),
  ('c7000000-0000-4000-8000-0000000000c6', 'at-ow6-0070@example.com'),
  ('c7000000-0000-4000-8000-0000000000c7', 'at-ow7-0070@example.com');

-- Operador ativo (super_admin + internal_operators) e usuário comum.
UPDATE public.profiles SET role = 'super_admin'
WHERE id = 'c6900000-0000-4000-8000-0000000000f1';
INSERT INTO public.internal_operators (user_id, active)
VALUES ('c6900000-0000-4000-8000-0000000000f1', true);

-- ============ Fixtures: tenants (plan `full` = sem quota, fora do escopo) ============
-- `tenant_acceptance_required` é constraint trigger DEFERRABLE: o caminho de
-- produto é a RPC `create_tenant_with_owner_and_acceptance` (0025). Aqui os ids
-- são determinísticos, então o insert direto é feito como postgres (runbook)
-- com o trigger de aceite desligado SÓ neste bloco atômico — o aceite não é o
-- objeto desta spec (precedente 0061: fixture desliga trigger de quota).
BEGIN;
ALTER TABLE public.tenants DISABLE TRIGGER tenant_acceptance_required;

INSERT INTO public.tenants
  (id, kind, owner_user_id, cpf, razao_social, nome_fantasia, plan_id, subscription_status)
VALUES
  ('c6900000-0000-4000-8000-0000000000d1', 'pf',
   'c6900000-0000-4000-8000-0000000000a1', '69000000101',
   'Alfa 0069', NULL, 'full', 'active'),
  ('c6900000-0000-4000-8000-0000000000d2', 'pf',
   'c6900000-0000-4000-8000-0000000000a4', '69000000102',
   'Beta Razao 0069', 'Beta 0069', 'full', 'active'),
  ('c6900000-0000-4000-8000-0000000000d3', 'pf',
   'c6900000-0000-4000-8000-0000000000a3', '69000000103',
   'Gama 0069', NULL, 'full', 'active'),
  ('c7000000-0000-4000-8000-0000000000d4', 'pf',
   'c7000000-0000-4000-8000-0000000000b1', '70000000104',
   'Alfa 0070', NULL, 'full', 'active'),
  ('c7000000-0000-4000-8000-0000000000d5', 'pf',
   'c7000000-0000-4000-8000-0000000000c5', '70000000105',
   'Beta Razao 0070', 'Beta 0070', 'full', 'active'),
  ('c7000000-0000-4000-8000-0000000000d6', 'pf',
   'c7000000-0000-4000-8000-0000000000c6', '70000000106',
   'Gama 0070', NULL, 'full', 'active'),
  ('c7000000-0000-4000-8000-0000000000d7', 'pf',
   'c7000000-0000-4000-8000-0000000000c7', '70000000107',
   'Delta 0070', NULL, 'full', 'active');

ALTER TABLE public.tenants ENABLE TRIGGER tenant_acceptance_required;

INSERT INTO public.tenant_members (tenant_id, user_id, role, created_at) VALUES
  -- c69: A1 owner de d1 + member de d2; A4 owner de d2 + member de d1;
  -- A3 owner de d3 (alvo `canceled`); A2 sem membership.
  ('c6900000-0000-4000-8000-0000000000d1', 'c6900000-0000-4000-8000-0000000000a1', 'owner',
   '2024-01-01 00:00:00+00'),
  ('c6900000-0000-4000-8000-0000000000d2', 'c6900000-0000-4000-8000-0000000000a4', 'owner',
   '2024-01-01 00:00:00+00'),
  ('c6900000-0000-4000-8000-0000000000d1', 'c6900000-0000-4000-8000-0000000000a4', 'member',
   '2024-01-02 00:00:00+00'),
  ('c6900000-0000-4000-8000-0000000000d2', 'c6900000-0000-4000-8000-0000000000a1', 'member',
   '2024-01-02 00:00:00+00'),
  ('c6900000-0000-4000-8000-0000000000d3', 'c6900000-0000-4000-8000-0000000000a3', 'owner',
   '2024-01-01 00:00:00+00'),
  -- c70: P1 owner de d4, member de d5 (empate de created_at com d4) e de d6.
  ('c7000000-0000-4000-8000-0000000000d4', 'c7000000-0000-4000-8000-0000000000b1', 'owner',
   '2024-01-01 00:00:00+00'),
  ('c7000000-0000-4000-8000-0000000000d5', 'c7000000-0000-4000-8000-0000000000c5', 'owner',
   '2024-01-01 00:00:00+00'),
  ('c7000000-0000-4000-8000-0000000000d5', 'c7000000-0000-4000-8000-0000000000b1', 'member',
   '2024-01-01 00:00:00+00'),
  ('c7000000-0000-4000-8000-0000000000d6', 'c7000000-0000-4000-8000-0000000000c6', 'owner',
   '2024-01-01 00:00:00+00'),
  ('c7000000-0000-4000-8000-0000000000d6', 'c7000000-0000-4000-8000-0000000000b1', 'member',
   '2024-01-02 00:00:00+00'),
  ('c7000000-0000-4000-8000-0000000000d7', 'c7000000-0000-4000-8000-0000000000c7', 'owner',
   '2024-01-01 00:00:00+00');

COMMIT;

-- ============ T00 — estrutura (0069 + 0070) ============
DO $$
DECLARE
  v_proc pg_proc;
  v_n integer;
  v_def text;
  v_cols text[];
  v_fk record;
  v_pk text;
BEGIN
  -- ---- user_active_tenants ----
  IF to_regclass('public.user_active_tenants') IS NULL THEN
    RAISE EXCEPTION '0069 T00 falhou: tabela user_active_tenants ausente';
  END IF;

  SELECT pg_catalog.array_agg(a.attname ORDER BY k.ord) INTO v_cols
  FROM pg_attribute AS a
  JOIN pg_catalog.unnest(
    (SELECT i.indkey FROM pg_index AS i
      WHERE i.indrelid = 'public.user_active_tenants'::regclass AND i.indisprimary)
  ) WITH ORDINALITY AS k(attnum, ord) ON a.attnum = k.attnum
  WHERE a.attrelid = 'public.user_active_tenants'::regclass;
  IF v_cols IS DISTINCT FROM ARRAY['user_id'] THEN
    RAISE EXCEPTION '0069 T00 falhou: PK de user_active_tenants nao e (user_id) (%)', v_cols;
  END IF;

  SELECT pg_catalog.array_agg(a.attname ORDER BY a.attnum) INTO v_cols
  FROM pg_attribute AS a
  WHERE a.attrelid = 'public.user_active_tenants'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cols IS DISTINCT FROM ARRAY['user_id', 'tenant_id', 'switched_at'] THEN
    RAISE EXCEPTION '0069 T00 falhou: colunas de user_active_tenants divergentes (%)', v_cols;
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = 'public.user_active_tenants'::regclass AND contype = 'f';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0069 T00 falhou: user_active_tenants com % FKs (esperado 2)', v_n;
  END IF;

  FOR v_fk IN
    SELECT c.confrelid, c.confdeltype
    FROM pg_constraint AS c
    WHERE c.conrelid = 'public.user_active_tenants'::regclass AND c.contype = 'f'
  LOOP
    IF v_fk.confdeltype <> 'c' THEN
      RAISE EXCEPTION '0069 T00 falhou: FK de user_active_tenants nao e CASCADE (%)', v_fk.confdeltype;
    END IF;
    IF v_fk.confrelid NOT IN ('public.profiles'::regclass, 'public.tenants'::regclass) THEN
      RAISE EXCEPTION '0069 T00 falhou: FK de user_active_tenants referencia tabela inesperada';
    END IF;
  END LOOP;

  IF (SELECT a.attnotnull FROM pg_attribute AS a
      WHERE a.attrelid = 'public.user_active_tenants'::regclass AND a.attname = 'tenant_id') IS NOT TRUE THEN
    RAISE EXCEPTION '0069 T00 falhou: tenant_id deveria ser NOT NULL';
  END IF;
  IF (SELECT a.attnotnull FROM pg_attribute AS a
      WHERE a.attrelid = 'public.user_active_tenants'::regclass AND a.attname = 'switched_at') IS NOT TRUE THEN
    RAISE EXCEPTION '0069 T00 falhou: switched_at deveria ser NOT NULL';
  END IF;
  IF (SELECT a.atthasdef FROM pg_attribute AS a
      WHERE a.attrelid = 'public.user_active_tenants'::regclass AND a.attname = 'switched_at') IS NOT TRUE THEN
    RAISE EXCEPTION '0069 T00 falhou: switched_at sem DEFAULT';
  END IF;

  -- ---- tenant_switches (append-only, ZERO FK) ----
  IF to_regclass('public.tenant_switches') IS NULL THEN
    RAISE EXCEPTION '0069 T00 falhou: tabela tenant_switches ausente';
  END IF;

  SELECT pg_catalog.array_agg(a.attname ORDER BY a.attnum) INTO v_cols
  FROM pg_attribute AS a
  WHERE a.attrelid = 'public.tenant_switches'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cols IS DISTINCT FROM ARRAY['id', 'actor_id', 'from_tenant_id', 'to_tenant_id', 'switched_at', 'source'] THEN
    RAISE EXCEPTION '0069 T00 falhou: colunas de tenant_switches divergentes (%)', v_cols;
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = 'public.tenant_switches'::regclass AND contype = 'f';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0069 T00 falhou: tenant_switches com % FKs (append-only sem FK)', v_n;
  END IF;

  IF (SELECT a.attnotnull FROM pg_attribute AS a
      WHERE a.attrelid = 'public.tenant_switches'::regclass AND a.attname = 'to_tenant_id') IS NOT TRUE THEN
    RAISE EXCEPTION '0069 T00 falhou: to_tenant_id deveria ser NOT NULL';
  END IF;
  IF (SELECT a.attnotnull FROM pg_attribute AS a
      WHERE a.attrelid = 'public.tenant_switches'::regclass AND a.attname = 'actor_id') THEN
    RAISE EXCEPTION '0069 T00 falhou: actor_id deveria ser NULLable';
  END IF;
  IF (SELECT a.attnotnull FROM pg_attribute AS a
      WHERE a.attrelid = 'public.tenant_switches'::regclass AND a.attname = 'from_tenant_id') THEN
    RAISE EXCEPTION '0069 T00 falhou: from_tenant_id deveria ser NULLable';
  END IF;

  -- índices
  v_def := pg_get_indexdef(to_regclass('public.tenant_switches_actor_idx'));
  IF v_def IS NULL OR position('actor_id, switched_at DESC' IN v_def) = 0 THEN
    RAISE EXCEPTION '0069 T00 falhou: tenant_switches_actor_idx divergente (%)', v_def;
  END IF;
  v_def := pg_get_indexdef(to_regclass('public.tenant_switches_to_idx'));
  IF v_def IS NULL OR position('to_tenant_id, switched_at DESC' IN v_def) = 0 THEN
    RAISE EXCEPTION '0069 T00 falhou: tenant_switches_to_idx divergente (%)', v_def;
  END IF;

  -- RLS habilitada SEM policy nas duas
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_active_tenants'::regclass) IS NOT TRUE THEN
    RAISE EXCEPTION '0069 T00 falhou: RLS desabilitada em user_active_tenants';
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_switches'::regclass) IS NOT TRUE THEN
    RAISE EXCEPTION '0069 T00 falhou: RLS desabilitada em tenant_switches';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('user_active_tenants', 'tenant_switches');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0069 T00 falhou: % policy(ies) nas tabelas de pin/trilha', v_n;
  END IF;

  -- privilégios de tabela revogados dos 4 papéis
  FOR v_pk IN SELECT unnest(ARRAY['anon', 'authenticated', 'service_role']) LOOP
    FOREACH v_def IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(v_pk, 'public.user_active_tenants', v_def) THEN
        RAISE EXCEPTION '0069 T00 falhou: % tem % em user_active_tenants', v_pk, v_def;
      END IF;
      IF has_table_privilege(v_pk, 'public.tenant_switches', v_def) THEN
        RAISE EXCEPTION '0069 T00 falhou: % tem % em tenant_switches', v_pk, v_def;
      END IF;
    END LOOP;
  END LOOP;

  -- ---- funções ----
  IF to_regprocedure('public.switch_tenant(uuid)') IS NULL
     OR to_regprocedure('public.list_my_tenants()') IS NULL
     OR to_regprocedure('public.admin_list_tenant_switches(uuid, int, int)') IS NULL
     OR to_regprocedure('private.resolve_user_tenant(uuid)') IS NULL
     OR to_regprocedure('private.resolve_writable_tenant(uuid)') IS NULL THEN
    RAISE EXCEPTION '0069 T00 falhou: assinatura de funcao ausente';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc
  WHERE proname = 'switch_tenant' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0069 T00 falhou: switch_tenant com % assinaturas', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
  WHERE proname = 'list_my_tenants' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0069 T00 falhou: list_my_tenants com % assinaturas', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
  WHERE proname = 'admin_list_tenant_switches' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0069 T00 falhou: admin_list_tenant_switches com % assinaturas', v_n;
  END IF;

  FOR v_pk IN SELECT unnest(ARRAY[
      'public.switch_tenant(uuid)',
      'public.list_my_tenants()',
      'public.admin_list_tenant_switches(uuid, int, int)']) LOOP
    SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure(v_pk);
    IF v_proc.prosecdef IS NOT TRUE THEN
      RAISE EXCEPTION '0069 T00 falhou: % sem SECURITY DEFINER', v_pk;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION '0069 T00 falhou: % sem search_path='''' travado', v_pk;
    END IF;
  END LOOP;

  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.switch_tenant(uuid)'::regprocedure) <> 'v' THEN
    RAISE EXCEPTION '0069 T00 falhou: switch_tenant deveria ser VOLATILE';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.list_my_tenants()'::regprocedure) <> 's' THEN
    RAISE EXCEPTION '0069 T00 falhou: list_my_tenants deveria ser STABLE';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.admin_list_tenant_switches(uuid, int, int)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION '0069 T00 falhou: admin_list_tenant_switches deveria ser STABLE';
  END IF;

  -- EXECUTE só para authenticated; PUBLIC/anon/service_role sem
  FOREACH v_pk IN ARRAY ARRAY[
      'public.switch_tenant(uuid)',
      'public.list_my_tenants()',
      'public.admin_list_tenant_switches(uuid, int, int)'] LOOP
    IF NOT has_function_privilege('authenticated', v_pk, 'EXECUTE') THEN
      RAISE EXCEPTION '0069 T00 falhou: authenticated sem EXECUTE em %', v_pk;
    END IF;
    IF has_function_privilege('anon', v_pk, 'EXECUTE') THEN
      RAISE EXCEPTION '0069 T00 falhou: anon com EXECUTE em %', v_pk;
    END IF;
    IF has_function_privilege('service_role', v_pk, 'EXECUTE') THEN
      RAISE EXCEPTION '0069 T00 falhou: service_role com EXECUTE em %', v_pk;
    END IF;
    SELECT count(*) INTO v_n
    FROM pg_proc AS p, pg_catalog.aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure(v_pk) AND a.grantee = 0;
    IF v_n <> 0 THEN
      RAISE EXCEPTION '0069 T00 falhou: PUBLIC com EXECUTE em %', v_pk;
    END IF;
  END LOOP;

  -- ---- 0070: pin presente no prosrc das DUAS resoluções ----
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'private.resolve_user_tenant(uuid)'::regprocedure)
     NOT LIKE '%user_active_tenants%' THEN
    RAISE EXCEPTION '0069/0070 T00 falhou: resolve_user_tenant sem o pin (0070)';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'private.resolve_writable_tenant(uuid)'::regprocedure)
     NOT LIKE '%user_active_tenants%' THEN
    RAISE EXCEPTION '0069/0070 T00 falhou: resolve_writable_tenant sem o pin (0070)';
  END IF;

  -- ---- faixa F7 entregue (REQ-52; BE-76): 0072–0074 agora EXISTEM em
  --      `schema_migrations` após o `db reset`. A faixa reservada encolheu e
  --      não há mais faixa futura a exigir vazia neste arquivo. ----
  SELECT count(*) INTO v_n FROM supabase_migrations.schema_migrations
  WHERE version IN ('0072', '0073', '0074');
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0069 T00 falhou: % migration(s) da faixa F7 (esperado 3)', v_n;
  END IF;

  RAISE NOTICE '0069/0070 T00 ok: tabelas+FK CASCADE+RLS sem policy+REVOKE+2 indices+5 assinaturas+pin nas 2 resolucoes';
END $$;

-- ============ T-sw-01 — sem sessão ⇒ not-authenticated ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claims', '', true);

DO $$
BEGIN
  BEGIN
    PERFORM public.switch_tenant('c6900000-0000-4000-8000-0000000000d1');
    RAISE EXCEPTION '0069 T-sw-01 falhou: sem sessao aceitou a troca';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0069 T-sw-01 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-authenticated' THEN
        RAISE EXCEPTION '0069 T-sw-01 falhou: rotulo errado sem sessao (%)', SQLERRM;
      END IF;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.user_active_tenants
  WHERE user_id = 'c6900000-0000-4000-8000-0000000000a1';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0069 T-sw-01 falhou: sem sessao gravou pin';
  END IF;
  RAISE NOTICE '0069 T-sw-01 ok: sem sessao -> not-authenticated, 0 escrita';
END $$;

-- ============ T-sw-02 — sem membership ⇒ tenant-not-member (sem id) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6900000-0000-4000-8000-0000000000a2', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6900000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    PERFORM public.switch_tenant('c6900000-0000-4000-8000-0000000000d1');
    RAISE EXCEPTION '0069 T-sw-02 falhou: aceitou tenant alheio';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0069 T-sw-02 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-not-member' THEN
        RAISE EXCEPTION '0069 T-sw-02 falhou: rotulo errado para tenant alheio (%)', SQLERRM;
      END IF;
  END;

  BEGIN
    PERFORM public.switch_tenant('00000000-0000-4000-8000-000000000000');
    RAISE EXCEPTION '0069 T-sw-02 falhou: aceitou tenant inexistente';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0069 T-sw-02 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'tenant-not-member' THEN
        RAISE EXCEPTION '0069 T-sw-02 falhou: rotulo errado para inexistente (%)', SQLERRM;
      END IF;
  END;
  RAISE NOTICE '0069 T-sw-02 ok: sem membership -> tenant-not-member (sem id)';
END $$;
ROLLBACK;

-- ============ T-sw-03/T-sw-04 — troca grava pin + 1 trilha; no-op sem trilha ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6900000-0000-4000-8000-0000000000a1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  PERFORM public.switch_tenant('c6900000-0000-4000-8000-0000000000d2');
END $$;

-- mesma transação: pin E trilha visíveis juntos (T-sw-04)
RESET ROLE;
DO $$
DECLARE
  v_pin uuid;
  v_pin_at timestamptz;
  v_n bigint;
  v_from uuid;
  v_to uuid;
  v_trail_at timestamptz;
  v_source text;
BEGIN
  SELECT tenant_id, switched_at INTO v_pin, v_pin_at
  FROM public.user_active_tenants
  WHERE user_id = 'c6900000-0000-4000-8000-0000000000a1';
  IF v_pin IS DISTINCT FROM 'c6900000-0000-4000-8000-0000000000d2' THEN
    RAISE EXCEPTION '0069 T-sw-04 falhou: pin nao gravado (%)', v_pin;
  END IF;

  SELECT count(*) INTO v_n FROM public.tenant_switches
  WHERE actor_id = 'c6900000-0000-4000-8000-0000000000a1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0069 T-sw-04 falhou: % linhas de trilha (esperado 1)', v_n;
  END IF;

  SELECT from_tenant_id, to_tenant_id, switched_at, source
    INTO v_from, v_to, v_trail_at, v_source
  FROM public.tenant_switches
  WHERE actor_id = 'c6900000-0000-4000-8000-0000000000a1';

  IF v_from IS NOT NULL THEN
    RAISE EXCEPTION '0069 T-sw-04 falhou: from_tenant_id deveria ser NULL na primeira troca (%)', v_from;
  END IF;
  IF v_to IS DISTINCT FROM 'c6900000-0000-4000-8000-0000000000d2' THEN
    RAISE EXCEPTION '0069 T-sw-04 falhou: to_tenant_id divergente (%)', v_to;
  END IF;
  IF v_source <> 'selector' THEN
    RAISE EXCEPTION '0069 T-sw-04 falhou: source divergente (%)', v_source;
  END IF;
  IF v_trail_at IS DISTINCT FROM v_pin_at THEN
    RAISE EXCEPTION '0069 T-sw-04 falhou: pin e trilha fora da mesma transacao (%)', v_trail_at;
  END IF;
  RAISE NOTICE '0069 T-sw-04 ok: troca grava pin + 1 trilha na mesma transacao';
END $$;

-- segunda troca: from = anterior
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.switch_tenant('c6900000-0000-4000-8000-0000000000d1');
END $$;
RESET ROLE;

DO $$
DECLARE
  v_n bigint;
  v_from_count bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenant_switches
  WHERE actor_id = 'c6900000-0000-4000-8000-0000000000a1';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0069 T-sw-04 falhou: % linhas de trilha na 2a troca', v_n;
  END IF;
  -- as duas trocas vivem na MESMA transação (now() idêntico), então a
  -- identidade da 2ª linha é o `from`, não a ordem por switched_at.
  SELECT count(*) INTO v_from_count FROM public.tenant_switches
  WHERE actor_id = 'c6900000-0000-4000-8000-0000000000a1'
    AND from_tenant_id = 'c6900000-0000-4000-8000-0000000000d2';
  IF v_from_count <> 1 THEN
    RAISE EXCEPTION '0069 T-sw-04 falhou: from da 2a troca divergente (% linhas)', v_from_count;
  END IF;
END $$;

-- T-sw-03: trocar para o tenant JÁ ativo = no-op sem trilha
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.switch_tenant('c6900000-0000-4000-8000-0000000000d1');
END $$;
RESET ROLE;

DO $$
DECLARE
  v_n bigint;
  v_pin_at timestamptz;
BEGIN
  SELECT count(*) INTO v_n FROM public.tenant_switches
  WHERE actor_id = 'c6900000-0000-4000-8000-0000000000a1';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0069 T-sw-03 falhou: no-op gerou trilha (% linhas)', v_n;
  END IF;
  SELECT switched_at INTO v_pin_at FROM public.user_active_tenants
  WHERE user_id = 'c6900000-0000-4000-8000-0000000000a1';
  IF v_pin_at IS DISTINCT FROM (
    SELECT max(switched_at) FROM public.tenant_switches
    WHERE actor_id = 'c6900000-0000-4000-8000-0000000000a1'
  ) THEN
    RAISE EXCEPTION '0069 T-sw-03 falhou: no-op reescreveu switched_at';
  END IF;
  RAISE NOTICE '0069 T-sw-03 ok: no-op sem trilha e sem reescrita';
END $$;
ROLLBACK;

-- ============ T-sw-05 — alvo canceled ⇒ subscription-canceled-readonly ============
BEGIN;
UPDATE public.tenants SET subscription_status = 'canceled'
WHERE id = 'c6900000-0000-4000-8000-0000000000d3';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6900000-0000-4000-8000-0000000000a3', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6900000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    PERFORM public.switch_tenant('c6900000-0000-4000-8000-0000000000d3');
    RAISE EXCEPTION '0069 T-sw-05 falhou: aceitou alvo canceled';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0069 T-sw-05 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'subscription-canceled-readonly' THEN
        RAISE EXCEPTION '0069 T-sw-05 falhou: rotulo errado para canceled (%)', SQLERRM;
      END IF;
  END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.user_active_tenants
  WHERE user_id = 'c6900000-0000-4000-8000-0000000000a3';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0069 T-sw-05 falhou: pin gravado em alvo canceled';
  END IF;
  RAISE NOTICE '0069 T-sw-05 ok: alvo canceled -> subscription-canceled-readonly, 0 pin';
END $$;
ROLLBACK;

-- ============ T-sw-06 — list_my_tenants ============
DO $$
DECLARE
  v_result text;
BEGIN
  v_result := pg_get_function_result(to_regprocedure('public.list_my_tenants()'));
  IF position('cpf' IN v_result) > 0 OR position('cnpj' IN v_result) > 0
     OR position('document' IN v_result) > 0 OR position('email' IN v_result) > 0 THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: list_my_tenants expoe documento/PII (%)', v_result;
  END IF;
  IF position('is_active boolean' IN v_result) = 0 THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: list_my_tenants sem is_active (%)', v_result;
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6900000-0000-4000-8000-0000000000a1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6900000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_n bigint;
  v_names text[];
  v_roles text[];
  v_active boolean[];
  v_ids uuid[];
BEGIN
  SELECT count(*) INTO v_n FROM public.list_my_tenants();
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: % memberships (esperado 2)', v_n;
  END IF;

  SELECT pg_catalog.array_agg(name ORDER BY ord),
         pg_catalog.array_agg(role ORDER BY ord),
         pg_catalog.array_agg(is_active ORDER BY ord),
         pg_catalog.array_agg(tenant_id ORDER BY ord)
    INTO v_names, v_roles, v_active, v_ids
  FROM (SELECT name, role, is_active, tenant_id,
               row_number() OVER () AS ord
        FROM public.list_my_tenants()) AS r;

  IF v_ids IS DISTINCT FROM ARRAY[
      'c6900000-0000-4000-8000-0000000000d1'::uuid,
      'c6900000-0000-4000-8000-0000000000d2'::uuid] THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: ordem/ids divergentes (%)', v_ids;
  END IF;
  IF v_names IS DISTINCT FROM ARRAY['Alfa 0069', 'Beta 0069'] THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: nomes divergentes (%)', v_names;
  END IF;
  IF v_roles IS DISTINCT FROM ARRAY['owner', 'member'] THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: papeis divergentes (%)', v_roles;
  END IF;
  IF v_active IS DISTINCT FROM ARRAY[true, false] THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: is_active divergente sem pin (%)', v_active;
  END IF;
END $$;

-- com pin em d2: is_active acompanha a resolução
DO $$
BEGIN
  PERFORM public.switch_tenant('c6900000-0000-4000-8000-0000000000d2');
END $$;

DO $$
DECLARE
  v_ids uuid[];
  v_active boolean[];
BEGIN
  SELECT pg_catalog.array_agg(tenant_id ORDER BY ord),
         pg_catalog.array_agg(is_active ORDER BY ord)
    INTO v_ids, v_active
  FROM (SELECT tenant_id, is_active, row_number() OVER () AS ord
        FROM public.list_my_tenants()) AS r;

  IF v_ids IS DISTINCT FROM ARRAY[
      'c6900000-0000-4000-8000-0000000000d2'::uuid,
      'c6900000-0000-4000-8000-0000000000d1'::uuid] THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: ordem com pin divergente (%)', v_ids;
  END IF;
  IF v_active IS DISTINCT FROM ARRAY[true, false] THEN
    RAISE EXCEPTION '0069 T-sw-06 falhou: is_active nao acompanhou o pin (%)', v_active;
  END IF;
  RAISE NOTICE '0069 T-sw-06 ok: so memberships, is_active = resolucao, sem documento';
END $$;
ROLLBACK;

-- ============ T-sw-07 — admin_list_tenant_switches ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6900000-0000-4000-8000-0000000000f2', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6900000-0000-4000-8000-0000000000f2","role":"authenticated","aal":"aal2"}', true);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.admin_list_tenant_switches();
    RAISE EXCEPTION '0069 T-sw-07 falhou: nao-operador leu a trilha';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0069 T-sw-07 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-admin' THEN
        RAISE EXCEPTION '0069 T-sw-07 falhou: rotulo errado sem operador (%)', SQLERRM;
      END IF;
  END;
END $$;
ROLLBACK;

BEGIN;
-- fixture controlada de trilha (postgres)
INSERT INTO public.tenant_switches (id, actor_id, from_tenant_id, to_tenant_id, switched_at, source) VALUES
  ('c6900000-0000-4000-8000-0000000005a1',
   'c6900000-0000-4000-8000-0000000000a1',
   'c6900000-0000-4000-8000-0000000000d1',
   'c6900000-0000-4000-8000-0000000000d2',
   '2026-01-01 10:00:00+00', 'selector'),
  ('c6900000-0000-4000-8000-0000000005a2',
   'c6900000-0000-4000-8000-0000000000a1',
   'c6900000-0000-4000-8000-0000000000d2',
   'c6900000-0000-4000-8000-0000000000d1',
   '2026-01-01 10:00:00+00', 'selector'),
  ('c6900000-0000-4000-8000-0000000005a3',
   'c6900000-0000-4000-8000-0000000000a3',
   NULL,
   'c6900000-0000-4000-8000-0000000000d1',
   '2026-01-01 10:00:00+00', 'selector');

-- 105 linhas para o clamp superior (p_tenant NULL); alvo d3, que não participa
-- das asserções de filtro/ordem abaixo.
INSERT INTO public.tenant_switches (actor_id, to_tenant_id, switched_at, source)
SELECT 'c6900000-0000-4000-8000-0000000000a4',
       'c6900000-0000-4000-8000-0000000000d3',
       '2026-02-01 00:00:00+00'::timestamptz - (g || ' seconds')::interval,
       'selector'
FROM generate_series(1, 105) AS g;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c6900000-0000-4000-8000-0000000000f1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c6900000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}', true);

DO $$
DECLARE
  v_n bigint;
  v_order text[];
BEGIN
  -- clamp superior: p_limit 1000 ⇒ 100
  SELECT count(*) INTO v_n FROM public.admin_list_tenant_switches(NULL, 1000, 0);
  IF v_n <> 100 THEN
    RAISE EXCEPTION '0069 T-sw-07 falhou: p_limit 1000 devolveu % (esperado 100)', v_n;
  END IF;

  -- clamp inferior: p_limit 0 e negativo ⇒ 1; p_offset negativo ⇒ 0
  SELECT count(*) INTO v_n FROM public.admin_list_tenant_switches(NULL, 0, 0);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0069 T-sw-07 falhou: p_limit 0 devolveu % (esperado 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.admin_list_tenant_switches(NULL, -7, -5);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0069 T-sw-07 falhou: p_limit negativo devolveu % (esperado 1)', v_n;
  END IF;

  -- filtro from|to: d1 casa 3 linhas controladas (1 from + 1 to + 1 to)
  SELECT count(*) INTO v_n FROM public.admin_list_tenant_switches(
    'c6900000-0000-4000-8000-0000000000d1', 100, 0);
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0069 T-sw-07 falhou: filtro d1 devolveu % (esperado 3)', v_n;
  END IF;

  -- filtro d2 casa 2 (1 to + 1 from), provando que o filtro e from|to
  SELECT count(*) INTO v_n FROM public.admin_list_tenant_switches(
    'c6900000-0000-4000-8000-0000000000d2', 100, 0);
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0069 T-sw-07 falhou: filtro d2 devolveu % (esperado 2)', v_n;
  END IF;

  -- ordem: mesmo switched_at ⇒ id DESC. A função não devolve `id`, então a
  -- identidade da linha vem do par (from, to).
  SELECT pg_catalog.array_agg(
           COALESCE(r.from_tenant_id::text, '-') || '>' || r.to_tenant_id::text
           ORDER BY r.ord) INTO v_order
  FROM (SELECT s.from_tenant_id, s.to_tenant_id, row_number() OVER () AS ord
        FROM public.admin_list_tenant_switches('c6900000-0000-4000-8000-0000000000d1', 100, 0) AS s
        WHERE s.actor_id IN (
          'c6900000-0000-4000-8000-0000000000a1',
          'c6900000-0000-4000-8000-0000000000a3')
       ) AS r;
  IF v_order IS DISTINCT FROM ARRAY[
      '->c6900000-0000-4000-8000-0000000000d1',
      'c6900000-0000-4000-8000-0000000000d2>c6900000-0000-4000-8000-0000000000d1',
      'c6900000-0000-4000-8000-0000000000d1>c6900000-0000-4000-8000-0000000000d2'] THEN
    RAISE EXCEPTION '0069 T-sw-07 falhou: ordem deterministica divergente (%)', v_order;
  END IF;

  RAISE NOTICE '0069 T-sw-07 ok: gate not-admin, clamp 1..100, filtro from|to, ordem';
END $$;
ROLLBACK;

-- ============ T-pin-01 — resolve_user_tenant honra o pin ============
BEGIN;
INSERT INTO public.user_active_tenants (user_id, tenant_id)
VALUES ('c7000000-0000-4000-8000-0000000000b1', 'c7000000-0000-4000-8000-0000000000d5');

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := private.resolve_user_tenant('c7000000-0000-4000-8000-0000000000b1');
  IF v_tenant IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d5' THEN
    RAISE EXCEPTION '0070 T-pin-01 falhou: leitura ignorou o pin (%)', v_tenant;
  END IF;
  RAISE NOTICE '0070 T-pin-01 ok: resolve_user_tenant = pin';
END $$;
ROLLBACK;

-- ============ T-pin-02 — pin órfão é ignorado ============
BEGIN;
INSERT INTO public.user_active_tenants (user_id, tenant_id)
VALUES ('c7000000-0000-4000-8000-0000000000b1', 'c7000000-0000-4000-8000-0000000000d7');

DO $$
DECLARE
  v_read uuid;
  v_write uuid;
BEGIN
  v_read := private.resolve_user_tenant('c7000000-0000-4000-8000-0000000000b1');
  v_write := private.resolve_writable_tenant('c7000000-0000-4000-8000-0000000000b1');
  IF v_read IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d4' THEN
    RAISE EXCEPTION '0070 T-pin-02 falhou: pin orfao honrado na leitura (%)', v_read;
  END IF;
  IF v_write IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d4' THEN
    RAISE EXCEPTION '0070 T-pin-02 falhou: pin orfao honrado na escrita (%)', v_write;
  END IF;
  RAISE NOTICE '0070 T-pin-02 ok: pin orfao ignorado, fallback deterministico';
END $$;
ROLLBACK;

-- ============ T-pin-03 — resolve_writable_tenant honra pin gravável ============
BEGIN;
INSERT INTO public.user_active_tenants (user_id, tenant_id)
VALUES ('c7000000-0000-4000-8000-0000000000b1', 'c7000000-0000-4000-8000-0000000000d5');

DO $$
DECLARE
  v_write uuid;
BEGIN
  v_write := private.resolve_writable_tenant('c7000000-0000-4000-8000-0000000000b1');
  IF v_write IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d5' THEN
    RAISE EXCEPTION '0070 T-pin-03 falhou: escrita ignorou o pin gravavel (%)', v_write;
  END IF;
  RAISE NOTICE '0070 T-pin-03 ok: resolve_writable_tenant = pin gravavel';
END $$;
ROLLBACK;

-- ============ T-pin-04 — janela O-F4-3: pin canceled ============
BEGIN;
INSERT INTO public.user_active_tenants (user_id, tenant_id)
VALUES ('c7000000-0000-4000-8000-0000000000b1', 'c7000000-0000-4000-8000-0000000000d6');
UPDATE public.tenants SET subscription_status = 'canceled'
WHERE id = 'c7000000-0000-4000-8000-0000000000d6';

DO $$
DECLARE
  v_read uuid;
  v_write uuid;
BEGIN
  v_read := private.resolve_user_tenant('c7000000-0000-4000-8000-0000000000b1');
  v_write := private.resolve_writable_tenant('c7000000-0000-4000-8000-0000000000b1');
  IF v_read IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d6' THEN
    RAISE EXCEPTION '0070 T-pin-04 falhou: leitura abandonou o pin (%)', v_read;
  END IF;
  IF v_write IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d4' THEN
    RAISE EXCEPTION '0070 T-pin-04 falhou: escrita honrou pin canceled (%)', v_write;
  END IF;
  RAISE NOTICE '0070 T-pin-04 ok: leitura mantem pin canceled, escrita cai no gravavel';
END $$;
ROLLBACK;

-- ============ T-pin-05 — sem pin: idêntico a 0054/0061 ============
BEGIN;
DELETE FROM public.user_active_tenants
WHERE user_id = 'c7000000-0000-4000-8000-0000000000b1';

DO $$
DECLARE
  v_read uuid;
  v_write uuid;
  v_legacy_read uuid;
  v_legacy_write uuid;
BEGIN
  v_read := private.resolve_user_tenant('c7000000-0000-4000-8000-0000000000b1');
  v_write := private.resolve_writable_tenant('c7000000-0000-4000-8000-0000000000b1');

  -- corpo de 0054:59-79 (ordem antiga, sem pin)
  SELECT tm.tenant_id INTO v_legacy_read
  FROM public.tenant_members AS tm
  WHERE tm.user_id = 'c7000000-0000-4000-8000-0000000000b1'
  ORDER BY (tm.role = 'owner') DESC,
           tm.created_at ASC,
           tm.tenant_id ASC
  LIMIT 1;

  -- corpo de 0061:150-166 (status primeiro, sem pin)
  SELECT tm.tenant_id INTO v_legacy_write
  FROM public.tenant_members AS tm
  JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE tm.user_id = 'c7000000-0000-4000-8000-0000000000b1'
  ORDER BY (t.subscription_status <> 'canceled') DESC,
           (tm.role = 'owner') DESC,
           tm.created_at ASC,
           tm.tenant_id ASC
  LIMIT 1;

  IF v_read IS DISTINCT FROM v_legacy_read THEN
    RAISE EXCEPTION '0070 T-pin-05 falhou: leitura sem pin divergiu de 0054 (% vs %)', v_read, v_legacy_read;
  END IF;
  IF v_write IS DISTINCT FROM v_legacy_write THEN
    RAISE EXCEPTION '0070 T-pin-05 falhou: escrita sem pin divergiu de 0061 (% vs %)', v_write, v_legacy_write;
  END IF;
  IF v_read IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d4'
     OR v_write IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d4' THEN
    RAISE EXCEPTION '0070 T-pin-05 falhou: fixture sem empate resolvido pelo owner (%/%)', v_read, v_write;
  END IF;
  RAISE NOTICE '0070 T-pin-05 ok: sem pin = 0054/0061 (3 memberships, empate de created_at)';
END $$;
ROLLBACK;

-- ============ T-pin-06 — estrutura das duas resoluções ============
DO $$
DECLARE
  v_proc pg_proc;
  v_fn text;
  v_n bigint;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'private.resolve_user_tenant(uuid)',
      'private.resolve_writable_tenant(uuid)'] LOOP
    SELECT count(*) INTO v_n FROM pg_proc
    WHERE proname = split_part(split_part(v_fn, '(', 1), '.', 2)
      AND pronamespace = 'private'::regnamespace;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '0070 T-pin-06 falhou: % com % assinaturas', v_fn, v_n;
    END IF;

    SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure(v_fn);
    IF v_proc.prosecdef IS NOT TRUE THEN
      RAISE EXCEPTION '0070 T-pin-06 falhou: % sem SECURITY DEFINER', v_fn;
    END IF;
    IF v_proc.provolatile <> 's' THEN
      RAISE EXCEPTION '0070 T-pin-06 falhou: % nao e STABLE', v_fn;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION '0070 T-pin-06 falhou: % sem search_path='''' travado', v_fn;
    END IF;
    IF position('auth.uid' IN v_proc.prosrc) > 0 THEN
      RAISE EXCEPTION '0070 T-pin-06 falhou: % le auth.uid()', v_fn;
    END IF;
    IF position('user_active_tenants' IN v_proc.prosrc) = 0 THEN
      RAISE EXCEPTION '0070 T-pin-06 falhou: % sem o pin no corpo', v_fn;
    END IF;

    IF has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0070 T-pin-06 falhou: % com EXECUTE para client', v_fn;
    END IF;
  END LOOP;

  RAISE NOTICE '0070 T-pin-06 ok: 1 assinatura, STABLE, DEFINER, search_path vazio, sem auth.uid, sem GRANT';
END $$;

-- ============ T-usage-01 — pin move LEITURA e ESCRITA juntas (REQ-46) ============
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7000000-0000-4000-8000-0000000000b1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', true);

-- sem pin: 2 contas caem no tenant do gate (d4)
INSERT INTO public.accounts (user_id, name, type) VALUES
  ('c7000000-0000-4000-8000-0000000000b1', 'Base 1 0070', 'checking'),
  ('c7000000-0000-4000-8000-0000000000b1', 'Base 2 0070', 'checking');

-- pin em d5
DO $$
BEGIN
  PERFORM public.switch_tenant('c7000000-0000-4000-8000-0000000000d5');
END $$;

DO $$
DECLARE
  v_used bigint;
BEGIN
  SELECT used INTO v_used FROM public.get_tenant_usage(NULL) WHERE resource = 'accounts';
  IF v_used <> 0 THEN
    RAISE EXCEPTION '0070 T-usage-01 falhou: leitura nao seguiu o pin (% contas)', v_used;
  END IF;
END $$;

-- escrita com pin: a conta nova cai em d5
INSERT INTO public.accounts (user_id, name, type) VALUES
  ('c7000000-0000-4000-8000-0000000000b1', 'Pin 1 0070', 'checking');

DO $$
DECLARE
  v_used bigint;
BEGIN
  SELECT used INTO v_used FROM public.get_tenant_usage(NULL) WHERE resource = 'accounts';
  IF v_used <> 1 THEN
    RAISE EXCEPTION '0070 T-usage-01 falhou: consumo nao seguiu a escrita no pin (%)', v_used;
  END IF;
END $$;

-- troca o pin para d4: leitura e escrita movem juntas
DO $$
BEGIN
  PERFORM public.switch_tenant('c7000000-0000-4000-8000-0000000000d4');
END $$;

DO $$
DECLARE
  v_used bigint;
BEGIN
  SELECT used INTO v_used FROM public.get_tenant_usage(NULL) WHERE resource = 'accounts';
  IF v_used <> 2 THEN
    RAISE EXCEPTION '0070 T-usage-01 falhou: troca de pin nao moveu o consumo (%)', v_used;
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  v_n bigint;
  v_active uuid;
BEGIN
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE user_id = 'c7000000-0000-4000-8000-0000000000b1'
    AND tenant_id = 'c7000000-0000-4000-8000-0000000000d4';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0070 T-usage-01 falhou: % contas em d4 (esperado 2)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.accounts
  WHERE user_id = 'c7000000-0000-4000-8000-0000000000b1'
    AND tenant_id = 'c7000000-0000-4000-8000-0000000000d5';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0070 T-usage-01 falhou: % contas em d5 (esperado 1)', v_n;
  END IF;

  v_active := private.resolve_user_tenant('c7000000-0000-4000-8000-0000000000b1');
  IF v_active IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d4' THEN
    RAISE EXCEPTION '0070 T-usage-01 falhou: leitura final divergente (%)', v_active;
  END IF;

  RAISE NOTICE '0070 T-usage-01 ok: pin muda leitura e escrita juntas';
END $$;
ROLLBACK;

-- ============ T-usage-02 — sem pin: baseline de 0061/0064 ============
BEGIN;
DELETE FROM public.user_active_tenants
WHERE user_id = 'c7000000-0000-4000-8000-0000000000b1';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c7000000-0000-4000-8000-0000000000b1', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c7000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', true);

INSERT INTO public.accounts (user_id, name, type) VALUES
  ('c7000000-0000-4000-8000-0000000000b1', 'Baseline 1 0070', 'checking'),
  ('c7000000-0000-4000-8000-0000000000b1', 'Baseline 2 0070', 'checking');

RESET ROLE;

DO $$
DECLARE
  v_gate uuid;
  v_tenant uuid;
  v_used bigint;
  v_direct bigint;
BEGIN
  v_gate := private.resolve_writable_tenant('c7000000-0000-4000-8000-0000000000b1');
  v_tenant := private.resolve_user_tenant('c7000000-0000-4000-8000-0000000000b1');
  IF v_gate IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d4'
     OR v_tenant IS DISTINCT FROM 'c7000000-0000-4000-8000-0000000000d4' THEN
    RAISE EXCEPTION '0070 T-usage-02 falhou: baseline de resolucao divergente (%/%)', v_tenant, v_gate;
  END IF;

  SELECT used INTO v_used FROM public.get_tenant_usage(NULL) WHERE resource = 'accounts';
  SELECT count(*) INTO v_direct FROM public.accounts
  WHERE tenant_id = v_gate;

  IF v_used IS DISTINCT FROM v_direct THEN
    RAISE EXCEPTION '0070 T-usage-02 falhou: consumo (%) difere do baseline (%)', v_used, v_direct;
  END IF;
  IF v_used <> 2 THEN
    RAISE EXCEPTION '0070 T-usage-02 falhou: baseline de contas divergente (%)', v_used;
  END IF;
  RAISE NOTICE '0070 T-usage-02 ok: sem pin = baseline 0061/0064';
END $$;
ROLLBACK;

-- ============ Fixtures 0071 — cleanup (postgres bypass RLS) ============
BEGIN;
SET LOCAL app.card_purge = 'on';

DELETE FROM public.admin_audit
WHERE target_id IN (
  'c7100000-0000-4000-8000-0000000000a1',
  'c7100000-0000-4000-8000-0000000000a2',
  'c7100000-0000-4000-8000-0000000000a3',
  'c7100000-0000-4000-8000-0000000000a4',
  'c7100000-0000-4000-8000-0000000000b1',
  'c7100000-0000-4000-8000-0000000000b2',
  'c7100000-0000-4000-8000-0000000000b3',
  'c7100000-0000-4000-8000-0000000000b4',
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
)
OR actor_id IN (
  'c7100000-0000-4000-8000-0000000000a1',
  'c7100000-0000-4000-8000-0000000000a2',
  'c7100000-0000-4000-8000-0000000000a3',
  'c7100000-0000-4000-8000-0000000000a4',
  'c7100000-0000-4000-8000-0000000000b1',
  'c7100000-0000-4000-8000-0000000000b2',
  'c7100000-0000-4000-8000-0000000000b3',
  'c7100000-0000-4000-8000-0000000000b4'
);

DELETE FROM public.usage_events
WHERE tenant_id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.tenant_invoices
WHERE tenant_id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.tenant_members
WHERE tenant_id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.tenants
WHERE id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.internal_operators
WHERE user_id IN (
  'c7100000-0000-4000-8000-0000000000a1',
  'c7100000-0000-4000-8000-0000000000a2',
  'c7100000-0000-4000-8000-0000000000a3',
  'c7100000-0000-4000-8000-0000000000a4',
  'c7100000-0000-4000-8000-0000000000b1',
  'c7100000-0000-4000-8000-0000000000b2',
  'c7100000-0000-4000-8000-0000000000b3',
  'c7100000-0000-4000-8000-0000000000b4'
);
DELETE FROM auth.users
WHERE id IN (
  'c7100000-0000-4000-8000-0000000000a1',
  'c7100000-0000-4000-8000-0000000000a2',
  'c7100000-0000-4000-8000-0000000000a3',
  'c7100000-0000-4000-8000-0000000000a4',
  'c7100000-0000-4000-8000-0000000000b1',
  'c7100000-0000-4000-8000-0000000000b2',
  'c7100000-0000-4000-8000-0000000000b3',
  'c7100000-0000-4000-8000-0000000000b4'
);

COMMIT;

-- ============ Fixtures 0071 — usuários e tenants ============
INSERT INTO auth.users (id, email) VALUES
  ('c7100000-0000-4000-8000-0000000000a1', 'at-op-0071@example.com'),
  ('c7100000-0000-4000-8000-0000000000a2', 'at-opi-0071@example.com'),
  ('c7100000-0000-4000-8000-0000000000a3', 'at-opf-0071@example.com'),
  ('c7100000-0000-4000-8000-0000000000a4', 'at-us-0071@example.com'),
  ('c7100000-0000-4000-8000-0000000000b1', 'at-m1-0071@example.com'),
  ('c7100000-0000-4000-8000-0000000000b2', 'at-m2-0071@example.com'),
  ('c7100000-0000-4000-8000-0000000000b3', 'at-m3-0071@example.com'),
  ('c7100000-0000-4000-8000-0000000000b4', 'at-m4-0071@example.com');

-- Operador canônico (super_admin + aal2 + ativo), operador inativo, operador
-- com primeiro acesso pendente e usuário comum (gate not-admin).
UPDATE public.profiles SET role = 'super_admin', must_change_password = false
WHERE id = 'c7100000-0000-4000-8000-0000000000a1';
UPDATE public.profiles SET role = 'super_admin', must_change_password = false
WHERE id = 'c7100000-0000-4000-8000-0000000000a2';
UPDATE public.profiles SET role = 'super_admin', must_change_password = true
WHERE id = 'c7100000-0000-4000-8000-0000000000a3';
UPDATE public.profiles SET role = 'user', must_change_password = false
WHERE id = 'c7100000-0000-4000-8000-0000000000a4';
-- Matriz T-par-01: (role × must_change_password)
UPDATE public.profiles SET role = 'user', must_change_password = false
WHERE id = 'c7100000-0000-4000-8000-0000000000b1';
UPDATE public.profiles SET role = 'user', must_change_password = true
WHERE id = 'c7100000-0000-4000-8000-0000000000b2';
UPDATE public.profiles SET role = 'super_admin', must_change_password = false
WHERE id = 'c7100000-0000-4000-8000-0000000000b3';
UPDATE public.profiles SET role = 'super_admin', must_change_password = true
WHERE id = 'c7100000-0000-4000-8000-0000000000b4';

INSERT INTO public.internal_operators (user_id, active) VALUES
  ('c7100000-0000-4000-8000-0000000000a1', true),
  ('c7100000-0000-4000-8000-0000000000a2', false),
  ('c7100000-0000-4000-8000-0000000000a3', true),
  ('c7100000-0000-4000-8000-0000000000b3', true),
  ('c7100000-0000-4000-8000-0000000000b4', true);

BEGIN;
ALTER TABLE public.tenants DISABLE TRIGGER tenant_acceptance_required;

INSERT INTO public.tenants
  (id, kind, owner_user_id, cpf, razao_social, nome_fantasia, plan_id, subscription_status)
VALUES
  ('c7100000-0000-4000-8000-0000000000d1', 'pf',
   'c7100000-0000-4000-8000-0000000000a1', '71000000101',
   'Alfa 0071', NULL, 'free', 'active'),
  ('c7100000-0000-4000-8000-0000000000d2', 'pf',
   'c7100000-0000-4000-8000-0000000000a4', '71000000102',
   'Beta 0071', NULL, 'free', 'active'),
  ('c7100000-0000-4000-8000-0000000000d3', 'pf',
   'c7100000-0000-4000-8000-0000000000a1', '71000000103',
   'Gama 0071', NULL, 'free', 'active'),
  ('c7100000-0000-4000-8000-0000000000d4', 'pf',
   'c7100000-0000-4000-8000-0000000000a1', '71000000104',
   'Delta 0071', NULL, 'pro', 'active'),
  ('c7100000-0000-4000-8000-0000000000d5', 'pf',
   'c7100000-0000-4000-8000-0000000000a1', '71000000105',
   'Epsilon 0071', NULL, 'standard', 'past_due'),
  ('c7100000-0000-4000-8000-0000000000d6', 'pf',
   'c7100000-0000-4000-8000-0000000000a1', '71000000106',
   'Zeta 0071', NULL, 'standard', 'trial');

ALTER TABLE public.tenants ENABLE TRIGGER tenant_acceptance_required;
COMMIT;

-- ============ T-read-01 — estrutura das RPCs de leitura (0071) ============
DO $$
DECLARE
  v_proc pg_proc;
  v_n bigint;
  v_fn text;
  v_result text;
BEGIN
  IF to_regprocedure('public.admin_usage_series(date, date, uuid)') IS NULL
     OR to_regprocedure('public.admin_mrr_summary(date)') IS NULL THEN
    RAISE EXCEPTION '0071 T-read-01 falhou: assinatura de funcao ausente';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc
  WHERE proname = 'admin_usage_series' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0071 T-read-01 falhou: admin_usage_series com % assinaturas', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
  WHERE proname = 'admin_mrr_summary' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0071 T-read-01 falhou: admin_mrr_summary com % assinaturas', v_n;
  END IF;

  -- retorno exato (forma congelada)
  v_result := pg_get_function_result(to_regprocedure('public.admin_usage_series(date, date, uuid)'));
  IF v_result NOT LIKE '%competencia date%'
     OR v_result NOT LIKE '%tenant_id uuid%'
     OR v_result NOT LIKE '%events bigint%' THEN
    RAISE EXCEPTION '0071 T-read-01 falhou: retorno de admin_usage_series divergente (%)', v_result;
  END IF;
  IF pg_get_function_result(to_regprocedure('public.admin_mrr_summary(date)')) <> 'jsonb' THEN
    RAISE EXCEPTION '0071 T-read-01 falhou: admin_mrr_summary nao devolve jsonb';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
      'public.admin_usage_series(date, date, uuid)',
      'public.admin_mrr_summary(date)'] LOOP
    SELECT * INTO v_proc FROM pg_proc WHERE oid = to_regprocedure(v_fn);
    IF v_proc.prosecdef IS NOT TRUE THEN
      RAISE EXCEPTION '0071 T-read-01 falhou: % sem SECURITY DEFINER', v_fn;
    END IF;
    IF v_proc.provolatile <> 's' THEN
      RAISE EXCEPTION '0071 T-read-01 falhou: % nao e STABLE', v_fn;
    END IF;
    IF v_proc.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc.proconfig) AS c
      WHERE c IN ('search_path=', 'search_path=""')
    ) THEN
      RAISE EXCEPTION '0071 T-read-01 falhou: % sem search_path='''' travado', v_fn;
    END IF;
    -- dinheiro em BIGINT: nenhum float/double/numeric no corpo
    IF position('float' IN pg_catalog.lower(v_proc.prosrc)) > 0
       OR position('double precision' IN pg_catalog.lower(v_proc.prosrc)) > 0
       OR position('::numeric' IN pg_catalog.lower(v_proc.prosrc)) > 0 THEN
      RAISE EXCEPTION '0071 T-read-01 falhou: % usa tipo nao-inteiro para dinheiro', v_fn;
    END IF;

    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0071 T-read-01 falhou: authenticated sem EXECUTE em %', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0071 T-read-01 falhou: anon/service_role com EXECUTE em %', v_fn;
    END IF;
    SELECT count(*) INTO v_n
    FROM pg_proc AS p, pg_catalog.aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure(v_fn) AND a.grantee = 0;
    IF v_n <> 0 THEN
      RAISE EXCEPTION '0071 T-read-01 falhou: PUBLIC com EXECUTE em %', v_fn;
    END IF;
  END LOOP;

  -- 0071 registrada
  SELECT count(*) INTO v_n FROM supabase_migrations.schema_migrations
  WHERE version = '0071';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0071 T-read-01 falhou: migration 0071 nao registrada (% linhas)', v_n;
  END IF;

  RAISE NOTICE '0071 T-read-01 ok: 1 assinatura cada, STABLE, DEFINER, search_path vazio, retorno exato, so authenticated';
END $$;

-- ============ T-read-02 — default 12 competências SP + count(*) ============
BEGIN;
DO $$
DECLARE
  v_m0 date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_m11 date := (pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo') - interval '11 months')::date;
  v_m12 date := (pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo') - interval '12 months')::date;
  v_n bigint;
  v_comps date[];
  v_events bigint[];
  v_tenants uuid[];
BEGIN
  INSERT INTO public.usage_events (tenant_id, competencia, dedup_key) VALUES
    ('c7100000-0000-4000-8000-0000000000d1', v_m0, 'r2-a'),
    ('c7100000-0000-4000-8000-0000000000d1', v_m0, 'r2-b'),
    ('c7100000-0000-4000-8000-0000000000d1', v_m0, 'r2-c'),
    ('c7100000-0000-4000-8000-0000000000d1', v_m11, 'r2-d'),
    ('c7100000-0000-4000-8000-0000000000d1', v_m12, 'r2-e'),
    ('c7100000-0000-4000-8000-0000000000d2', v_m0, 'r2-f');

  PERFORM set_config('request.jwt.claim.sub', 'c7100000-0000-4000-8000-0000000000a1', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    '{"sub":"c7100000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- default (p_from/p_to NULL): mês corrente + 11 anteriores ⇒ M0-12 fora
  SELECT count(*) INTO v_n
  FROM public.admin_usage_series(NULL, NULL, 'c7100000-0000-4000-8000-0000000000d1');
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0071 T-read-02 falhou: default devolveu % linhas (esperado 2)', v_n;
  END IF;

  SELECT pg_catalog.array_agg(competencia ORDER BY competencia),
         pg_catalog.array_agg(events ORDER BY competencia)
    INTO v_comps, v_events
  FROM public.admin_usage_series(NULL, NULL, 'c7100000-0000-4000-8000-0000000000d1');
  IF v_comps IS DISTINCT FROM ARRAY[v_m11, v_m0] THEN
    RAISE EXCEPTION '0071 T-read-02 falhou: janela default divergente (%)', v_comps;
  END IF;
  IF v_events IS DISTINCT FROM ARRAY[1::bigint, 3::bigint] THEN
    RAISE EXCEPTION '0071 T-read-02 falhou: count(*) por competencia divergente (%)', v_events;
  END IF;

  -- range explícito sobrepõe o default (inclui M0-12)
  SELECT count(*) INTO v_n
  FROM public.admin_usage_series(v_m12, v_m0, 'c7100000-0000-4000-8000-0000000000d1');
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0071 T-read-02 falhou: range explicito devolveu % linhas (esperado 3)', v_n;
  END IF;

  -- sem p_tenant: todos os tenants, ordem competencia ASC, tenant_id ASC
  SELECT count(*) INTO v_n FROM public.admin_usage_series(NULL, NULL, NULL);
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0071 T-read-02 falhou: serie global devolveu % linhas (esperado 3)', v_n;
  END IF;

  SELECT pg_catalog.array_agg(competencia ORDER BY ord),
         pg_catalog.array_agg(tenant_id ORDER BY ord),
         pg_catalog.array_agg(events ORDER BY ord)
    INTO v_comps, v_tenants, v_events
  FROM (SELECT competencia, tenant_id, events, row_number() OVER () AS ord
        FROM public.admin_usage_series(NULL, NULL, NULL)) AS r;
  IF v_comps IS DISTINCT FROM ARRAY[v_m11, v_m0, v_m0]
     OR v_tenants IS DISTINCT FROM ARRAY[
       'c7100000-0000-4000-8000-0000000000d1'::uuid,
       'c7100000-0000-4000-8000-0000000000d1'::uuid,
       'c7100000-0000-4000-8000-0000000000d2'::uuid]
     OR v_events IS DISTINCT FROM ARRAY[1::bigint, 3::bigint, 1::bigint] THEN
    RAISE EXCEPTION '0071 T-read-02 falhou: ordem/agrupamento global divergente (%/%/%)',
      v_comps, v_tenants, v_events;
  END IF;

  RAISE NOTICE '0071 T-read-02 ok: default 12 competencias SP, count(*) por tenant/competencia';
END $$;
ROLLBACK;

-- ============ T-read-03 — usage-range-invalid ============
BEGIN;
DO $$
DECLARE
  v_m0 date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_n bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c7100000-0000-4000-8000-0000000000a1', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    '{"sub":"c7100000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- p_to < p_from
  BEGIN
    PERFORM * FROM public.admin_usage_series(v_m0, v_m0 - 1, NULL);
    RAISE EXCEPTION '0071 T-read-03 falhou: aceitou p_to < p_from';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0071 T-read-03 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'usage-range-invalid' THEN
        RAISE EXCEPTION '0071 T-read-03 falhou: rotulo errado para to<from (%)', SQLERRM;
      END IF;
  END;

  -- janela > 24 meses (25 competências)
  BEGIN
    PERFORM * FROM public.admin_usage_series((v_m0 - interval '24 months')::date, v_m0, NULL);
    RAISE EXCEPTION '0071 T-read-03 falhou: aceitou janela de 25 meses';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0071 T-read-03 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'usage-range-invalid' THEN
        RAISE EXCEPTION '0071 T-read-03 falhou: rotulo errado para >24m (%)', SQLERRM;
      END IF;
  END;

  -- borda: exatamente 24 meses passa
  SELECT count(*) INTO v_n
  FROM public.admin_usage_series((v_m0 - interval '23 months')::date, v_m0, NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0071 T-read-03 falhou: base sem eventos devolveu % linhas', v_n;
  END IF;

  RAISE NOTICE '0071 T-read-03 ok: usage-range-invalid (to<from, >24m); 24m exatos passam';
END $$;
ROLLBACK;

-- ============ T-read-04 — gate not-admin nas duas RPCs ============
BEGIN;
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c7100000-0000-4000-8000-0000000000a4', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    '{"sub":"c7100000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    PERFORM * FROM public.admin_usage_series(NULL, NULL, NULL);
    RAISE EXCEPTION '0071 T-read-04 falhou: nao-operador leu a serie';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0071 T-read-04 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-admin' THEN
        RAISE EXCEPTION '0071 T-read-04 falhou: rotulo errado em usage_series (%)', SQLERRM;
      END IF;
  END;

  BEGIN
    PERFORM public.admin_mrr_summary(NULL);
    RAISE EXCEPTION '0071 T-read-04 falhou: nao-operador leu o MRR';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '0071 T-read-04 falhou%' THEN RAISE; END IF;
      IF SQLERRM <> 'not-admin' THEN
        RAISE EXCEPTION '0071 T-read-04 falhou: rotulo errado em mrr_summary (%)', SQLERRM;
      END IF;
  END;

  RAISE NOTICE '0071 T-read-04 ok: not-admin sem operador nas duas RPCs';
END $$;
ROLLBACK;

-- ============ T-read-05 — forma congelada do MRR (chaves e tipos) ============
BEGIN;
DO $$
DECLARE
  v_payload jsonb;
  v_n bigint;
  v_m0 date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c7100000-0000-4000-8000-0000000000a1', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    '{"sub":"c7100000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_payload := public.admin_mrr_summary(NULL);
  IF pg_catalog.jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION '0071 T-read-05 falhou: retorno nao e objeto jsonb';
  END IF;

  SELECT count(*) INTO v_n FROM pg_catalog.jsonb_object_keys(v_payload);
  IF v_n <> 6 THEN
    RAISE EXCEPTION '0071 T-read-05 falhou: % chaves (esperado 6)', v_n;
  END IF;
  IF NOT (v_payload ?& ARRAY[
      'competencia', 'mrr_cents', 'active_count',
      'past_due_count', 'overdue_cents', 'overdue_count']) THEN
    RAISE EXCEPTION '0071 T-read-05 falhou: chaves divergentes (%)', v_payload;
  END IF;

  IF v_payload->>'competencia' <> pg_catalog.to_char(v_m0, 'YYYY-MM-DD') THEN
    RAISE EXCEPTION '0071 T-read-05 falhou: competencia default divergente (%)',
      v_payload->>'competencia';
  END IF;
  IF pg_catalog.jsonb_typeof(v_payload->'mrr_cents') <> 'number'
     OR (v_payload->>'mrr_cents') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION '0071 T-read-05 falhou: mrr_cents nao e inteiro em cents (%)',
      v_payload->>'mrr_cents';
  END IF;
  IF pg_catalog.jsonb_typeof(v_payload->'overdue_cents') <> 'number'
     OR (v_payload->>'overdue_cents') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION '0071 T-read-05 falhou: overdue_cents nao e inteiro em cents (%)',
      v_payload->>'overdue_cents';
  END IF;
  IF (v_payload->>'active_count') !~ '^[0-9]+$'
     OR (v_payload->>'past_due_count') !~ '^[0-9]+$'
     OR (v_payload->>'overdue_count') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION '0071 T-read-05 falhou: contadores nao inteiros (%)', v_payload;
  END IF;

  -- p_competencia normalizada ao dia 1
  IF public.admin_mrr_summary('2026-03-17'::date)->>'competencia' <> '2026-03-01' THEN
    RAISE EXCEPTION '0071 T-read-05 falhou: p_competencia nao normalizada ao dia 1 (%)',
      public.admin_mrr_summary('2026-03-17'::date)->>'competencia';
  END IF;

  RAISE NOTICE '0071 T-read-05 ok: 6 chaves congeladas, cents inteiros, competencia dia 1';
END $$;
ROLLBACK;

-- ============ T-read-06 — prova do MRR (O-F4-5: só `active` conta) ============
BEGIN;
DELETE FROM public.tenant_invoices;
DELETE FROM public.tenant_subscriptions;

DO $$
DECLARE
  v_m0 date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_sub uuid;
  v_payload jsonb;
  v_pro_cents bigint;
  v_std_cents bigint;
BEGIN
  SELECT pc.price_cents INTO v_pro_cents FROM public.plan_catalog AS pc WHERE pc.slug = 'pro';
  SELECT pc.price_cents INTO v_std_cents FROM public.plan_catalog AS pc WHERE pc.slug = 'standard';

  -- 2 `active` (free + pro), 1 `past_due` (standard) e 1 `trial` (standard).
  INSERT INTO public.tenant_subscriptions (tenant_id, plan_slug, status, billing_day)
  VALUES
    ('c7100000-0000-4000-8000-0000000000d3', 'free', 'active', NULL),
    ('c7100000-0000-4000-8000-0000000000d4', 'pro', 'active', 1),
    ('c7100000-0000-4000-8000-0000000000d5', 'standard', 'past_due', 10);

  INSERT INTO public.tenant_subscriptions
    (tenant_id, plan_slug, status, billing_day, trial_ends_at)
  VALUES
    ('c7100000-0000-4000-8000-0000000000d6', 'standard', 'trial', 5,
     pg_catalog.now() + interval '7 days');

  SELECT s.id INTO v_sub FROM public.tenant_subscriptions AS s
  WHERE s.tenant_id = 'c7100000-0000-4000-8000-0000000000d5';

  -- 1 fatura `overdue` do tenant past_due
  INSERT INTO public.tenant_invoices
    (tenant_id, subscription_id, competencia, period_start, period_end, due_date,
     amount_cents, status)
  VALUES
    ('c7100000-0000-4000-8000-0000000000d5', v_sub, v_m0,
     (v_m0 - interval '1 month')::date, v_m0, (v_m0 + 10), v_std_cents, 'overdue');

  PERFORM set_config('request.jwt.claim.sub', 'c7100000-0000-4000-8000-0000000000a1', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    '{"sub":"c7100000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_payload := public.admin_mrr_summary(NULL);

  -- MRR = preço SÓ do `pro` ativo (free = 0; past_due e trial FORA)
  IF (v_payload->>'mrr_cents')::bigint <> v_pro_cents THEN
    RAISE EXCEPTION '0071 T-read-06 falhou: mrr_cents = % (esperado % = so o pro ativo)',
      v_payload->>'mrr_cents', v_pro_cents;
  END IF;
  IF (v_payload->>'active_count')::int <> 2 THEN
    RAISE EXCEPTION '0071 T-read-06 falhou: active_count = % (esperado 2: free+pro)',
      v_payload->>'active_count';
  END IF;
  IF (v_payload->>'past_due_count')::int <> 1 THEN
    RAISE EXCEPTION '0071 T-read-06 falhou: past_due_count = % (esperado 1)',
      v_payload->>'past_due_count';
  END IF;
  IF (v_payload->>'overdue_cents')::bigint <> v_std_cents THEN
    RAISE EXCEPTION '0071 T-read-06 falhou: overdue_cents = % (esperado % da fatura)',
      v_payload->>'overdue_cents', v_std_cents;
  END IF;
  IF (v_payload->>'overdue_count')::int <> 1 THEN
    RAISE EXCEPTION '0071 T-read-06 falhou: overdue_count = % (esperado 1)',
      v_payload->>'overdue_count';
  END IF;

  RAISE NOTICE '0071 T-read-06 ok: MRR = pro ativo (% cents); past_due/trial fora; overdue = fatura', v_pro_cents;
END $$;
ROLLBACK;

-- ============ T-read-07 — base vazia ⇒ 0 e [] ============
BEGIN;
DELETE FROM public.tenant_invoices;
DELETE FROM public.tenant_subscriptions;
DELETE FROM public.usage_events;

DO $$
DECLARE
  v_payload jsonb;
  v_n bigint;
  v_m0 text := pg_catalog.to_char(
    pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date,
    'YYYY-MM-DD');
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'c7100000-0000-4000-8000-0000000000a1', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    '{"sub":"c7100000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_payload := public.admin_mrr_summary(NULL);
  IF v_payload->>'mrr_cents' <> '0'
     OR v_payload->>'active_count' <> '0'
     OR v_payload->>'past_due_count' <> '0'
     OR v_payload->>'overdue_cents' <> '0'
     OR v_payload->>'overdue_count' <> '0' THEN
    RAISE EXCEPTION '0071 T-read-07 falhou: base vazia devolveu valores nao-zero (%)', v_payload;
  END IF;
  IF v_payload->>'competencia' <> v_m0 THEN
    RAISE EXCEPTION '0071 T-read-07 falhou: competencia default divergente (%)',
      v_payload->>'competencia';
  END IF;

  SELECT count(*) INTO v_n FROM public.admin_usage_series(NULL, NULL, NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0071 T-read-07 falhou: base vazia devolveu % linhas na serie', v_n;
  END IF;

  RAISE NOTICE '0071 T-read-07 ok: base vazia -> 0/[] sem erro';
END $$;
ROLLBACK;

-- ============ T-par-01 — paridade Edge × SQL: 16 casos ============
-- A MESMA tabela de expectativa vive em
-- `supabase/functions/verify-operator/index_test.ts` (BE-46b): colunas
-- must_change_password, role, aal, operator.active -> resultado.
-- Vocabulário compartilhado: allow | deny | first-access | mfa-required |
-- operator-inactive. Aqui `allow` = is_super_admin() true; `deny` = false sem
-- raise; os rótulos = exceção com a mesma mensagem do Edge.
BEGIN;
DO $$
DECLARE
  v_case record;
  v_uid uuid;
  v_got text;
  v_total int := 0;
BEGIN
  FOR v_case IN
    SELECT * FROM (VALUES
      (false, 'user',        'aal1', false, 'deny'),
      (false, 'user',        'aal1', true,  'deny'),
      (false, 'user',        'aal2', false, 'deny'),
      (false, 'user',        'aal2', true,  'deny'),
      (false, 'super_admin', 'aal1', false, 'mfa-required'),
      (false, 'super_admin', 'aal1', true,  'mfa-required'),
      (false, 'super_admin', 'aal2', false, 'operator-inactive'),
      (false, 'super_admin', 'aal2', true,  'allow'),
      (true,  'user',        'aal1', false, 'first-access'),
      (true,  'user',        'aal1', true,  'first-access'),
      (true,  'user',        'aal2', false, 'first-access'),
      (true,  'user',        'aal2', true,  'first-access'),
      (true,  'super_admin', 'aal1', false, 'first-access'),
      (true,  'super_admin', 'aal1', true,  'first-access'),
      (true,  'super_admin', 'aal2', false, 'first-access'),
      (true,  'super_admin', 'aal2', true,  'first-access')
    ) AS t(p_must, p_role, p_aal, p_active, p_expected)
  LOOP
    v_total := v_total + 1;

    -- usuário por (role × must_change_password)
    v_uid := CASE
      WHEN v_case.p_role = 'user' AND NOT v_case.p_must
        THEN 'c7100000-0000-4000-8000-0000000000b1'::uuid
      WHEN v_case.p_role = 'user' AND v_case.p_must
        THEN 'c7100000-0000-4000-8000-0000000000b2'::uuid
      WHEN NOT v_case.p_must
        THEN 'c7100000-0000-4000-8000-0000000000b3'::uuid
      ELSE 'c7100000-0000-4000-8000-0000000000b4'::uuid
    END;

    IF v_case.p_role = 'super_admin' THEN
      UPDATE public.internal_operators SET active = v_case.p_active
      WHERE user_id = v_uid;
    END IF;

    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims',
      pg_catalog.format(
        '{"sub":"%s","role":"authenticated","aal":"%s"}', v_uid, v_case.p_aal),
      true);

    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      IF public.is_super_admin() THEN
        v_got := 'allow';
      ELSE
        v_got := 'deny';
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        v_got := CASE SQLERRM
          WHEN 'first-access-password-change-required' THEN 'first-access'
          WHEN 'mfa-required' THEN 'mfa-required'
          WHEN 'operator-inactive' THEN 'operator-inactive'
          ELSE SQLERRM
        END;
    END;
    EXECUTE 'RESET ROLE';

    IF v_got IS DISTINCT FROM v_case.p_expected THEN
      RAISE EXCEPTION
        '0071 T-par-01 falhou: (must=%, role=%, aal=%, active=%) => % (esperado %)',
        v_case.p_must, v_case.p_role, v_case.p_aal, v_case.p_active,
        v_got, v_case.p_expected;
    END IF;
  END LOOP;

  IF v_total <> 16 THEN
    RAISE EXCEPTION '0071 T-par-01 falhou: matriz com % casos (esperado 16)', v_total;
  END IF;

  RAISE NOTICE '0071 T-par-01 ok: 16 casos (must x role x aal x operator.active) iguais ao Edge';
END $$;
ROLLBACK;

-- ============ Fixtures 0071 — cleanup (fim) ============
BEGIN;
SET LOCAL app.card_purge = 'on';

DELETE FROM public.admin_audit
WHERE target_id IN (
  'c7100000-0000-4000-8000-0000000000a1',
  'c7100000-0000-4000-8000-0000000000a2',
  'c7100000-0000-4000-8000-0000000000a3',
  'c7100000-0000-4000-8000-0000000000a4',
  'c7100000-0000-4000-8000-0000000000b1',
  'c7100000-0000-4000-8000-0000000000b2',
  'c7100000-0000-4000-8000-0000000000b3',
  'c7100000-0000-4000-8000-0000000000b4',
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
)
OR actor_id IN (
  'c7100000-0000-4000-8000-0000000000a1',
  'c7100000-0000-4000-8000-0000000000a2',
  'c7100000-0000-4000-8000-0000000000a3',
  'c7100000-0000-4000-8000-0000000000a4',
  'c7100000-0000-4000-8000-0000000000b1',
  'c7100000-0000-4000-8000-0000000000b2',
  'c7100000-0000-4000-8000-0000000000b3',
  'c7100000-0000-4000-8000-0000000000b4'
);

DELETE FROM public.usage_events
WHERE tenant_id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.tenant_invoices
WHERE tenant_id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.tenant_subscriptions
WHERE tenant_id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.tenant_members
WHERE tenant_id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.tenants
WHERE id IN (
  'c7100000-0000-4000-8000-0000000000d1',
  'c7100000-0000-4000-8000-0000000000d2',
  'c7100000-0000-4000-8000-0000000000d3',
  'c7100000-0000-4000-8000-0000000000d4',
  'c7100000-0000-4000-8000-0000000000d5',
  'c7100000-0000-4000-8000-0000000000d6'
);
DELETE FROM public.internal_operators
WHERE user_id IN (
  'c7100000-0000-4000-8000-0000000000a1',
  'c7100000-0000-4000-8000-0000000000a2',
  'c7100000-0000-4000-8000-0000000000a3',
  'c7100000-0000-4000-8000-0000000000a4',
  'c7100000-0000-4000-8000-0000000000b1',
  'c7100000-0000-4000-8000-0000000000b2',
  'c7100000-0000-4000-8000-0000000000b3',
  'c7100000-0000-4000-8000-0000000000b4'
);
DELETE FROM auth.users
WHERE id IN (
  'c7100000-0000-4000-8000-0000000000a1',
  'c7100000-0000-4000-8000-0000000000a2',
  'c7100000-0000-4000-8000-0000000000a3',
  'c7100000-0000-4000-8000-0000000000a4',
  'c7100000-0000-4000-8000-0000000000b1',
  'c7100000-0000-4000-8000-0000000000b2',
  'c7100000-0000-4000-8000-0000000000b3',
  'c7100000-0000-4000-8000-0000000000b4'
);

COMMIT;

-- ============ Fixtures cleanup (fim) ============
BEGIN;
SET LOCAL app.card_purge = 'on';

DELETE FROM public.user_active_tenants
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);

DELETE FROM public.tenant_switches
WHERE actor_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
)
OR from_tenant_id IN (
  'c6900000-0000-4000-8000-0000000000d1',
  'c6900000-0000-4000-8000-0000000000d2',
  'c6900000-0000-4000-8000-0000000000d3',
  'c7000000-0000-4000-8000-0000000000d4',
  'c7000000-0000-4000-8000-0000000000d5',
  'c7000000-0000-4000-8000-0000000000d6',
  'c7000000-0000-4000-8000-0000000000d7'
)
OR to_tenant_id IN (
  'c6900000-0000-4000-8000-0000000000d1',
  'c6900000-0000-4000-8000-0000000000d2',
  'c6900000-0000-4000-8000-0000000000d3',
  'c7000000-0000-4000-8000-0000000000d4',
  'c7000000-0000-4000-8000-0000000000d5',
  'c7000000-0000-4000-8000-0000000000d6',
  'c7000000-0000-4000-8000-0000000000d7'
);

DELETE FROM public.transactions
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);
DELETE FROM public.credit_cards
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);
DELETE FROM public.budgets
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);
DELETE FROM public.accounts
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);

DELETE FROM public.admin_audit
WHERE actor_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
)
OR target_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7',
  'c6900000-0000-4000-8000-0000000000d1',
  'c6900000-0000-4000-8000-0000000000d2',
  'c6900000-0000-4000-8000-0000000000d3',
  'c7000000-0000-4000-8000-0000000000d4',
  'c7000000-0000-4000-8000-0000000000d5',
  'c7000000-0000-4000-8000-0000000000d6',
  'c7000000-0000-4000-8000-0000000000d7'
);

DELETE FROM public.tenant_members
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
)
OR tenant_id IN (
  'c6900000-0000-4000-8000-0000000000d1',
  'c6900000-0000-4000-8000-0000000000d2',
  'c6900000-0000-4000-8000-0000000000d3',
  'c7000000-0000-4000-8000-0000000000d4',
  'c7000000-0000-4000-8000-0000000000d5',
  'c7000000-0000-4000-8000-0000000000d6',
  'c7000000-0000-4000-8000-0000000000d7'
);

DELETE FROM public.tenants
WHERE owner_user_id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);

DELETE FROM public.internal_operators
WHERE user_id IN (
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2'
);

DELETE FROM auth.users
WHERE id IN (
  'c6900000-0000-4000-8000-0000000000a1',
  'c6900000-0000-4000-8000-0000000000a2',
  'c6900000-0000-4000-8000-0000000000a3',
  'c6900000-0000-4000-8000-0000000000a4',
  'c6900000-0000-4000-8000-0000000000f1',
  'c6900000-0000-4000-8000-0000000000f2',
  'c7000000-0000-4000-8000-0000000000b1',
  'c7000000-0000-4000-8000-0000000000c5',
  'c7000000-0000-4000-8000-0000000000c6',
  'c7000000-0000-4000-8000-0000000000c7'
);

COMMIT;
