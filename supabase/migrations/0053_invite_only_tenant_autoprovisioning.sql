-- 0053_invite_only_tenant_autoprovisioning.sql — SEC-04 (F-09) residual / D1.
--
-- Motivo: a 0052 fechou o wrapper 0025, mas deixou de pé o caminho de baixo
-- nível. `public.create_tenant_with_owner` (0022) e `public.accept_contract`
-- (0024) continuavam com `GRANT EXECUTE ... TO authenticated`: qualquer
-- usuário JÁ autenticado (não só o signup novo, que está fechado) provisiona
-- tenant próprio e grava aceite sem convite nem backoffice. O frontend não
-- chama nenhuma das duas (grep em `src/` limpo fora de `types/supabase.ts`),
-- então o grant é resíduo, não contrato.
--
-- Decisão humana (fechar agora): modelo **invite-only de ponta a ponta**.
-- Tenant nasce por ato administrativo — `create_tenant_for_invited_user`
-- (0029, gate `is_admin()`) ou backoffice/Edge sob `service_role`.
--
-- Escopo desta migration (0022/0024/0025/0052 intocadas — já aplicadas):
--   1) `REVOKE ALL` das duas funções de `PUBLIC`, `anon` e `authenticated`.
--      `authenticated`/`anon` → `42501` (insufficient_privilege): o caminho
--      deixa de existir para o cliente, sem erro de domínio e sem escrita.
--   2) `GRANT EXECUTE` para `service_role` (backoffice/Edge, com claims do
--      dono vindos do JWT; dono continua `auth.uid()` no servidor).
--   3) `COMMENT ON FUNCTION` declarando o modelo invite-only (0052/0053).
--
-- O wrapper 0025 (já revogado na 0052) é autossuficiente: faz os INSERTs
-- inline, não chama 0022/0024 — segue funcionando para `service_role`.
--
-- Idempotente-safe: REVOKE/GRANT/COMMENT repetíveis. Nenhum valor monetário.

-- ============ 1. RPC base 0022: fora do alcance do cliente ============

REVOKE ALL ON FUNCTION public.create_tenant_with_owner(
  text, text, text, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_tenant_with_owner(
  text, text, text, text, text, text, text, text, text, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.create_tenant_with_owner(
  text, text, text, text, text, text, text, text, text, text, text, text, text
) IS
  'SEC-04/D1 (0053): provisionamento de tenant é ato de backoffice/Edge (service_role), nunca do próprio usuário. `authenticated`/`anon` não executam (42501); o caminho de convite é create_tenant_for_invited_user (0029). Modelo invite-only (0052/0053).';

-- ============ 2. Aceite 0024: idem ============

REVOKE ALL ON FUNCTION public.accept_contract(uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.accept_contract(uuid, text) TO service_role;

COMMENT ON FUNCTION public.accept_contract(uuid, text) IS
  'SEC-04/D1 (0053): aceite contratual é gravado por backoffice/Edge (service_role) com claims do dono (auth.uid() no servidor). `authenticated`/`anon` não executam (42501). Modelo invite-only (0052/0053).';
