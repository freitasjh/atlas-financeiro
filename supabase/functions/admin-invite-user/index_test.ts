// Deno tests admin-invite-user re-gate — internal-admin L1 / T04 (TDD FIRST).
// Importa só ./core.ts (sem fetch remoto): roda offline com `deno test`.
// Prova: `role='admin'` stale pós-0035 ignorado; único gate é
// internal_operators(active=true) + aal2. aal null nega.

import { isCallerOperator, parseAllowedOrigins, allowedOrigin } from './core.ts'
import type { OperatorDeps } from './core.ts'

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

function reqWithJwt(jwt: string | null): Request {
  const headers = new Headers()
  if (jwt !== null) headers.set('Authorization', `Bearer ${jwt}`)
  return new Request('http://localhost/admin-invite-user', { method: 'POST', headers })
}

function baseDeps(overrides: Partial<OperatorDeps> = {}): OperatorDeps {
  return {
    getUser: async (_jwt: string) => ({ user: { id: 'op-1' }, error: null }),
    isActiveOperator: async (_userId: string) => true,
    timeoutMs: 2000,
    ...overrides,
  }
}

Deno.test('whenOperatorAal2_thenTrue', async () => {
  const jwt = makeJwt({ sub: 'op-1', aal: 'aal2', role: 'authenticated' })
  const ok = await isCallerOperator(reqWithJwt(jwt), baseDeps())
  assertEq(ok, true, 'operador ativo aal2 deve passar no gate')
})

Deno.test('whenStaleAdminRoleWithoutOperator_thenFalse', async () => {
  // Regressão pós-0035: claim JWT com role='admin' não é prova.
  // Sem linha em internal_operators, nega mesmo com qualquer role no JWT.
  const jwt = makeJwt({ sub: 'u-x', aal: 'aal2', role: 'admin' })
  const ok = await isCallerOperator(
    reqWithJwt(jwt),
    baseDeps({
      getUser: async () => ({ user: { id: 'u-x' }, error: null }),
      isActiveOperator: async () => false,
    }),
  )
  assertEq(ok, false, 'stale role=admin sem operador deve negar')
})

Deno.test('whenSuperAdminWithoutOperator_thenFalse', async () => {
  // profiles.role=super_admin sozinho não autoriza invite: só operador.
  const jwt = makeJwt({ sub: 'u-sup', aal: 'aal2', role: 'authenticated' })
  const ok = await isCallerOperator(
    reqWithJwt(jwt),
    baseDeps({
      getUser: async () => ({ user: { id: 'u-sup' }, error: null }),
      isActiveOperator: async () => false,
    }),
  )
  assertEq(ok, false, 'super_admin sem operador deve negar')
})

Deno.test('whenOperatorAal1_thenFalse', async () => {
  const jwt = makeJwt({ sub: 'op-1', aal: 'aal1', role: 'authenticated' })
  const ok = await isCallerOperator(reqWithJwt(jwt), baseDeps())
  assertEq(ok, false, 'operador aal1 deve negar (mfa-required)')
})

Deno.test('whenOperatorAalNull_thenFalse', async () => {
  const jwt = makeJwt({ sub: 'op-1', role: 'authenticated' })
  const ok = await isCallerOperator(reqWithJwt(jwt), baseDeps())
  assertEq(ok, false, 'aal null deve negar (nunca fail-open)')
})

Deno.test('whenInactiveOperator_thenFalse', async () => {
  const jwt = makeJwt({ sub: 'op-off', aal: 'aal2', role: 'authenticated' })
  const ok = await isCallerOperator(
    reqWithJwt(jwt),
    baseDeps({
      getUser: async () => ({ user: { id: 'op-off' }, error: null }),
      isActiveOperator: async () => false,
    }),
  )
  assertEq(ok, false, 'operador inativo deve negar')
})

Deno.test('whenNoJwt_thenFalse', async () => {
  const ok = await isCallerOperator(reqWithJwt(null), baseDeps())
  assertEq(ok, false, 'sem JWT deve negar')
})

