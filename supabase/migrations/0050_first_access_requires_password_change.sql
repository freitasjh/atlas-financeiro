-- 0050_first_access_requires_password_change.sql
-- Bugfix security-p1-hardening / correção C1+A1+A2 (code review do Batch 1, 2026-11-18).
--
-- ============ A2 — correção de prosa (imprecisão da 0049) ============
-- A 0049 afirmava, no comentário de `complete_first_access()`, que o GUC
-- transacional `app.first_access = 'on'` era "setado APENAS por
-- complete_first_access()". Isso é **impreciso** e não é uma garantia: o GUC é
-- gravável por qualquer papel (namespace de GUC de aplicação não tem ACL) e o
-- próprio T7 do spec 0049 prova que, com o grant de coluna devolvido, marcar o
-- GUC basta para escrever `must_change_password`. O GUC nunca foi autorização —
-- é marcador de canal. A 0049 permanece **imutável** (já aplicada); esta
-- migration não a edita, apenas registra a correção aqui.
--
-- ============ C1 (🔴) — a saída do primeiro acesso não provava troca de senha ====
-- `complete_first_access()` é SECURITY DEFINER com EXECUTE para `authenticated`
-- e só checava a flag. Cadeia de bypass: senha temporária vaza → login (aal1) →
-- `rpc/complete_first_access` → flag cai **sem tocar `auth.users`** → o gate de
-- primeiro acesso (`is_admin()`/`is_super_admin()`) destrava com a senha
-- temporária intacta. A flag, sozinha, nunca foi prova de troca de senha.
--
-- Correção (decisão humana aprovada: amarrar ao Auth + revogar a RPC):
--   1) Trigger `AFTER UPDATE OF encrypted_password ON auth.users`
--      (`WHEN (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password)`)
--      chamando `public.clear_first_access_on_password_change()`: função
--      SECURITY DEFINER, `SET search_path = ''`, referências qualificadas,
--      `REVOKE ALL` de PUBLIC/anon/authenticated/service_role. Ela faz
--      `UPDATE public.profiles SET must_change_password = false WHERE id = NEW.id
--      AND must_change_password = true`. Toda troca real de senha — `updateUser`
--      (GoTrue), DBA, Edge — limpa a flag no mesmo COMMIT, que é a única prova
--      que temos no banco de que a credencial temporária deixou de existir.
--      Não interfere em `handle_new_user` (0001) nem em signup: o trigger é
--      `AFTER UPDATE OF encrypted_password`, nunca dispara em INSERT.
--   2) `REVOKE EXECUTE ON FUNCTION public.complete_first_access() FROM
--      authenticated, anon` (mantém `service_role`/DBA). A função **não** é
--      dropada: Edge/compat continuam podendo chamá-la server-side, mas o
--      cliente perde o caminho. Sem chamador legítimo em `src/` (único
--      casamento é `src/types/supabase.ts`, tipo gerado).
--   3) A1: `deny_role_change()` redefinida — o ramo `must_change_password`
--      deixa de ter `RETURN NEW` antecipado (fall-through). Antes, um UPDATE
--      único que mexesse na flag **e** em `subscription_status`/`role` saía
--      pelo RETURN do ramo 0 e pulava os ramos 1/2: o freeze de status (0027)
--      e a trava de role (0034/0035) eram curto-circuitados pelo próprio
--      tripwire. Agora o ramo 0 só **recusa** (ou não); quem decide o resto
--      são os ramos 1/2, com os rótulos originais preservados.
--   4) O canal legítimo da troca de senha passa a ser o Auth. A flag continua
--      barrando `is_admin()`/`is_super_admin()` enquanto `true`; ela só cai
--      quando `auth.users.encrypted_password` muda (ou por service_role/DBA).
--
-- Erros por rótulo fixo, sem PII: nenhum rótulo novo nesta migration.
--   profiles-first-access-readonly (0049), profiles-status-readonly-use-tenant-rpc
--   (0027), not-super-admin / profiles.role/subscription_status imutáveis (0034).
-- Sem dinheiro (só identidade): nenhum float/double.
-- Idempotente-safe: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS +
-- REVOKE/GRANT repetíveis. Migrations 0001–0049 intocadas.
--
-- Efeito declarado sobre o spec 0049 (imutável, já aplicado): seu T5 chamava
-- `complete_first_access()` como `authenticated` — caminho que C1 fecha de
-- propósito. T5 fica SUPERSEDED por este ciclo; a cobertura nova é o T1
-- (42501) + T6 (service_role) do spec 0050, e T0–T4/T7 do 0049 seguem válidos.

-- ============ 1. Prova de troca de senha: trigger em auth.users ============

CREATE OR REPLACE FUNCTION public.clear_first_access_on_password_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Só o próprio profile, só se a flag estiver ligada. Idempotente: o
  -- segundo UPDATE de senha não toca linha nenhuma.
  UPDATE public.profiles
  SET must_change_password = false
  WHERE id = NEW.id
    AND must_change_password = true;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.clear_first_access_on_password_change() IS
  'BUGFIX C1 (0050): prova de troca de senha. AFTER UPDATE de auth.users.encrypted_password limpa profiles.must_change_password. Rodar como owner (DEFINER) é o que permite escrever a flag sob o tripwire de 0049.';

REVOKE ALL ON FUNCTION public.clear_first_access_on_password_change()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS on_auth_user_password_changed ON auth.users;
CREATE TRIGGER on_auth_user_password_changed
  AFTER UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW
  WHEN (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password)
  EXECUTE FUNCTION public.clear_first_access_on_password_change();

-- ============ 2. A1: deny_role_change com fall-through ============

CREATE OR REPLACE FUNCTION public.deny_role_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Ramo 0 (BUGFIX SEC-02, 0049): flag de primeiro acesso. Este ramo APENAS
  -- recusa — não retorna. Retornar aqui pulava os ramos 1/2 e deixava um
  -- UPDATE combinado escapar do freeze de status e da trava de role (A1).
  -- Tripwire de ACL: não é autorização (ver A2 no cabeçalho).
  IF NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
    IF COALESCE(current_setting('app.first_access', true), '') = 'on' THEN
      NULL;
    ELSIF COALESCE((auth.jwt() ->> 'role'), '') = 'service_role' THEN
      NULL;
    ELSIF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'profiles-first-access-readonly';
    END IF;
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
  'ADR-002 + SEC-02 (0049) + A1 (0050): must_change_password = tripwire (rótulo profiles-first-access-readonly) SEM RETURN antecipado — os ramos subscription_status (0027) e role (0034/0035) sempre avaliam, preservando os rótulos.';

REVOKE ALL ON FUNCTION public.deny_role_change()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS deny_role_change ON public.profiles;
CREATE TRIGGER deny_role_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.deny_role_change();

-- ============ 3. C1: fechar o caminho do cliente na RPC ============
-- A função fica (Edge/compat server-side); o cliente perde o EXECUTE.

REVOKE ALL ON FUNCTION public.complete_first_access()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.complete_first_access() TO service_role;

COMMENT ON FUNCTION public.complete_first_access() IS
  'Primeiro acesso: SEM EXECUTE para authenticated/anon desde a 0050 (C1) — a flag só cai por troca real de senha (trigger on_auth_user_password_changed) ou server-side (service_role/DBA). A chamada não prova troca de senha; nunca foi controle suficiente.';
