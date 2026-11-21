// Deno tests `verify-operator` v2 — SEC-DEBT-49 (Edge v2, ordem do 0051:86-124).
// Importa só ./core.ts (sem fetch remoto): roda offline com `deno test`.
//
// Cenários obrigatórios (TASKS.md §DEBT-49):
//   200 só com super_admin + aal2 + operador ativo + must_change_password=false;
//   403 first-access quando a flag é true (mesmo com aal2 e operador ativo);
//   403 genérico quando role <> 'super_admin' (sem vazar role ao cliente);
//   403 mfa-required em aal1/null;
//   403 operator-inactive sem linha ativa em internal_operators;
//   401 sem header / JWT inválido;
//   deadline total estourado ⇒ 403 fail-closed (nunca 200).
// Extras: ordem canônica (first-access → role → aal2 → operador), profile
// ausente/erro = 403, CORS fail-closed, 200/403 sem PII.

import { handleVerifyOperator } from './core.ts'
import type { VerifyDeps } from './core.ts'

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

function reqWithJwt(jwt: string | null, opts: { origin?: string; method?: string } = {}): Request {
  const headers = new Headers()
  if (jwt !== null) headers.set('Authorization', `Bearer ${jwt}`)
  if (opts.origin) headers.set('Origin', opts.origin)
  return new Request('http://localhost/verify-operator', {
    method: opts.method ?? 'GET',
    headers,
  })
}

// ADR-004: o único id do corpo 200 é o `user_id` do próprio chamador — que em
// produção É um uuid. O fixture usa uuid real para a invariante não passar por
// acidente: com um `sub` fictício ('op-1') "nenhum uuid no corpo" seria trivial.
const OPERATOR_ID = 'f0e1d2c3-b4a5-4678-9abc-def012345678'

const OPERATOR_JWT = makeJwt({ sub: OPERATOR_ID, aal: 'aal2', role: 'authenticated' })

function baseDeps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    getUser: async (_jwt: string) => ({ user: { id: OPERATOR_ID }, error: null }),
    getProfile: async (_userId: string) => ({ role: 'super_admin', must_change_password: false }),
    isActiveOperator: async (_userId: string) => true,
    appUrl: 'https://app.test',
    deadlineMs: 2000,
    ...overrides,
  }
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

// ---------- 401: sessão ----------

Deno.test('whenNoJwt_then401', async () => {
  const res = await handleVerifyOperator(reqWithJwt(null), baseDeps())
  assertEq(res.status, 401, 'sem JWT deve ser 401')
  const b = await body(res)
  assertEq(b.is_operator, false, 'body deve ser is_operator false')
  assertEq(b.error, undefined, 'sem JWT não expõe rótulo interno')
})

Deno.test('whenInvalidJwt_then401', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ getUser: async () => ({ user: null, error: new Error('bad jwt') }) }),
  )
  assertEq(res.status, 401, 'JWT inválido deve ser 401')
  assertEq((await body(res)).is_operator, false, 'body is_operator false')
})

// ---------- 200: único caminho permitido ----------

Deno.test('whenSuperAdminAal2Active_then200', async () => {
  const res = await handleVerifyOperator(reqWithJwt(OPERATOR_JWT), baseDeps())
  assertEq(res.status, 200, 'super_admin + aal2 + ativo + flag false deve ser 200')
  const b = await body(res)
  assertEq(b.is_operator, true, 'body is_operator true')
  assertEq(b.aal, 'aal2', 'body aal aal2')
  assertEq(b.user_id, OPERATOR_ID, 'body user_id = id da sessao (ADR-004)')
})

Deno.test('whenPost_thenSameAsGet', async () => {
  const res = await handleVerifyOperator(reqWithJwt(OPERATOR_JWT, { method: 'POST' }), baseDeps())
  assertEq(res.status, 200, 'POST deve ser aceito como GET')
})

// ---------- 403 first-access (Ef1) ----------

Deno.test('whenMustChangePassword_then403FirstAccess', async () => {
  // Mesmo com aal2 e operador ativo: a flag de primeiro acesso vem antes.
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ getProfile: async () => ({ role: 'super_admin', must_change_password: true }) }),
  )
  assertEq(res.status, 403, 'flag de primeiro acesso deve ser 403')
  const b = await body(res)
  assertEq(b.is_operator, false, 'body is_operator false')
  assertEq(b.error, 'first-access', 'rótulo fixo first-access')
})

