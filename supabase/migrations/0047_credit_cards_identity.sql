-- 0047_credit_cards_identity.sql — ADR-001: colunas de identidade PCI-safe em credit_cards.
-- Idempotente-safe: ADD COLUMN IF NOT EXISTS. Nunca editar migrations aplicadas.
-- PAN, CVV e número completo ficam FORA do DDL — só last4 é persistido (ADR-005:
-- cartões legados ficam NULL, sem backfill inferido). theme/is_default são neutros.
-- RLS credit_cards_tenant (FOR ALL auth.uid()=user_id) já cobre as novas colunas.

ALTER TABLE public.credit_cards
  ADD COLUMN IF NOT EXISTS last4 text,
  ADD COLUMN IF NOT EXISTS holder_name text,
  ADD COLUMN IF NOT EXISTS expiry_mm_aa text,
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'platinum'
    CHECK (theme IN ('midnight','emerald','violet','platinum','rose_gold')),
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