Deno.test('whenInvalidJwt_thenFalse', async () => {
  const jwt = makeJwt({ sub: 'x', aal: 'aal2', role: 'authenticated' })
  const ok = await isCallerOperator(
    reqWithJwt(jwt),
    baseDeps({ getUser: async () => ({ user: null, error: new Error('bad') }) }),
  )
  assertEq(ok, false, 'JWT inválido deve negar')
})

Deno.test('whenGetUserThrows_thenFalse', async () => {
  const jwt = makeJwt({ sub: 'op-1', aal: 'aal2', role: 'authenticated' })
  const ok = await isCallerOperator(
    reqWithJwt(jwt),
    baseDeps({
      getUser: async () => {
        throw new Error('network')
      },
    }),
  )
  assertEq(ok, false, 'erro no getUser deve negar fail-closed')
})

Deno.test('whenDbThrows_thenFalse', async () => {
  const jwt = makeJwt({ sub: 'op-1', aal: 'aal2', role: 'authenticated' })
  const ok = await isCallerOperator(
    reqWithJwt(jwt),
    baseDeps({
      isActiveOperator: async () => {
        throw new Error('db')
      },
    }),
  )
  assertEq(ok, false, 'erro no lookup deve negar fail-closed')
})

Deno.test('whenGetUserTimesOut_thenFalse', async () => {
  const jwt = makeJwt({ sub: 'op-1', aal: 'aal2', role: 'authenticated' })
  const never = new Promise<{ user: { id: string }; error: null }>(() => {})
  const ok = await isCallerOperator(
    reqWithJwt(jwt),
    baseDeps({ getUser: () => never as never, timeoutMs: 50 }),
  )
  assertEq(ok, false, 'timeout deve negar fail-closed')
  assert(ok === false, 'gate nunca deve retornar true em timeout')
})

// ============================================================================
// BE-29 · E1–E5 — contrato v3 da borda (pipeline puro em ./core.ts).
// Mocks das RPCs e do `auth.admin` — nenhuma rede, nenhum env.
// ============================================================================

import { handleInvite, handleDelete } from './core.ts'
import type { InviteEdgeDeps } from './core.ts'

const INVITE_UUID = '11111111-1111-4111-8111-111111111111'
const EXISTING_UUID = '22222222-2222-4222-8222-222222222222'

interface CountingDeps {
  deps: InviteEdgeDeps
  calls: {
    resolve: string[]
    quota: number
    invite: string[]
    record: string[]
    cancel: string[]
    delete: string[]
  }
}

function makeInviteDeps(overrides: Partial<InviteEdgeDeps> = {}): CountingDeps {
  const calls = { resolve: [] as string[], quota: 0, invite: [] as string[], record: [] as string[], cancel: [] as string[], delete: [] as string[] }
  const deps: InviteEdgeDeps = {
    resolveInvitedUser: async (email: string) => {
      calls.resolve.push(email)
      return { userId: null, error: null }
    },
    inviteQuota: async () => {
      calls.quota += 1
      return { remaining: 20, error: null }
    },
    inviteUser: async (email: string) => {
      calls.invite.push(email)
      return { userId: INVITE_UUID, error: null }
    },
    recordInvite: async (userId: string) => {
      calls.record.push(userId)
      return { error: null }
    },
    cancelInvite: async (userId: string) => {
      calls.cancel.push(userId)
      return { canceled: false, error: null }
    },
    deleteUser: async (userId: string) => {
      calls.delete.push(userId)
      return { error: null }
    },
    ...overrides,
  }
  return { deps, calls }
}

