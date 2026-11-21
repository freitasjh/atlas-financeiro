// Deno tests `mfa-recovery-codes` — ADR-001 / EDGE-01 (TDD: escritos ANTES de
// core.ts/index.ts). Importa só ./core.ts (sem fetch remoto): roda offline
// via `deno test --allow-env --no-remote` e via `npm run test:edge` (shim).
//
// Matriz obrigatória (TASKS.md EDGE-01):
//   401 sem JWT / JWT inválido; 403 first-access, mfa-required,
//   operator-inactive, genérico (erro/timeout) — ZERO chamada RPC;
//   200 só com operador aal2 + ativo nas 3 rotas;
//   409 active-set-conflict / confirmation-required;
//   R2 🔴: gate com JWT do chamador (getUser juncao), service_role só nas RPCs;
//   CORS fail-closed (APP_URL + APP_URL_ALIASES, unknown ⇒ 403 sem ACAO);
//   plaintext SÓ no 200 de generate/regenerate — nunca em erro/log.
//
// Convenção de nome: when{Action}_then{Expected}.

import {
  CONFIRMATION_TOKEN,
  decodeJwtPayload,
  handleRecoveryCodes,
  parseAllowedOrigins,
  parseRoute,
  resolveAal,
} from './core.ts'
import type { RecoveryDeps } from './core.ts'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function assertEq<T>(got: T, want: T, msg: string): void {
  if (got !== want) throw new Error(`${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function makeJwt(payload: Record<string, unknown>): string {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64url(JSON.stringify(payload))
  return `${h}.${p}.fakesig`
}

interface ReqOpts {
  origin?: string
  method?: string
  path?: string
  body?: unknown
}

function reqWithJwt(jwt: string | null, opts: ReqOpts = {}): Request {
  const headers = new Headers()
  if (jwt !== null) headers.set('Authorization', `Bearer ${jwt}`)
  if (opts.origin !== undefined) headers.set('Origin', opts.origin)
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  }
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(opts.body)
  }
  return new Request(`http://localhost${opts.path ?? '/status'}`, init)
}

const OPERATOR_ID = 'f0e1d2c3-b4a5-4678-9abc-def012345678'
const SET_ID = '11111111-2222-3333-4444-555555555555'
const NEW_SET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CALLER_JWT = makeJwt({ sub: OPERATOR_ID, aal: 'aal2', role: 'authenticated' })

// 10 códigos base32/24 distintos — formato congelado da migration 0083.
const CODES: string[] = Array.from({ length: 10 }, (_, i) =>
  'abcdefghijklmnopqrstuvwxyz234567'.slice(0, 23) + String.fromCharCode(97 + i))
const CODE_SENTINEL = CODES[0]

function uuidAt(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
}

function statusResult(remaining: number): Record<string, unknown> {
  return {
    total: 10,
    remaining,
    low: remaining <= 2,
    codes: Array.from({ length: 10 }, (_, i) => ({
      id: uuidAt(i),
      used_at: i < 10 - remaining ? '2026-11-20T12:00:00.000Z' : null,
    })),
  }
}

interface RpcCall {
  name: 'generate' | 'status' | 'regenerate'
  userId: string
  confirmation?: string
}

interface Fixture {
  deps: RecoveryDeps
  calls: RpcCall[]
  getUsers: string[]
}

function baseDeps(overrides: Partial<RecoveryDeps> = {}): Fixture {
  const calls: RpcCall[] = []
  const getUsers: string[] = []
  const deps: RecoveryDeps = {
    getUser: async (jwt: string) => {
      getUsers.push(jwt)
      return { user: { id: OPERATOR_ID }, error: null }
    },
    getProfile: async () => ({ role: 'super_admin', must_change_password: false }),
    isActiveOperator: async () => true,
    generate: async (userId: string) => {
      calls.push({ name: 'generate', userId })
      return { set_id: SET_ID, codes: CODES }
    },
    status: async (userId: string) => {
      calls.push({ name: 'status', userId })
      return statusResult(8)
    },
    regenerate: async (userId: string, confirmation: string) => {
      calls.push({ name: 'regenerate', userId, confirmation })
      return { set_id: NEW_SET_ID, codes: CODES }
    },
    appUrl: 'https://app.test',
    deadlineMs: 2000,
    ...overrides,
  }
  return { deps, calls, getUsers }
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))
}

