-- 0049_profiles_column_grants.sql — bugfix P1 security-p1-hardening / SEC-02 (F-08).
--
-- Motivo: `profiles.must_change_password` era gravável direto pelo dono da
-- linha (`profiles_update_own` + grant de TABELA default do Supabase para
-- `authenticated`/`anon`). Qualquer JWT do próprio usuário desligava o gate de
-- primeiro acesso (`is_admin()`/`is_super_admin()` 0034/0035/0037/0039) sem
-- passar por `complete_first_access()`: o travamento virava decorativo. A
-- policy RLS é por LINHA, não por COLUNA — ela nunca foi a barreira certa.
--
-- Entrega (server-side; nenhuma migration aplicada é editada):
--   1) `REVOKE UPDATE ON public.profiles FROM authenticated, anon;`
--      Obrigatório e não opcional: `REVOKE UPDATE (coluna)` isolado é inócuo
--      quando existe grant de tabela (a tabela já cobre todas as colunas).
--   2) `GRANT UPDATE (full_name, role, subscription_status) ON public.profiles
--      TO authenticated;` — lista fechada de colunas escrevíveis pelo cliente.
--      Ficam FORA do grant: `must_change_password`, `id`, `created_at`,
--      `updated_at`.
--      * `role` permanece no grant: promoção por JWT de operador é contrato
--        documentado (0004/0005, preservado em 0027 e estreitado em 0034/0035)
--        — a autorização continua sendo o trigger `deny_role_change`
--        (`is_admin()`/`is_super_admin()` + permitidos DBA/service_role), não
--        o grant. Sem `role` no grant, o contrato viraria 42501.
--      * `subscription_status` permanece no grant: o trigger já recusa com o
--        rótulo fixo `profiles-status-readonly-use-tenant-rpc` (0027) e o
--        caminho sancionado é a RPC de tenant (0028). Removê-lo do grant
--        trocaria um rótulo auditável por 42501.
--      * `anon` não recebe coluna nenhuma: cadastro é `service_role`
--        (`handle_new_user`, DEFINER) e signup é Edge/Auth.
--   3) `deny_role_change()` endurecida: ramo novo que recusa mudança de
--      `must_change_password` fora do canal sancionado. Defesa em
--      profundidade — a barreira primária é o grant por coluna do passo 2.
--      Alcance honesto: o ramo impede caminho ACIDENTAL (ex.: código novo que
--      faça `update profiles` cego) e exige um segundo passo deliberado —
--      quem já tiver o grant de coluna precisaria também marcar o GUC na
--      própria transação (provado em T7 do spec). Não é autorização; é
--      tripwire de regressão de ACL.
--      Canal sancionado: GUC transacional `app.first_access = 'on'`, setado
--      APENAS por `complete_first_access()` (mesmo padrão do `app.invoice_rpc`
--      de 0011). `service_role` e DBA (`postgres`/`supabase_admin`) seguem
--      escrevendo para seed/Edge/migrations — o seed nasce com a flag `true`
--      (0034) e a Edge de provisionamento precisa poder travá-la.
--      Rótulo fixo novo: `profiles-first-access-readonly`.
--   4) `complete_first_access()` (corpo 0034 preservado) marca o GUC com
--      `set_config('app.first_access', 'on', true)` antes do UPDATE e o
--      devolve a `'off'` depois — o canal fica restrito à própria chamada.
--
-- Fora de escopo (declarado): `INSERT` em `profiles` continua com grant de
-- tabela, mas `profiles.id` tem PK = `auth.users.id` e `handle_new_user`
-- (DEFINER) já criou a linha no signup; `deny_admin_insert` barra role/status
-- iniciais. Endurecer INSERT por coluna fica para um ciclo próprio se o
-- threat model apontar caminho real.
--
-- Erros por rótulo fixo, sem PII (id/e-mail/hash): nenhum rótulo existente
-- muda; só nasce `profiles-first-access-readonly`.
-- Sem dinheiro (só identidade): nenhum float/double.
-- Idempotente-safe: REVOKE/GRANT repetíveis + CREATE OR REPLACE; nenhum
-- objeto novo, nenhum drop de dados. Migrations 0001–0048 intocadas.

