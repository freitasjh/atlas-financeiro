-- 0021_transaction_category_guard.sql — QA-DRAWER-02 (cross-tenant de categoria).
--
-- Falha medida (harness/cartoes-lancamentos-drawer.json, achado QA-DRAWER-02):
-- `POST /rest/v1/transactions` com o JWT do tenant A e `category_id` de uma
-- categoria do tenant B respondia **201** e gravava a linha. A FK
-- `transactions.category_id -> categories(id)` valida a existência, mas não o
-- dono; a RLS de `categories` filtra SELECT/UPDATE/DELETE, não o INSERT de
-- OUTRA tabela que aponta para ela. Até aqui a recusa existia apenas no
-- service (`assertCategoryBelongsToTenant`), o que não cobre escrita direta no
-- PostgREST.
--
-- Correção estrutural: trigger BEFORE INSERT OR UPDATE OF category_id em
-- `transactions` que exige `categories.user_id = NEW.user_id` sempre que
-- `category_id` não é NULL. Mensagem fixa, sem ids (SEC-G3).
--
-- Notas de implementação:
-- 1) `SECURITY DEFINER` + `search_path = public`: a checagem não depende das
--    policies do papel que escreve (RLS esconderia a categoria alheia e o
--    erro viraria "não existe" em vez de "é de outro tenant").
-- 2) Sem gate por `current_user`: durante a cascata de FK o trigger roda como
--    owner (lição de 0016/0017) — o discriminador mentiria.
-- 3) `category_id IS NULL` é permitido e não consulta nada (categoria é
--    opcional, RF-01). O `ON DELETE SET NULL` de `categories` cai nesse ramo.
-- 4) Escape administrativo único: `SET LOCAL app.card_purge = 'on'` — o mesmo
--    GUC de 0016/0017/0018. Nenhum código de aplicação seta esse GUC.
-- 5) Idempotente: `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`.
--    Reexecutar a migration não duplica trigger. Migrations 0001–0020
--    intocadas; dinheiro segue BIGINT cents.

-- ============ Guard de tenant da categoria ============

CREATE OR REPLACE FUNCTION public.transactions_category_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Categoria é opcional: NULL nunca consulta (e cobre o SET NULL da FK).
  IF NEW.category_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Escape administrativo declarado (purge/manutenção). Não é caminho de app.
  IF coalesce(current_setting('app.card_purge', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.categories c
    WHERE c.id = NEW.category_id
      AND c.user_id = NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  -- Categoria de outro tenant (ou inexistente): recusa tipada, sem ids.
  RAISE EXCEPTION 'category-tenant-mismatch';
END;
$$;

DROP TRIGGER IF EXISTS transactions_category_guard ON public.transactions;
CREATE TRIGGER transactions_category_guard
  BEFORE INSERT OR UPDATE OF category_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_category_guard();