async function expectNoLeak(res: Response, label?: string): Promise<void> {
  const text = await res.text()
  assert(!text.includes(CODE_SENTINEL), `corpo não deve conter código em claro${label ? ` (${label})` : ''}: ${text}`)
  assert(!text.includes('code_hash'), 'corpo não deve conter code_hash')
}

// ---------- parse/validadores puros ----------

Deno.test('whenGatewayPrefixedPath_thenRouteParsed', () => {
  assertEq(parseRoute('/functions/v1/mfa-recovery-codes/generate'), 'generate', 'rota com prefixo do gateway')
  assertEq(parseRoute('/generate'), 'generate', 'rota direta')
  assertEq(parseRoute('/status/'), 'status', 'trailing slash')
  assertEq(parseRoute('/'), null, 'sem rota')
  assertEq(parseRoute('/unknown'), null, 'rota desconhecida')
})

Deno.test('whenAliasListParsed_thenWildcardsAndNullDiscarded', () => {
  const list = parseAllowedOrigins('https://app.test', ' , http://localhost:5173 ,, *, null')
  assertEq(list.length, 2, 'duas origens válidas')
  assertEq(list[0], 'https://app.test', 'APP_URL primeiro')
  assertEq(list[1], 'http://localhost:5173', 'alias válido')
})

// ---------- resolveAal: só o aal do JWT do chamador promove ----------

Deno.test('whenResolveAal_thenOnlyExplicitAalCounts', () => {
  assertEq(resolveAal(null), null, 'payload nulo = null')
  assertEq(resolveAal({ aal: 'aal2' }), 'aal2', 'aal2 explícito')
  assertEq(resolveAal({ aal: 'aal1' }), 'aal1', 'aal1 explícito')
  assertEq(resolveAal({ aal: 'other' }), null, 'aal desconhecido = null')
  assertEq(resolveAal({}), null, 'sem aal = null')
})

Deno.test('whenResolveAalReceivesServiceRole_thenNoPromotion', () => {
  assertEq(
    resolveAal({ role: 'service_role' }),
    null,
    'service_role NÃO promove aal2 (atalho removido — JWT é do chamador)',
  )
  assertEq(
    resolveAal({ role: 'service_role', aal: 'aal1' }),
    'aal1',
    'service_role com aal1 continua aal1',
  )
  assertEq(
    resolveAal({ role: 'service_role', aal: 'aal2' }),
    'aal2',
    'aal2 explícito vence independente do role',
  )
  assertEq(
    resolveAal(decodeJwtPayload(makeJwt({ sub: OPERATOR_ID, role: 'service_role' }))),
    null,
    'JWT decodificado com service_role e sem aal = null',
  )
})

// ---------- 401: sessão ----------

Deno.test('whenNoJwt_then401AndNoRpc', async () => {
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(reqWithJwt(null, { path: '/generate', method: 'POST' }), deps)
  assertEq(res.status, 401, 'sem JWT deve ser 401')
  assertEq((await body(res)).error, 'mfa-recovery-forbidden', 'rótulo congelado de negação')
  assertEq(calls.length, 0, 'sem JWT: zero chamada RPC')
})

Deno.test('whenInvalidJwt_then401AndNoRpc', async () => {
  const { deps, calls } = baseDeps({ getUser: async () => ({ user: null, error: new Error('bad jwt') }) })
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/generate', method: 'POST' }), deps)
  assertEq(res.status, 401, 'JWT inválido deve ser 401')
  assertEq(calls.length, 0, 'JWT inválido: zero chamada RPC')
})