-- ============ 1. Grant por coluna (tabela → lista fechada) ============
-- A ordem importa: revogar o grant de TABELA primeiro, senão o grant de
-- coluna não muda nada (o grant de tabela já permite todas as colunas).

REVOKE UPDATE ON public.profiles FROM authenticated, anon;

GRANT UPDATE (full_name, role, subscription_status)
  ON public.profiles TO authenticated;

COMMENT ON TABLE public.profiles IS
  'BUGFIX SEC-02 (0049): UPDATE via client é por COLUNA — authenticated escreve apenas full_name/role/subscription_status. must_change_password/id/created_at/updated_at ficam fora do grant; a flag só muda por complete_first_access() (GUC app.first_access) ou service_role/DBA.';

-- ============ 2. deny_role_change: ramo de primeiro acesso ============

CREATE OR REPLACE FUNCTION public.deny_role_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Ramo 0 (BUGFIX SEC-02): a flag de primeiro acesso é estado de segurança.
  -- Barreira primária = grant por coluna (0049); este ramo é tripwire contra
  -- regressão de ACL (impede escrita acidental sem grant). Canal sancionado:
  -- GUC transacional `app.first_access`, setado só por complete_first_access()
  -- (padrão 0011).
  IF NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
    IF COALESCE(current_setting('app.first_access', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    -- Seed / Edge / migrations (server-only): escrevem por DBA ou service_role.
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'profiles-first-access-readonly';
  END IF;

  -- Ramo 1 (BE-03, 0027): subscription_status congelado para JWT.
  -- Serviço de cobrança lê tenants; profiles nunca entra no caminho decisão.
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'profiles-status-readonly-use-tenant-rpc';
  END IF;

  -- Ramo 2 (contrato 0004/0005, estreitado em 0034/0035): transição
  -- envolvendo super_admin só service_role/DBA; demais casos por is_admin().
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NEW.role = 'super_admin' OR OLD.role = 'super_admin' THEN
      IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
        RETURN NEW;
      END IF;
      IF current_user IN ('postgres', 'supabase_admin') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'not-super-admin';
    END IF;

    IF public.is_admin() THEN
      RETURN NEW;
    END IF;
    IF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      RETURN NEW;
    END IF;
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'profiles.role/subscription_status imutáveis via client (só admin/service_role)';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.deny_role_change() IS
  'ADR-002 + BUGFIX SEC-02 (0049): must_change_password só muda com GUC app.first_access=on (complete_first_access) ou service_role/DBA — rótulo profiles-first-access-readonly; subscription_status freeze 0027 preservado; role 0004/0035 preservado (super_admin só service_role/DBA).';

REVOKE ALL ON FUNCTION public.deny_role_change()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS deny_role_change ON public.profiles;
CREATE TRIGGER deny_role_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_role_change();

-- ============ 3. complete_first_access: único canal do GUC ============

CREATE OR REPLACE FUNCTION public.complete_first_access()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not-authenticated';
  END IF;

  -- Só o próprio profile, só com flag true. Sem linha ou sem flag → rótulo
  -- fixo (nunca revela se o id existe em outro tenant).
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = v_uid AND p.must_change_password = true
  ) THEN
    RAISE EXCEPTION 'first-access-not-required';
  END IF;

  -- Canal sancionado do ramo 0 de deny_role_change (defesa em profundidade
  -- ao grant por coluna da 0049). Transacional: morre no fim da transação.
  PERFORM set_config('app.first_access', 'on', true);

  UPDATE public.profiles SET must_change_password = false
  WHERE id = v_uid;

  PERFORM set_config('app.first_access', 'off', true);
END;
$$;

COMMENT ON FUNCTION public.complete_first_access() IS
  'Primeiro acesso (ADR-002; canal do GUC desde 0049): após updateUser no Auth, valida auth.uid()=profiles.id + flag true, marca app.first_access=on na transação e libera (must_change_password=false). Sem flag → first-access-not-required.';

REVOKE ALL ON FUNCTION public.complete_first_access()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.complete_first_access() TO authenticated;
