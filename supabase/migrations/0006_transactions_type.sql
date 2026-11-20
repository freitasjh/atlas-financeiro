-- 0006_transactions_type.sql — BG-51: coluna de direção do lançamento.
-- `transactions.type` ('income'|'expense') é a FONTE ÚNICA de direção
-- (D3): grade, stats e recalc de saldo passam a ler `type` — nunca mais
-- inferir entrada/saída pelo sinal do amount (amount_cents >= 0 CHECK).
-- RN04: direção de transfer permanece regida por is_transfer +
-- transfer_destination_account_id (origem −/destino +), type só amarra
-- default neutro 'expense'. Migrations 0001–0005 intocadas.

-- 1) Coluna: NOT NULL + default 'expense'. Idempotente-safe (IF NOT EXISTS).
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'expense';

-- 2) CHECK nomeado (sem IF NOT EXISTS nativo p/ constraint → DO guard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_type_allowed' AND conrelid = 'public.transactions'::regclass
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_type_allowed CHECK (type IN ('income', 'expense'));
  END IF;
END $$;

-- 3) Backfill idempotente (D2): função pura do dado base — re-execução
-- reproduce o MESMO resultado (UPDATE, nunca INSERT: re-execucao não
-- duplica linha). Ordem de decisão por linha:
--   a) categoria do tipo income             → income
--   b) sem categoria, não-transfer,
--      amount > 0                           → income (importações/avulso legadas;
--      transfer É explicitamente excluído — direção vem da regra
--      origem −/destino + via is_transfer; aqui 'expense' é o default neutro)
--   c) resto                                → expense (default)
UPDATE public.transactions t
SET type = CASE
  WHEN EXISTS (
    SELECT 1 FROM public.categories c
    WHERE c.id = t.category_id AND c.type = 'income'
  ) THEN 'income'
  WHEN t.category_id IS NULL AND NOT t.is_transfer AND t.amount_cents > 0 THEN 'income'
  ELSE 'expense'
END;
