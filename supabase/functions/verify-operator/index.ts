// Edge Function `verify-operator` v2 — SEC-DEBT-49 (internal-admin L1 / T03).
// Único caminho de prova de operador (fail-closed): valida o JWT via
// `auth.getUser(jwt)` server-side, lê `profiles(role, must_change_password)`
// e `internal_operators(active)` com `service_role`, responde 200/401/403
// sem vazar dado. `service_role` confinado a esta borda (server-only);
// nunca em `VITE_*` nem no bundle. Erro/timeout = nega. Sem cache client
// como prova.
//
// Ordem canônica (espelha `public.is_super_admin()`, 0051:86-124):
//   sem JWT / JWT inválido            → 401 { is_operator: false }
//   profile ausente / erro            → 403 { is_operator: false }
//   must_change_password !== false    → 403 { is_operator: false, error: 'first-access' }
//   role <> 'super_admin'             → 403 { is_operator: false } (motivo só interno)
//   aal <> 'aal2'                     → 403 { is_operator: false, error: 'mfa-required' }
//   sem operador active=true          → 403 { is_operator: false, error: 'operator-inactive' }
//   tudo OK                           → 200 { is_operator: true, aal: 'aal2', user_id }
// Deadline TOTAL 5 s (soma das etapas); estourou = 403, nunca 200.
// Sem PII: sem e-mail, sem role, sem tenant — só is_operator/aal/error e, no
// 200, `user_id` (id da própria sessão do chamador; contrato do ADR-004).
//
// Deploy: `supabase functions deploy verify-operator` (verify_jwt=true,
// gateway nega sem JWT antes da borda; a borda revalida via auth.getUser)
// + secrets SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL (obrigatório —
// sem APP_URL nenhum Origin é confiável: fail-closed, nunca `*`).
// Lógica pura em ./core.ts (testável offline); aqui só deps reais + serve.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'
import { handleVerifyOperator, type VerifyDeps } from './core.ts'

function buildDeps(): VerifyDeps {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  // Sem env, o client falha fechado: getUser/lookup lançam e o core vira 403.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  return {
    getUser: async (jwt: string) => {
      const { data, error } = await admin.auth.getUser(jwt)
      if (error || !data.user) return { user: null, error: error ?? new Error('no-user') }
      return { user: { id: data.user.id }, error: null }
    },
    getProfile: async (userId: string) => {
      const { data, error } = await admin
        .from('profiles')
        .select('role, must_change_password')
        .eq('id', userId)
        .maybeSingle()
      if (error) throw new Error('profile-lookup-failed')
      if (data === null) return null
      return data as { role?: unknown; must_change_password?: unknown }
    },
    isActiveOperator: async (userId: string) => {
      const { data, error } = await admin
        .from('internal_operators')
        .select('active')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw new Error('operator-lookup-failed')
      return (data as { active?: unknown } | null)?.active === true
    },
    appUrl: Deno.env.get('APP_URL') ?? '',
    deadlineMs: 5000,
  }
}

if (import.meta.main) {
  const deps = buildDeps()
  serve((req: Request) => handleVerifyOperator(req, deps))
}