// ---------- 403: gate fail-closed (ordem do 0051) ----------

Deno.test('whenMustChangePassword_then403FirstAccessAndNoRpc', async () => {
  const { deps, calls } = baseDeps({
    getProfile: async () => ({ role: 'super_admin', must_change_password: true }),
  })
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/generate', method: 'POST' }), deps)
  assertEq(res.status, 403, 'first-access deve ser 403')
  assertEq((await body(res)).error, 'first-access', 'rótulo first-access')
  assertEq(calls.length, 0, 'first-access: zero chamada RPC')
})

Deno.test('whenAal1_then403MfaRequiredAndNoRpc', async () => {
  const jwt = makeJwt({ sub: OPERATOR_ID, aal: 'aal1', role: 'authenticated' })
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(reqWithJwt(jwt, { path: '/status' }), deps)
  assertEq(res.status, 403, 'aal1 deve ser 403')
  assertEq((await body(res)).error, 'mfa-required', 'rótulo mfa-required')
  assertEq(calls.length, 0, 'aal1: zero chamada RPC')
})

Deno.test('whenAalMissing_then403MfaRequired', async () => {
  const jwt = makeJwt({ sub: OPERATOR_ID, role: 'authenticated' })
  const res = await handleRecoveryCodes(reqWithJwt(jwt, { path: '/status' }), baseDeps().deps)
  assertEq(res.status, 403, 'aal ausente deve negar')
  assertEq((await body(res)).error, 'mfa-required', 'aal ausente = mfa-required (fail-closed)')
})

Deno.test('whenJwtServiceRoleWithoutAal_then403MfaRequiredAndNoRpc', async () => {
  const jwt = makeJwt({ sub: OPERATOR_ID, role: 'service_role' })
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(reqWithJwt(jwt, { path: '/generate', method: 'POST' }), deps)
  assertEq(res.status, 403, 'service_role sem aal não promove aal2')
  assertEq((await body(res)).error, 'mfa-required', 'rótulo mfa-required')
  assertEq(calls.length, 0, 'service_role sem aal: zero chamada RPC')
})

Deno.test('whenJwtServiceRoleWithAal1_then403MfaRequiredAndNoRpc', async () => {
  const jwt = makeJwt({ sub: OPERATOR_ID, role: 'service_role', aal: 'aal1' })
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(reqWithJwt(jwt, { path: '/status' }), deps)
  assertEq(res.status, 403, 'service_role com aal1 não promove aal2')
  assertEq((await body(res)).error, 'mfa-required', 'rótulo mfa-required')
  assertEq(calls.length, 0, 'service_role com aal1: zero chamada RPC')
})

Deno.test('whenRoleUser_then403GenericAndNoRpc', async () => {
  const { deps, calls } = baseDeps({
    getProfile: async () => ({ role: 'user', must_change_password: false }),
  })
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/status' }), deps)
  assertEq(res.status, 403, 'role != super_admin deve ser 403')
  assertEq((await body(res)).error, 'mfa-recovery-forbidden', 'genérico não vaza role')
  assertEq(calls.length, 0, 'role errada: zero chamada RPC')
})

Deno.test('whenProfileMissing_then403Generic', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status' }),
    baseDeps({ getProfile: async () => null }).deps,
  )
  assertEq(res.status, 403, 'profile ausente = fail-closed')
  assertEq((await body(res)).error, 'mfa-recovery-forbidden', 'genérico')
})

Deno.test('whenOperatorInactive_then403AndNoRpc', async () => {
  const { deps, calls } = baseDeps({ isActiveOperator: async () => false })
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/status' }), deps)
  assertEq(res.status, 403, 'operador inativo deve ser 403')
  assertEq((await body(res)).error, 'operator-inactive', 'rótulo operator-inactive')
  assertEq(calls.length, 0, 'operador inativo: zero chamada RPC')
})

