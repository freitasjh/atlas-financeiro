-- 0080_tenant_onboarding_edge_support.sql — tenant-onboarding / F2 / ADR-006 (BE-27).
--
-- Motivo: a borda `admin-invite-user` (v3) recebe **e-mail** e precisa do `id`
-- do convidado para registrar o convite (`admin_record_invite(user_id)` em
-- `0078`) e para decidir entre convidar (`inviteUserByEmail`) e reaproveitar o
-- usuário existente. O cliente nunca resolve e-mail: o banco lê `auth.users`
-- com `SECURITY DEFINER` e devolve somente UUID (I5, REQ-14/REQ-23/REQ-24).
--
-- Decisão congelada (SPEC §4.3, §7; R6 do PROPOSAL):
--   * `public.admin_resolve_invited_user(p_email text) RETURNS uuid`
--     — `STABLE`, `SECURITY DEFINER`, `search_path=''`; compara
--     `lower(auth.users.email) = lower(btrim(p_email))` e devolve o `id` (ou
--     `NULL`).
--   * **Resposta neutra**: e-mail inexistente (ou `NULL`/vazio) devolve `NULL`
--     sem exceção — a RPC não confirma existência a ninguém. Quem chama é a
--     Edge, server-side: `NULL` ⇒ `inviteUserByEmail` (`state:'invited'`);
--     id devolvido ⇒ reusa a conta sem segundo convite (`state:'existing'`).
--   * **Conta soft-deleted não resolve** (review final da F2): `auth.users`
--     ganha `deleted_at` no soft delete (`auth.admin.deleteUser` com
--     `shouldSoftDelete`) e a conta apagada continuava resolvendo — a Edge
--     respondia `state:'existing'` sem convidar, e o e-mail ficava
--     inutilizável. O filtro é `u.deleted_at IS NULL`.
--   * **`banned_until` NÃO filtra** (decisão declarada): conta banida continua
--     sendo a MESMA conta (`auth.users`); resolver o id evita criar conta
--     duplicada por convite, e o desbloqueio é ato administrativo do Auth —
--     nunca consequência de um convite novo.
--   * Sem PII no retorno, no `COMMENT` ou em mensagem: só UUID na saída; o
--     e-mail de entrada nunca aparece em erro (a RPC não levanta erro de
--     domínio — a única falha possível é 42501 de grant, genérica).
--
-- ACL (REVOKE antes do GRANT — precedente 0078/0079):
--   `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` e
--   `GRANT EXECUTE ... TO service_role` **apenas**. `anon`/`authenticated`
--   recebem `42501`; `PUBLIC` (grantee 0) fica sem grant. A função é
--   deliberadamente **fora** da allowlist de RPC do painel — o painel continua
--   usando as RPCs de `0077`..`0079` com JWT do operador.
--
-- Leitura pura: nenhuma escrita, nenhuma trilha, nenhuma tabela/coluna nova
-- (REQ-24). O `LIMIT 1` é defesa local (o `UNIQUE` de `auth.users.email` é do
-- Auth, não desta fatia) — sem ele, um índice duplicado quebraria a RPC em vez
-- de resolver. `ORDER BY u.created_at, u.id` torna a escolha determinística
-- caso o índice duplicado exista (nunca "depende do plano"): conta mais antiga
-- primeiro, desempate por id. NULL em `created_at` não é possível
-- (`auth.users.created_at` é NOT NULL). Contas soft-deleted ficam fora do
-- `ORDER BY`: o filtro `deleted_at IS NULL` as remove antes.
--
-- Idempotente-safe: guard de pré-condição + CREATE OR REPLACE +
-- REVOKE/GRANT/COMMENT repetíveis. Migrations 0001–0078 intocadas. Nenhum
-- valor monetário nesta fatia.

-- Pré-condição dura (fail-closed na aplicação): sem `auth.users.email` (nem
-- `deleted_at`, o filtro do review da F2) a RPC não cumpre o contrato e o erro
-- só apareceria no runtime com DETAIL cru.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute
      WHERE attrelid = 'auth.users'::regclass
        AND attname = 'email'
        AND NOT attisdropped
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute
      WHERE attrelid = 'auth.users'::regclass
        AND attname = 'deleted_at'
        AND NOT attisdropped
    ) THEN
    RAISE EXCEPTION 'tenant-onboarding-edge-support-precondition-missing';
  END IF;
END $$;

-- ============ 1. Resolução de e-mail do convidado (service_role-only) ============

CREATE OR REPLACE FUNCTION public.admin_resolve_invited_user(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id
  FROM auth.users AS u
  WHERE pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
    AND u.deleted_at IS NULL
  ORDER BY u.created_at, u.id
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.admin_resolve_invited_user(text) IS
  'ADR-006 / SPEC §4.3 + §7 (0080) + review F2: apoio a Edge — resolve o auth.users.id de um convidado por e-mail. Lower + btrim nas bordas; e-mail ausente, NULL ou vazio => NULL sem excecao (resposta neutra, sem confirmacao de existencia). Conta soft-deleted (deleted_at preenchido) NAO resolve: devolve NULL e a Edge convida de novo, em vez de responder state=existing sem enviar convite. banned_until NAO filtra (decisao declarada): a conta banida existe e convidar criaria duplicata — desbloqueio e ato administrativo do Auth. Leitura pura (STABLE), zero trilha, zero tabela/coluna nova. Retorna SO uuid (sem PII). SECURITY DEFINER com search_path vazio; EXECUTE apenas service_role — anon/authenticated recebem 42501. Fora da allowlist de RPC do painel.';

-- ============ 2. ACL (REVOKE antes do GRANT; só service_role) ============

REVOKE ALL ON FUNCTION public.admin_resolve_invited_user(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_invited_user(text)
  TO service_role;
