// Edge Function `admin-invite-user` — ADR-003 (R3-A), SPEC §5.
// Convite sem senha: o app envia só `email`; a credencial nasce no aceite
// do convite, no Auth. `service_role` confinado a esta borda (server-only);
// nunca em `VITE_*` nem no bundle (C-1, guarda por grep em `src/` e `dist/`).
//
// Rotas (mesmo gate operador por JWT nas duas) — contrato v3 (SPEC §4.1):
// · POST   { email }   → resolve/convida/registra → `200 { user_id, state }`
// · DELETE { user_id } → `admin_cancel_invite` (precisa devolver `true`) +
//   `deleteUser` → `200 { ok: true }`; sem cancelamento autorizado ⇒ `500`
// Erro sempre `{ error: 'invite-failed' }` (C-4: sem detalhe do provedor,
// sem token, sem eco de email). Cota esgotada ⇒ `429 invite-rate-limited` +
// `Retry-After`. Log só com `request_id` + `ok` (sem email/token).
//
// Pipeline do POST vive em ./core.ts (`handleInvite`): resolução do e-mail é
// **server-side** (`admin_resolve_invited_user`, service_role) — o cliente só
// manda `email`, nunca `user_id`. Cota/trilha/cancelamento usam o JWT do
// chamador (`admin_invite_quota`, `admin_record_invite`, `admin_cancel_invite`);
// Auth (convite/delete) usa `service_role`. Nenhum id é inventado na borda.
//
// Gate (internal-admin L1 / T03, ADR-02): operador ativo + aal2.
// O gate antigo (`profiles.role='admin'`) era stale pós-0035 (CHECK só aceita
// user/super_admin) e negava todo convite. Agora delega a ./core.ts
// (internal_operators active=true + aal2, espelho de private.is_aal2()).
// Qualquer erro/timeout = nega (fail-closed).
//
// Deploy: `supabase functions deploy admin-invite-user` (verify_jwt=true,
// gateway nega sem JWT; a Function revalida via auth.getUser) + secrets
// `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (cota/trilha
// com JWT do chamador), `APP_URL` (obrigatório — sem ele a borda responde 403
// para qualquer Origin: fail-closed, nunca `*`) e `APP_URL_ALIASES` (opcional;
// origens extras separadas por vírgula, ex.: `http://localhost:5173` quando o
// dev server também serve nesse host). APP_URL permanece um único valor.
// Qualquer secret ausente ⇒ 500 `invite-failed` (nunca convite sem trilha).
//
// Throttle invite (SPEC §4, BE-07): 10 POSTs/min por IP → `429` com
// `Retry-After` (in-memory por isolate; prod usa WAF/rate-limit da borda
// como segunda camada). Leituras admin (RPCs `admin_*`) não têm throttle
// no banco (T-G8a prova ausência de falso-positivo); o 60/min de leitura
// vive na mesma borda quando exposta via HTTP.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'
import {
  handleDelete,
  handleInvite,
  isCallerOperator,
  extractBearer,
  allowedOrigin as coreAllowedOrigin,
} from './core.ts'
import type { EdgeResult, InviteEdgeDeps } from './core.ts'

const FAILURE = { error: 'invite-failed' } as const
const RATE_LIMITED = { error: 'invite-rate-limited' } as const

// Helper local da borda: lê APP_URL + APP_URL_ALIASES do ambiente e delega a
// comparação exata em ./core.ts (puro, testável offline). APP_URL permanece UM
// valor; aliases extras vêm de APP_URL_ALIASES (split ',', trim, descarta '',
// '*' e 'null'). Fail-closed: sem origens válidas ⇒ nenhuma Origin confiável.
// Requisições sem Origin (curl/server-to-server) seguem para o gate admin.
function allowedOrigin(req: Request): string | null {
  return coreAllowedOrigin(
    req,
    Deno.env.get('APP_URL') ?? '',
    Deno.env.get('APP_URL_ALIASES') ?? '',
  )
}

function corsHeaders(req: Request): HeadersInit {
  const allow = allowedOrigin(req)
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  }
  if (allow !== null) headers['Access-Control-Allow-Origin'] = allow
  return headers
}

// Throttle pré-auth por IP+rota (invite 10/min → 429 + Retry-After).
const INVITE_WINDOW_MS = 60_000
const INVITE_MAX_HITS = 10
const inviteHits = new Map<string, number[]>()

function inviteThrottled(req: Request): number {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown'
  const key = `${ip}:POST:/admin-invite-user`
  const now = Date.now()
  const windowStart = now - INVITE_WINDOW_MS
  const hits = (inviteHits.get(key) ?? []).filter((t) => t > windowStart)
  if (hits.length >= INVITE_MAX_HITS) {
    const retryAfter = Math.ceil((hits[0] + INVITE_WINDOW_MS - now) / 1000)
    return Math.max(retryAfter, 1)
  }
  hits.push(now)
  inviteHits.set(key, hits)
  return 0
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(req) })
}

// Resposta do pipeline puro + headers do resultado (ex.: `Retry-After`).
function resultResponse(req: Request, result: EdgeResult): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...corsHeaders(req), ...(result.headers ?? {}) },
  })
}