Deno.test('whenProfileThrows_then403AndNoRpc', async () => {
  const { deps, calls } = baseDeps({
    getProfile: async () => {
      throw new Error('db down')
    },
  })
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/generate', method: 'POST' }), deps)
  assertEq(res.status, 403, 'erro no profile = 403 fail-closed')
  assertEq(calls.length, 0, 'erro no profile: zero chamada RPC')
})

Deno.test('whenGetUserThrows_then403AndNoRpc', async () => {
  const { deps, calls } = baseDeps({
    getUser: async () => {
      throw new Error('auth down')
    },
  })
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/status' }), deps)
  assertEq(res.status, 403, 'erro no getUser = 403 fail-closed')
  assertEq(calls.length, 0, 'erro no getUser: zero chamada RPC')
})

Deno.test('whenGetUserTimesOut_then403AndNoRpc', async () => {
  const { deps, calls } = baseDeps({ getUser: () => never(), deadlineMs: 50 })
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/status' }), deps)
  assertEq(res.status, 403, 'timeout no getUser = 403')
  assertEq(calls.length, 0, 'timeout: zero chamada RPC')
})

Deno.test('whenTotalDeadlineExceeded_then403AndNoRpc', async () => {
  const { deps, calls } = baseDeps({
    getUser: () => delay(40, { user: { id: OPERATOR_ID }, error: null }),
    getProfile: () => delay(40, { role: 'super_admin', must_change_password: false }),
    deadlineMs: 60,
  })
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/status' }), deps)
  assertEq(res.status, 403, 'orçamento total estourado = 403')
  assertEq(calls.length, 0, 'deadline estourado: zero chamada RPC')
})

Deno.test('whenMustChangeAal1AndInactive_thenFirstAccessWins', async () => {
  const jwt = makeJwt({ sub: OPERATOR_ID, aal: 'aal1', role: 'authenticated' })
  const res = await handleRecoveryCodes(
    reqWithJwt(jwt, { path: '/status' }),
    baseDeps({
      getProfile: async () => ({ role: 'super_admin', must_change_password: true }),
      isActiveOperator: async () => false,
    }).deps,
  )
  assertEq((await body(res)).error, 'first-access', 'ordem canônica: first-access vence')
})

// ---------- R2 🔴: veredito vem do JWT do chamador ----------

Deno.test('whenGenerating_thenGateUsesCallerJwtAndUserIdFromGetUser', async () => {
  const { deps, calls, getUsers } = baseDeps()
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, {
      path: '/generate',
      method: 'POST',
      body: { user_id: '99999999-9999-4999-8999-999999999999' },
    }),
    deps,
  )
  assertEq(res.status, 200, 'operador aal2 ativo deve gerar')
  assertEq(getUsers.length, 1, 'getUser chamado exatamente uma vez')
  assertEq(getUsers[0], CALLER_JWT, 'R2: getUser recebe o JWT do chamador')
  assertEq(calls.length, 1, 'uma RPC de generate')
  assertEq(calls[0].userId, OPERATOR_ID, 'R2: p_user_id vem do JWT validado, nunca do body')
  assertEq(calls[0].name, 'generate', 'RPC correta')
})

Deno.test('whenRegenerating_thenConfirmationForwardedAndUserIdFromCaller', async () => {
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, {
      path: '/regenerate',
      method: 'POST',
      body: { confirmation: CONFIRMATION_TOKEN, user_id: '99999999-9999-4999-8999-999999999999' },
    }),
    deps,
  )
  assertEq(res.status, 200, 'regeneração com confirmação deve passar')
  assertEq(calls.length, 1, 'uma RPC de regenerate')
  assertEq(calls[0].name, 'regenerate', 'RPC correta')
  assertEq(calls[0].userId, OPERATOR_ID, 'user_id do chamador validado')
  assertEq(calls[0].confirmation, CONFIRMATION_TOKEN, 'confirmação exata encaminhada')
})

// ---------- 200: três rotas ----------

