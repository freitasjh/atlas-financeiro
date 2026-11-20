-- 0052_invite_only_tenant_provisioning.sql — SEC-04 (F-09) / decisão humana D1.
--
-- Motivo: `create_tenant_with_owner_and_acceptance` (0025) era executável por
-- `authenticated` e provisionava tenant + membership owner + aceite sem
-- qualquer convite. Com `enable_signup=true` (config.toml, pré-SEC-04) a
-- combinação permitia conta auto-criada → tenant próprio, sem passar pelo
-- backoffice. D1 (invite-only): o tenant nasce só por ato administrativo.
--
-- Escopo desta migration (0025/0029 intocadas — já aplicadas):
--   1) `REVOKE` de `PUBLIC`, `anon` e `authenticated` no wrapper 0025.
--      `authenticated` → `42501` (insufficient_privilege), nunca erro de
--      domínio: o caminho não existe mais para o cliente.
--   2) `GRANT EXECUTE` para `service_role` (backoffice/Edge, com claims do
--      dono via `auth.uid()`), mantendo `postgres`/DBA como dono da função.
--   3) `COMMENT ON FUNCTION` declarando o modelo: provisionamento de tenant
--      é ato de backoffice/Edge, nunca do próprio usuário.
--
-- O caminho canônico de convite permanece em `public.
-- create_tenant_for_invited_user` (0029, gate `is_admin()`): admin com JWT
-- aal2 + operador ativo cria o tenant do convidado. Cadastro público de
-- conta segue fechado no Auth (`enable_signup=false` nos dois escopos de
-- `config.toml`; ver runbook §10.6).
--
-- Idempotente-safe: REVOKE/GRANT/COMMENT repetíveis. Nenhum valor monetário.

-- ============ 1. RPC 0025: fora do alcance do cliente ============

REVOKE ALL ON FUNCTION public.create_tenant_with_owner_and_acceptance(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_tenant_with_owner_and_acceptance(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.create_tenant_with_owner_and_acceptance(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text
) IS
  'SEC-04/D1: provisionamento de tenant é ato de backoffice/Edge (service_role), nunca do próprio usuário. `authenticated` não executa (42501); o caminho de convite é create_tenant_for_invited_user (0029).';
