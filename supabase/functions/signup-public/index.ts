// Edge Function `signup-public` — ADR-001 / SIGN-02..04, SIGN-12..13.
//
// POST /functions/v1/signup-public · verify_jwt=false (config.toml, hunk 2).
// Superfície pública do auto-serviço: a identidade nasce no GoTrue com a
// chave publicável/anon (signUp envia o e-mail de confirmação pelo mailer
// configurado; NUNCA admin.createUser/generateLink/resend no caminho inicial,
// NUNCA email_confirm:true). O negócio nasce na RPC service_role.
//
// Respostas (interface congelada):
//   201 { ok:true, message:'auth.signup.success' } — conta nova, e-mail
//       duplicado OU colisão de documento entre donos diferentes (bytes idênticos)
//   400 { error:'cadastro-invalido' } — única texto genérico
//   429 { error:'muitas-tentativas' } + Retry-After — 0 escrita de domínio
//   500 { error:'cadastro-falhou' } — compensação tentada, detalhe nunca vaza
// Log: request_id + route + ok. Sem e-mail/senha/documento/token/id no log.
//
// Segredos: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (só servidor), chave
// publicável SUPABASE_PUBLISHABLE_KEY/SUPABASE_ANON_KEY (signUp) e APP_URL
// (redirect allowlisted). Nada é literal no repo; ausência ⇒ 500 fail-closed.
//
// Ordem: CORS fail-closed → throttle → admin_resolve_invited_user → signUp →
// RPC → compensação → resposta. Pipeline puro em ./core.ts; aqui só wiring.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'
import {
  allowedOrigin as coreAllowedOrigin,
  clientKeys,
  FAILURE_BODY,
  handleSignup,
  INVALID_BODY,
  realSignUpUserId,
  tracePayload,
} from './core.ts'
import type { EdgeResult, HeaderReader, SignupContext, SignupDeps } from './core.ts'

const ROUTE = 'POST /functions/v1/signup-public'
const hits = new Map<string, number[]>()

interface EdgeEnv {
  url: string
  serviceKey: string
  publishableKey: string
  appUrl: string
}

function readEnv(): EdgeEnv | null {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const publishableKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    ?? Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const appUrl = Deno.env.get('APP_URL') ?? ''
  if (url === '' || serviceKey === '' || publishableKey === '' || appUrl === '') return null
  return { url, serviceKey, publishableKey, appUrl }
}

function allowedOrigin(req: Request): string | null {
  return coreAllowedOrigin(
    req.headers.get('Origin'),
    Deno.env.get('APP_URL') ?? '',
    Deno.env.get('APP_URL_ALIASES') ?? '',
  )
}

function corsHeaders(req: Request): Record<string, string> {
  const allow = allowedOrigin(req)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allow !== null) headers['Access-Control-Allow-Origin'] = allow
  return headers
}

function json(req: Request, status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), ...(extra ?? {}) },
  })
}

function trace(requestId: string, ok: boolean): void {
  console.log(JSON.stringify(tracePayload(requestId, ROUTE, ok)))
}

function makeDeps(
  env: EdgeEnv,
  requestId: string,
  header: HeaderReader,
): { ctx: SignupContext; deps: SignupDeps } {
  // Separação explícita: signUp usa a chave publicável; resolução/RPC/audit/
  // compensação usam service_role. Nenhuma das duas aparece em log ou corpo.
  const keys = clientKeys({ anonKey: env.publishableKey, serviceKey: env.serviceKey })
  const anon = createClient(env.url, keys.signupKey, { auth: { persistSession: false } })
  const service = createClient(env.url, keys.privilegedKey, { auth: { persistSession: false } })

  const ctx: SignupContext = {
    requestId,
    route: ROUTE,
    appUrl: env.appUrl,
    header,
  }

  const deps: SignupDeps = {
    now: () => Date.now(),
    throttleState: hits,
    resolveInvitedUser: async (email: string) => {
      const { data, error } = await service.rpc('admin_resolve_invited_user', { p_email: email })
      if (error) return { userId: null, error }
      return { userId: typeof data === 'string' ? data : null, error: null }
    },
    signUp: async (input) => {
      // SignUp com anon: GoTrue entrega o e-mail de confirmação; sem
      // email_confirm:true (RF-06) e sem metadata com PII.
      const { data, error } = await anon.auth.signUp({
        email: input.email,
        password: input.password,
        options: { emailRedirectTo: input.redirectTo },
      })
      // Usuário obfuscado/fake (identities vazia) NÃO é identidade criada.
      // core.ts mapeia userId ausente a 201 genérico: 0 provisionamento e
      // 0 compensação — nunca apagar id de terceiro (🟡-1 / CWE-204).
      const userId = realSignUpUserId(data)
      if (error || userId === null) return { userId: null, error: error ?? null }
      return { userId, error: null }
    },
    provision: async (args) => {
      const { data, error } = await service.rpc('create_tenant_for_public_signup', {
        p_request_id: args.requestId,
        p_owner_user_id: args.ownerUserId,
        p_kind: args.kind,
        p_document: args.document,
        p_razao_social: args.razaoSocial,
        p_nome_fantasia: args.nomeFantasia,
        p_phone: args.phone,
        p_cep: args.cep,
        p_logradouro: args.logradouro,
        p_numero: args.numero,
        p_complemento: args.complemento,
        p_bairro: args.bairro,
        p_cidade: args.cidade,
        p_uf: args.uf,
        p_contract_version: args.contractVersion,
      })
      if (error) return { tenantId: null, error }
      return { tenantId: typeof data === 'string' ? data : null, error: null }
    },
    recordAudit: async (event, userId = null) => {
      const { error } = await service.rpc('record_public_signup_audit', {
        p_request_id: requestId,
        p_event: event,
        p_user_id: userId,
      })
      return { error: error ?? null }
    },
    deleteUser: async (userId: string) => {
      const { error } = await service.auth.admin.deleteUser(userId)
      return { error: error ?? null }
    },
    orphanAlert: (requestId: string) => {
      // R1: órfão residual é REGISTRADO (alerta), nunca negado. Sem PII.
      console.error(JSON.stringify({
        event: 'signup-public-orphan-alert', request_id: requestId, ok: false,
      }))
    },
  }
  return { ctx, deps }
}

if (import.meta.main) {
  serve(async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID()

    // CORS fail-closed ANTES de qualquer etapa: Origin desconhecida ⇒ 400
    // genérico sem Access-Control-Allow-Origin (nunca '*').
    if (req.headers.get('Origin') !== null && allowedOrigin(req) === null) {
      trace(requestId, false)
      return new Response(JSON.stringify(INVALID_BODY), {
        status: 400,
        headers: { 'Content-Type': 'application/json', Vary: 'Origin' },
      })
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) })
    }

    const env = readEnv()
    if (env === null || req.method !== 'POST') {
      trace(requestId, false)
      return json(req, 500, FAILURE_BODY)
    }

    const wired = makeDeps(env, requestId, (name: string) => req.headers.get(name))
    let payload: unknown = null
    try {
      payload = await req.json()
    } catch {
      payload = null
    }
    const result: EdgeResult = await handleSignup(payload, wired.ctx, wired.deps)
    trace(requestId, result.status === 201)
    return json(req, result.status, result.body, result.headers)
  })
}