Deno.test('whenGeneratePost_then200WithTenCodes', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/generate', method: 'POST' }),
    baseDeps().deps,
  )
  assertEq(res.status, 200, 'generate deve ser 200')
  const b = await body(res)
  assertEq(b.set_id, SET_ID, 'set_id do retorno da RPC')
  const codes = b.codes as string[]
  assert(Array.isArray(codes) && codes.length === 10, 'exatamente 10 códigos')
  for (const code of codes) assert(/^[a-z2-7]{24}$/.test(code), `código base32/24: ${code}`)
})

Deno.test('whenStatusGet_then200FrozenFieldsOnly', async () => {
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/status' }), baseDeps().deps)
  assertEq(res.status, 200, 'status deve ser 200')
  const b = await body(res)
  assertEq(Object.keys(b).sort().join(','), 'codes,low,remaining,total', 'só campos congelados')
  assertEq(b.total, 10, 'total 10')
  assertEq(b.remaining, 8, 'remaining')
  assertEq(b.low, false, 'low=false com remaining=8')
  const codes = b.codes as Record<string, unknown>[]
  assertEq(codes.length, 10, '10 entradas')
  assertEq(Object.keys(codes[0]).sort().join(','), 'id,used_at', 'entrada só com id/used_at')
})

Deno.test('whenStatusRpcReturnsHashField_thenStripped', async () => {
  const poisoned = statusResult(8)
  poisoned.extra = 'leak'
  poisoned.codes = (poisoned.codes as Record<string, unknown>[]).map((c) => ({ ...c, code_hash: 'deadbeef' }))
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status' }),
    baseDeps({ status: async () => poisoned }).deps,
  )
  assertEq(res.status, 200, 'campos extras não invalidam o payload')
  const text = await res.text()
  assert(!text.includes('code_hash'), 'code_hash nunca sai da borda')
  assert(!text.includes('leak'), 'campo extra nunca sai da borda')
})

Deno.test('whenStatusRemainingBoundary_thenLowRecomputed', async () => {
  for (const [remaining, low] of [[2, true], [3, false], [0, true]] as const) {
    const res = await handleRecoveryCodes(
      reqWithJwt(CALLER_JWT, { path: '/status' }),
      baseDeps({ status: async () => statusResult(remaining) }).deps,
    )
    assertEq(res.status, 200, `status remaining=${remaining}`)
    assertEq((await body(res)).low, low, `low para remaining=${remaining}`)
  }
})

Deno.test('whenGatewayPrefixedGenerate_then200', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, {
      path: '/functions/v1/mfa-recovery-codes/generate',
      method: 'POST',
    }),
    baseDeps().deps,
  )
  assertEq(res.status, 200, 'prefixo /functions/v1/<fn> aceito')
})

// ---------- 405 / 404 ----------

Deno.test('whenGenerateWithGet_then405', async () => {
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/generate' }), baseDeps().deps)
  assertEq(res.status, 405, 'generate exige POST')
  await expectNoLeak(res)
})

Deno.test('whenStatusWithPost_then405', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status', method: 'POST' }),
    baseDeps().deps,
  )
  assertEq(res.status, 405, 'status exige GET')
})

Deno.test('whenUnknownRoute_then404AndNoRpc', async () => {
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(reqWithJwt(CALLER_JWT, { path: '/consume' }), deps)
  assertEq(res.status, 404, 'consume não passa pela Edge (ADR §3.2)')
  assertEq(calls.length, 0, 'rota desconhecida: zero chamada RPC')
})

// ---------- 409: confirmação e conflito ----------

Deno.test('whenRegenerateWithoutConfirmation_then409AndNoRpc', async () => {
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/regenerate', method: 'POST', body: {} }),
    deps,
  )
  assertEq(res.status, 409, 'sem confirmação deve ser 409')
  assertEq((await body(res)).error, 'mfa-recovery-confirmation-required', 'rótulo congelado')
  assertEq(calls.length, 0, 'confirmação inválida: zero chamada RPC (0 escrita)')
})