Deno.test('whenNewInvite_then200InvitedAndRecordOnce', async () => {
  // E1 — fluxo feliz: resolve NULL ⇒ convida ⇒ registra trilha 1×.
  const { deps, calls } = makeInviteDeps()
  const res = await handleInvite('novo@empresa.com.br', deps)
  assertEq(res.status, 200, 'convite novo deve responder 200')
  const body = res.body as { user_id?: unknown; state?: unknown }
  assertEq(body.state, 'invited', 'estado deve ser invited')
  assertEq(body.user_id, INVITE_UUID, 'user_id deve vir do Auth, nunca inventado')
  assertEq(calls.invite.length, 1, 'inviteUserByEmail deve ser chamado 1×')
  assertEq(calls.record.length, 1, 'admin_record_invite deve ser chamado 1×')
  assertEq(calls.record[0], INVITE_UUID, 'trilha usa o id resolvido no servidor')
})

Deno.test('whenEmailAlreadyResolved_then200ExistingWithoutSecondInvite', async () => {
  // E2 — retry: e-mail já existe ⇒ não reenvia convite, mas grava trilha (F13).
  const { deps, calls } = makeInviteDeps({
    resolveInvitedUser: async (email: string) => {
      calls.resolve.push(email)
      return { userId: EXISTING_UUID, error: null }
    },
  })
  const res = await handleInvite('ja-existe@empresa.com.br', deps)
  assertEq(res.status, 200, 'retry deve responder 200')
  const body = res.body as { user_id?: unknown; state?: unknown }
  assertEq(body.state, 'existing', 'estado deve ser existing')
  assertEq(body.user_id, EXISTING_UUID, 'user_id deve ser o resolvido no servidor')
  assertEq(calls.invite.length, 0, 'nenhum 2º convite no retry')
  assertEq(calls.record.length, 1, 'retry ainda grava a trilha do convite')
})

Deno.test('whenQuotaExhausted_then429WithRetryAfter', async () => {
  // E3 — cota 0 ⇒ 429 invite-rate-limited + Retry-After, sem convidar.
  const { deps, calls } = makeInviteDeps({
    inviteQuota: async () => {
      calls.quota += 1
      return { remaining: 0, error: null }
    },
  })
  const res = await handleInvite('cota@empresa.com.br', deps)
  assertEq(res.status, 429, 'cota esgotada deve responder 429')
  const body = res.body as { error?: unknown }
  assertEq(body.error, 'invite-rate-limited', 'rótulo novo do 429')
  const retryAfter = res.headers?.['Retry-After']
  assert(typeof retryAfter === 'string' && Number(retryAfter) >= 1, 'Retry-After numérico ≥ 1')
  assertEq(calls.invite.length, 0, 'sem convite quando a cota está esgotada')
  assertEq(calls.record.length, 0, 'sem trilha quando a cota está esgotada')
})

Deno.test('whenRecordFailsAfterInvite_thenCompensatesAndFailsClosed', async () => {
  // E4 — falha em admin_record_invite ⇒ DELETE do usuário criado, 500, sem órfão.
  const { deps, calls } = makeInviteDeps({
    recordInvite: async (userId: string) => {
      calls.record.push(userId)
      return { error: new Error('record-failed') }
    },
  })
  const res = await handleInvite('orfaos@empresa.com.br', deps)
  assertEq(res.status, 500, 'falha de trilha deve falhar fechado')
  const body = res.body as { error?: unknown; user_id?: unknown }
  assertEq(body.error, 'invite-failed', 'rótulo genérico sem detalhe de provedor')
  assertEq(body.user_id, undefined, 'nunca devolve user_id sem trilha')
  assertEq(calls.delete.length, 1, 'compensação deve apagar o usuário recém-criado')
  assertEq(calls.delete[0], INVITE_UUID, 'compensação usa o id criado nesta chamada')
})

Deno.test('whenRecordFailsForExistingUser_thenNoDelete', async () => {
  // E4b — retry sobre usuário pré-existente nunca apaga conta real.
  const { deps, calls } = makeInviteDeps({
    resolveInvitedUser: async (email: string) => {
      calls.resolve.push(email)
      return { userId: EXISTING_UUID, error: null }
    },
    recordInvite: async (userId: string) => {
      calls.record.push(userId)
      return { error: new Error('record-failed') }
    },
  })
  const res = await handleInvite('existe@empresa.com.br', deps)
  assertEq(res.status, 500, 'falha de trilha em existing também falha fechado')
  assertEq(calls.delete.length, 0, 'nunca apaga usuário pré-existente')
})

