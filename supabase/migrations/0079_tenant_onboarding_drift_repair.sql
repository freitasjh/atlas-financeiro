-- 0079_tenant_onboarding_drift_repair.sql — tenant-onboarding / F2 / ADR-006 (BE-25).
--
-- Motivo: o provisionamento (`0077`) é atômico, mas um tenant legado (dump/DBA)
-- ou uma escrita fora do caminho pode existir sem `membership`, sem `acceptance`
-- ou sem `subscription`. Sem diagnóstico, o painel só descobre o buraco quando a
-- quota responde fail-open (`ADR-005` §18.3 T-A6) ou o usuário entra sem vínculo.
--
-- Decisão congelada (ADR-006 D6, SPEC I8): drift é **reparado**, nunca recriado.
--   * `admin_tenant_onboarding_state(p_tenant)` — leitura pura; devolve
--     `(tenant_id, state, missing)` com `state ∈ {onboarding-complete,
--     tenant-provision-failed}` e `missing ⊂ {membership, acceptance,
--     subscription}` em ordem fixa. Tenant inexistente ⇒ `tenant-not-found`.
--   * `admin_repair_tenant_onboarding(p_tenant, p_contract_version DEFAULT NULL)`
--     — preenche **só** o que falta, com INSERT; nunca `UPDATE`, nunca `DELETE`;
--     **nunca concede trial**. 2ª chamada é no-op e devolve
--     `onboarding-complete` com zero escrita. Trilha `tenant_onboard_repaired:<peça>`.
--
-- Regras do reparo (REQ-13/REQ-20):
--   membership  → INSERT `(tenant_id, user_id = tenants.owner_user_id, role='owner')`.
--                 Role-drift (dono já vinculado com `member`/`admin`, ou outro
--                 usuário como `owner`) colidiria com `tenant_members_pkey` /
--                 `tenant_members_one_owner_uq` (23505 cru) — e I8 proíbe
--                 UPDATE ⇒ pré-validado: `tenant-onboarding-membership-role-manual`
--                 ANTES de qualquer INSERT (0 escrita; caso de runbook).
--                 `acceptance`  → exige `p_contract_version` explícito; ausente ⇒
--                 `tenant-onboarding-acceptance-manual` (pré-validado antes de
--                 qualquer INSERT ⇒ 0 escrita no erro).
--   subscription→ INSERT `status='active'`, `plan_slug = tenants.plan_id`,
--                 `trial_ends_at=NULL`, `past_due_since=NULL`, sem período.
--                 Plano pago exige `billing_day` (`0055`): usa o dia corrente em
--                 `America/Sao_Paulo`, como o nascimento (`0077`). O reparo não
--                 abre ciclo (`period_*` NULL) e não cria `trial` — reparar não é
--                 presente comercial (D6/REQ-20). Tenant `canceled` sem
--                 assinatura é pré-validado: `subscription-canceled-readonly`,
--                 0 escrita (o espelho de `0058` reescreveria `canceled→active`
--                 e devolveria acesso pago sem pagamento). Tenant `past_due`
--                 sem assinatura também é pré-validado:
--                 `tenant-onboarding-subscription-state-manual`, 0 escrita —
--                 `past_due_since` só nasce de `active + payment_overdue`
--                 (`0059`) e o reparo devolveria o tenant a `active` (review
--                 final da F2).
--
-- O espelho `tenants.plan_id`/`subscription_status` continua sendo o trigger
-- `tenant_subscriptions_mirror` (`0058`), na mesma transação: se o tenant legado
-- estava coerente (ex. `free`/`active`) a linha de assinatura é no-op de espelho
-- (0 trilha de status); se o legado tinha status divergente do plano, o espelho
-- corrige com `reason='onboarding'` (mesmo mecanismo do provisionamento). O corpo
-- desta RPC não emite `UPDATE`/`DELETE` — o invariante I8 é do corpo.
--
-- Erros por rótulo fixo, sem PII/id: `not-admin`, `tenant-not-found`,
-- `tenant-onboarding-membership-role-manual` (role-drift de membership:
-- runbook, nunca UPDATE), `subscription-canceled-readonly` (tenant `canceled`
-- sem assinatura: reparar concederia acesso pago sem pagamento),
-- `tenant-onboarding-subscription-state-manual` (tenant `past_due` sem
-- assinatura: `past_due_since` é derivado da cobrança — reparar reescreveria
-- `past_due → active` pelo espelho e sairia da carência sem pagamento),
-- `tenant-onboarding-acceptance-manual` (e `acceptance-version-invalid` quando a
-- versão informada fere o formato de `0024`, rótulo já existente no domínio).
--
-- Idempotente-safe: guard de pré-condição + CREATE OR REPLACE +
-- REVOKE/GRANT/COMMENT repetíveis. Migrations 0001–0078 intocadas. Zero tabela,
-- zero coluna nova (REQ-24). Nenhum valor monetário nesta fatia.