Deno.test('whenRegenerateWithWrongConfirmation_then409AndNoRpc', async () => {
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, {
      path: '/regenerate',
      method: 'POST',
      body: { confirmation: 'errado' },
    }),
    deps,
  )
  assertEq(res.status, 409, 'confirmação divergente deve ser 409')
  assertEq((await body(res)).error, 'mfa-recovery-confirmation-required', 'rótulo congelado')
  assertEq(calls.length, 0, 'confirmação divergente: zero chamada RPC')
})

Deno.test('whenRegenerateWithNonStringConfirmation_then409AndNoRpc', async () => {
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, {
      path: '/regenerate',
      method: 'POST',
      body: { confirmation: 12345 },
    }),
    deps,
  )
  assertEq(res.status, 409, 'confirmação não-string deve ser 409')
  assertEq(calls.length, 0, 'confirmação inválida: zero chamada RPC')
})

Deno.test('whenRegenerateWithInvalidBody_then409AndNoRpc', async () => {
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(
    new Request('http://localhost/regenerate', {
      method: 'POST',
      headers: new Headers({ Authorization: `Bearer ${CALLER_JWT}` }),
      body: 'not-json',
    }),
    deps,
  )
  assertEq(res.status, 409, 'body inválido cai na confirmação obrigatória')
  assertEq(calls.length, 0, 'body inválido: zero chamada RPC')
})

Deno.test('whenGenerateConflict_then409NoLeak', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/generate', method: 'POST' }),
    baseDeps({
      generate: async () => ({ ok: false, error: 'mfa-recovery-active-set-conflict', message: CODE_SENTINEL }),
    }).deps,
  )
  assertEq(res.status, 409, 'conflito deve ser 409')
  assertEq((await body(res.clone())).error, 'mfa-recovery-active-set-conflict', 'rótulo congelado')
  await expectNoLeak(res)
})

Deno.test('whenRpcReturnsConfirmationRequired_then409', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, {
      path: '/regenerate',
      method: 'POST',
      body: { confirmation: CONFIRMATION_TOKEN },
    }),
    baseDeps({ regenerate: async () => ({ ok: false, error: 'mfa-recovery-confirmation-required' }) }).deps,
  )
  assertEq(res.status, 409, 'confirmação recusada pela RPC deve ser 409')
  assertEq((await body(res)).error, 'mfa-recovery-confirmation-required', 'rótulo congelado')
})

Deno.test('whenStatusNoActiveSet_then409', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status' }),
    baseDeps({ status: async () => ({ ok: false, error: 'mfa-recovery-no-active-set' }) }).deps,
  )
  assertEq(res.status, 409, 'sem set ativo deve ser 409')
  assertEq((await body(res)).error, 'mfa-recovery-no-active-set', 'rótulo congelado')
})

Deno.test('whenRpcForbidden_then403', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status' }),
    baseDeps({ status: async () => ({ ok: false, error: 'mfa-recovery-forbidden' }) }).deps,
  )
  assertEq(res.status, 403, 'forbidden da RPC deve ser 403')
  assertEq((await body(res)).error, 'mfa-recovery-forbidden', 'rótulo congelado')
})

Deno.test('whenRpcThrows_then500NoLeak', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/generate', method: 'POST' }),
    baseDeps({
      generate: async () => {
        throw new Error('db down')
      },
    }).deps,
  )
  assertEq(res.status, 500, 'erro técnico da RPC deve ser 500')
  await expectNoLeak(res)
})

Deno.test('whenRpcReturnsUnknownError_then500GenericNoEcho', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status' }),
    baseDeps({ status: async () => ({ ok: false, error: 'internal-detail', code: CODE_SENTINEL }) }).deps,
  )
  assertEq(res.status, 500, 'rótulo desconhecido = 500 fail-closed')
  const b = await body(res)
  assertEq(b.error, 'mfa-recovery-forbidden', 'genérico, sem ecoar detalhe interno')
  assert(!JSON.stringify(b).includes('internal-detail'), 'detalhe interno não vaza')
})