Deno.test('whenSecondDelete_then200Idempotent', async () => {
  // E5 — DELETE repetido com cancelamento AUTORIZADO: usuário já ausente ⇒ 200
  // (`auth.admin.deleteUser` de conta inexistente é idempotente).
  const { deps, calls } = makeInviteDeps({
    cancelInvite: async (userId: string) => {
      calls.cancel.push(userId)
      return { canceled: true, error: null }
    },
    deleteUser: async (userId: string) => {
      calls.delete.push(userId)
      return { error: { status: 404, code: 'user_not_found', message: 'User not found' } }
    },
  })
  const first = await handleDelete(INVITE_UUID, deps)
  const second = await handleDelete(INVITE_UUID, deps)
  assertEq(first.status, 200, 'primeiro DELETE de ausente ⇒ 200')
  assertEq(second.status, 200, 'segundo DELETE ⇒ 200 (idempotente)')
  assertEq((first.body as { ok?: unknown }).ok, true, 'body do DELETE idempotente')
  assertEq((second.body as { ok?: unknown }).ok, true, 'body do 2º DELETE idempotente')
  assertEq(calls.delete.length, 2, 'deleção tentada nas duas chamadas')
})

Deno.test('whenDeleteWithTenant_then500AndNoDelete', async () => {
  // I7 — `admin_cancel_invite` recusa com tenant ⇒ 500, nunca apaga.
  const { deps, calls } = makeInviteDeps({
    cancelInvite: async (userId: string) => {
      calls.cancel.push(userId)
      return { canceled: false, error: { code: 'P0001', message: 'invite-not-pending' } }
    },
  })
  const res = await handleDelete(INVITE_UUID, deps)
  assertEq(res.status, 500, 'tenant existente ⇒ 500 (FK RESTRICT / invite-not-pending)')
  assertEq(calls.delete.length, 0, 'cancelamento recusado nunca chama deleteUser')
})

Deno.test('whenDeleteMember_then500AndNoDelete', async () => {
  // E6 — alvo é MEMBRO de tenant (role `member`/`admin`, não owner):
  // `admin_cancel_invite` recusa com `invite-not-pending`. A borda responde
  // fail-closed e NUNCA chama `deleteUser` — apagar a conta apagaria o vínculo
  // por cascade (`profiles -> tenant_members`) sem trilha.
  const { deps, calls } = makeInviteDeps({
    cancelInvite: async (userId: string) => {
      calls.cancel.push(userId)
      return { canceled: null, error: { code: 'P0001', message: 'invite-not-pending' } }
    },
  })
  const res = await handleDelete(INVITE_UUID, deps)
  assertEq(res.status, 500, 'membro de tenant ⇒ 500 (invite-not-pending)')
  assertEq((res.body as { error?: unknown }).error, 'invite-failed', 'rótulo genérico')
  assertEq(calls.cancel.length, 1, 'RPC é consultada antes do Auth')
  assertEq(calls.delete.length, 0, 'membro nunca chega ao deleteUser')
})

Deno.test('whenCancelNotAuthorized_then500AndNoDelete', async () => {
  // E6b — `canceled=false` sem erro (sem pendência derivada) NÃO autoriza
  // apagar conta: o DELETE exige `canceled === true`.
  const { deps, calls } = makeInviteDeps()
  const res = await handleDelete(INVITE_UUID, deps)
  assertEq(res.status, 500, 'sem cancelamento autorizado ⇒ 500 (fail-closed)')
  assertEq(calls.cancel.length, 1, 'RPC consultada')
  assertEq(calls.delete.length, 0, 'deleteUser não é chamado sem canceled=true')
})

// ============================================================================
// CORS fail-closed — APP_URL + APP_URL_ALIASES (mesmo padrão verify-operator).
// Lógica pura em ./core.ts para teste offline: a borda (index.ts) só lê env
// e delega. APP_URL permanece UM valor; aliases são extras separados por ','.
// ============================================================================

