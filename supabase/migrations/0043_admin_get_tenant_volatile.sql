-- 0043_admin_get_tenant_volatile.sql — internal-admin L3 / T07 (correção 0042).
--
-- Motivo: `admin_get_tenant` (0042) foi criada STABLE mas faz INSERT em
-- `admin_audit` (trilha de leitura auditada). Postgres recusa escrita em
-- função STABLE em tempo de chamada ("STABLE functions cannot modify the
-- database") — a leitura auditada nunca funcionaria. Precedente 0028
-- (`admin_set_tenant_status`, RPC de escrita): sem STABLE, i.e. VOLATILE
-- (o default). Recria a função idêntica à 0042 com a volatilidade removida.
-- Correção adicional provada pelo spec (mesmo espírito): a `CASE` do
-- document devolve bpchar (char(11)/char(14) de tenants) contra
-- `document text` do RETURNS TABLE — RETURN QUERY recusa ("structure of
-- query does not match function result type"). Cast explícito p/ text.
-- `admin_list_members` permanece STABLE (só leitura).
--
-- Prova: `supabase/tests/0042-internal-admin-reads.spec.sql` (T00 checa
-- provolatile='v'; T03 executa a chamada e confere a trilha).
--
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migration 0042 intocada (já aplicada). Sem dinheiro (só leitura).

CREATE OR REPLACE FUNCTION public.admin_get_tenant(p_tenant uuid)
RETURNS TABLE (
  id uuid,
  kind text,
  document text,
  razao_social text,
  nome_fantasia text,
  plan_id text,
  subscription_status text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_found boolean := false;
BEGIN
  -- InitPlan: gate avaliado 1× por statement (precedente 0031/0032).
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'not-admin';
  END IF;

  SELECT true INTO v_found FROM public.tenants AS t WHERE t.id = p_tenant;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'tenant-not-found';
  END IF;

  -- Trilha de leitura auditada (SPEC T07): sem documento/PII, só escopo.
  INSERT INTO public.admin_audit (actor_id, target_id, tenant_id, action, reason)
  VALUES (auth.uid(), p_tenant, p_tenant, 'other', 'internal_admin_read');

  RETURN QUERY
  SELECT t.id, t.kind,
    (CASE WHEN t.kind = 'pj' THEN t.cnpj WHEN t.kind = 'pf' THEN t.cpf ELSE NULL END)::text,
    t.razao_social, t.nome_fantasia, t.plan_id, t.subscription_status, t.created_at
  FROM public.tenants AS t
  WHERE t.id = p_tenant;
END;
$$;

COMMENT ON FUNCTION public.admin_get_tenant(uuid) IS
  'Internal-admin L3 (ADR-03, 0043): detalhe do tenant via RPC auditada (trilha admin_audit internal_admin_read). Gate is_admin(); só is_admin(); sem PII na trilha. VOLATILE: a função grava a trilha (0042 STABLE era incorreto — o Postgres recusa escrita em STABLE).';

REVOKE ALL ON FUNCTION public.admin_get_tenant(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_get_tenant(uuid)
  TO authenticated;