-- Pré-condição dura (fail-closed na aplicação): sem estas tabelas/função as RPCs
-- não cumprem o contrato e o erro só apareceria no runtime com DETAIL cru.
DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL
    OR to_regclass('public.tenant_members') IS NULL
    OR to_regclass('public.contract_acceptances') IS NULL
    OR to_regclass('public.tenant_subscriptions') IS NULL
    OR to_regclass('public.plan_catalog') IS NULL
    OR to_regclass('public.admin_audit') IS NULL
    OR to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'tenant-onboarding-drift-repair-precondition-missing';
  END IF;
END $$;

-- ============ 1. Diagnóstico derivado (leitura pura) ============

CREATE OR REPLACE FUNCTION public.admin_tenant_onboarding_state(p_tenant uuid)
RETURNS TABLE (
  tenant_id uuid,
  state text,
  missing text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
  v_missing text[] := ARRAY[]::text[];
BEGIN
  -- InitPlan: gate avaliado 1× por statement (precedente 0022/0032/0078).
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  SELECT t.owner_user_id INTO v_owner
  FROM public.tenants AS t
  WHERE t.id = p_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  -- Ordem fixa (REQ-12): membership, acceptance, subscription.
  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_members AS tm
    WHERE tm.tenant_id = p_tenant
      AND tm.user_id = v_owner
      AND tm.role = 'owner'
  ) THEN
    v_missing := v_missing || 'membership'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.contract_acceptances AS ca
    WHERE ca.tenant_id = p_tenant
  ) THEN
    v_missing := v_missing || 'acceptance'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_subscriptions AS s
    WHERE s.tenant_id = p_tenant
  ) THEN
    v_missing := v_missing || 'subscription'::text;
  END IF;

  RETURN QUERY
  SELECT p_tenant,
         CASE
           WHEN pg_catalog.cardinality(v_missing) = 0 THEN 'onboarding-complete'
           ELSE 'tenant-provision-failed'
         END,
         v_missing;
END;
$$;

COMMENT ON FUNCTION public.admin_tenant_onboarding_state(uuid) IS
  'ADR-006 D6/§10.3 (0079): diagnóstico DERIVADO do onboarding de um tenant. Gate is_admin(); tenant inexistente => tenant-not-found; state = onboarding-complete | tenant-provision-failed; missing em ordem fixa (membership, acceptance, subscription) — membership ausente quando nao existe (tenant_id, owner_user_id, role=owner). Leitura pura (nenhuma trilha). Sem PII: so UUID e rotulos. EXECUTE authenticated.';

-- ============ 2. Reparo (preenche só o que falta; nunca trial) ============