const LOOPBACK_ORIGIN = 'http://127.0.0.1:5173'
const LOCALHOST_ORIGIN = 'http://localhost:5173'

function reqWithOrigin(origin: string | null): Request {
  const headers = new Headers()
  if (origin !== null) headers.set('Origin', origin)
  return new Request('http://localhost/admin-invite-user', { method: 'POST', headers })
}

Deno.test('whenLocalhostAlias_thenAllowedOriginEchoesLocalhost', () => {
  const allow = allowedOrigin(
    reqWithOrigin(LOCALHOST_ORIGIN),
    LOOPBACK_ORIGIN,
    LOCALHOST_ORIGIN,
  )
  assertEq<string | null>(allow, LOCALHOST_ORIGIN, 'localhost aceito via APP_URL_ALIASES')
})

Deno.test('whenAppUrlOrigin_thenAllowedOriginEchoesLoopback', () => {
  const allow = allowedOrigin(
    reqWithOrigin(LOOPBACK_ORIGIN),
    LOOPBACK_ORIGIN,
    LOCALHOST_ORIGIN,
  )
  assertEq<string | null>(allow, LOOPBACK_ORIGIN, '127.0.0.1 (APP_URL) continua aceito')
})

Deno.test('whenUnknownOriginWithAliases_thenAllowedOriginNull', () => {
  const allow = allowedOrigin(
    reqWithOrigin('https://evil.test'),
    LOOPBACK_ORIGIN,
    LOCALHOST_ORIGIN,
  )
  assertEq<string | null>(allow, null, 'origem desconhecida ⇒ null (sem ACAO, 403)')
})

Deno.test('whenWildcardAlias_thenUnknownOriginStillNull', () => {
  const allow = allowedOrigin(reqWithOrigin('https://evil.test'), LOOPBACK_ORIGIN, '*')
  assertEq<string | null>(allow, null, 'curinga nunca autoriza origem arbitrária')
})

Deno.test('whenEmptyTokens_thenExactMatchOnly', () => {
  const depsAliases = ` , ${LOCALHOST_ORIGIN} ,,`
  const ok = allowedOrigin(reqWithOrigin(LOCALHOST_ORIGIN), LOOPBACK_ORIGIN, depsAliases)
  assertEq<string | null>(ok, LOCALHOST_ORIGIN, 'tokens vazios não impedem alias válido')
  const empty = allowedOrigin(reqWithOrigin(''), LOOPBACK_ORIGIN, depsAliases)
  assertEq<string | null>(empty, null, 'token vazio não autoriza Origin vazia')
})

Deno.test('whenNoOriginsConfigured_thenEveryOriginNull', () => {
  const allow = allowedOrigin(reqWithOrigin(LOOPBACK_ORIGIN), '', '')
  assertEq<string | null>(allow, null, 'sem APP_URL e sem aliases: nenhuma origem confiável')
})

Deno.test('whenNoOriginHeader_thenNull', () => {
  const allow = allowedOrigin(reqWithOrigin(null), LOOPBACK_ORIGIN, LOCALHOST_ORIGIN)
  assertEq<string | null>(allow, null, 'sem Origin (curl/server-to-server): sem CORS')
})

Deno.test('whenParseAllowedOrigins_thenDiscardsWildcardNullAndDuplicates', () => {
  const parsed = parseAllowedOrigins(
    `${LOOPBACK_ORIGIN}, *`,
    `null, ${LOCALHOST_ORIGIN},,${LOOPBACK_ORIGIN} , NULL`,
  )
  assertEq(parsed.length, 2, 'descarta *, null/NULL, vazios e duplicatas')
  assertEq(parsed[0], LOOPBACK_ORIGIN, 'APP_URL é a primeira origem')
  assertEq(parsed[1], LOCALHOST_ORIGIN, 'alias válido é a segunda origem')
})
