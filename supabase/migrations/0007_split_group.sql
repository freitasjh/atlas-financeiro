-- 0007_split_group.sql — Split RN-04.4 (ME-58a): vínculo de grupo do split.
-- `transactions.split_group_id uuid NULL` (+ índice): N partes de um split
-- compartilham o mesmo id (um gen_random_uuid() por operação). Nullable,
-- sem backfill (linhas antigas ficam NULL = sem split). Migrations 0001–0006
-- intocadas. Idempotente-safe (IF NOT EXISTS).

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS split_group_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_split_group
  ON public.transactions (user_id, split_group_id);
