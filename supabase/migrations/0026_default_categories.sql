-- 0026_default_categories.sql — categorias default por tenant (ADR-001/ADR-002).
--
-- Adiciona colunas icon_code/color_hex/spending_limit_cents em categories,
-- estende handle_new_user para provisionar 12 categorias default no signup
-- e faz backfill idempotente para profiles existentes.
--
-- Idempotente-safe: ADD COLUMN IF NOT EXISTS, DO blocks, ON CONFLICT/WHERE NOT EXISTS.

-- ============ 1. ALTER TABLE categories ============

ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS icon_code text;
ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS color_hex text;
ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS spending_limit_cents bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'categories_spending_limit_check'
      AND conrelid = 'public.categories'::regclass
  ) THEN
    ALTER TABLE public.categories
      ADD CONSTRAINT categories_spending_limit_check CHECK (spending_limit_cents >= 0);
  END IF;
END $$;

-- ============ 2. handle_new_user (profile + 12 categorias default) ============

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role, subscription_status)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'full_name', NULL), 'user', 'trial')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.categories (user_id, name, type, icon_code, color_hex, spending_limit_cents)
  SELECT NEW.id, v.name, v.type, v.icon_code, v.color_hex, v.spending_limit_cents
  FROM (VALUES
    ('Alimentação', 'expense', 'pi pi-shopping-cart', 'ff0808', 100000::bigint),
    ('Moradia', 'expense', 'pi pi-home', 'ff0808', 100000::bigint),
    ('Transporte', 'expense', 'pi pi-cart', 'ff0808', 100000::bigint),
    ('Saúde', 'expense', 'pi pi-heart', 'ff0808', 100000::bigint),
    ('Educação', 'expense', 'pi pi-book', 'ff0808', 100000::bigint),
    ('Lazer', 'expense', 'pi pi-ticket', 'ff0808', 100000::bigint),
    ('Vestuário', 'expense', 'pi pi-wallet', 'ff0808', 100000::bigint),
    ('Dívidas', 'expense', 'pi pi-wallet', 'ff0808', 100000::bigint),
    ('Investimentos', 'expense', 'pi pi-building', 'ff0808', 100000::bigint),
    ('Outros', 'expense', 'pi pi-cog', 'ff0808', 100000::bigint),
    ('Salario Fixo', 'income', 'pi pi-wallet', 'ff0808', 0::bigint),
    ('Renda extra', 'income', 'pi pi-wallet', 'ff0808', 0::bigint)
  ) AS v(name, type, icon_code, color_hex, spending_limit_cents)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.categories c
    WHERE c.user_id = NEW.id AND c.name = v.name
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ 3. Backfill idempotente para profiles existentes ============

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT id FROM public.profiles LOOP
    INSERT INTO public.categories (user_id, name, type, icon_code, color_hex, spending_limit_cents)
    SELECT p.id, v.name, v.type, v.icon_code, v.color_hex, v.spending_limit_cents
    FROM (VALUES
      ('Alimentação', 'expense', 'pi pi-shopping-cart', 'ff0808', 100000::bigint),
      ('Moradia', 'expense', 'pi pi-home', 'ff0808', 100000::bigint),
      ('Transporte', 'expense', 'pi pi-cart', 'ff0808', 100000::bigint),
      ('Saúde', 'expense', 'pi pi-heart', 'ff0808', 100000::bigint),
      ('Educação', 'expense', 'pi pi-book', 'ff0808', 100000::bigint),
      ('Lazer', 'expense', 'pi pi-ticket', 'ff0808', 100000::bigint),
      ('Vestuário', 'expense', 'pi pi-wallet', 'ff0808', 100000::bigint),
      ('Dívidas', 'expense', 'pi pi-wallet', 'ff0808', 100000::bigint),
      ('Investimentos', 'expense', 'pi pi-building', 'ff0808', 100000::bigint),
      ('Outros', 'expense', 'pi pi-cog', 'ff0808', 100000::bigint),
      ('Salario Fixo', 'income', 'pi pi-wallet', 'ff0808', 0::bigint),
      ('Renda extra', 'income', 'pi pi-wallet', 'ff0808', 0::bigint)
    ) AS v(name, type, icon_code, color_hex, spending_limit_cents)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.categories c
      WHERE c.user_id = p.id AND c.name = v.name
    );
  END LOOP;
END $$;