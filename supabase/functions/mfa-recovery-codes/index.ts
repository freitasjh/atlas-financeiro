// Edge Function `mfa-recovery-codes` — ADR-001 / EDGE-01 (control plane).
// Expõe 3 rotas de gestão de códigos de recuperação MFA; consumo fica FORA
// desta borda (browser chama `mfa_recovery_consume` com token aal1).
//
//   POST /generate     → { set_id, codes:[10] }  (exibição única)
//   GET  /status       → { total, remaining, low, codes:[{id,used_at}] }
//   POST /regenerate   → { set_id, codes:[10] }  (confirmação textual)
//
// R2 🔴: `getUser(jwt)` recebe o JWT DO CHAMADOR e toda a cadeia de gate
// (profiles → internal_operators → aal) é montada a partir do id que ele
// devolveu. `service_role` é usado SÓ para ler profiles/internal_operators
// e chamar as RPCs — nunca como prova de operador. Erro/timeout = nega,
// com ZERO chamada às RPCs (provado em index_test.ts).
//
// Plaintext de códigos existe apenas no 200 de generate/regenerate; nenhum
// log, nenhuma mensagem de erro com código. Segredos fora de código:
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-only, nunca VITE_*),
// APP_URL (obrigatório para CORS confiável; sem ele nenhuma Origin passa)
// e APP_URL_ALIASES (opcional, origens extras separadas por vírgula).
//
// Deploy: `supabase functions deploy mfa-recovery-codes` (verify_jwt=true,
// gateway nega sem JWT antes da borda; a borda revalida via auth.getUser).
// Lógica pura em ./core.ts (testável offline); aqui só deps reais + serve.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'
import { handleRecoveryCodes, type RecoveryDeps } from './core.ts'

// Construção LAZY: sem SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, cada deps lança
// e o core devolve 403 fail-closed. Nunca cria client com credencial vazia
// (createClient vazio lançaria fora do handler, derrubando o isolate).
function adminClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (url === '' || serviceKey === '') throw new Error('mfa-recovery-config-missing')
  return createClient(url, serviceKey, { auth: { persistSession: false } })
}

function buildDeps(): RecoveryDeps {
  return {
    getUser: async (jwt: string) => {
      const { data, error } = await adminClient().auth.getUser(jwt)
      if (error || !data.user) return { user: null, error: error ?? new Error('no-user') }
      return { user: { id: data.user.id }, error: null }
    },
    getProfile: async (userId: string) => {
      const { data, error } = await adminClient()
        .from('profiles')
        .select('role, must_change_password')
        .eq('id', userId)
        .maybeSingle()
      if (error) throw new Error('profile-lookup-failed')
      if (data === null) return null
      return data as { role?: unknown; must_change_password?: unknown }
    },
    isActiveOperator: async (userId: string) => {
      const { data, error } = await adminClient()
        .from('internal_operators')
        .select('active')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw new Error('operator-lookup-failed')
      return (data as { active?: unknown } | null)?.active === true
    },
    // RPCs de gestão: EXECUTE service_role (0083). p_user_id é o id validado
    // pelo getUser do chamador — nunca um parâmetro do body da request.
    generate: async (userId: string) => {
      const { data, error } = await adminClient().rpc('mfa_recovery_generate', { p_user_id: userId })
      if (error) throw new Error('generate-rpc-failed')
      return data as unknown
    },
    status: async (userId: string) => {
      const { data, error } = await adminClient().rpc('mfa_recovery_status', { p_user_id: userId })
      if (error) throw new Error('status-rpc-failed')
      return data as unknown
    },
    regenerate: async (userId: string, confirmation: string) => {
      const { data, error } = await adminClient().rpc('mfa_recovery_regenerate', {
        p_user_id: userId,
        p_confirmation: confirmation,
      })
      if (error) throw new Error('regenerate-rpc-failed')
      return data as unknown
    },
    appUrl: Deno.env.get('APP_URL') ?? '',
    appUrlAliases: Deno.env.get('APP_URL_ALIASES') ?? '',
    deadlineMs: 5000,
  }
}

if (import.meta.main) {
  serve((req: Request) => handleRecoveryCodes(req, buildDeps()))
}
