-- 0045_accounts_single_default.sql — no máximo UMA conta principal por usuário.
-- Idempotente-safe: saneia duplicatas antes de criar o índice parcial único.
-- Dinheiro intocado (BIGINT cents preservado).

-- 1) Saneia dados legados: mantém como principal a conta mais recente do usuário.
UPDATE public.accounts AS a
SET is_default = false
WHERE a.is_default
  AND EXISTS (
    SELECT 1
    FROM public.accounts AS b
    WHERE b.user_id = a.user_id
      AND b.is_default
      AND (b.created_at, b.id) > (a.created_at, a.id)
  );

-- 2) Índice parcial único: o banco recusa a segunda principal.
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_user_default
  ON public.accounts (user_id)
  WHERE is_default;