Deno.test('whenMustChangeFlagMissing_then403FirstAccess', async () => {
  // Fail-closed: flag ausente/não-boolean não pode virar 200.
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ getProfile: async () => ({ role: 'super_admin' } as never) }),
  )
  assertEq(res.status, 403, 'flag ausente deve negar')
  assertEq((await body(res)).error, 'first-access', 'flag ausente = first-access (fail-closed)')
})

// ---------- 403 role (Ef2) ----------

Deno.test('whenRoleUser_then403Generic', async () => {
  // Operador ativo + aal2, mas role='user': 403 genérico, sem vazar o motivo.
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ getProfile: async () => ({ role: 'user', must_change_password: false }) }),
  )
  assertEq(res.status, 403, 'role != super_admin deve ser 403')
  const b = await body(res)
  assertEq(b.is_operator, false, 'body is_operator false')
  assertEq(b.error, undefined, 'não vaza not-super-admin ao cliente')
})

Deno.test('whenProfileMissing_then403', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ getProfile: async () => null }),
  )
  assertEq(res.status, 403, 'sem profile = fail-closed 403')
  assertEq((await body(res)).is_operator, false, 'body is_operator false')
})

Deno.test('whenProfileThrows_then403', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({
      getProfile: async () => {
        throw new Error('db down')
      },
    }),
  )
  assertEq(res.status, 403, 'erro no lookup de profile = 403 fail-closed')
})

// ---------- 403 mfa-required (aal) ----------

Deno.test('whenOperatorAal1_then403MfaRequired', async () => {
  const jwt = makeJwt({ sub: OPERATOR_ID, aal: 'aal1', role: 'authenticated' })
  const res = await handleVerifyOperator(reqWithJwt(jwt), baseDeps())
  assertEq(res.status, 403, 'aal1 deve ser 403')
  const b = await body(res)
  assertEq(b.is_operator, false, 'body is_operator false')
  assertEq(b.error, 'mfa-required', 'rótulo fixo mfa-required')
})

Deno.test('whenOperatorAalNull_then403MfaRequired', async () => {
  const jwt = makeJwt({ sub: OPERATOR_ID, role: 'authenticated' })
  const res = await handleVerifyOperator(reqWithJwt(jwt), baseDeps())
  assertEq(res.status, 403, 'aal ausente deve negar')
  assertEq((await body(res)).error, 'mfa-required', 'aal ausente = mfa-required')
})

// ---------- 403 operador inativo ----------

Deno.test('whenOperatorInactive_then403OperatorInactive', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ isActiveOperator: async () => false }),
  )
  assertEq(res.status, 403, 'operador inativo deve ser 403')
  const b = await body(res)
  assertEq(b.is_operator, false, 'body is_operator false')
  assertEq(b.error, 'operator-inactive', 'rótulo fixo do 0051: operator-inactive')
})

Deno.test('whenOperatorLookupThrows_then403', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({
      isActiveOperator: async () => {
        throw new Error('db down')
      },
    }),
  )
  assertEq(res.status, 403, 'erro no lookup de operador = 403 fail-closed')
})

// ---------- ordem canônica (Ef3) ----------

Deno.test('whenMustChangeAal1AndInactive_thenFirstAccess', async () => {
  // first-access precede mfa-required e operator-inactive.
  const jwt = makeJwt({ sub: OPERATOR_ID, aal: 'aal1', role: 'authenticated' })
  const res = await handleVerifyOperator(
    reqWithJwt(jwt),
    baseDeps({
      getProfile: async () => ({ role: 'super_admin', must_change_password: true }),
      isActiveOperator: async () => false,
    }),
  )
  assertEq(res.status, 403, 'deve negar')
  assertEq((await body(res)).error, 'first-access', 'first-access vence os demais rótulos')
})

Deno.test('whenRoleUserAal1AndInactive_then403Generic', async () => {
  // role precede aal2 (v1 checava aal/operador antes: Ef3).
  const jwt = makeJwt({ sub: 'u-plain', aal: 'aal1', role: 'authenticated' })
  const res = await handleVerifyOperator(
    reqWithJwt(jwt),
    baseDeps({
      getUser: async () => ({ user: { id: 'u-plain' }, error: null }),
      getProfile: async () => ({ role: 'user', must_change_password: false }),
      isActiveOperator: async () => false,
    }),
  )
  assertEq(res.status, 403, 'deve negar')
  assertEq((await body(res)).error, undefined, 'role errada = genérico, nunca mfa-required')
})