function trace(route: string, ok: boolean): void {
  console.log(JSON.stringify({ request_id: crypto.randomUUID(), route, ok }))
}

interface EdgeEnv {
  url: string
  serviceKey: string
  anonKey: string
}

// Fail-closed: sem os três secrets não há convite coerente (Auth + cota com
// JWT do chamador). Ausente ⇒ 500 `invite-failed`, nunca caminho parcial.
function readEnv(): EdgeEnv | null {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (url === '' || serviceKey === '' || anonKey === '') return null
  return { url, serviceKey, anonKey }
}

async function isCallerAdmin(req: Request, env: EdgeEnv): Promise<boolean> {
  // Re-gate L1: operador ativo + aal2 via ./core.ts (nunca role de client,
  // nunca profiles.role stale). Falha fechada em qualquer erro/timeout.
  const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } })
  return isCallerOperator(req, {
    getUser: async (jwt: string) => {
      const { data, error } = await admin.auth.getUser(jwt)
      if (error || !data.user) return { user: null, error: error ?? new Error('no-user') }
      return { user: { id: data.user.id }, error: null }
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
    timeoutMs: 5000,
  })
}

// Clientes: `service_role` só no que exige privilégio (Auth + resolução de
// e-mail); as RPCs operador-scoped levam o JWT do chamador (auth.uid() real).
function inviteDeps(req: Request, env: EdgeEnv): InviteEdgeDeps {
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false } })
  const jwt = extractBearer(req) ?? ''
  const caller = createClient(env.url, env.anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  return {
    resolveInvitedUser: async (email: string) => {
      const { data, error } = await service.rpc('admin_resolve_invited_user', { p_email: email })
      if (error) return { userId: null, error }
      return { userId: typeof data === 'string' ? data : null, error: null }
    },
    inviteQuota: async () => {
      const { data, error } = await caller.rpc('admin_invite_quota')
      if (error) return { remaining: null, error }
      return { remaining: typeof data === 'number' ? data : null, error: null }
    },
    inviteUser: async (email: string) => {
      const { data, error } = await service.auth.admin.inviteUserByEmail(email)
      if (error || !data.user) return { userId: null, error: error ?? new Error('no-user') }
      return { userId: data.user.id, error: null }
    },
    recordInvite: async (userId: string) => {
      const { error } = await caller.rpc('admin_record_invite', { p_target: userId })
      return { error: error ?? null }
    },
    cancelInvite: async (userId: string) => {
      const { data, error } = await caller.rpc('admin_cancel_invite', { p_target: userId })
      if (error) return { canceled: null, error }
      return { canceled: data === true, error: null }
    },
    deleteUser: async (userId: string) => {
      const { error } = await service.auth.admin.deleteUser(userId)
      return { error: error ?? null }
    },
  }
}

async function readPayload(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const payload: unknown = await req.json()
    if (typeof payload !== 'object' || payload === null) return null
    return payload as Record<string, unknown>
  } catch {
    return null
  }
}

async function handleInviteRoute(req: Request, env: EdgeEnv): Promise<Response> {
  const payload = await readPayload(req)
  if (payload === null) {
    trace('POST', false)
    return json(req, 400, FAILURE)
  }
  const result = await handleInvite(payload.email, inviteDeps(req, env))
  trace('POST', result.status === 200)
  return resultResponse(req, result)
}

async function handleDeleteRoute(req: Request, env: EdgeEnv): Promise<Response> {
  const payload = await readPayload(req)
  if (payload === null) {
    trace('DELETE', false)
    return json(req, 400, FAILURE)
  }
  const result = await handleDelete(payload.user_id, inviteDeps(req, env))
  trace('DELETE', result.status === 200)
  return resultResponse(req, result)
}

if (import.meta.main) {
  serve(async (req: Request): Promise<Response> => {
    // CORS fail-closed antes de qualquer gate: Origin desconhecida (ou
    // APP_URL ausente) → 403 sem `Access-Control-Allow-Origin:*`.
    const origin = req.headers.get('Origin')
    if (origin !== null && allowedOrigin(req) === null) {
      trace(req.method, false)
      return new Response(JSON.stringify(FAILURE), {
        status: 403,
        headers: { 'Content-Type': 'application/json', Vary: 'Origin' },
      })
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) })
    }
    const env = readEnv()
    if (env === null) {
      // Fail-closed de configuração: sem Auth/anon key não existe convite com
      // trilha. Nunca convida "pela metade".
      trace(req.method, false)
      return json(req, 500, FAILURE)
    }
    if (req.method === 'POST') {
      const retryAfter = inviteThrottled(req)
      if (retryAfter > 0) {
        trace(req.method, false)
        return new Response(JSON.stringify(RATE_LIMITED), {
          status: 429,
          headers: { ...corsHeaders(req), 'Retry-After': String(retryAfter) },
        })
      }
    }
    if (!(await isCallerAdmin(req, env))) {
      trace(req.method, false)
      return json(req, 401, FAILURE)
    }
    if (req.method === 'POST') return handleInviteRoute(req, env)
    if (req.method === 'DELETE') return handleDeleteRoute(req, env)
    trace(req.method, false)
    return json(req, 405, FAILURE)
  })
}
