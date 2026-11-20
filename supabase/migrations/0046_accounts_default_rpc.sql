-- 0046_accounts_default_rpc.sql — troca de conta principal atômica.
--
-- Motivação: `createAccount` no cliente fazia dois round-trips
-- (UPDATE ... is_default=false seguido de INSERT is_default=true). Entre eles o
-- usuário ficava sem principal e, se o INSERT falhasse, a preferência era
-- perdida. Não existe UPDATE único no PostgREST que escreva valores diferentes
-- por linha, então a atomicidade vem de uma RPC.
--
-- A RPC:
--   · resolve o dono por `auth.uid()` — nunca por parâmetro (SEC-G1);
--   · recusa conta ausente/estrangeira com rótulo fixo `account-not-found`
--     (mensagem sem id/PII) ANTES de qualquer escrita;
--   · desmarca a principal anterior e promove a nova nas duas instruções da
--     MESMA transação — erro em qualquer uma reverte ambas;
--   · BIGINT cents intocado (nenhum valor monetário aqui).
--
-- Privilégios: EXECUTE só para `authenticated`. `PUBLIC`/`anon` não executam.
-- Idempotente: CREATE OR REPLACE + REVOKE/GRANT repetíveis.
-- Migrations 0001–0045 intocadas.

CREATE OR REPLACE FUNCTION public.set_default_account(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = p_account_id
      AND a.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'account-not-found';
  END IF;

  -- Ordem importa: desmarcar antes de promover evita violar o índice parcial
  -- único `ux_accounts_user_default` (0045) no meio do caminho.
  UPDATE public.accounts
  SET is_default = false
  WHERE user_id = v_user
    AND is_default
    AND id <> p_account_id;

  UPDATE public.accounts
  SET is_default = true
  WHERE id = p_account_id
    AND user_id = v_user;
END;
$$;

COMMENT ON FUNCTION public.set_default_account(uuid) IS
  'Promove a conta do próprio tenant a principal e desmarca a anterior na mesma transação (0045 garante unicidade).';

REVOKE ALL ON FUNCTION public.set_default_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_default_account(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_default_account(uuid) TO authenticated;