CREATE OR REPLACE FUNCTION public.admin_repair_tenant_onboarding(
  p_tenant uuid,
  p_contract_version text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_plan text;
  v_sub_status text;
  v_version text := pg_catalog.btrim(COALESCE(p_contract_version, ''));
  v_missing text[] := ARRAY[]::text[];
  v_piece text;
  v_day smallint;
  v_state text;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  SELECT t.owner_user_id, t.plan_id, t.subscription_status
    INTO v_owner, v_plan, v_sub_status
  FROM public.tenants AS t
  WHERE t.id = p_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  -- Diagnóstico na mesma ordem do `state`.
  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_members AS tm
    WHERE tm.tenant_id = p_tenant
      AND tm.user_id = v_owner
      AND tm.role = 'owner'
  ) THEN
    v_missing := v_missing || 'membership'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.contract_acceptances AS ca
    WHERE ca.tenant_id = p_tenant
  ) THEN
    v_missing := v_missing || 'acceptance'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_subscriptions AS s
    WHERE s.tenant_id = p_tenant
  ) THEN
    v_missing := v_missing || 'subscription'::text;
  END IF;

  -- 2ª chamada: nada a preencher ⇒ no-op absoluto (0 escrita).
  IF pg_catalog.cardinality(v_missing) = 0 THEN
    RETURN 'onboarding-complete';
  END IF;

  -- Pré-validações ANTES de qualquer INSERT: o erro não pode deixar outra peça
  -- escrita pela metade (atomicidade observável no rótulo). Ordem fixa:
  -- membership (role-drift) → subscription (canceled) → acceptance (versão).

  -- F1/role-drift: `missing` marca membership quando não existe
  -- `(tenant_id, owner_user_id, role='owner')`; o INSERT cego colide em
  -- `tenant_members_pkey` (dono já com `member`/`admin`) ou em
  -- `tenant_members_one_owner_uq` (outro usuário como `owner`) e devolve 23505
  -- cru com DETAIL. I8 proíbe UPDATE ⇒ é caso de runbook: rótulo fixo, 0 escrita.
  IF 'membership' = ANY (v_missing) THEN
    IF EXISTS (
      SELECT 1
      FROM public.tenant_members AS tm
      WHERE tm.tenant_id = p_tenant
        AND tm.user_id = v_owner
    ) OR EXISTS (
      SELECT 1
      FROM public.tenant_members AS tm
      WHERE tm.tenant_id = p_tenant
        AND tm.role = 'owner'
    ) THEN
      RAISE EXCEPTION 'tenant-onboarding-membership-role-manual';
    END IF;
  END IF;

  -- F2/canceled: `tenants.subscription_status` é espelho (`0022`/`0058`);
  -- reparar a assinatura de um tenant `canceled` nasceria `active` e o espelho
  -- de `0058` reescreveria `canceled -> active` na mesma transação — acesso
  -- pago sem pagamento. Reativar é ato comercial/pagamento (runbook), nunca
  -- reparo de drift.
  IF 'subscription' = ANY (v_missing) AND v_sub_status = 'canceled' THEN
    RAISE EXCEPTION 'subscription-canceled-readonly';
  END IF;

  -- F2/past_due (review final da F2): `past_due` é carência ATIVA com dívida;
  -- `past_due_since` só nasce da aresta `active + payment_overdue` (`0059`) e
  -- não é reconstruível a partir de `tenants` (nem plano, ciclo ou carência
  -- vivem lá). O reparo antigo inseria `active` e o espelho de `0058`
  -- reescrevia `past_due -> active` — o tenant sairia da carência sem
  -- pagamento. Inventar `past_due_since` seria forjar dívida: é runbook de
  -- cobrança, nunca reparo de drift.
  IF 'subscription' = ANY (v_missing) AND v_sub_status = 'past_due' THEN
    RAISE EXCEPTION 'tenant-onboarding-subscription-state-manual';
  END IF;

  -- Pré-validação do aceite: exige versão explícita e no formato de `0024`.
  IF 'acceptance' = ANY (v_missing) THEN
    IF v_version = '' THEN
      RAISE EXCEPTION 'tenant-onboarding-acceptance-manual';
    END IF;
    IF pg_catalog.char_length(v_version) NOT BETWEEN 1 AND 64
      OR v_version !~ '^[A-Za-z0-9._-]+$' THEN
      RAISE EXCEPTION 'acceptance-version-invalid';
    END IF;
  END IF;

  -- Caminho de escrita intencional (0028) + motivo do espelho (0058/0032).
  PERFORM pg_catalog.set_config('app.tenant_write', 'on', true);
  PERFORM pg_catalog.set_config('app.tenant_reason', 'onboarding', true);

  -- Ordem fixa de preenchimento: membership, acceptance, subscription.
  FOREACH v_piece IN ARRAY ARRAY['membership', 'acceptance', 'subscription']::text[]
  LOOP
    CONTINUE WHEN NOT (v_piece = ANY (v_missing));

    IF v_piece = 'membership' THEN
      INSERT INTO public.tenant_members (tenant_id, user_id, role)
      VALUES (p_tenant, v_owner, 'owner');
    ELSIF v_piece = 'acceptance' THEN
      INSERT INTO public.contract_acceptances (
        tenant_id, contract_version, accepted_at, user_id
      ) VALUES (
        p_tenant, v_version, pg_catalog.now(), v_owner
      );
    ELSE
      -- Reparo NUNCA dá trial: nasce `active` sem período (REQ-20). Plano pago
      -- exige `billing_day` (CHECK de 0055) — dia corrente em São Paulo, igual
      -- ao nascimento (0077); o ciclo (`period_*`) fica NULL.
      v_day := CASE
        WHEN v_plan = 'free' THEN NULL
        ELSE EXTRACT(day FROM pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now()))::smallint
      END;

      INSERT INTO public.tenant_subscriptions (
        tenant_id,
        plan_slug,
        status,
        psp_subscription_id,
        psp_customer_id,
        trial_ends_at,
        billing_day,
        period_start,
        period_end,
        past_due_since,
        pending_plan_slug,
        pending_plan_at,
        cancel_at_period_end
      ) VALUES (
        p_tenant,
        v_plan,
        'active',
        NULL,
        NULL,
        NULL,
        v_day,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        false
      );
    END IF;

    INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
    VALUES (
      v_uid,
      p_tenant,
      p_tenant,
      'other',
      'tenant_onboard_repaired:' || v_piece
    );
  END LOOP;

  -- Estado após o reparo (fonte única: a RPC de diagnóstico).
  SELECT s.state INTO v_state
  FROM public.admin_tenant_onboarding_state(p_tenant) AS s;

  RETURN v_state;
