-- 0074_impersonation_read.sql — internal-control-plane / F7 / ADR-005 (BE-73, BE-74, BE-75).
--
-- Motivo: é a ÚNICA superfície que aceita o token de impersonation. Precisa
-- devolver dado de tenant em escopo fechado (5 escopos) sem vazar PII, ids de
-- PSP, o `token_hash` da sessão nem escrever em dado de tenant.
--
-- Entrega (server-side; nenhuma escrita de dado de tenant):
--   1) `public.impersonation_read(p_token, p_tenant, p_scope, p_params) RETURNS jsonb`
--      VOLATILE, SECURITY DEFINER, search_path=''. Ordem literal (REQ-24):
--        (1) auth.uid() nulo ⇒ `not-authenticated`
--        (2) is_super_admin() — raises herdados; false ⇒ `not-admin`
--        (3)–(6) `private.impersonation_gate` (READ-ONLY)
--        (7) p_scope ∉ ('tenant','billing','usage','members','audit') ⇒
--            `impersonation-read-only`
--        (8) delegação SEMPRE com `v_session.tenant_id` (O-F7-5; nunca p_tenant)
--        (9) `reads += 1`, `last_read_at = now()` (única escrita)
--   2) Envelope EXATO de 4 chaves (REQ-26): `{scope, tenant, expires_at, data}`.
--      O composite da sessão (que inclui `token_hash`) NUNCA é projetado.
--   3) `scope='tenant'`: 7 chaves (`id, kind, razao_social, nome_fantasia,
--      plan_id, subscription_status, created_at`); SEM `document`.
--   4) `scope='billing'`: envelope do delegado SEM `subscription.psp_subscription_id`,
--      `subscription.psp_customer_id` e, em cada `invoices.items`, SEM
--      `psp_invoice_id`/`psp_payment_id`; `usage` permanece `null`.
--   5) `scope='usage'`: `{rows:[{resource,used,limit_max} × 5]}` (ordem do delegado).
--   6) `scope='members'`: `{items:[{user_id,role,created_at}], total}`; total antes
--      de limit/offset; ordem `created_at ASC, user_id ASC`.
--   7) `scope='audit'`: `{items:[linha de list_admin_audit_page], total}`; `reason`
--      REDIGIDO mecanicamente (O-F7-4), nesta ordem: (a) CNPJ formatado
--      `NN.NNN.NNN/NNNN-NN`; (b) CPF formatado `NNN.NNN.NNN-NN`; (c) corrida
--      contígua de 11+ dígitos (sem teto — cobre 15/16/20); (d) e-mail
--      (inclusive `foo@localhost`). Todos viram `***`; forma da linha preservada
--      (telefone `(11) 98765-4321` permanece — residual declarado). `total` pelo
--      MESMO predicado do delegado.
--   8) `p_params` (O-F7-7): `p_limit` default 20 / clamp 1..100; `p_offset`
--      default 0 / >= 0; `p_action` só quando string (senão ignorado).
--
-- Read-only de verdade: o gate NÃO grava (§6.2/Opção C) e `impersonation_read`
-- não faz INSERT/UPDATE/DELETE em dado de tenant nem em `admin_audit`. As únicas
-- escritas são `reads`/`last_read_at` na própria sessão. As trilhas
-- `internal_admin_read` vêm dos DELEGADOS pré-existentes (0042/0060/0064), não
-- desta função.
--
-- Sem dinheiro calculado aqui: `amount_cents` (BIGINT) só trafega no jsonb do
-- billing. Erros por rótulo fixo, sem token/id/PII.
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0073 intocadas.

