-- 0044_accounts_template_fields.sql — campos do template BankAccountsView (RF-06).
-- Idempotente-safe: ADD COLUMN IF NOT EXISTS. Nunca editar migration aplicada.
-- Dinheiro segue BIGINT cents (RN01); nenhum campo monetário aqui.
-- RLS accounts_tenant (FOR ALL) já cobre as novas colunas.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS institution text,
  ADD COLUMN IF NOT EXISTS agency text,
  ADD COLUMN IF NOT EXISTS account_number text,
  ADD COLUMN IF NOT EXISTS account_digit text,
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connection_status text NOT NULL DEFAULT 'manual'
    CHECK (connection_status IN ('connected', 'syncing', 'error', 'manual')),
  ADD COLUMN IF NOT EXISTS color text;

-- Índice de ordenação/consulta por user_id + padrão (nome já ordenado no service).
CREATE INDEX IF NOT EXISTS idx_accounts_user_default
  ON public.accounts (user_id, is_default DESC);
