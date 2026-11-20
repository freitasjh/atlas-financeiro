-- 0016_account_delete_guard.sql — RF03 / P2-saneamento (iteração 3).
--
-- Fecha o bypass de cascata descoberto no review de 0015: o guard de cartão
-- discriminava por `current_user`, mas durante a cascata de FK o trigger roda
-- com `current_user = postgres`. Resultado: `DELETE FROM accounts` como
-- `authenticated` apagava em cascata `credit_cards -> invoices ->
-- transactions` de cartão com histórico e deixava compras órfãs
-- (`invoice_id = NULL`), exatamente o estado que 0015 queria proibir.
--
-- 1) `credit_cards_delete_guard` recriado SEM o gate por `current_user`:
--    bloqueia sempre que existir histórico (transação vinculada a uma fatura
--    do cartão), em qualquer caminho — cliente, cascata de FK ou service_role.
-- 2) `accounts_delete_guard` (novo): bloqueia a exclusão da conta quando a
--    cascata orfanaria compras de cartão —
--      · transação de despesa com `invoice_id` na própria conta (compra de
--        cartão cujo `account_id` é esta conta), ou
--      · cartão vinculado à conta com histórico (a cascata apagaria a fatura
--        e soltaria as compras que moram em outras contas).
-- 3) Caminho administrativo explícito: purge intencional exige
--    `SET LOCAL app.card_purge = 'on'` na transação corrente. Nenhum código de
--    aplicação seta esse GUC — é operação de manutenção (psql/service_role).
--
-- Mensagens fixas, sem ids (SEC-G3): `account-has-history` / `card-has-history`.
-- Idempotente: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- Migrations 0001–0015 intocadas. Dinheiro segue BIGINT cents.

-- ============ 1. Guard de cartão sem discriminador de usuário ============

CREATE OR REPLACE FUNCTION public.credit_cards_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF coalesce(current_setting('app.card_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.transactions t
    JOIN public.invoices i ON i.id = t.invoice_id
    WHERE i.credit_card_id = OLD.id
      AND t.user_id = OLD.user_id
  ) THEN
    RAISE EXCEPTION 'card-has-history';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS credit_cards_delete_guard ON public.credit_cards;
CREATE TRIGGER credit_cards_delete_guard
  BEFORE DELETE ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.credit_cards_delete_guard();

-- ============ 2. Guard de conta (cascata não pode orfanar compras) ============

CREATE OR REPLACE FUNCTION public.accounts_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF coalesce(current_setting('app.card_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;

  -- Compra de cartão lançada nesta conta: o CASCADE apagaria a linha (histórico
  -- do cartão) e o total da fatura ficaria sem lastro.
  IF EXISTS (
    SELECT 1
    FROM public.transactions t
    WHERE t.account_id = OLD.id
      AND t.user_id = OLD.user_id
      AND t.is_transfer = false
      AND t.invoice_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'account-has-history';
  END IF;

  -- Cartão desta conta com histórico: a cascata apagaria fatura e soltaria as
  -- compras que moram em outras contas (`transactions.invoice_id` SET NULL).
  IF EXISTS (
    SELECT 1
    FROM public.credit_cards c
    JOIN public.invoices i ON i.credit_card_id = c.id
    JOIN public.transactions t ON t.invoice_id = i.id
    WHERE c.account_id = OLD.id
      AND c.user_id = OLD.user_id
      AND t.user_id = OLD.user_id
  ) THEN
    RAISE EXCEPTION 'account-has-history';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS accounts_delete_guard ON public.accounts;
CREATE TRIGGER accounts_delete_guard
  BEFORE DELETE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_delete_guard();
