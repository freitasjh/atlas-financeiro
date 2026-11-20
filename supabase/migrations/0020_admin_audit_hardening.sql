-- 0020_admin_audit_hardening.sql — Frente A / fechamento do A-AUDIT.
--
-- Furos medidos no review de 0019 (defaults do Supabase ainda presentes):
--   R-1) `profiles_admin_audit_fn()` tinha `EXECUTE` para anon, authenticated e
--        service_role. A função é SECURITY DEFINER e só deve rodar como trigger;
--        chamada direta por client não faz parte do contrato.
--   R-2) `service_role` mantinha `REFERENCES` e `TRIGGER` em `admin_audit`
--        (sobras do `GRANT ALL` default). O backoffice precisa de leitura; DDL
--        e escrita continuam proibidos.
--
-- Correção (server-side):
--   - REVOKE ALL na função do trigger para PUBLIC/anon/authenticated/service_role.
--     Trigger não checa EXECUTE: o disparo continua funcionando (a função é
--     SECURITY DEFINER e roda como o owner da tabela).
--   - REVOKE ALL na tabela e GRANT apenas SELECT para service_role.
--
-- Idempotente: REVOKE/GRANT são reexecutáveis. Migrations 0001–0019 intocadas.
-- Dinheiro inalterado (BIGINT cents).

-- ============ R-1 — ACL da função do trigger ============

REVOKE ALL ON FUNCTION public.profiles_admin_audit_fn()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============ R-2 — privilégios residuais em admin_audit ============
-- `REVOKE ALL` remove REFERENCES/TRIGGER herdados do grant default do Supabase;
-- o backoffice mantém só a leitura da trilha.

REVOKE ALL ON TABLE public.admin_audit
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.admin_audit TO service_role;