Deno.test('whenAal1AndInactive_thenMfaRequired', async () => {
  // aal2 precede operator-inactive.
  const jwt = makeJwt({ sub: OPERATOR_ID, aal: 'aal1', role: 'authenticated' })
  const res = await handleVerifyOperator(
    reqWithJwt(jwt),
    baseDeps({ isActiveOperator: async () => false }),
  )
  assertEq(res.status, 403, 'deve negar')
  assertEq((await body(res)).error, 'mfa-required', 'mfa-required vence operator-inactive')
})

// ---------- deadline total (fail-closed) ----------

Deno.test('whenGetUserTimesOut_then403', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ getUser: () => never(), deadlineMs: 50 }),
  )
  assertEq(res.status, 403, 'timeout no getUser deve ser 403 fail-closed')
  assertEq((await body(res)).is_operator, false, 'body is_operator false')
})

Deno.test('whenProfileTimesOut_then403', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ getProfile: () => never(), deadlineMs: 50 }),
  )
  assertEq(res.status, 403, 'timeout no profile deve ser 403 fail-closed')
})

Deno.test('whenOperatorLookupTimesOut_then403', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ isActiveOperator: () => never(), deadlineMs: 50 }),
  )
  assertEq(res.status, 403, 'timeout no operador deve ser 403 fail-closed')
})

Deno.test('whenTotalDeadlineExceeded_then403', async () => {
  // Deadline é TOTAL: cada etapa isolada cabe no budget (40ms), a soma não (60ms).
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({
      getUser: () => delay(40, { user: { id: OPERATOR_ID }, error: null }),
      getProfile: () => delay(40, { role: 'super_admin', must_change_password: false }),
      deadlineMs: 60,
    }),
  )
  assertEq(res.status, 403, 'orçamento total estourado deve negar')
  assertEq((await body(res)).is_operator, false, 'nunca 200 com deadline estourado')
})

// ---------- CORS / método ----------

Deno.test('whenUnknownOrigin_then403WithoutCORS', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: 'https://evil.test' }),
    baseDeps(),
  )
  assertEq(res.status, 403, 'origin desconhecida deve ser 403 fail-closed')
  assert(!res.headers.has('Access-Control-Allow-Origin'), 'não deve ecoar CORS para origin desconhecida')
})

Deno.test('whenAllowedOrigin_thenEchoesCORS', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: 'https://app.test' }),
    baseDeps(),
  )
  assertEq(res.status, 200, 'origin permitida deve passar')
  assertEq(res.headers.get('Access-Control-Allow-Origin'), 'https://app.test', 'deve ecoar APP_URL')
})

Deno.test('whenOptions_then204', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(null, { origin: 'https://app.test', method: 'OPTIONS' }),
    baseDeps(),
  )
  assertEq(res.status, 204, 'OPTIONS deve ser 204')
})

// ---------- CORS: aliases locais (localhost × 127.0.0.1) ----------
// Dev server Vite escuta nos dois hosts na porta 5173. APP_URL permanece
// único (admin-invite-user compara por igualdade exata, fora deste escopo);
// a Edge verifica-original aceita origens extras via APP_URL_ALIASES.

const LOOPBACK_ORIGIN = 'http://127.0.0.1:5173'
const LOCALHOST_ORIGIN = 'http://localhost:5173'

function localDeps(aliases: string = LOCALHOST_ORIGIN): VerifyDeps {
  return baseDeps({ appUrl: LOOPBACK_ORIGIN, appUrlAliases: aliases })
}

Deno.test('whenLocalhostOriginViaAlias_then200EchoesLocalhost', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: LOCALHOST_ORIGIN }),
    localDeps(),
  )
  assertEq(res.status, 200, 'localhost deve ser aceito via APP_URL_ALIASES')
  assertEq(
    res.headers.get('Access-Control-Allow-Origin'),
    LOCALHOST_ORIGIN,
    'ACAO deve ecoar a origin permitida (MDN: múltiplas origens ⇒ devolver a do cliente)',
  )
})

Deno.test('whenLoopbackOriginViaAppUrl_then200EchoesLoopback', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: LOOPBACK_ORIGIN }),
    localDeps(),
  )
  assertEq(res.status, 200, '127.0.0.1 (APP_URL) continua aceito')
  assertEq(res.headers.get('Access-Control-Allow-Origin'), LOOPBACK_ORIGIN, 'ACAO ecoa APP_URL')
})

Deno.test('whenBothLocalOrigins_thenSameVerdict', async () => {
  const loopback = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: LOOPBACK_ORIGIN, method: 'POST' }),
    localDeps(),
  )
  const localhost = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: LOCALHOST_ORIGIN, method: 'POST' }),
    localDeps(),
  )
  assertEq(loopback.status, localhost.status, 'mesmo status para ambos os hosts')
  assertEq(await loopback.text(), await localhost.text(), 'mesmo corpo de veredito para ambos os hosts')
})

