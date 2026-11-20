-- 0001_fundacao.sql — Fase 1 Fundação (SB-01)
-- 8 tabelas + 3 índices + triggers + RLS. Idempotente-safe (IF NOT EXISTS / DROP IF EXISTS).
-- Dinheiro: BIGINT cents + CHECK >= 0. Tenant: user_id + RLS auth.uid()=user_id.
-- Colunas futuras (RN02/RN03/RN05 N/A-futura Fase 1): fitid, dedup_hash,
-- installment_number, invoices.period_start/end/due_date.

-- ============ TABELAS ============

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  full_name text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  subscription_status text NOT NULL DEFAULT 'trial'
    CHECK (subscription_status IN ('trial', 'active', 'past_due', 'canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  initial_balance_cents bigint NOT NULL DEFAULT 0 CHECK (initial_balance_cents >= 0),
  current_balance_cents bigint NOT NULL DEFAULT 0 CHECK (current_balance_cents >= 0),
  color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.credit_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  account_id uuid NOT NULL UNIQUE REFERENCES public.accounts (id) ON DELETE CASCADE,
  name text NOT NULL,
  limit_cents bigint NOT NULL DEFAULT 0 CHECK (limit_cents >= 0),
  closing_day int NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
  due_day int NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  credit_card_id uuid NOT NULL REFERENCES public.credit_cards (id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'open',
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.categories (id) ON DELETE SET NULL,
  name text NOT NULL,
  type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.installment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  description text NOT NULL,
  total_amount_cents bigint NOT NULL CHECK (total_amount_cents >= 0),
  total_installments int NOT NULL CHECK (total_installments > 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts (id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES public.invoices (id) ON DELETE SET NULL,
  category_id uuid REFERENCES public.categories (id) ON DELETE SET NULL,
  installment_plan_id uuid REFERENCES public.installment_plans (id) ON DELETE CASCADE,
  installment_number int,
  description text NOT NULL DEFAULT '',
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  date date NOT NULL,
  is_transfer boolean NOT NULL DEFAULT false,
  transfer_destination_account_id uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  reconciled boolean NOT NULL DEFAULT false,
  dedup_hash varchar(64),
  fitid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_amount_cents_nonnegative CHECK (amount_cents >= 0)
);

CREATE TABLE IF NOT EXISTS public.rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  keyword text NOT NULL,
  target_category_id uuid NOT NULL REFERENCES public.categories (id) ON DELETE CASCADE,
  priority int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ ÍNDICES (3) ============

CREATE INDEX IF NOT EXISTS idx_transactions_user_date
  ON public.transactions (user_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_user_account
  ON public.transactions (user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_dedup
  ON public.transactions (user_id, dedup_hash);

-- ============ FUNÇÕES + TRIGGERS ============

-- Auto-cria profiles no signup (Tenant Provisioning, SPEC §2)
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- updated_at automático
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_accounts_updated_at ON public.accounts;
CREATE TRIGGER set_accounts_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_credit_cards_updated_at ON public.credit_cards;
CREATE TRIGGER set_credit_cards_updated_at
  BEFORE UPDATE ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_transactions_updated_at ON public.transactions;
CREATE TRIGGER set_transactions_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Role imutável via client (anti-escalation, ADR-004)
CREATE OR REPLACE FUNCTION public.deny_role_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'profiles.role imutável via client (só service_role)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deny_role_change ON public.profiles;
CREATE TRIGGER deny_role_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_role_change();

-- ============ RLS ============

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.installment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;

-- profiles: leitura/escrita própria
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- tenant: FOR ALL USING (auth.uid() = user_id)
DROP POLICY IF EXISTS accounts_tenant ON public.accounts;
CREATE POLICY accounts_tenant ON public.accounts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS credit_cards_tenant ON public.credit_cards;
CREATE POLICY credit_cards_tenant ON public.credit_cards
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS invoices_tenant ON public.invoices;
CREATE POLICY invoices_tenant ON public.invoices
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS categories_tenant ON public.categories;
CREATE POLICY categories_tenant ON public.categories
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS installment_plans_tenant ON public.installment_plans;
CREATE POLICY installment_plans_tenant ON public.installment_plans
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS transactions_tenant ON public.transactions;
CREATE POLICY transactions_tenant ON public.transactions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS rules_tenant ON public.rules;
CREATE POLICY rules_tenant ON public.rules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
