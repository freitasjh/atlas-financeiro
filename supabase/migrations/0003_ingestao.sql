-- 0003_ingestao.sql — Fase 3 Ingestão (SB-20)
-- UNIQUE parcial dedup + CHECK formato 64hex + 2 índices. Idempotente.
-- NÃO edita 0001/0002. Sem backfill: legado dedup_hash NULL permanece válido
-- (índice parcial WHERE NOT NULL ignora NULL). Sem service_role, sem float.
-- Dinheiro: BIGINT cents (inalterado). Tenant: RLS herdada de 0001 (inalterada).

-- ============ CHECK formato dedup_hash 64hex (NULL passa — legado válido) ============

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_dedup_hash_format') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_dedup_hash_format CHECK (
      dedup_hash IS NULL OR dedup_hash ~ '^[0-9a-f]{64}$'
    );
  END IF;
END $$;

-- ============ UNIQUE parcial (user_id, dedup_hash) WHERE NOT NULL ============
-- Índice único parcial (não constraint): duplicata por tenant bloqueada no DB (409),
-- legado NULL ignorado. UNIQUE total é defeito proibido (ver ddl.spec T14b).

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_user_dedup_partial
  ON public.transactions (user_id, dedup_hash)
  WHERE dedup_hash IS NOT NULL;

-- ============ ÍNDICES Fase 3 ============

CREATE INDEX IF NOT EXISTS idx_rules_user_keyword
  ON public.rules (user_id, keyword);

CREATE INDEX IF NOT EXISTS idx_transactions_user_reconciled
  ON public.transactions (user_id, reconciled);