Deno.test('whenUnknownOriginWithAliases_then403WithoutCORS', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: 'https://evil.test' }),
    localDeps(),
  )
  assertEq(res.status, 403, 'origin fora da lista continua 403')
  assert(!res.headers.has('Access-Control-Allow-Origin'), 'nenhum ACAO para origin desconhecida')
})

Deno.test('whenLocalhostPreflight_then204EchoesLocalhost', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(null, { origin: LOCALHOST_ORIGIN, method: 'OPTIONS' }),
    localDeps(),
  )
  assertEq(res.status, 204, 'preflight do browser em localhost deve passar')
  assertEq(res.headers.get('Access-Control-Allow-Origin'), LOCALHOST_ORIGIN, 'ACAO do preflight')
})

Deno.test('whenWildcardAlias_thenUnknownOriginStill403', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: 'https://evil.test' }),
    localDeps('*'),
  )
  assertEq(res.status, 403, 'curinga nunca autoriza origem arbitrária (fail-closed)')
  assert(!res.headers.has('Access-Control-Allow-Origin'), 'curinga não gera ACAO')
})

Deno.test('whenAliasListHasEmptyTokens_thenExactMatchOnly', async () => {
  const deps = localDeps(` , ${LOCALHOST_ORIGIN} ,,`)
  const ok = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: LOCALHOST_ORIGIN }),
    deps,
  )
  assertEq(ok.status, 200, 'tokens vazios não impedem o alias válido')
  // `reqWithJwt` só seta Origin quando truthy: aqui é preciso o header presente
  // e vazio (diferente de ausente, que é o caso curl/server-to-server).
  const emptyOriginReq = new Request('http://localhost/verify-operator', {
    method: 'GET',
    headers: new Headers({ Authorization: `Bearer ${OPERATOR_JWT}`, Origin: '' }),
  })
  const bad = await handleVerifyOperator(emptyOriginReq, deps)
  assertEq(bad.status, 403, 'token vazio não autoriza Origin vazia')
  assert(!bad.headers.has('Access-Control-Allow-Origin'), 'sem ACAO para Origin vazia')
})

Deno.test('whenNoOriginsConfigured_thenEveryOrigin403', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT, { origin: LOOPBACK_ORIGIN }),
    baseDeps({ appUrl: '', appUrlAliases: '' }),
  )
  assertEq(res.status, 403, 'sem APP_URL e sem aliases: nenhuma origem confiável')
  assert(!res.headers.has('Access-Control-Allow-Origin'), 'fail-closed sem ACAO')
})

// ---------- ausência de PII ----------

Deno.test('when200_thenNoPii', async () => {
  const res = await handleVerifyOperator(reqWithJwt(OPERATOR_JWT), baseDeps())
  const text = await res.text()
  assert(!text.includes('@'), `body 200 não deve conter e-mail: ${text}`)
  assert(!/email/i.test(text), 'body 200 não deve conter campo email')
  assert(!/super_admin/.test(text), 'body 200 não deve vazar role')
  assert(!/tenant/i.test(text), 'body 200 não deve conter campo tenant')
  // ADR-004: `user_id` é o único id do corpo — e é o da própria sessão.
  const b = JSON.parse(text) as Record<string, unknown>
  assertEq(b.user_id, OPERATOR_ID, 'body 200 só devolve o user_id do próprio chamador')
  // Invariante verdadeira: o chamador É um uuid em produção, logo o corpo traz
  // exatamente 1 uuid — o dele. Qualquer uuid de terceiro reprova aqui.
  const ids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []
  assertEq(ids.length, 1, `body 200 deve conter exatamente o uuid do chamador: ${text}`)
  assertEq((ids[0] ?? '').toLowerCase(), OPERATOR_ID, 'o único uuid do corpo é o do próprio chamador')
})

Deno.test('when403_thenNoPii', async () => {
  const res = await handleVerifyOperator(
    reqWithJwt(OPERATOR_JWT),
    baseDeps({ getProfile: async () => ({ role: 'super_admin', must_change_password: true }) }),
  )
  const text = await res.text()
  assert(!text.includes('@'), `body 403 não deve conter e-mail: ${text}`)
  assert(!text.includes('super_admin'), 'body 403 não deve vazar role')
  assert(!text.includes(OPERATOR_ID), 'body 403 não deve devolver id do usuário')
})