Deno.test('whenGenerateRpcMalformed_then500NoLeak', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/generate', method: 'POST' }),
    baseDeps({ generate: async () => ({ set_id: SET_ID, codes: CODES.slice(0, 9) }) }).deps,
  )
  assertEq(res.status, 500, 'payload malformado deve ser 500')
  await expectNoLeak(res)
})

Deno.test('whenStatusRpcMalformed_then500NoLeak', async () => {
  const poisoned = statusResult(8)
  poisoned.codes = [{ id: 'bad', used_at: null, code: CODE_SENTINEL }]
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status' }),
    baseDeps({ status: async () => poisoned }).deps,
  )
  assertEq(res.status, 500, 'entrada malformada em status deve ser 500')
  await expectNoLeak(res)
})

// ---------- CORS fail-closed (APP_URL + APP_URL_ALIASES) ----------

Deno.test('whenUnknownOrigin_then403WithoutAcao', async () => {
  const { deps, calls } = baseDeps()
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/generate', method: 'POST', origin: 'https://evil.test' }),
    deps,
  )
  assertEq(res.status, 403, 'origin desconhecida = 403 fail-closed')
  assert(!res.headers.has('Access-Control-Allow-Origin'), 'sem ACAO para origin desconhecida')
  assertEq(calls.length, 0, 'origin desconhecida: zero chamada RPC')
})

Deno.test('whenAllowedOrigin_thenEchoesAcao', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status', origin: 'https://app.test' }),
    baseDeps().deps,
  )
  assertEq(res.status, 200, 'origin permitida passa')
  assertEq(res.headers.get('Access-Control-Allow-Origin'), 'https://app.test', 'ACAO ecoa APP_URL')
})

Deno.test('whenAliasOrigin_then200EchoesAlias', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status', origin: 'http://localhost:5173' }),
    baseDeps({ appUrl: 'http://127.0.0.1:5173', appUrlAliases: 'http://localhost:5173' }).deps,
  )
  assertEq(res.status, 200, 'alias permitido passa')
  assertEq(
    res.headers.get('Access-Control-Allow-Origin'),
    'http://localhost:5173',
    'ACAO ecoa a origin do alias',
  )
})

Deno.test('whenOptions_then204WithAcao', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(null, { path: '/generate', method: 'OPTIONS', origin: 'https://app.test' }),
    baseDeps().deps,
  )
  assertEq(res.status, 204, 'preflight deve ser 204')
  assertEq(res.headers.get('Access-Control-Allow-Origin'), 'https://app.test', 'ACAO no preflight')
})

Deno.test('whenUnknownOriginPreflight_then403WithoutAcao', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(null, { path: '/generate', method: 'OPTIONS', origin: 'https://evil.test' }),
    baseDeps().deps,
  )
  assertEq(res.status, 403, 'preflight de origin desconhecida negado')
  assert(!res.headers.has('Access-Control-Allow-Origin'), 'sem ACAO no preflight desconhecido')
})

Deno.test('whenNoOriginsConfigured_thenEveryOrigin403', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status', origin: 'https://app.test' }),
    baseDeps({ appUrl: '', appUrlAliases: '' }).deps,
  )
  assertEq(res.status, 403, 'sem origens configuradas: fail-closed')
  assert(!res.headers.has('Access-Control-Allow-Origin'), 'sem ACAO')
})

Deno.test('whenWildcardAlias_thenUnknownOriginStill403', async () => {
  const res = await handleRecoveryCodes(
    reqWithJwt(CALLER_JWT, { path: '/status', origin: 'https://evil.test' }),
    baseDeps({ appUrl: 'https://app.test', appUrlAliases: '*' }).deps,
  )
  assertEq(res.status, 403, 'curinga nunca autoriza')
  assert(!res.headers.has('Access-Control-Allow-Origin'), 'curinga não gera ACAO')
})
