-- 0048_set_default_card.sql — ADR-002: cartão principal único e atômico.
--
-- Índice parcial sozinho deixa a janela de duas instruções do cliente sem
-- principal; RPC sozinha é burlável por UPDATE direto. Defesa em profundidade:
-- o banco garante no máximo um principal e a RPC troca na mesma transação.
--
-- 1) Saneia duplicatas legadas pelo mesmo critério de 0045: vence a tupla
--    (created_at, id) maior. Deve rodar ANTES do índice.
-- 2) Índice parcial único: o banco recusa a segunda principal.
-- 3) RPC SECURITY DEFINER com search_path fixo: dono resolvido por auth.uid(),
--    erro nomeado `card-not-found` sem id/PII, desmarca→promove na MESMA
--    transação. Dinheiro intocado (BIGINT cents preservado).
-- 4) EXECUTE só para authenticated; PUBLIC/anon sem EXECUTE.
--
-- Idempotente-safe: UPDATE de saneamento é inócuo após a 1ª execução,
-- CREATE UNIQUE INDEX IF NOT EXISTS, CREATE OR REPLACE + REVOKE/GRANT.
-- Migration 0046 (set_default_account, accounts) NÃO é alterada — é o padrão
-- replicado; 0001–0047 permanecem intocadas.

-- 1) Saneamento de duplicatas legadas de is_default.
UPDATE public.credit_cards AS a
SET is_default = false
WHERE a.is_default
  AND EXISTS (
    SELECT 1
    FROM public.credit_cards AS b
    WHERE b.user_id = a.user_id
      AND b.is_default
      AND (b.created_at, b.id) > (a.created_at, a.id)
  );

-- 2) Índice parcial único.
CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_cards_user_default
  ON public.credit_cards (user_id)
  WHERE is_default;

-- 3) RPC atômica (DDL exato do ADR-002, interface congelada).
CREATE OR REPLACE FUNCTION public.set_default_card(p_card_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.credit_cards WHERE id = p_card_id AND user_id = v_user
  ) THEN RAISE EXCEPTION 'card-not-found'; END IF;
  UPDATE public.credit_cards SET is_default = false
    WHERE user_id = v_user AND is_default;
  UPDATE public.credit_cards SET is_default = true
    WHERE id = p_card_id AND user_id = v_user;
END $$;

COMMENT ON FUNCTION public.set_default_card(uuid) IS
  'Promove o cartão do próprio tenant a principal e desmarca o anterior na mesma transação (índice parcial 0048 garante unicidade).';

-- 4) ACL: somente authenticated executa.
REVOKE ALL ON FUNCTION public.set_default_card(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_default_card(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_default_card(uuid) TO authenticated;