// ---------- BE-46b: matriz de paridade 16 casos (Edge × SQL) ----------
// A MESMA tabela de expectativa vive em
// `supabase/tests/0069-0071-active-tenant.spec.sql` (T-par-01), na mesma ordem.
// Colunas: must_change_password, role, aal, operator.active -> resultado.
// Vocabulário compartilhado: allow | deny | first-access | mfa-required |
// operator-inactive. `allow` = 200 `is_operator:true`; `deny` = 403 genérico
// (sem rótulo); os demais = 403 com o rótulo fixo. No SQL, `allow` =
// `is_super_admin()` true, `deny` = false sem raise, e os rótulos = exceção
// com a mesma mensagem — `core.ts` não muda.
type ParityOutcome = 'allow' | 'deny' | 'first-access' | 'mfa-required' | 'operator-inactive'

interface ParityCase {
  mustChangePassword: boolean
  role: 'user' | 'super_admin'
  aal: 'aal1' | 'aal2'
  operatorActive: boolean
  outcome: ParityOutcome
}

const PARITY_CASES: ParityCase[] = [
  { mustChangePassword: false, role: 'user', aal: 'aal1', operatorActive: false, outcome: 'deny' },
  { mustChangePassword: false, role: 'user', aal: 'aal1', operatorActive: true, outcome: 'deny' },
  { mustChangePassword: false, role: 'user', aal: 'aal2', operatorActive: false, outcome: 'deny' },
  { mustChangePassword: false, role: 'user', aal: 'aal2', operatorActive: true, outcome: 'deny' },
  { mustChangePassword: false, role: 'super_admin', aal: 'aal1', operatorActive: false, outcome: 'mfa-required' },
  { mustChangePassword: false, role: 'super_admin', aal: 'aal1', operatorActive: true, outcome: 'mfa-required' },
  { mustChangePassword: false, role: 'super_admin', aal: 'aal2', operatorActive: false, outcome: 'operator-inactive' },
  { mustChangePassword: false, role: 'super_admin', aal: 'aal2', operatorActive: true, outcome: 'allow' },
  { mustChangePassword: true, role: 'user', aal: 'aal1', operatorActive: false, outcome: 'first-access' },
  { mustChangePassword: true, role: 'user', aal: 'aal1', operatorActive: true, outcome: 'first-access' },
  { mustChangePassword: true, role: 'user', aal: 'aal2', operatorActive: false, outcome: 'first-access' },
  { mustChangePassword: true, role: 'user', aal: 'aal2', operatorActive: true, outcome: 'first-access' },
  { mustChangePassword: true, role: 'super_admin', aal: 'aal1', operatorActive: false, outcome: 'first-access' },
  { mustChangePassword: true, role: 'super_admin', aal: 'aal1', operatorActive: true, outcome: 'first-access' },
  { mustChangePassword: true, role: 'super_admin', aal: 'aal2', operatorActive: false, outcome: 'first-access' },
  { mustChangePassword: true, role: 'super_admin', aal: 'aal2', operatorActive: true, outcome: 'first-access' },
]

Deno.test('whenParityMatrix_then16Cases', () => {
  assertEq(PARITY_CASES.length, 16, 'a matriz de paridade tem exatamente 16 casos')
})

for (const c of PARITY_CASES) {
  const label = `must=${c.mustChangePassword}_role=${c.role}_aal=${c.aal}_active=${c.operatorActive}`
  Deno.test(`whenParity_${label}_then${c.outcome}`, async () => {
    const jwt = makeJwt({ sub: OPERATOR_ID, aal: c.aal, role: 'authenticated' })
    const res = await handleVerifyOperator(
      reqWithJwt(jwt),
      baseDeps({
        getProfile: async () => ({
          role: c.role,
          must_change_password: c.mustChangePassword,
        }),
        isActiveOperator: async () => c.operatorActive,
      }),
    )
    const b = await body(res)
    if (c.outcome === 'allow') {
      assertEq(res.status, 200, `${label} deve permitir`)
      assertEq(b.is_operator, true, `${label} body is_operator true`)
      return
    }
    assertEq(res.status, 403, `${label} deve negar`)
    assertEq(b.is_operator, false, `${label} body is_operator false`)
    if (c.outcome === 'deny') {
      assertEq(b.error, undefined, `${label} deny é genérico (sem rótulo)`)
    } else {
      assertEq(b.error, c.outcome, `${label} rótulo fixo ${c.outcome}`)
    }
  })
}