END;
$$;

COMMENT ON FUNCTION public.admin_repair_tenant_onboarding(uuid, text) IS
  'ADR-006 D6/§10.3 + REQ-13/REQ-20 (0079): repara drift preenchendo SO o que falta (membership/acceptance/subscription) por INSERT, em ordem fixa; nunca UPDATE, nunca DELETE, nunca trial. Pre-validacoes antes de qualquer INSERT (0 escrita): role-drift de membership (dono ja vinculado com outro role, ou outro usuario como owner) => tenant-onboarding-membership-role-manual (runbook; nunca 23505 cru); aceite exige versao explicita (senao tenant-onboarding-acceptance-manual); tenant canceled sem assinatura => subscription-canceled-readonly (o espelho 0058 tornaria canceled->active = acesso pago sem pagamento); tenant past_due sem assinatura => tenant-onboarding-subscription-state-manual (past_due_since so nasce de active+payment_overdue em 0059; reparar tornaria past_due->active pelo espelho). Assinatura nasce active, plan_slug=tenants.plan_id, trial_ends_at/past_due_since/período NULL; plano pago recebe billing_day SP (CHECK 0055). Trilha tenant_onboard_repaired:<peca> (action=other, reason constante => sem PII). Gate is_admin(); tenant-not-found; 2a chamada => onboarding-complete com 0 escrita. Devolve o estado pos-reparo. EXECUTE authenticated.';

-- ============ 3. ACL (REVOKE antes do GRANT) ============

REVOKE ALL ON FUNCTION public.admin_tenant_onboarding_state(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_tenant_onboarding_state(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.admin_repair_tenant_onboarding(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_repair_tenant_onboarding(uuid, text)
  TO authenticated;