CREATE OR REPLACE FUNCTION public.impersonation_read(
  p_token uuid,
  p_tenant uuid,
  p_scope text,
  p_params jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.impersonation_sessions;
  v_limit int;
  v_offset int;
  v_action text;
  v_data jsonb;
  v_rows jsonb;
  v_items jsonb;
  v_total int;
  v_billing jsonb;
BEGIN
  -- Passo 1: sessão.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  -- Passo 2: gate de operador (herda first-access/mfa/operator-inactive).
  -- NÃO sela nem audita (§6.2/Opção C).
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  -- Passos 3–6: gate READ-ONLY (lookup, ended, expiração, mismatch).
  SELECT * INTO v_session
  FROM private.impersonation_gate(p_token, p_tenant);

  -- Passo 7: enum fechado (igualdade exata, case-sensitive).
  IF p_scope IS NULL
     OR p_scope NOT IN ('tenant', 'billing', 'usage', 'members', 'audit') THEN
    RAISE EXCEPTION 'impersonation-read-only';
  END IF;

  -- p_params: clamp/default sem rótulo novo (O-F7-7). Regex limita a 9 dígitos
  -- antes do cast (evita `value out of range for type integer`).
  v_limit := CASE
    WHEN p_params IS NOT NULL
         AND (p_params ->> 'p_limit') ~ '^[0-9]{1,9}$'
      THEN LEAST(GREATEST((p_params ->> 'p_limit')::int, 1), 100)
    ELSE 20
  END;
  v_offset := CASE
    WHEN p_params IS NOT NULL
         AND (p_params ->> 'p_offset') ~ '^[0-9]{1,9}$'
      THEN GREATEST((p_params ->> 'p_offset')::int, 0)
    ELSE 0
  END;
  v_action := NULL;
  IF p_params IS NOT NULL
     AND pg_catalog.jsonb_typeof(p_params -> 'p_action') = 'string' THEN
    v_action := NULLIF(pg_catalog.btrim(p_params ->> 'p_action'), '');
  END IF;

  -- Passo 8: delegação — SEMPRE `v_session.tenant_id` (nunca p_tenant).
  IF p_scope = 'tenant' THEN
    SELECT pg_catalog.jsonb_build_object(
             'id', t.id,
             'kind', t.kind,
             'razao_social', t.razao_social,
             'nome_fantasia', t.nome_fantasia,
             'plan_id', t.plan_id,
             'subscription_status', t.subscription_status,
             'created_at', t.created_at)
      INTO v_data
    FROM public.admin_get_tenant(v_session.tenant_id) AS t;

  ELSIF p_scope = 'billing' THEN
    v_billing := public.admin_get_tenant_billing(v_session.tenant_id);

    v_billing := v_billing
      #- '{subscription,psp_subscription_id}'
      #- '{subscription,psp_customer_id}';

    SELECT pg_catalog.jsonb_set(
             v_billing,
             '{invoices,items}',
             COALESCE((
               SELECT pg_catalog.jsonb_agg(
                        e.item - 'psp_invoice_id' - 'psp_payment_id'
                        ORDER BY e.ord)
               FROM pg_catalog.jsonb_array_elements(
                      v_billing -> 'invoices' -> 'items') WITH ORDINALITY AS e(item, ord)
             ), '[]'::jsonb))
      INTO v_data;

  ELSIF p_scope = 'usage' THEN
    SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'resource', u.resource,
                 'used', u.used,
                 'limit_max', u.limit_max)
               ORDER BY u.ord),
             '[]'::jsonb)
      INTO v_rows
    FROM public.get_tenant_usage(v_session.tenant_id)
         WITH ORDINALITY AS u(resource, used, limit_max, ord);
    v_data := pg_catalog.jsonb_build_object('rows', v_rows);

  ELSIF p_scope = 'members' THEN
    SELECT count(*) INTO v_total
    FROM public.admin_list_members(v_session.tenant_id) AS m;

    SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'user_id', o.user_id,
                 'role', o.role,
                 'created_at', o.created_at)
               ORDER BY o.created_at ASC, o.user_id ASC),
             '[]'::jsonb)
      INTO v_items
    FROM (
      SELECT m.user_id, m.role, m.created_at
      FROM public.admin_list_members(v_session.tenant_id) AS m
      ORDER BY m.created_at ASC, m.user_id ASC
      LIMIT v_limit OFFSET v_offset
    ) AS o;

    v_data := pg_catalog.jsonb_build_object('items', v_items, 'total', v_total);

  ELSE
    -- p_scope = 'audit' (enum já validado no passo 7).
    SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'id', r.id,
                 'actor_id', r.actor_id,
                 'target_id', r.target_id,
                 'tenant_id', r.tenant_id,
                 'action', r.action,
                 'from_value', r.from_value,
                 'to_value', r.to_value,
                 'reason', r.reason_redacted,
                 'at', r.at)
               ORDER BY r.at DESC, r.id ASC),
             '[]'::jsonb)
      INTO v_items
    FROM (
      SELECT x.id, x.actor_id, x.target_id, x.tenant_id, x.action,
             x.from_value, x.to_value, x.at,
             CASE
               WHEN x.reason IS NULL THEN NULL
               ELSE pg_catalog.regexp_replace(
                      pg_catalog.regexp_replace(
                        pg_catalog.regexp_replace(
                          pg_catalog.regexp_replace(
                            x.reason,
                            -- 1) CNPJ formatado (separadores obrigatórios)
                            '[0-9]{2}\.[0-9]{3}\.[0-9]{3}/[0-9]{4}-[0-9]{2}',
                            '***', 'g'),
                          -- 2) CPF formatado (separadores obrigatórios)
                          '[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}',
                          '***', 'g'),
                        -- 3) corrida contígua sem teto (11+ dígitos)
                        '[0-9]{11,}',
                        '***', 'g'),
                      -- 4) e-mail (inclusive foo@localhost)
                      '[^@[:space:]]+@[^@[:space:]]+',
                      '***', 'g')
             END AS reason_redacted
      FROM public.list_admin_audit_page(
             v_session.tenant_id, v_action, v_limit, v_offset) AS x
    ) AS r;

    SELECT count(*) INTO v_total
    FROM public.admin_audit AS a
    WHERE (a.tenant_id = v_session.tenant_id OR a.target_id = v_session.tenant_id)
      AND (v_action IS NULL OR a.action = v_action);

    v_data := pg_catalog.jsonb_build_object('items', v_items, 'total', v_total);
  END IF;

  -- Passo 9: anotação durável da sessão (única escrita).
  UPDATE public.impersonation_sessions AS s
     SET reads = s.reads + 1,
         last_read_at = pg_catalog.now()
   WHERE s.id = v_session.id;

  -- Envelope EXATO de 4 chaves (REQ-26); nunca projeta o composite da sessão.
  RETURN pg_catalog.jsonb_build_object(
    'scope', p_scope,
    'tenant', v_session.tenant_id,
    'expires_at', v_session.expires_at,
    'data', v_data);
END;
$$;

COMMENT ON FUNCTION public.impersonation_read(uuid, uuid, text, jsonb) IS
  'F7/ADR-005 (0074): única superfície que aceita o token. Envelope de 4 chaves {scope,tenant,expires_at,data}; 5 escopos fechados; delega SEMPRE com v_session.tenant_id (O-F7-5); billing sem 4 psp_*; audit com reason redigido (O-F7-4); reads/last_read_at é a única escrita. NUNCA projeta o composite da sessão (token_hash).';

REVOKE ALL ON FUNCTION public.impersonation_read(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.impersonation_read(uuid, uuid, text, jsonb)
  TO authenticated;
