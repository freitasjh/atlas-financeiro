-- 0084_mfa_recovery_aal_hook.sql — mfa-recovery-codes / ADR-001 / HOOK-01.
--
-- Custom access token hook (SQL): transforma o grant one-shot gravado no
-- consume (0083) em claims.aal='aal2' + amr[0]={method:'recovery'} na emissão
-- do JWT. Sem grant vigente o evento volta INTACTO — refresh arbitrário a
-- partir de aal1 NÃO eleva (RF-13); aal2 de entrada nunca é rebaixado.
--
-- R1 (🔴 no ADR) RESOLVIDO: `claims.session_id` é claim REQUIRED no payload do
-- hook (docs oficiais, consultados 2026-11-21):
--   https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook
-- Logo a chave do grant é exatamente (event->'claims'->>'session_id',
-- event->>'user_id'), casando com p_session_id/auth.uid() da RPC consume.
--
-- Corpo congelado (ADR §3.3/§9.3 da SPEC):
--   1) aal já 'aal2' ⇒ evento intacto;
--   2) DELETE ... RETURNING indexado por session_id (PK), com
--      consumed_at IS NULL AND expires_at > now(); perdedor ⇒ intacto;
--   3) jsonb_set(claims,'{aal}','"aal2"') e
--      amr = [{"method":"recovery","timestamp":epoch}] || amr anterior;
--   4) jsonb_set(event,'{claims}',claims) — demais claims preservados.
--
-- PL/pgSQL SEM SECURITY DEFINER (docs F20/F24): a role que executa é
-- supabase_auth_admin, com USAGE em public + EXECUTE aqui + SELECT/DELETE na
-- tabela de grants (0082). Uma única DELETE indexada: orçamento 2 s (F24).
-- Idempotente-safe: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migration 0083 é pré-requisito. Deploy: ativar config.toml ANTES da UI.

-- ============ Guarda de dependência ============
DO $$
BEGIN
  IF to_regclass('public.mfa_recovery_aal_grants') IS NULL THEN
    RAISE EXCEPTION 'mfa-recovery-hook-missing-dependency';
  END IF;
END $$;

-- ============ Função do hook ============
CREATE OR REPLACE FUNCTION public.mfa_recovery_aal_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_claims jsonb := event -> 'claims';
  v_session_id text;
  v_user_id uuid;
  v_amr jsonb;
BEGIN
  -- 1. Nunca rebaixa: token já AAL2 volta exatamente como veio.
  IF COALESCE(v_claims ->> 'aal', '') = 'aal2' THEN
    RETURN event;
  END IF;

  -- R1: session_id vem do claim do evento, não de fonte externa.
  v_session_id := v_claims ->> 'session_id';
  v_user_id := nullif(event ->> 'user_id', '')::uuid;
  IF v_session_id IS NULL OR v_user_id IS NULL THEN
    RETURN event;
  END IF;

  -- 2. Uma DELETE indexada por PK (session_id). DELETE ... RETURNING é a
  --    autoridade one-shot: corrida perdedora não encontra linha.
  DELETE FROM public.mfa_recovery_aal_grants AS g
  WHERE g.session_id = v_session_id
    AND g.user_id = v_user_id
    AND g.consumed_at IS NULL
    AND g.expires_at > now()
  RETURNING g.session_id INTO v_session_id;
  IF NOT FOUND THEN
    RETURN event;
  END IF;

  -- 3. aal2 + amr com method recovery na frente (mais recente primeiro).
  v_claims := jsonb_set(v_claims, '{aal}', '"aal2"'::jsonb);
  v_amr := jsonb_build_array(jsonb_build_object(
    'method', 'recovery',
    'timestamp', pg_catalog.date_part('epoch', now())::bigint
  ));
  IF jsonb_typeof(v_claims -> 'amr') = 'array' THEN
    v_amr := v_amr || (v_claims -> 'amr');
  END IF;
  v_claims := jsonb_set(v_claims, '{amr}', v_amr);

  -- 4. Demais claims intactos.
  RETURN jsonb_set(event, '{claims}', v_claims);
END $$;

COMMENT ON FUNCTION public.mfa_recovery_aal_hook(jsonb) IS
  'ADR-001 (0084): custom access token hook. Consome grant one-shot por (claims.session_id, user_id) e eleva aal2 com amr[0]=recovery; sem grant/aal2 de entrada devolve evento intacto. Invoker (não DEFINER), 1 DELETE indexada, 2 s.';

-- Invoker por decisão congelada: grants explícitos, sem tag SECURITY DEFINER.
REVOKE ALL ON FUNCTION public.mfa_recovery_aal_hook(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mfa_recovery_aal_hook(jsonb) TO supabase_auth_admin;
